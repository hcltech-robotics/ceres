import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEPTH_FEATURE, DEPTH_FRAGMENT_PAYLOAD_BYTES, DEPTH_MAX_FRAME_BYTES,
  encodeDepthFrame, fragmentDepthFrame, validateDepthHeader, type DepthHeader,
} from "../shared/bridge-depth.js";
import { decodePose, parseMetadata } from "../shared/bridge-protocol.js";
import { BridgeDepth, copyCpuDepth, depthDimensions, depthGeometry, type DepthImage, type DepthPeer } from "../src/bridge/depth.js";
import { BridgeSender } from "../src/bridge/sender.js";
import { XR_HAND_JOINTS } from "../shared/xr-hand-joints.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const view = { eye: "left", transform: { matrix: identity }, projectionMatrix: identity } as unknown as XRView;
const header = (width = 2, height = 2): DepthHeader => ({
  version: 1, epoch: 3, space_epoch: 7, sequence: 11, observed_us: 123456, target_us: 134567,
  width, height, source_width: width, source_height: height, eye: "left", usage: "cpu-optimized", source_format: "float32",
  depth_format: "uint16-mm", world_from_view: identity, projection: identity, norm_depth_from_norm_view: identity,
});
function image(values = [0, 1, 2, 3]): DepthImage {
  return { width: 2, height: 2, rawValueToMeters: 1, data: new Float32Array(values).buffer,
    normDepthBufferFromNormView: { matrix: identity } };
}
function fixture(mode: "cpu-optimized" | "gpu-optimized" | null = "cpu-optimized") {
  let depthImage: DepthImage | null = image();
  let acquired = 0, resume = 0, pause = 0;
  const session = { depthUsage: mode, depthDataFormat: "float32", depthActive: true,
    pauseDepthSensing() { pause++; this.depthActive = false; },
    resumeDepthSensing() { resume++; this.depthActive = true; } } as unknown as XRSession;
  const frame = { session, getViewerPose: () => ({ views: [view] }),
    getDepthInformation: () => { acquired++; return depthImage; } } as unknown as XRFrame;
  const packets: Uint8Array[] = [], statuses: any[] = [];
  const channel = { readyState: "open", bufferedAmount: 0, send: (bytes: Uint8Array) => packets.push(bytes) };
  const peer = { epoch: 1, depthMetadataVersion: 2, depth: channel, sendDepthStatus: (status: unknown) => { statuses.push(status); return true; } } as unknown as DepthPeer;
  const space = {} as XRReferenceSpace;
  return { session, frame, channel, peer, packets, statuses, space,
    set image(next: DepthImage | null) { depthImage = next; }, get acquired() { return acquired; },
    get resume() { return resume; }, get pause() { return pause; } };
}
function decodeSingle(packet: Uint8Array) {
  const body = packet.subarray(24);
  const length = new DataView(body.buffer, body.byteOffset).getUint32(4, true);
  return { header: JSON.parse(new TextDecoder().decode(body.subarray(8, 8 + length))),
    pixels: Array.from(new Uint16Array(body.slice(8 + length).buffer)) };
}

