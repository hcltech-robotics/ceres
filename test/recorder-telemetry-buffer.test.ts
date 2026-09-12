import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEMETRY_VALUE_COUNT,
  decodeTelemetryFrame,
  writeXrTelemetry,
} from "../src/recorder/telemetry-buffer.js";

test("XR controllers do not populate hand telemetry", () => {
  const values = new Float64Array(TELEMETRY_VALUE_COUNT);
  const xrFrame = {
    getViewerPose: () => null,
    getJointPose: () => {
      throw new Error("Controller input must not be read as hand joints");
    },
  };
  const xrSession = {
    inputSources: [
      { handedness: "left", targetRayMode: "tracked-pointer", gamepad: {} },
      { handedness: "right", targetRayMode: "tracked-pointer", gamepad: {} },
    ],
  };

  writeXrTelemetry(values, 0, 2_000_000, xrFrame, {}, xrSession, "unknown");
  const frame = decodeTelemetryFrame(values, 7, 0);

  assert.equal(frame.timestampMs, 2_000);
  assert.equal(frame.frameIndex, 7);
  assert.deepEqual(frame.leftHand, { tracked: false, joints: {}, pinch: 0 });
  assert.deepEqual(frame.rightHand, { tracked: false, joints: {}, pinch: 0 });
});
