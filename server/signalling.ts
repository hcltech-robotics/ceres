import express, { type Express, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { SessionSignallingAuthority } from "../shared/session-signalling.js";
import { BridgeSignallingAuthority } from "../shared/bridge-signalling.js";
import { BRIDGE_INVITE_MS, BridgeFault, bridgeCodePattern, requireBridgeIdentity, type BridgeBinding } from "../shared/bridge-authority.js";
import type { SignallingContext, SignallingSocket } from "../shared/signalling-context.js";
import { normalisePairingCode, pairingRoomIdPattern } from "../shared/pairing-code.js";
import { SignallingStore } from "./signalling-store.js";

const bindingPattern = /^[A-Za-z0-9_-]{20,128}$/;
type Authority = SessionSignallingAuthority | BridgeSignallingAuthority;

class NodeSignalSocket implements SignallingSocket {
  private attachment: unknown = { openedAt: Date.now() };
  constructor(readonly socket: WebSocket) {}
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  send(value: string) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 128 * 1024) { this.close(4429, "Signalling backpressure limit reached"); return; }
    this.socket.send(value);
  }
  close(code: number, reason: string) { this.socket.close(code, reason.slice(0, 100)); }
}

class SignalActor {
  readonly sockets = new Set<NodeSignalSocket>();
  readonly authority: Authority;
  readonly storage: SignallingStore;
  private tail: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private pending = 0;
  lastUsed = Date.now();
  constructor(file: string, bridge: boolean) {
    this.storage = new SignallingStore(file, deadline => this.schedule(deadline));
    const context: SignallingContext = {
      storage: this.storage,
      getWebSockets: () => [...this.sockets].filter(item => item.socket.readyState === WebSocket.OPEN),
      openWebSocket: () => new Response(null, { status: 204 }),
    };
    this.authority = bridge ? new BridgeSignallingAuthority(context) : new SessionSignallingAuthority(context, false);
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed || this.pending >= 64) return Promise.reject(new BridgeFault(429, "Signalling queue is full"));
    this.pending++;
    this.lastUsed = Date.now();
    const result = this.tail.then(operation).finally(() => { this.pending--; this.lastUsed = Date.now(); });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private schedule(deadline: number) {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(async () => {
        if (await this.storage.consumeAlarm(Date.now())) await this.authority.alarm();
      }).catch(() => {
        for (const socket of this.sockets) socket.close(1011, "Signalling storage unavailable");
      });
    }, Math.max(1, Math.min(deadline - Date.now(), 2_147_483_647)));
    this.timer.unref();
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const socket of this.sockets) socket.socket.terminate();
  }
  get idle() { return this.pending === 0 && this.sockets.size === 0; }
}

