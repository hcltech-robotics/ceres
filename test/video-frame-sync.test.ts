import assert from "node:assert/strict";
import test from "node:test";
import type { SensorFrame } from "../shared/protocol.js";
import { closestSensorFrame, senderTimestampForVideoFrame } from "../src/video-frame-sync.js";

const frame = (timestampMs: number, frameIndex: number) => ({ timestampMs, frameIndex }) as SensorFrame;

test("video presentation selects the closest sensor frame", () => {
  const frames = [frame(1_000, 1), frame(1_020, 2), frame(1_040, 3)];
  assert.equal(closestSensorFrame(frames, 1_033)?.frameIndex, 3);
  assert.equal(closestSensorFrame(frames, 1_028)?.frameIndex, 2);
});

test("video presentation selection clamps to available sensor history", () => {
  const frames = [frame(1_000, 1), frame(1_020, 2)];
  assert.equal(closestSensorFrame(frames, 900)?.frameIndex, 1);
  assert.equal(closestSensorFrame(frames, 1_200)?.frameIndex, 2);
  assert.equal(closestSensorFrame([], 1_000), null);
});

test("receiver video time is mapped into the sender sensor clock", () => {
  assert.equal(senderTimestampForVideoFrame(5_000, 750), 4_250);
  assert.equal(senderTimestampForVideoFrame(5_000, -250), 5_250);
  assert.equal(senderTimestampForVideoFrame(5_000, null), 5_000);
});
