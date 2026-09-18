import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_BOTH_CAMERAS, bridgeSelectedCameraChoices, bridgeStereoCameraChoices, openBridgeCameraSelection } from "../src/bridge-camera-selection.js";
import type { CameraChoice } from "../src/quest-camera.js";

const choices: CameraChoice[] = [
  { deviceId: "physical-0", label: "camera2 0", side: "right" },
  { deviceId: "physical-1", label: "camera2 1", side: "left" },
];

function cameraStream() {
  let state: MediaStreamTrackState = "live";
  const track = {
    get readyState() { return state; },
    stop: () => { state = "ended"; },
  } as MediaStreamTrack;
  return { stream: { getVideoTracks: () => [track], getTracks: () => [track] } as MediaStream, track };
}

test("both cameras requires distinct left and right devices and preserves their physical identities", () => {
  assert.deepEqual(bridgeSelectedCameraChoices(choices, BRIDGE_BOTH_CAMERAS), choices);
  assert.deepEqual(bridgeSelectedCameraChoices(choices, "physical-1"), [choices[1]]);
  assert.deepEqual(bridgeStereoCameraChoices([choices[0]]), []);
  assert.deepEqual(bridgeStereoCameraChoices([choices[0], { ...choices[1], deviceId: "physical-0" }]), []);
  assert.throws(() => bridgeSelectedCameraChoices([choices[0]], BRIDGE_BOTH_CAMERAS), /left and right/);
});

test("second-camera failure releases the first camera", async () => {
  const first = cameraStream();
  const requested: string[] = [];
  await assert.rejects(openBridgeCameraSelection(choices, new AbortController().signal, async (deviceId) => {
    requested.push(deviceId);
    if (deviceId === choices[1].deviceId) throw new Error("Left camera is busy");
    return first.stream;
  }), /Left camera is busy/);
  assert.deepEqual(requested, ["physical-0", "physical-1"]);
  assert.equal(first.track.readyState, "ended");
});

test("cancelling a pending pair releases acquired and late-arriving camera tracks", async () => {
  const first = cameraStream();
  const second = cameraStream();
  const abort = new AbortController();
  let resolveSecond!: (stream: MediaStream) => void;
  let secondRequested!: () => void;
  const requestStarted = new Promise<void>((resolve) => { secondRequested = resolve; });
  const opening = openBridgeCameraSelection(choices, abort.signal, async (deviceId) => {
    if (deviceId === choices[0].deviceId) return first.stream;
    secondRequested();
    return new Promise<MediaStream>((resolve) => { resolveSecond = resolve; });
  });
  await requestStarted;
  abort.abort();
  assert.equal(first.track.readyState, "ended");
  resolveSecond(second.stream);
  assert.equal(await opening, null);
  assert.equal(second.track.readyState, "ended");
});

test("a first camera that ends during second-camera acquisition rejects the whole pair", async () => {
  const first = cameraStream();
  const second = cameraStream();
  await assert.rejects(openBridgeCameraSelection(choices, new AbortController().signal, async (deviceId) => {
    if (deviceId === choices[0].deviceId) return first.stream;
    first.track.stop();
    return second.stream;
  }), /stopped while/);
  assert.equal(second.track.readyState, "ended");
});
