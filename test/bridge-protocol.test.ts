import assert from "node:assert/strict";
import test from "node:test";
import { createPoseBuffer, writePoseHeader, decodePose, newerSequence, canSendObservation, parseMetadata } from "../shared/bridge-protocol.js";

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
