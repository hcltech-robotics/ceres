import assert from "node:assert/strict";
import test from "node:test";
import { releaseCaptureMediaResources, type CaptureMediaResources } from "../src/capture-media-authority.js";

test("releases each capture track once and clears the preview", () => {
  const camera = fakeTrack();
  const microphone = fakeTrack();
  const preview = {
    pauseCount: 0,
    srcObject: {} as MediaProvider | null,
    pause() { this.pauseCount += 1; },
  };
  const released = releaseCaptureMediaResources({
    cameraStream: fakeStream(camera),
    captureStream: fakeStream(camera, microphone),
    microphoneStream: fakeStream(microphone),
  }, preview);

  assert.deepEqual(released, {
    cameraStream: null,
    captureStream: null,
    microphoneStream: null,
  });
  assert.equal(camera.stopCount, 1);
  assert.equal(microphone.stopCount, 1);
  assert.equal(preview.pauseCount, 1);
  assert.equal(preview.srcObject, null);
});

test("continues releasing capture tracks when one source throws", () => {
  const broken = fakeTrack(true);
  const healthy = fakeTrack();
  const resources: CaptureMediaResources = {
    cameraStream: fakeStream(broken),
    captureStream: fakeStream(broken, healthy),
    microphoneStream: fakeStream(healthy),
  };

  const released = releaseCaptureMediaResources(resources);

  assert.equal(broken.stopCount, 1);
  assert.equal(healthy.stopCount, 1);
  releaseCaptureMediaResources(released);
  assert.equal(broken.stopCount, 1);
  assert.equal(healthy.stopCount, 1);
});

function fakeTrack(throws = false) {
  return {
    stopCount: 0,
    stop() {
      this.stopCount += 1;
      if (throws) throw new Error("track already failed");
    },
  };
}

function fakeStream(...tracks: Array<ReturnType<typeof fakeTrack>>) {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}
