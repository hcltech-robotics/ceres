import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BridgePeer } from "../src/bridge/peer.js";
import type { BridgeCamera } from "../src/bridge/camera.js";
import { parseMetadata } from "../shared/bridge-protocol.js";

const binding = { version: 1 as const, bindingId: "b".repeat(64), deviceId: "d".repeat(64), secret: "s".repeat(64), label: "Receiver", epoch: 1 };
const camera = (side: "left" | "right", width = 1280): BridgeCamera => ({
  side, width, height: 960,
  stream: { id: side } as MediaStream,
  track: { kind: "video", id: side, readyState: "live", getSettings: () => ({ width, height: 960, frameRate: 30 }) } as MediaStreamTrack,
});

function environment(t: TestContext) {
  const peers: any[] = [], sockets: any[] = [], errors: Error[] = [];
  let epoch = 0;
  const globals = {
    location: new URL("https://ceres.test/bridge/"),
    fetch: async () => Response.json({ version: 1, epoch: ++epoch }),
    indexedDB: { open() {
      const request: any = { result: {
        close() {},
        transaction() {
          const transaction: any = { objectStore: () => ({ put: () => {
            queueMicrotask(() => transaction.oncomplete());
            return {};
          } }) };
          return transaction;
        },
      } };
      queueMicrotask(() => request.onsuccess());
      return request;
    } },
    RTCRtpSender: { getCapabilities: (kind: string) => ({ codecs: kind === "video"
      ? [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }]
      : [{ mimeType: "audio/opus" }] }) },
    RTCPeerConnection: class {
      transceivers: any[] = [];
      channels: any[] = [];
      closed = false;
      connectionState = "new";
      constructor() { peers.push(this); }
      createDataChannel(label: string) {
        const channel = { label, sent: [] as string[], send(value: string) { this.sent.push(value); } };
        this.channels.push(channel);
        return channel;
      }
      addTransceiver(track: any, options: any) {
        const transceiver = { mid: null as string | null, options, codecs: [] as any[],
          kind: typeof track === "string" ? track : track.kind,
          sender: { track: typeof track === "string" ? null : track,
            async replaceTrack(next: any) { this.track = next; } },
          setCodecPreferences(codecs: any[]) { this.codecs = codecs; },
        };
        this.transceivers.push(transceiver);
        return transceiver;
      }
      async createOffer() { return { type: "offer", sdp: "test-offer" }; }
      async setLocalDescription() {
        this.transceivers.forEach((value, index) => { value.mid = `${epoch}-${index}`; });
      }
      close() { this.closed = true; }
    },
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      sent: any[] = [];
      closed = false;
      constructor() { sockets.push(this); }
      send(value: string) { this.sent.push(JSON.parse(value)); }
      close() { this.closed = true; }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { peers, sockets, errors, async offer(peer: BridgePeer) {
    await peer.start();
    const socket = sockets.at(-1);
    socket.onmessage({ data: JSON.stringify({ type: "peer-ready", epoch: peer.epoch }) });
    for (let i = 0; i < 20 && !socket.sent.some((value: any) => value.signal?.type === "offer") && !errors.length; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(errors, []);
    assert.ok(socket.sent.some((value: any) => value.signal?.type === "offer"));
    const pc = peers.at(-1);
    const meta = pc.channels.find((value: any) => value.label === "ceres.meta.v1");
    meta.onopen();
    return { pc, description: parseMetadata(meta.sent[0]) };
  } };
}

test("Bridge negotiates independent camera tracks and pauses and resumes both with audio", async t => {
  const env = environment(t);
  const cameras = [camera("right"), camera("left", 1920)];
  const peer = new BridgePeer(binding, cameras, "local-floor", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const audio = { kind: "audio" } as MediaStreamTrack;
  await peer.setAudioTrack(audio);
  const { pc, description } = await env.offer(peer);
  assert.equal(description.type, "description");
  if (description.type !== "description") return;
  assert.deepEqual(description.cameras?.map(({ side, mid }) => ({ side, mid })), [
    { side: "right", mid: "1-0" }, { side: "left", mid: "1-1" },
  ]);
  assert.equal(description.camera.side, "right");
  assert.deepEqual(pc.transceivers.map((item: any) => item.sender.track), [...cameras.map(item => item.track), audio]);
  assert.deepEqual(pc.transceivers.slice(0, 2).map((item: any) => item.options.sendEncodings[0].scaleResolutionDownBy), [2, 3]);
  assert.ok(pc.transceivers.slice(0, 2).every((item: any) => item.codecs[0].mimeType === "video/H264"));
  await peer.setPaused(true);
  assert.deepEqual(pc.transceivers.map((item: any) => item.sender.track), [null, null, null]);
  await peer.setPaused(false);
  assert.deepEqual(pc.transceivers.map((item: any) => item.sender.track), [...cameras.map(item => item.track), audio]);
  await peer.setPaused(true);
  const next = await env.offer(peer);
  assert.ok(pc.closed);
  assert.deepEqual(next.pc.transceivers.map((item: any) => item.sender.track), [null, null, null]);
  assert.equal(next.description.type === "description" && next.description.cameras?.[1].mid, "2-1");
  await peer.setPaused(false);
  assert.deepEqual(next.pc.transceivers.map((item: any) => item.sender.track), [...cameras.map(item => item.track), audio]);
  peer.stop();
  assert.ok(next.pc.closed);
  assert.ok(env.sockets.every(socket => socket.closed));
});

test("Bridge single-camera offers retain the original metadata shape", async t => {
  const env = environment(t);
  const peer = new BridgePeer(binding, [camera("left")], "local", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const { pc, description } = await env.offer(peer);
  assert.equal(pc.transceivers.filter((item: any) => item.kind === "video").length, 1);
  assert.equal(description.type === "description" && description.camera.side, "left");
  assert.ok(!("cameras" in description));
});

test("Bridge uses one camera metadata snapshot when measured settings change during setup", async t => {
  const env = environment(t);
  const right = camera("right");
  let reads = 0;
  right.track.getSettings = () => ({ frameRate: reads++ === 0 ? undefined : 30 });
  const peer = new BridgePeer(binding, [right, camera("left")], "local", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const { description } = await env.offer(peer);
  assert.equal(description.type, "description");
  if (description.type !== "description") return;
  assert.equal(description.camera.fps, 30);
  assert.equal(description.cameras?.[0].fps, 30);
});

test("Bridge rejects camera sets without distinct identities", () => {
  for (const cameras of [[], [camera("left"), camera("left")], [camera("left"), camera("right"), camera("left")]]) {
    assert.throws(() => new BridgePeer(binding, cameras, "local", () => {}, () => {}), /camera/);
  }
});
