import assert from "node:assert/strict";
import test from "node:test";
import { bridgeSelectedCameraChoice, openBridgeCamera } from "../src/bridge-camera-selection.js";
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

test("Bridge selects exactly one camera with its physical identity", async () => {
  for (const choice of choices) {
    const selected = bridgeSelectedCameraChoice(choices, choice.deviceId);
    assert.equal(selected, choice);
    const source = cameraStream(), requested: string[] = [];
    const opened = await openBridgeCamera(selected, new AbortController().signal, async deviceId => {
      requested.push(deviceId);
      return source.stream;
    });
    assert.deepEqual(requested, [choice.deviceId]);
    assert.equal(opened?.track, source.track);
  }
  assert.throws(() => bridgeSelectedCameraChoice(choices, "missing"), /unavailable/);
});

test("a stale Both setting opens one deterministic camera only", async () => {
  const requested: string[] = [];
  const choice = bridgeSelectedCameraChoice([...choices].reverse(), "bridge-both-cameras");
  assert.equal(choice.side, "right");
  await openBridgeCamera(choice, new AbortController().signal, async deviceId => {
    requested.push(deviceId);
    return cameraStream().stream;
  });
  assert.deepEqual(requested, ["physical-0"]);
  assert.equal(bridgeSelectedCameraChoice([choices[1]], "bridge-both-cameras").side, "left");
  const unknown: CameraChoice = { deviceId: "generic", side: "unknown", label: "Webcam" };
  assert.equal(bridgeSelectedCameraChoice([unknown], "bridge-both-cameras"), unknown);
  assert.throws(() => bridgeSelectedCameraChoice([], "bridge-both-cameras"), /unavailable/);
});

test("cancelling camera acquisition releases its late-arriving track", async () => {
  const source = cameraStream();
  const abort = new AbortController();
  let resolveCamera!: (stream: MediaStream) => void;
  const opening = openBridgeCamera(choices[0], abort.signal, async () => {
    return new Promise<MediaStream>((resolve) => { resolveCamera = resolve; });
  });
  abort.abort();
  resolveCamera(source.stream);
  assert.equal(await opening, null);
  assert.equal(source.track.readyState, "ended");
});

test("unexpected multiple video tracks are rejected and released", async () => {
  const first = cameraStream();
  const second = cameraStream();
  const stream = { getVideoTracks: () => [first.track, second.track], getTracks: () => [first.track, second.track] } as MediaStream;
  await assert.rejects(openBridgeCamera(choices[0], new AbortController().signal, async () => stream), /one live video track/);
  assert.equal(first.track.readyState, "ended");
  assert.equal(second.track.readyState, "ended");
});

test("an ended video track is rejected and an aborted request never opens a camera", async () => {
  const source = cameraStream();
  source.track.stop();
  await assert.rejects(openBridgeCamera(choices[0], new AbortController().signal, async () => source.stream), /one live video track/);
  const abort = new AbortController(); abort.abort();
  const result = await openBridgeCamera(choices[0], abort.signal, async () => { throw new Error("Unexpected camera request"); });
  assert.equal(result, null);
});
