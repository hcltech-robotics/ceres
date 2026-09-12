import type { SensorFrame } from "../shared/protocol.js";

export function closestSensorFrame(frames: readonly SensorFrame[], timestampMs: number): SensorFrame | null {
  if (!frames.length || !Number.isFinite(timestampMs)) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].timestampMs < timestampMs) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return frames[0];
  const before = frames[low - 1];
  const after = frames[low];
  return timestampMs - before.timestampMs <= after.timestampMs - timestampMs ? before : after;
}

export function senderTimestampForVideoFrame(receiverCaptureTimestampMs: number, sensorClockOffsetMs: number | null) {
  return receiverCaptureTimestampMs - (sensorClockOffsetMs ?? 0);
}
