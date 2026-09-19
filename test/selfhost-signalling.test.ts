import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { installSignalling } from "../server/signalling.js";
import { SignallingStore } from "../server/signalling-store.js";
import { BRIDGE_INVITE_MS } from "../shared/bridge-authority.js";

const identity = () => randomBytes(24).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Signalling transition did not complete");
}
async function fixture(dataDirectory: string, port = 0) {
  const app = express();
  const server = createServer(app);
  const signalling = installSignalling(app, server, { dataDirectory });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  return {
    origin, port: address.port,
    request: (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Connection: "close", ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }),
    connect(route: string, registration: unknown) {
      const socket = new WebSocket(origin.replace("http:", "ws:") + route, { origin });
      sockets.push(socket);
      const result = { socket, messages: [] as Record<string, any>[], code: 0 };
      socket.on("open", () => socket.send(JSON.stringify(registration)));
      socket.on("message", bytes => result.messages.push(JSON.parse(String(bytes))));
      socket.on("close", code => { result.code = code; });
      socket.on("error", () => undefined);
      return result;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      signalling.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("invitation capabilities, exclusive capture authority and restart recovery use the local server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ceres-signalling-"));
  let host = await fixture(directory);
  const roomId = identity(), sessionId = identity(), monitor = identity(), capture = identity();
  const registration = (role: "monitor" | "capture", capability: string, pairingId = "capture-one") => ({
    type: "register", protocol: "invitation", role, capability, roomId, sessionId,
    ...(role === "capture" ? { pairingId } : {}),
  });
  try {
    const room = {
      version: 1, roomId, sessionId, monitorCapabilityHash: hash(monitor), demonstratorCapabilityHash: hash(capture),
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
      joinUrl: `${host.origin}/launch/capture/?session=${sessionId}#invite=${identity()}`,
    };
    assert.equal((await host.request("/api/v1/rooms", room, { Origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await host.request("/api/v1/rooms", { ...room, joinUrl: "invalid" })).status, 400);
    assert.equal((await host.request("/api/v1/rooms", room)).status, 201);
    assert.equal((await host.request("/api/v1/rooms", room)).status, 409);
    assert.equal((await host.request(`/j/${roomId}`)).headers.get("location"), room.joinUrl);
    const route = `/invite-signal?room=${roomId}`;
    const legacy = host.connect(route, { type: "register", role: "monitor", sessionId });
    const wrong = host.connect(route, registration("monitor", identity()));
    await until(() => legacy.code !== 0 && wrong.code !== 0);
    assert.equal(legacy.code, 4403);
    assert.equal(wrong.code, 4403);
    const director = host.connect(route, registration("monitor", monitor));
    const demonstrator = host.connect(route, registration("capture", capture));
    await until(() => demonstrator.messages.some(m => m.type === "capture-intent-granted"));
    demonstrator.socket.send(JSON.stringify({ type: "capture-xr-active" }));
    await until(() => demonstrator.messages.some(m => m.type === "capture-authority-granted"));
    await until(() => director.messages.some(m => m.type === "invitation-picked-up"));
    const foreign = host.connect(route, registration("capture", capture, "capture-two"));
    await until(() => foreign.code !== 0);
    assert.equal(foreign.code, 4403);
    const port = host.port;
    await host.close();
    host = await fixture(directory, port);
    const restored = host.connect(route, registration("capture", capture));
    await until(() => restored.messages.some(m => m.type === "capture-intent-granted"));
    restored.socket.send(JSON.stringify({ type: "capture-xr-active" }));
    await until(() => restored.messages.some(m => m.type === "capture-authority-granted"));
    const rejected = host.connect(route, registration("capture", capture, "capture-two"));
    await until(() => rejected.code !== 0);
    assert.equal(rejected.code, 4403);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Bridge claims, epochs, SDP direction and revocation survive a local restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ceres-bridge-"));
  let host = await fixture(directory);
  const receiver = { deviceId: identity(), secret: identity(), role: "receiver" };
  const sender = { deviceId: identity(), secret: identity(), role: "sender" };
  const bindingId = identity(), invitationSecret = identity();
  const base = `/api/bridge/v1/bindings/${bindingId}`;
  try {
    const body = { ...receiver, bindingId, invitationSecret, code: "ABCDEFGH", label: "Receiver", appOrigin: host.origin };
    assert.equal((await host.request("/api/bridge/v1/bindings", body)).status, 200);
    assert.equal((await host.request(`${base}/claim`, { ...sender, invitationSecret: identity() })).status, 403);
    assert.equal((await host.request(`${base}/claim`, { ...sender, invitationSecret })).status, 200);
    assert.equal((await host.request(`${base}/claim`, { ...sender, deviceId: identity(), invitationSecret })).status, 403);
    assert.equal((await host.request("/api/bridge/v1/invitations/ABCDEFGH")).status, 410);
    const port = host.port;
    await host.close();
    host = await fixture(directory, port);
    const generations = await Promise.all([sender, receiver].map(async auth => {
      const response = await host.request(`${base}/session`, { ...auth, restartAfter: 1 });
      assert.equal(response.status, 200);
      return (await response.json()).epoch;
    }));
    assert.deepEqual(generations, [2, 2]);
    const connect = (auth: typeof sender) => host.connect(`${base}/signal`, { ...auth, type: "register", version: 1, epoch: 2 });
    const left = connect(sender), right = connect(receiver);
    await until(() => left.messages.some(m => m.type === "peer-ready") && right.messages.some(m => m.type === "peer-ready"));
    const duplicate = connect(sender);
    await until(() => duplicate.code !== 0);
    assert.equal(duplicate.code, 4409);
    left.socket.send(JSON.stringify({ type: "signal", epoch: 2, signal: { type: "offer", sdp: "v=0\r\n" } }));
    await until(() => right.messages.some(m => m.signal?.type === "offer"));
    assert.equal((await host.request(`${base}/revoke`, receiver)).status, 200);
    await until(() => left.code !== 0 && right.code !== 0);
    assert.equal(left.code, 4410);
    assert.equal((await host.request(`${base}/session`, receiver)).status, 403);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const code of ["ABCDEFGHJ", "ABCIOL29"]) {
  test(`short pairing code ${code} resolves without case sensitivity and keeps collision and expiry guards`, async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ceres-short-code-"));
    const host = await fixture(directory);
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const sessionId = identity(), monitor = identity();
    const room = {
      version: 1, roomId: code, sessionId, monitorCapabilityHash: hash(monitor), demonstratorCapabilityHash: hash(identity()),
      expiresAt: new Date(now + 240_000).toISOString(),
      joinUrl: `${host.origin}/launch/capture/?session=${sessionId}#invite=${identity()}`,
    };
    const binding = {
      bindingId: identity(), deviceId: identity(), secret: identity(), invitationSecret: identity(),
      code, label: "Receiver", appOrigin: host.origin,
    };
    try {
      assert.equal((await host.request("/api/v1/rooms", room)).status, 201);
      assert.equal((await host.request("/api/v1/rooms", room)).status, 409);
      for (const entered of [code, code.toLowerCase()]) {
        assert.equal((await host.request(`/api/v1/invitations/${entered}`)).status, 200);
        assert.equal((await host.request(`/j/${entered}`)).headers.get("location"), room.joinUrl);
      }
      const director = host.connect(`/invite-signal?room=${code}`, {
        type: "register", protocol: "invitation", role: "monitor", roomId: code, sessionId, capability: monitor,
      });
      await until(() => director.messages.some(message => message.type === "session-registered"));
      assert.equal((await host.request("/api/bridge/v1/bindings", binding)).status, 200);
      assert.equal((await host.request("/api/bridge/v1/bindings", { ...binding, bindingId: identity() })).status, 409);
      assert.equal((await host.request(`/api/bridge/v1/invitations/${code.toLowerCase()}`)).status, 200);
      now += BRIDGE_INVITE_MS + 1;
      assert.equal((await host.request(`/api/v1/invitations/${code}`)).status, 410);
      assert.equal((await host.request(`/j/${code}`)).status, 410);
      assert.equal((await host.request(`/api/bridge/v1/invitations/${code}`)).status, 410);
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("short pairing routes reject invalid nine-character codes before allocation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ceres-invalid-code-"));
  const host = await fixture(directory);
  const sessionId = identity();
  try {
    for (const code of ["ABCDEFGH2", "ABCDEFGHI", "ABCDEFGHL", "ABCDEFGHO", "ABCD-EFGH", "ABCD EFGH"]) {
      const room = {
        version: 1, roomId: code, sessionId, monitorCapabilityHash: hash(identity()), demonstratorCapabilityHash: hash(identity()),
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
        joinUrl: `${host.origin}/launch/capture/?session=${sessionId}#invite=${identity()}`,
      };
      assert.equal((await host.request("/api/v1/rooms", room)).status, 400, code);
      const binding = {
        bindingId: identity(), deviceId: identity(), secret: identity(), invitationSecret: identity(),
        code, label: "Receiver", appOrigin: host.origin,
      };
      assert.equal((await host.request("/api/bridge/v1/bindings", binding)).status, 400, code);
      assert.equal((await host.request(`/api/bridge/v1/invitations/${encodeURIComponent(code)}`)).status, 400, code);
    }
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("signalling transactions roll back and persisted alarms run once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ceres-journal-"));
  try {
    const file = path.join(directory, "state.json");
    const store = new SignallingStore(file, () => undefined);
    await store.put("binding", { epoch: 1 });
    await assert.rejects(store.transaction(async transaction => {
      await transaction.put("binding", { epoch: 2 });
      throw new Error("Interrupted");
    }));
    await store.setAlarm(100);
    const restored = new SignallingStore(file, () => undefined);
    assert.deepEqual(await restored.get("binding"), { epoch: 1 });
    assert.equal(await restored.consumeAlarm(101), true);
    assert.equal(await restored.consumeAlarm(102), false);
    assert.equal(await new SignallingStore(file, () => undefined).consumeAlarm(103), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
