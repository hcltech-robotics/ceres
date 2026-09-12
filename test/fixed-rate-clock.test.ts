import assert from "node:assert/strict";
import test from "node:test";
import { FixedRateRecorderClock } from "../src/recorder/fixed-rate-clock.js";

test("assigns samples to integer recorder slots without duplicates", () => {
  const clock = new FixedRateRecorderClock(1_000_000, 20);
  assert.deepEqual(clock.assignSample(1_001_000), { gapCount: 0, frameIndex: 0, slotTimestampUs: 1_000_000 });
  assert.equal(clock.assignSample(1_010_000), null);
  assert.deepEqual(clock.assignSample(1_052_000), { gapCount: 0, frameIndex: 1, slotTimestampUs: 1_050_000 });
});

test("accounts for missed slots as explicit gaps", () => {
  const clock = new FixedRateRecorderClock(2_000_000, 10);
  assert.deepEqual(clock.assignSample(2_305_000), { gapCount: 3, frameIndex: 3, slotTimestampUs: 2_300_000 });
  assert.equal(clock.frameIndex, 4);
  assert.equal(clock.claimExpiredGaps(2_610_000), 2);
  assert.equal(clock.frameIndex, 6);
  assert.equal(clock.claimThrough(2_850_000), 3);
  assert.equal(clock.frameIndex, 9);
});

test("resumes at the next contiguous frame without counting paused wall time", () => {
  const clock = new FixedRateRecorderClock(3_000_000, 20);
  assert.deepEqual(clock.assignSample(3_002_000), { gapCount: 0, frameIndex: 0, slotTimestampUs: 3_000_000 });

  assert.equal(clock.pause(3_020_000), true);
  assert.equal(clock.isPaused, true);
  assert.equal(clock.assignSample(8_000_000), null);
  assert.equal(clock.claimExpiredGaps(8_000_000), 0);
  assert.equal(clock.claimThrough(8_000_000), 0);
  assert.equal(clock.frameIndex, 1);

  assert.equal(clock.resume(8_000_000), true);
  assert.equal(clock.isPaused, false);
  assert.deepEqual(clock.assignSample(8_001_000), { gapCount: 0, frameIndex: 1, slotTimestampUs: 8_000_000 });
  assert.deepEqual(clock.assignSample(8_052_000), { gapCount: 0, frameIndex: 2, slotTimestampUs: 8_050_000 });
  assert.equal(clock.slotTimestampUs(0), 3_000_000);
  assert.equal(clock.frameIndex, 3);
});

test("keeps frame indices contiguous across repeated pauses", () => {
  const clock = new FixedRateRecorderClock(10_000_000, 10);
  assert.deepEqual(clock.assignSample(10_001_000), { gapCount: 0, frameIndex: 0, slotTimestampUs: 10_000_000 });
  assert.equal(clock.pause(10_040_000), true);
  assert.equal(clock.pause(10_050_000), false);
  assert.equal(clock.resume(15_000_000), true);
  assert.equal(clock.resume(15_010_000), false);
  assert.deepEqual(clock.assignSample(15_001_000), { gapCount: 0, frameIndex: 1, slotTimestampUs: 15_000_000 });
  assert.equal(clock.pause(15_020_000), true);
  assert.equal(clock.resume(25_000_000), true);
  assert.deepEqual(clock.assignSample(25_001_000), { gapCount: 0, frameIndex: 2, slotTimestampUs: 25_000_000 });
  assert.equal(clock.frameIndex, 3);
});
