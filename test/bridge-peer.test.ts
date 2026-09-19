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
      createDataChannel(label: string, options: RTCDataChannelInit) {
        const channel = { label, options, readyState: "open", bufferedAmount: 0, sent: [] as string[], send(value: string) { this.sent.push(value); } };
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

test("Bridge negotiates one selected camera and pauses and resumes it with audio", async t => {
  const env = environment(t);
  const selected = camera("right");
  const peer = new BridgePeer(binding, selected, "local-floor", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const audio = { kind: "audio" } as MediaStreamTrack;
  await peer.setAudioTrack(audio);
  const { pc, description } = await env.offer(peer);
  assert.equal(description.type, "description");
  if (description.type !== "description") return;
  assert.equal(description.cameras, undefined);
  assert.equal(description.camera?.side, "right");
  assert.equal(description.environment_depth?.channel, "ceres-depth-v1");
  assert.deepEqual(pc.transceivers.map((item: any) => item.sender.track), [selected.track, audio]);
  assert.equal(pc.transceivers[0].options.sendEncodings[0].scaleResolutionDownBy, 2);
  assert.equal(pc.transceivers[0].codecs[0].mimeType, "video/H264");
  await peer.setPaused(true);
  assert.deepEqual(pc.transceivers.map((item: any) => item.sender.track), [null, null]);
  await peer.setPaused(false);
  assert.deepEqual(pc.transceivers.map((item: any) => item.sender.track), [selected.track, audio]);
  await peer.setPaused(true);
  const next = await env.offer(peer);
  assert.ok(pc.closed);
  assert.deepEqual(next.pc.transceivers.map((item: any) => item.sender.track), [null, null]);
  assert.equal(next.description.type === "description" && next.description.camera?.side, "right");
  await peer.setPaused(false);
  assert.deepEqual(next.pc.transceivers.map((item: any) => item.sender.track), [selected.track, audio]);
  peer.stop();
  assert.ok(next.pc.closed);
  assert.ok(env.sockets.every(socket => socket.closed));
});

test("Bridge single-camera offers retain the original metadata shape", async t => {
  const env = environment(t);
  const peer = new BridgePeer(binding, camera("left"), "local", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const { pc, description } = await env.offer(peer);
  assert.equal(pc.transceivers.filter((item: any) => item.kind === "video").length, 1);
  assert.equal(description.type === "description" && description.camera?.side, "left");
  assert.ok(!("cameras" in description));
});

test("Bridge uses one camera metadata snapshot when measured settings change during setup", async t => {
  const env = environment(t);
  const right = camera("right");
  let reads = 0;
  right.track.getSettings = () => ({ frameRate: reads++ === 0 ? undefined : 30 });
  const peer = new BridgePeer(binding, right, "local", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const { description } = await env.offer(peer);
  assert.equal(description.type, "description");
  if (description.type !== "description") return;
  assert.equal(description.camera?.fps, 30);
  assert.equal(description.cameras, undefined);
});

test("Bridge rejects camera arrays even when passed by an old caller", () => {
  for (const cameras of [[], [camera("left")], [camera("left"), camera("right")]]) {
    assert.throws(() => new BridgePeer(binding, cameras as unknown as BridgeCamera, "local", () => {}, () => {}), /one selected camera/);
  }
});

test("Bridge depth-only offers require no camera and use a separate lossy channel", async t => {
  const env = environment(t);
  const peer = new BridgePeer(binding, null, "local-floor", () => {}, error => env.errors.push(error));
  t.after(() => peer.stop());
  const { pc, description } = await env.offer(peer);
  assert.equal(description.type, "description");
  if (description.type !== "description") return;
  assert.equal(description.camera, undefined);
  assert.equal(description.environment_depth?.channel, "ceres-depth-v1");
  assert.equal(pc.transceivers.filter((item: any) => item.kind === "video").length, 0);
  const depth = pc.channels.find((item: any) => item.label === "ceres-depth-v1");
  assert.deepEqual(depth.options, { ordered: false, maxRetransmits: 0 });
  assert.equal(peer.sendDepthStatus({ type: "depth-status", version: 1, epoch: peer.epoch,
    status: "unsupported", usage: null, source_format: null }), true);
  peer.stop();
  assert.equal(peer.depth, null);
});