export function installSignalling(app: Express, server: Server, options: { dataDirectory: string; origin?: string; secure?: boolean }) {
  const actors = new Map<string, SignalActor>();
  const rates = new Map<string, { count: number; until: number }>();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const cleanup = setInterval(() => {
    for (const [key, value] of actors) {
      if (value.idle && value.lastUsed < Date.now() - 300_000) { value.dispose(); actors.delete(key); }
    }
  }, 60_000);
  cleanup.unref();
  const actor = (kind: "room" | "bridge" | "code", id: string) => {
    if (!(kind === "room" ? pairingRoomIdPattern : kind === "code" ? bridgeCodePattern : bindingPattern).test(id)) throw new BridgeFault(400, "Invalid signalling identity");
    const key = `${kind}-${id}`;
    let current = actors.get(key);
    if (!current) {
      if (actors.size >= 2048) throw new BridgeFault(429, "Signalling capacity reached");
      current = new SignalActor(path.join(options.dataDirectory, "signalling", `${key}.json`), kind !== "room");
      actors.set(key, current);
    }
    return current;
  };
  const origin = (request: IncomingMessage) => options.origin ?? `${options.secure ? "https" : "http"}://${request.headers.host}`;
  const allowed = (request: IncomingMessage) => !request.headers.origin || request.headers.origin === origin(request);
  const rate = (request: IncomingMessage, bucket: string, limit = 120) => {
    const now = Date.now();
    for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
    const key = `${bucket}:${request.socket.remoteAddress ?? "unknown"}`;
    const value = rates.get(key) ?? { count: 0, until: now + 60_000 };
    value.count++;
    rates.set(key, value);
    if (value.count > limit) throw new BridgeFault(429, "Signalling request limit reached");
  };
  const invoke = (current: SignalActor, target: string, request: ExpressRequest) => current.run(() => current.authority.fetch(new Request(`https://signalling.invalid${target}`, {
    method: request.method,
    ...(request.method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) } : {}),
  })));
  const respond = async (response: ExpressResponse, value: Response) => {
    response.status(value.status);
    response.setHeader("Cache-Control", "no-store");
    response.type(value.headers.get("Content-Type") ?? "text/plain").send(await value.text());
  };
  const router = express.Router();
  router.use((request, response, next) => {
    if (!allowed(request)) { response.status(403).json({ error: "Origin is not allowed" }); return; }
    response.setHeader("Cache-Control", "no-store");
    try { rate(request, "http"); next(); } catch (error) { next(error); }
  });
  router.use(express.json({ limit: "8kb", strict: true }));
  router.post("/v1/rooms", async (request, response) => {
    rate(request, "create", 20);
    let join: URL;
    try { join = new URL(String(request.body?.joinUrl)); }
    catch { throw new BridgeFault(400, "Invalid pairing invitation target"); }
    if (join.origin !== origin(request) || join.pathname !== "/launch/capture/"
      || join.searchParams.get("session") !== request.body.sessionId || !new URLSearchParams(join.hash.slice(1)).has("invite")) {
      throw new BridgeFault(400, "Invalid pairing invitation target");
    }
    await respond(response, await invoke(actor("room", request.body.roomId), "/internal/create-invitation", request));
  });
  router.get("/v1/invitations/:room", async (request, response) => {
    const room = String(request.params.room);
    await respond(response, await invoke(actor("room", normalisePairingCode(room) ?? room), "/internal/resolve-invitation", request));
  });
  router.post("/bridge/v1/bindings", async (request, response) => {
    rate(request, "create", 20);
    const body = request.body ?? {};
    for (const key of ["bindingId", "deviceId", "secret", "invitationSecret"]) requireBridgeIdentity(body[key]);
    if (!bridgeCodePattern.test(body.code ?? "") || typeof body.label !== "string" || !body.label || body.label.length > 80 || body.appOrigin !== origin(request)) {
      throw new BridgeFault(400, "Invalid Bridge invitation");
    }
    const binding = actor("bridge", body.bindingId);
    const index = actor("code", body.code);
    const expiresAt = Date.now() + BRIDGE_INVITE_MS;
    const indexed = await index.run(async () => {
      const previous = await index.storage.get<{ expiresAt: number }>("code");
      if (previous && previous.expiresAt > Date.now()) throw new BridgeFault(409, "Bridge code is already allocated");
      const created = await invoke(binding, "/create", request);
      if (!created.ok) return created;
      await index.storage.transaction(async store => {
        await store.put("code", { version: 1, bindingId: body.bindingId, invitationSecret: body.invitationSecret, label: body.label, appOrigin: body.appOrigin, expiresAt });
        await store.setAlarm(expiresAt);
      });
      return created;
    });
    await respond(response, indexed);
  });
  router.get("/bridge/v1/invitations/:code", async (request, response) => {
    const index = actor("code", normalisePairingCode(String(request.params.code)) ?? "");
    const invitation = await index.run(() => index.storage.get<{ bindingId: string; expiresAt: number }>("code"));
    if (!invitation || Date.now() >= invitation.expiresAt) throw new BridgeFault(410, "Bridge invitation expired");
    const available = await invoke(actor("bridge", invitation.bindingId), "/available", request);
    if (!available.ok) { await respond(response, available); return; }
    response.json(invitation);
  });
  router.post("/bridge/v1/bindings/:binding/:operation", async (request, response) => {
    const operation = String(request.params.operation);
    if (!["claim", "session", "revoke"].includes(operation)) throw new BridgeFault(404, "Unknown Bridge operation");
    await respond(response, await invoke(actor("bridge", String(request.params.binding)), `/${operation}`, request));
  });
  router.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: express.NextFunction) => {
    response.status(error instanceof BridgeFault ? error.status : (error as { type?: string })?.type === "entity.too.large" ? 413 : error instanceof SyntaxError ? 400 : 500)
      .json({ error: error instanceof BridgeFault ? error.message : "Signalling request failed" });
  });
  app.use("/api", router);
  app.get("/j/:room", async (request, response) => {
    try {
      rate(request, "join");
      const room = String(request.params.room);
      const value = await invoke(actor("room", normalisePairingCode(room) ?? room), "/internal/resolve-invitation", request);
      if (!value.ok) { await respond(response, value); return; }
      const invitation = await value.json() as { joinUrl: string };
      if (new URL(invitation.joinUrl).origin !== origin(request)) throw new BridgeFault(403, "Invitation origin mismatch");
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, invitation.joinUrl);
    } catch { response.status(410).send("Pairing invitation expired"); }
  });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = new URL(request.url ?? "/", origin(request));
    const bridge = target.pathname.match(/^\/api\/bridge\/v1\/bindings\/([A-Za-z0-9_-]{20,128})\/signal$/);
    if (target.pathname !== "/invite-signal" && target.pathname !== "/signal" && !bridge) return;
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    try {
      if (!allowed(request)) { reject(403); return; }
      // Self-hosted peer sessions always require opaque invitation capabilities.
      if (target.pathname === "/signal") { reject(403); return; }
      rate(request, "websocket");
      const current = bridge ? actor("bridge", bridge[1]) : actor("room", target.searchParams.get("room") ?? "");
      void current.run(async () => {
        if (current.sockets.size >= (bridge ? 4 : 16)) { reject(429); return; }
        if (bridge) {
          const binding = await current.storage.get<BridgeBinding>("binding");
          if (!binding || binding.revoked || binding.expiresAt <= Date.now()) { reject(410); return; }
        } else {
          const result = await current.authority.fetch(new Request(`https://signalling.invalid/invite-signal`, { headers: { Upgrade: "websocket" } }));
          if (result.status !== 204) { reject(result.status); return; }
        }
        websocketServer.handleUpgrade(request, socket, head, ws => {
          const wrapped = new NodeSignalSocket(ws);
          current.sockets.add(wrapped);
          const registrationTimer = setTimeout(() => {
            const attached = wrapped.deserializeAttachment() as { role?: string };
            if (!attached.role) wrapped.close(4408, "Registration timed out");
          }, 10_000);
          registrationTimer.unref();
          let count = 0;
          let windowStart = Date.now();
          ws.on("message", (bytes, binary) => {
            if (Date.now() - windowStart > 60_000) { count = 0; windowStart = Date.now(); }
            if (binary || ++count > 600) { wrapped.close(4429, "Invalid signalling traffic"); return; }
            void current.run(() => current.authority.webSocketMessage(wrapped, bytes.toString())).catch(() => wrapped.close(1011, "Signalling storage unavailable"));
          });
          ws.on("close", (code, reason) => {
            clearTimeout(registrationTimer);
            current.sockets.delete(wrapped);
            void current.run(() => current.authority instanceof SessionSignallingAuthority
              ? current.authority.webSocketClose(wrapped, code, reason.toString(), true)
              : Promise.resolve()).catch(() => undefined);
          });
          ws.on("error", () => wrapped.close(1011, "Signalling connection failed"));
        });
      }).catch(() => reject(500));
    } catch (error) { reject(error instanceof BridgeFault ? error.status : 400); }
  };
  server.on("upgrade", upgrade);
  return {
    dispose() {
      clearInterval(cleanup);
      server.off("upgrade", upgrade);
      for (const current of actors.values()) current.dispose();
      websocketServer.close();
    },
  };
}