test("Depth quantisation preserves invalids, integer formats and millimetre boundaries", () => {
  const d = image([0, -1, NaN, Infinity]);
  assert.deepEqual([...copyCpuDepth(d, "float32", 2, 2)], [0, 0, 0, 0]);
  d.data = new Float32Array([1.125, .25, 65.536, 2]).buffer;
  assert.deepEqual([...copyCpuDepth(d, "float32", 2, 2)], [1125, 250, 0, 2000]);
  d.rawValueToMeters = .001;
  d.data = new Uint16Array([0, 1, 256, 65535]).buffer;
  for (const format of ["luminance-alpha", "unsigned-short"] as const) assert.deepEqual([...copyCpuDepth(d, format, 2, 2)], [0, 1, 256, 65535]);
  d.data = new ArrayBuffer(1);
  assert.throws(() => copyCpuDepth(d, "unsigned-short", 2, 2), /size/);
});
test("Depth downsampling preserves aspect and source buffer orientation", () => {
  assert.deepEqual(depthDimensions(1024, 768), { width: 256, height: 192 });
  assert.deepEqual(depthDimensions(192, 256), { width: 192, height: 256 });
  assert.throws(() => depthDimensions(0, 480));
  const d = { ...image(), width: 4, height: 4, data: new Float32Array(Array.from({ length: 16 }, (_, i) => i + 1)).buffer };
  assert.deepEqual([...copyCpuDepth(d, "float32", 2, 2)], [6000, 8000, 14000, 16000]);
});
test("Depth uses source geometry when supplied and copies frame-owned matrices", () => {
  const transform = [...identity]; transform[12] = .25;
  const d = { ...image(), transform: { matrix: transform }, projectionMatrix: identity };
  const result = depthGeometry(d, view);
  assert.equal(result.world_from_view[12], .25);
  assert.equal(result.geometry_source, "sensor");
  transform[12] = 4;
  assert.equal(result.world_from_view[12], .25);
  assert.equal(depthGeometry(image(), view).world_from_view[12], 0);
  assert.equal(depthGeometry(image(), view).geometry_source, "view-fallback");
  assert.equal(depthGeometry({ ...image(), view: d }, view).geometry_source, "view");
});
test("Depth preserves the source view-to-buffer mapping including reflection and crop", () => {
  // WebXR Depth Sensing 1.1 and 3.3 define N as the complete transform from
  // top-left view coordinates to the returned texture, including its row origin.
  // https://immersive-web.github.io/depth-sensing/#xrdepthinformation
  for (const reflected of [false, true]) {
    const norm = [...identity];
    norm[0] = .8;
    norm[5] = reflected ? -.6 : .6;
    norm[12] = .1;
    norm[13] = reflected ? .85 : .15;
    const d = { ...image(), depthNear: .1, depthFar: Infinity,
      normDepthBufferFromNormView: { matrix: norm } };
    const copied = depthGeometry(d, view).norm_depth_from_norm_view;
    assert.deepEqual(copied, norm);
    // At view (0.25, 0.75), sample exactly N * view, without a second flip.
    assert.ok(Math.abs(copied[0]! * .25 + copied[12]! - .3) < 1e-12);
    assert.ok(Math.abs(copied[5]! * .75 + copied[13]! - (reflected ? .4 : .6)) < 1e-12);
    norm[5] = 99;
    assert.equal(copied[5], reflected ? -.6 : .6, "frame-owned matrix is copied");
  }
});
test("CED1 fragments have bounded complete lengths and exact little-endian identities", () => {
  const h = header(256, 256);
  const values = new Uint16Array(256 * 256).fill(1234);
  const frame = encodeDepthFrame(h, values);
  assert.ok(frame.length <= DEPTH_MAX_FRAME_BYTES);
  const fragments = fragmentDepthFrame(frame, h);
  assert.ok(fragments.length > 1);
  const rebuilt = new Uint8Array(frame.length);
  fragments.forEach((fragment, i) => {
    assert.ok(fragment.length <= 16384);
    const v = new DataView(fragment.buffer);
    assert.equal(v.getUint32(4, true), h.epoch);
    assert.equal(v.getUint32(8, true), h.space_epoch);
    assert.equal(v.getUint32(12, true), h.sequence);
    assert.equal(v.getUint16(16, true), i);
    assert.equal(v.getUint16(18, true), fragments.length);
    assert.equal(v.getUint32(20, true), frame.length);
    rebuilt.set(fragment.subarray(24), i * DEPTH_FRAGMENT_PAYLOAD_BYTES);
  });
  assert.deepEqual(rebuilt, frame);
  assert.throws(() => encodeDepthFrame({ ...h, width: 257 }, values));
  assert.throws(() => validateDepthHeader({ ...h, projection: [...identity.slice(0, 15), Infinity] }));
  assert.throws(() => encodeDepthFrame(h, values.subarray(1)));
});
test("Meta GPU framebuffer normalisation composes the full output coordinate transform", () => {
  const norm = [.1, .7, 0, .02, -.6, .2, 0, -.03, .04, -.08, 1, .01, .8, .1, 0, 1];
  const expected = [.1, -.68, 0, .02, -.6, -.23, 0, -.03, .04, .09, 1, .01, .8, .9, 0, 1];
  const d = { ...image(), depthNear: .1, depthFar: Infinity, normDepthBufferFromNormView: { matrix: norm } };
  const actual = depthGeometry(d, view, "gpu-optimized", "unsigned-short").norm_depth_from_norm_view;
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
  assert.deepEqual(depthGeometry(d, view, "cpu-optimized", "float32").norm_depth_from_norm_view, norm);
  assert.deepEqual(depthGeometry({ ...d, depthNear: undefined }, view, "gpu-optimized", "float32").norm_depth_from_norm_view, norm);
  assert.deepEqual(d.normDepthBufferFromNormView.matrix, norm, "original API matrix remains untouched");
});
test("Optional depth provenance and timings validate strictly while old CED1 remains valid", () => {
  const old = header();
  assert.doesNotThrow(() => validateDepthHeader(old));
  for (const geometry_source of ["sensor", "view", "view-fallback"] as const) {
    const next = { ...old, mapping_version: 2 as const, geometry_source, readback_us: 16000, target_lead_us: old.target_us - old.observed_us };
    assert.doesNotThrow(() => validateDepthHeader(next));
    const status = { type: "depth-status", version: 1, epoch: 1, status: "streaming", usage: old.usage,
      source_format: old.source_format, mapping_version: 2, geometry_source, readback_us: 16000, target_lead_us: -5000 };
    assert.equal(parseMetadata(JSON.stringify(status)).type, "depth-status");
    for (const invalid of [{ mapping_version: 1 }, { mapping_version: "2" }, { mapping_version: null },
      { geometry_source: "unknown" }, { geometry_source: null }, { readback_us: -1 },
      { readback_us: .5 }, { readback_us: "16000" }, { readback_us: Number.MAX_SAFE_INTEGER + 1 },
      { target_lead_us: .5 }, { target_lead_us: null }, { target_lead_us: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.throws(() => validateDepthHeader({ ...next, ...invalid } as DepthHeader));
      assert.throws(() => parseMetadata(JSON.stringify({ ...status, ...invalid })));
    }
    assert.throws(() => validateDepthHeader({ ...next, target_lead_us: 0 }));
  }
  assert.doesNotThrow(() => validateDepthHeader({ ...old, target_us: 100000, target_lead_us: 100000 - old.observed_us }));
});
test("Depth retains the 17-field envelope without a negotiated metadata version", () => {
  for (const version of [undefined, 1, 3, "2"] as const) {
    const f = fixture(), depth = new BridgeDepth();
    (f.peer as any).depthMetadataVersion = version;
    depth.start(f.session);
    depth.publish(f.frame, f.space, 110, f.peer, 3, false, 100);
    const h = decodeSingle(f.packets[0]).header;
    assert.equal(Object.keys(h).length, 17);
    assert.equal(h.mapping_version, undefined);
    assert.equal(h.geometry_source, undefined);
    assert.equal(h.readback_us, undefined);
    assert.equal(h.target_lead_us, undefined);
    assert.equal(f.statuses.at(-1).mapping_version, 2);
    assert.equal(f.statuses.at(-1).geometry_source, "view-fallback");
    depth.stop();
  }
});
test("CPU depth reports measured copy time and pose target lead", t => {
  const clock = [1, 1.25];
  t.mock.method(performance, "now", () => clock.shift()!);
  const f = fixture(), depth = new BridgeDepth();
  depth.start(f.session);
  depth.publish(f.frame, f.space, 110, f.peer, 3, false, 100);
  const h = decodeSingle(f.packets[0]).header;
  assert.equal(h.readback_us, 250);
  assert.equal(h.target_lead_us, 10000);
  assert.equal(h.geometry_source, "view-fallback");
  assert.equal(f.statuses.at(-1).readback_us, h.readback_us);
  assert.equal(f.statuses.at(-1).target_lead_us, h.target_lead_us);
  assert.equal(f.statuses.at(-1).geometry_source, h.geometry_source);
  depth.stop();
});
test("Depth CPU capture is 2 Hz with no catch-up bursts and sends original monotonic frame time", () => {
  const f = fixture(), depth = new BridgeDepth();
  depth.start(f.session);
  depth.publish(f.frame, f.space, 110, f.peer, 3, false, 100);
  assert.equal(f.packets.length, 1);
  const first = decodeSingle(f.packets[0]);
  assert.equal(first.header.observed_us, 100000);
  assert.equal(first.header.target_us, 110000);
  assert.equal(first.header.space_epoch, 3);
  assert.deepEqual(first.pixels, [0, 1000, 2000, 3000]);
  depth.publish(f.frame, f.space, 210, f.peer, 3, false, 200);
  assert.equal(f.acquired, 1);
  depth.publish(f.frame, f.space, 2010, f.peer, 3, false, 2000);
  depth.publish(f.frame, f.space, 2020, f.peer, 3, false, 2010);
  assert.equal(f.acquired, 2);
  depth.stop();
});
test("Depth and pose publication share the sender-monotonic clock", t => {
  t.mock.method(performance, "now", () => 1234.567);
  const f = fixture(), sender = new BridgeSender(), poses: ArrayBuffer[] = [];
  const pose = { views: [view], transform: {
    position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
  } } as unknown as XRViewerPose;
  (f.session as any).inputSources = [];
  t.mock.method(f.frame, "getViewerPose", () => pose);
  (sender as any).peer = { ...f.peer, pose: {
    readyState: "open", bufferedAmount: 0, send: (buffer: ArrayBuffer) => poses.push(buffer.slice(0)),
  } };
  sender.depth.start(f.session);
  sender.publish(f.frame, f.space, 1245.678);
  sender.publishDepth(f.frame, f.space, 1245.678);
  const head = decodePose(poses[0]), depth = decodeSingle(f.packets[0]).header;
  assert.equal(head.observedUs, 1234567);
  assert.equal(depth.observed_us, head.observedUs);
  assert.equal(depth.target_us, head.targetUs);
  assert.equal(depth.target_us, 1245678);
  sender.depth.stop();
});

test("Large depth frames send one fragment per XR callback and yield to queued hand poses", () => {
  const f = fixture(), depth = new BridgeDepth();
  f.image = { ...image(), width: 256, height: 256, data: new Float32Array(256 * 256).fill(1).buffer };
  const pose = { bufferedAmount: 1756 };
  f.peer.pose = pose;
  depth.start(f.session);
  const publish = (now: number) => depth.publish(f.frame, f.space, now + 5, f.peer, 0, false, now);
  publish(0);
  assert.equal(f.packets.length, 1, "no burst of an entire depth frame");
  const count = new DataView(f.packets[0].buffer).getUint16(18, true);
  assert.ok(count > 2);
  pose.bufferedAmount = 2000;
  publish(12);
  assert.equal(f.packets.length, 1, "pending poses take priority");
  pose.bufferedAmount = 1756;
  for (let i = 1; i < count; i++) {
    publish(12 + i * 12);
    assert.equal(f.packets.length, i + 1);
  }
  assert.equal(f.acquired, 1);
  depth.stop();
});

test("An old queued hand blocks both new depth capture and remaining fragments", t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture(), sender = new BridgeSender();
  f.image = { ...image(), width: 256, height: 256, data: new Float32Array(256 * 256).fill(1).buffer };
  (f.session as any).inputSources = [];
  t.mock.method(f.frame, "getViewerPose", () => ({ views: [view], transform: {
    position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
  } }) as unknown as XRViewerPose);
  const pose = { readyState: "open", bufferedAmount: 844, sent: 0,
    send(buffer: ArrayBuffer) { this.sent++; this.bufferedAmount += buffer.byteLength; },
  };
  (sender as any).peer = { ...f.peer, pose };
  sender.depth.start(f.session);
  const publish = () => {
    sender.publish(f.frame, f.space, now + 5);
    sender.publishDepth(f.frame, f.space, now + 5);
    now += 12;
  };
  publish();
  assert.equal(pose.sent, 0, "844 old queued bytes block the current complete pose");
  assert.equal(f.acquired, 0, "optional depth acquisition does not run ahead of current hands");
  assert.equal(f.packets.length, 0);
  pose.bufferedAmount = 0;
  publish();
  assert.equal(pose.sent, 3);
  assert.equal(pose.bufferedAmount, 1756);
  assert.equal(f.packets.length, 1, "a successfully queued fresh pose permits one depth fragment");
  pose.bufferedAmount = 844;
  publish();
  assert.equal(f.packets.length, 1, "an old hand also blocks the remainder of a partial depth frame");
  pose.bufferedAmount = 0;
  publish();
  assert.equal(f.packets.length, 2, "fragment pacing resumes after the current hands publish");
  sender.depth.stop();
});

test("Depth abandons obsolete partial frames and pauses transmission under video congestion", () => {
  const f = fixture(), depth = new BridgeDepth();
  f.image = { ...image(), width: 256, height: 256, data: new Float32Array(256 * 256).fill(1).buffer };
  depth.start(f.session);
  const publish = (now: number, paused = false) => depth.publish(f.frame, f.space, now + 5, f.peer, 0, paused, now);
  publish(0);
  publish(251);
  assert.equal(f.packets.length, 1, "expired fragments do not reach the network");
  publish(500);
  assert.equal(f.packets.length, 2);
  f.peer.depthThrottled = true;
  publish(512);
  publish(1000);
  assert.equal(f.packets.length, 2);
  f.peer.depthThrottled = false;
  publish(1012);
  const packet = new DataView(f.packets.at(-1)!.buffer);
  assert.equal(packet.getUint16(16, true), 0, "recovery starts a fresh independently decodable frame");
  publish(1024, true);
  assert.equal(f.packets.length, 3);
  depth.stop();
});
test("Depth backpressure, paused capture and null views leave pose/video independent", () => {
  const f = fixture(), depth = new BridgeDepth();
  depth.start(f.session);
  f.channel.bufferedAmount = 1;
  depth.publish(f.frame, f.space, 1, f.peer, 0, false, 0);
  assert.equal(f.acquired, 0);
  f.channel.bufferedAmount = 0;
  depth.publish(f.frame, f.space, 1, f.peer, 0, true, 0);
  assert.equal(f.acquired, 0);
  assert.equal(f.statuses.at(-1).status, "paused");
  f.image = null;
  depth.publish(f.frame, f.space, 2, f.peer, 0, false, 1);
  assert.equal(f.packets.length, 0);
  assert.equal(f.statuses.at(-1).status, "waiting");
  f.image = image();
  depth.publish(f.frame, f.space, 1002, f.peer, 0, false, 1001);
  assert.equal(f.packets.length, 1);
  depth.stop();
});
test("Receiver demand pauses the depth sensor and CPU acquisition until explicitly enabled", () => {
  const f = fixture(), depth = new BridgeDepth();
  depth.start(f.session);
  f.peer.depthEnabled = false;
  depth.publish(f.frame, f.space, 5, f.peer, 0, false, 0);
  depth.publish(f.frame, f.space, 505, f.peer, 0, false, 500);
  assert.equal(f.pause, 1);
  assert.equal(f.resume, 0);
  assert.equal(f.acquired, 0);
  assert.equal(f.packets.length, 0);
  assert.equal(f.statuses.at(-1).status, "paused");
  f.peer.epoch++;
  depth.publish(f.frame, f.space, 521, f.peer, 1, false, 516);
  assert.equal(f.acquired, 0, "epoch changes cannot override disabled demand");
  f.peer.depthEnabled = true;
  depth.publish(f.frame, f.space, 537, f.peer, 1, false, 532);
  assert.equal(f.resume, 1);
  assert.equal(f.acquired, 1);
  assert.equal(f.packets.length, 1);
  f.peer.depthEnabled = false;
  depth.publish(f.frame, f.space, 553, f.peer, 1, false, 548);
  assert.equal(f.pause, 2);
  f.peer.depthEnabled = true;
  depth.publish(f.frame, f.space, 569, f.peer, 1, true, 564);
  assert.equal(f.acquired, 1, "receiver demand cannot override the headset pause");
  depth.publish(f.frame, f.space, 585, f.peer, 1, false, 580);
  assert.equal(f.resume, 2);
  assert.equal(f.packets.length, 2);
  depth.stop();
});

test("Disabled depth skips acquisition on runtimes without sensor pause support", () => {
  const f = fixture(), depth = new BridgeDepth();
  delete (f.session as any).pauseDepthSensing;
  delete (f.session as any).resumeDepthSensing;
  depth.start(f.session);
  f.peer.depthEnabled = false;
  depth.publish(f.frame, f.space, 5, f.peer, 0, false, 0);
  assert.equal(f.acquired, 0);
  assert.equal(f.packets.length, 0);
  f.peer.depthEnabled = true;
  depth.publish(f.frame, f.space, 21, f.peer, 0, false, 16);
  assert.equal(f.packets.length, 1);
  depth.stop();
});

test("Depth reports granted mode, gracefully rejects unsupported sessions and resumes inactive depth", () => {
  const missing = fixture(null), depth = new BridgeDepth();
  depth.start(missing.session);
  depth.publish(missing.frame, missing.space, 1, missing.peer, 0, false, 0);
  assert.equal(missing.statuses[0].status, "unsupported");
  assert.equal(missing.acquired, 0);
  const f = fixture();
  (f.session as any).depthActive = false;
  depth.start(f.session);
  depth.publish(f.frame, f.space, 1, f.peer, 0, false, 0);
  assert.equal(f.resume, 1);
  assert.equal(f.packets.length, 1);
  assert.equal(f.statuses.at(-1).usage, "cpu-optimized");
  assert.equal(f.statuses.at(-1).source_format, "float32");
  depth.stop();
});
test("Depth does not transmit a frame the runtime marks invalid", () => {
  const f = fixture(), depth = new BridgeDepth();
  depth.start(f.session);
  f.image = { ...image(), isValid: false };
  depth.publish(f.frame, f.space, 1, f.peer, 0, false, 0);
  assert.equal(f.packets.length, 0);
  assert.equal(f.statuses.at(-1).status, "waiting");
  f.image = { ...image(), isValid: true };
  depth.publish(f.frame, f.space, 501, f.peer, 0, false, 500);
  assert.equal(f.packets.length, 1);
  assert.equal(f.statuses.at(-1).status, "streaming");
  depth.stop();
});
test("Depth GPU lease cancels on reset, reconnect, age, pause and stop", () => {
  const f = fixture("gpu-optimized");
  (f.session as any).depthDataFormat = "unsigned-short";
  let pending = false, completed = false, cancelled = 0, disposed = 0;
  const gpu = { get busy() { return pending; }, capture() { pending = true; return true; },
    poll() { if (!completed) return null; pending = false; return new Uint16Array([1, 2, 3, 4]); },
    cancel() { pending = false; cancelled++; }, dispose() { disposed++; } };
  const depth = new BridgeDepth(() => gpu);
  const renderer = { getContext: () => ({} as WebGL2RenderingContext), xr: { getBinding: () => ({ getDepthInformation: () => ({ ...image(),
    texture: {}, textureType: "texture-array" as const, imageIndex: 0, depthNear: .1, depthFar: Infinity, isValid: true }) }) } };
  depth.start(f.session, renderer);
  const publish = (now: number, space = 0, paused = false) => depth.publish(f.frame, f.space, now + 5, f.peer, space, paused, now);
  publish(0); assert.ok(pending); assert.equal(f.packets.length, 0);
  completed = true; publish(16); assert.equal(f.packets.length, 1);
  assert.equal(decodeSingle(f.packets[0]).header.observed_us, 0);
  assert.equal(decodeSingle(f.packets[0]).header.target_us, 5000);
  assert.equal(decodeSingle(f.packets[0]).header.source_format, "unsigned-short");
  assert.equal(Object.keys(decodeSingle(f.packets[0]).header).length, 21);
  assert.equal(decodeSingle(f.packets[0]).header.readback_us, 16000);
  assert.equal(decodeSingle(f.packets[0]).header.target_lead_us, 5000);
  assert.equal(f.statuses.at(-1).source_encoding, "perspective");
  assert.equal(f.statuses.at(-1).raw_value_to_metres, 1);
  assert.equal(f.statuses.at(-1).depth_near, .1);
  assert.equal(f.statuses.at(-1).depth_far, "infinity");
  assert.equal(f.statuses.at(-1).texture_type, "texture-array");
  assert.equal(f.statuses.at(-1).image_index, 0);
  completed = false; publish(500); assert.ok(pending);
  publish(800); assert.ok(!pending); assert.equal(f.packets.length, 1);
  publish(1000); f.peer.epoch = 2; publish(1016); assert.ok(cancelled > 0);
  completed = true; publish(1032); assert.equal(decodeSingle(f.packets.at(-1)!).header.epoch, 2);
  completed = false; publish(1516); publish(1520, 1); completed = true; publish(1536, 1);
  assert.equal(decodeSingle(f.packets.at(-1)!).header.space_epoch, 1);
  publish(2020, 1); publish(2030, 1, true); assert.ok(!pending);
  depth.stop(); assert.equal(disposed, 1);
});
test("Receiver demand cancels pending GPU depth without polling or transmitting its readback", () => {
  const f = fixture("gpu-optimized");
  let captured = 0, polled = 0, cancelled = 0, acquired = 0;
  const gpu = { busy: false, capture() { captured++; return true; },
    poll() { polled++; return new Uint16Array([1, 2, 3, 4]); }, cancel() { cancelled++; }, dispose() {} };
  const depth = new BridgeDepth(() => gpu);
  depth.start(f.session, { getContext: () => ({} as WebGL2RenderingContext), xr: {
    getBinding: () => ({ getDepthInformation: () => {
      acquired++;
      return { ...image(), texture: {}, textureType: "texture" as const };
    } }) } });
  depth.publish(f.frame, f.space, 5, f.peer, 0, false, 0);
  assert.equal(captured, 1);
  const before = cancelled;
  f.peer.depthEnabled = false;
  depth.publish(f.frame, f.space, 21, f.peer, 0, false, 16);
  depth.publish(f.frame, f.space, 505, f.peer, 0, false, 500);
  assert.ok(cancelled > before);
  assert.equal(polled, 0);
  assert.equal(acquired, 1);
  assert.equal(captured, 1);
  assert.equal(f.packets.length, 0);
  assert.equal(f.pause, 1);
  f.peer.depthEnabled = true;
  depth.publish(f.frame, f.space, 521, f.peer, 0, false, 516);
  assert.equal(captured, 2);
  depth.publish(f.frame, f.space, 537, f.peer, 0, false, 532);
  assert.equal(f.resume, 1);
  assert.equal(polled, 1);
  assert.equal(f.packets.length, 1);
  assert.equal(decodeSingle(f.packets[0]).header.observed_us, 516000);
  depth.stop();
});

test("Delayed GPU depth preserves the capture pose, provenance and times while the camera moves", () => {
  for (const source of ["sensor", "view", "view-fallback"] as const) {
    const f = fixture("gpu-optimized");
    let ready = false;
    const gpu = { busy: false, capture: () => true, poll: () => ready ? new Uint16Array([1000, 2000, 3000, 4000]) : null,
      cancel() {}, dispose() {} };
    const captureWorld = [...identity]; captureWorld[12] = .25;
    const captureProjection = [...identity]; captureProjection[0] = 2;
    const captureNorm = [...identity]; captureNorm[5] = -.8;
    const geometry = { transform: { matrix: [...captureWorld] }, projectionMatrix: [...captureProjection] };
    const captureView = { eye: "left", ...geometry } as unknown as XRView;
    let sourceImage: DepthImage = { ...image(), texture: {}, textureType: "texture",
      normDepthBufferFromNormView: { matrix: [...captureNorm] },
      ...(source === "sensor" ? geometry : source === "view" ? { view: geometry } : {}) };
    const frame = { session: f.session, getViewerPose: () => ({ views: [captureView] }) } as unknown as XRFrame;
    const depth = new BridgeDepth(() => gpu);
    depth.start(f.session, { getContext: () => ({} as WebGL2RenderingContext), xr: {
      getBinding: () => ({ getDepthInformation: () => sourceImage }) } });
    depth.publish(frame, f.space, 111, f.peer, 1, false, 100);
    geometry.transform.matrix[12] = 3;
    geometry.projectionMatrix[0] = 4;
    (sourceImage.normDepthBufferFromNormView.matrix as number[])[5] = .3;
    sourceImage = { ...image(), texture: {}, textureType: "texture" };
    depth.publish(frame, f.space, 127, f.peer, 1, false, 116);
    assert.equal(f.packets.length, 0);
    ready = true;
    depth.publish(frame, f.space, 143, f.peer, 1, false, 132);
    const h = decodeSingle(f.packets[0]).header;
    assert.deepEqual(h.world_from_view, captureWorld);
    assert.deepEqual(h.projection, captureProjection);
    assert.deepEqual(h.norm_depth_from_norm_view, captureNorm);
    assert.equal(h.geometry_source, source);
    assert.equal(h.observed_us, 100000);
    assert.equal(h.target_us, 111000);
    assert.equal(h.readback_us, 32000);
    assert.equal(h.target_lead_us, 11000);
    assert.equal(f.statuses.at(-1).geometry_source, source);
    assert.equal(f.statuses.at(-1).readback_us, 32000);
    depth.stop();
  }
});
test("GPU failures report bounded source diagnostics without emitting stale depth", () => {
  const f = fixture("gpu-optimized");
  (f.session as any).depthDataFormat = "unsigned-short";
  let failing = true;
  const gpu = { busy: false, capture() {
    if (failing) throw new Error(`Depth GPU sampling failed (WebGL 1282) ${"x".repeat(200)}`);
    return true;
  }, poll: () => new Uint16Array([1000, 2000, 3000, 4000]), cancel() {}, dispose() {} };
  const depth = new BridgeDepth(() => gpu);
  const renderer = { getContext: () => ({} as WebGL2RenderingContext), xr: { getBinding: () => ({
    getDepthInformation: () => ({ ...image(), texture: {}, textureType: "texture-array" as const, imageIndex: 0, isValid: true }),
  }) } };
  depth.start(f.session, renderer);
  depth.publish(f.frame, f.space, 5, f.peer, 0, false, 0);
  assert.equal(f.packets.length, 0);
  const failure = f.statuses.at(-1);
  assert.equal(failure.status, "error");
  assert.equal(failure.error.length, 160);
  assert.match(failure.error, /WebGL 1282/);
  assert.equal(failure.source_encoding, "linear");
  assert.equal(failure.source_format, "unsigned-short");
  assert.equal(failure.texture_type, "texture-array");
  assert.equal(failure.image_index, 0);
  assert.equal(failure.depth_near, undefined);
  assert.equal(failure.depth_far, undefined);
  assert.equal(parseMetadata(JSON.stringify(failure)).type, "depth-status");
  assert.ok(JSON.stringify(failure).length < 512);
  depth.publish(f.frame, f.space, 21, f.peer, 0, false, 16);
  assert.equal(f.statuses.length, 1);
  failing = false;
  depth.publish(f.frame, f.space, 505, f.peer, 0, false, 500);
  depth.publish(f.frame, f.space, 521, f.peer, 0, false, 516);
  assert.equal(f.packets.length, 1);
  assert.equal(f.statuses.at(-1).status, "streaming");
  assert.equal(f.statuses.at(-1).error, undefined);
  assert.equal(Object.keys(decodeSingle(f.packets[0]).header).length, 21);
  depth.stop();
});
test("Depth-only metadata is optional and malformed capability/status is rejected", () => {
  const description = { type: "description", version: 1, epoch: 1, axes: "right-handed-x-right-y-up-z-back", units: "metres",
    quaternion: "xyzw", joints: XR_HAND_JOINTS, referenceSpace: "local-floor", clock: { id: "clock", units: "microseconds", domain: "sender-monotonic" }, environment_depth: DEPTH_FEATURE };
  assert.equal(parseMetadata(JSON.stringify(description)).type, "description");
  assert.throws(() => parseMetadata(JSON.stringify({ ...description, environment_depth: undefined })));
  assert.throws(() => parseMetadata(JSON.stringify({ ...description, environment_depth: { ...DEPTH_FEATURE, max_width: 1024 } })));
  assert.equal(parseMetadata(JSON.stringify({ type: "depth-status", version: 1, epoch: 1, status: "waiting", usage: "cpu-optimized", source_format: "float32" })).type, "depth-status");
  assert.throws(() => parseMetadata(JSON.stringify({ type: "depth-status", version: 1, epoch: 1, status: "working", usage: null, source_format: null })));
});
test("Pinned CED1/CDF1 fixtures reproduce byte-for-byte", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/bridge-depth-v1.json", import.meta.url), "utf8"));
  for (const example of fixtures.cases) {
    const frame = encodeDepthFrame(example.header, Uint16Array.from(example.millimetres));
    assert.equal(Buffer.from(frame).toString("base64"), example.frame_base64);
    assert.deepEqual(fragmentDepthFrame(frame, example.header).map(fragment => Buffer.from(fragment).toString("base64")), example.fragments_base64);
  }
});
