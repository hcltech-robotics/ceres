import assert from "node:assert/strict";
import test from "node:test";
import { createPoseBuffer, writePoseHeader, decodePose, newerSequence, canSendObservation, parseMetadata, XR_HAND_JOINTS } from "../shared/bridge-protocol.js";

test("Bridge packets preserve clock domains and fixed little-endian layout", () => {
  const buffer = createPoseBuffer(1);
  const view = writePoseHeader(buffer, { kind: 1, valid: true, epoch: 15, spaceEpoch: 9, sequence: 0xffffffff, observedUs: 123456789, targetUs: 123467899 });
  view.setFloat32(40, 1.25, true);
  view.setFloat32(64, 1, true);
  const pose = decodePose(buffer);
  assert.equal(buffer.byteLength, 68);
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), "CBR1");
  assert.equal(pose.values[0], 1.25);
  assert.equal(pose.sequence, 0xffffffff);
  assert.equal(pose.targetUs - pose.observedUs, 11110);
});

test("Bridge hand validity rejects malformed masks and invalid transforms", () => {
  const buffer = createPoseBuffer(2);
  const view = writePoseHeader(buffer, { kind: 2, valid: true, epoch: 1, spaceEpoch: 1, sequence: 1, observedUs: 1, targetUs: 2 }, 1);
  view.setFloat32(44 + 6 * 4, 1, true);
  assert.equal(decodePose(buffer).jointMask, 1);
  view.setFloat32(44, Number.NaN, true);
  assert.throws(() => decodePose(buffer), /Non-finite/);
  view.setUint32(40, 0x80000000, true);
  assert.throws(() => decodePose(buffer), /validity/);
});

test("Bridge rejects incompatible and truncated packets and application control metadata", () => {
  const buffer = createPoseBuffer(1);
  writePoseHeader(buffer, { kind: 1, valid: false, epoch: 1, spaceEpoch: 0, sequence: 1, observedUs: 0, targetUs: 0 });
  assert.equal(decodePose(buffer).valid, false);
  new DataView(buffer).setFloat32(40, Number.NaN, true);
  assert.throws(() => decodePose(buffer), /Non-finite/);
  new DataView(buffer).setFloat32(40, 1, true);
  assert.throws(() => decodePose(buffer), /must be zero/);
  new DataView(buffer).setFloat32(40, 0, true);
  assert.throws(() => decodePose(buffer.slice(0, 67)), /envelope/);
  new DataView(buffer).setUint8(4, 2);
  assert.throws(() => decodePose(buffer), /envelope/);
  assert.throws(() => parseMetadata(JSON.stringify({ version: 1, epoch: 1, type: "start-recording" })), /description/);
});

test("Bridge sequence comparison wraps and sender admission never queues an old observation", () => {
  assert.ok(newerSequence(0, 0xffffffff));
  assert.ok(!newerSequence(0xffffffff, 0));
  assert.ok(!newerSequence(10, 10));
  assert.ok(!newerSequence(0x80000000, 0));
  assert.ok(canSendObservation({ readyState: "open", bufferedAmount: 292 }));
  assert.ok(!canSendObservation({ readyState: "open", bufferedAmount: 293 }));
  assert.ok(!canSendObservation({ readyState: "closed", bufferedAmount: 0 }));
});

function description() {
  const camera = { side: "right", width: 1280, height: 960, requestedWidth: 640, fps: 30, calibration: null };
  return {
    type: "description", version: 1, epoch: 1,
    clock: { id: "camera-test", units: "microseconds", domain: "sender-monotonic" },
    referenceSpace: "local-floor", axes: "right-handed-x-right-y-up-z-back", units: "metres",
    quaternion: "xyzw", joints: XR_HAND_JOINTS, camera,
    cameras: [{ ...camera, mid: "0" }, { ...camera, side: "left", mid: "1" }],
  };
}

test("Bridge camera descriptions preserve legacy primary metadata and identify both tracks", () => {
  const both = description();
  assert.deepEqual(parseMetadata(JSON.stringify(both)), both);
  const { cameras, ...single } = both;
  assert.deepEqual(parseMetadata(JSON.stringify(single)), single);
  assert.deepEqual(parseMetadata(JSON.stringify({ ...both, cameras: cameras.slice(0, 1) })), { ...both, cameras: cameras.slice(0, 1) });
});

test("Bridge rejects ambiguous or malformed camera identities", () => {
  const both = description();
  const cases = [
    null, {}, [], [...both.cameras, both.cameras[0]],
    [both.cameras[0], { ...both.cameras[1], mid: "0" }],
    [both.cameras[0], { ...both.cameras[1], side: "right" }],
    [both.cameras[0], { ...both.cameras[1], side: "unknown" }],
    [both.cameras[0], { ...both.cameras[1], mid: "" }],
    [both.cameras[0], { ...both.cameras[1], mid: "not a mid" }],
    [both.cameras[0], { ...both.cameras[1], mid: "x".repeat(65) }],
    [both.cameras[0], { ...both.cameras[1], width: 0 }],
    [both.cameras[0], { ...both.cameras[1], fps: "30" }],
    [{ ...both.cameras[0], height: 480 }, both.cameras[1]],
  ];
  for (const cameras of cases) {
    assert.throws(() => parseMetadata(JSON.stringify({ ...both, cameras })), /Bridge camera/);
  }
});
