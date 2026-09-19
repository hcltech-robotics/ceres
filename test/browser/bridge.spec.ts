import { expect, test, type Page } from "@playwright/test";

interface CameraHarness {
  failLeft: boolean;
  holdLeft: boolean;
  includeLeft: boolean;
  includeRight: boolean;
  requests: string[];
  tracks: Array<{ deviceId: string; track: MediaStreamTrack }>;
  releaseLeft: (() => void) | null;
}

declare global {
  interface Window { __bridgeCameras: CameraHarness }
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const harness: CameraHarness = { failLeft: false, holdLeft: false, includeLeft: true, includeRight: true, requests: [], tracks: [], releaseLeft: null };
    window.__bridgeCameras = harness;
    Object.defineProperty(navigator, "userAgent", { value: `${navigator.userAgent} OculusBrowser/40.0` });
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => [
      ...(harness.includeRight ? [{ deviceId: "camera-right", label: "camera2 0", kind: "videoinput", groupId: "quest" }] : []),
      ...(harness.includeLeft ? [{ deviceId: "camera-left", label: "camera2 1", kind: "videoinput", groupId: "quest" }] : []),
    ] });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async (constraints: MediaStreamConstraints) => {
      if (!constraints.video) return nativeGetUserMedia(constraints);
      const video = constraints.video as MediaTrackConstraints;
      const deviceId = (video.deviceId as ConstrainDOMStringParameters | undefined)?.exact as string | undefined ?? "permission";
      harness.requests.push(deviceId);
      if (deviceId === "camera-left") {
        if (harness.failLeft) throw new DOMException("Left camera is busy", "NotReadableError");
        if (harness.holdLeft) await new Promise<void>((resolve) => { harness.releaseLeft = resolve; });
      }
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const stream = canvas.captureStream(10);
      const track = stream.getVideoTracks()[0];
      const context = canvas.getContext("2d")!;
      const draw = () => {
        context.fillStyle = deviceId === "camera-left" ? "#244870" : "#704824";
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      draw();
      const timer = window.setInterval(draw, 100);
      const stop = track.stop.bind(track);
      track.stop = () => { window.clearInterval(timer); stop(); };
      const settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), deviceId, width: 640, height: 480, frameRate: 10 });
      harness.tracks.push({ deviceId, track });
      return stream;
    } });
  });
});

const liveCameras = (page: Page) => page.evaluate(() => window.__bridgeCameras.tracks
  .filter(({ track }) => track.readyState === "live")
  .map(({ deviceId }) => deviceId));

async function enableCamera(page: Page) {
  await page.goto("/bridge/");
  await page.getByRole("button", { name: "Enable camera", exact: true }).click();
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
}

test("Bridge selects one camera and releases replaced streams", async ({ page }) => {
  await enableCamera(page);
  await expect(page.getByLabel("Camera to stream")).toHaveValue("camera-right");
  await expect(page.locator("#camera-select option")).toHaveText(["camera2 0/right", "camera2 1/left"]);
  await expect.poll(() => liveCameras(page)).toEqual(["camera-right"]);
  await page.evaluate(() => { window.__bridgeCameras.requests = []; });
  await page.getByLabel("Camera to stream").selectOption("camera-left");
  await expect.poll(() => liveCameras(page)).toEqual(["camera-left"]);
  await expect(page.locator("#app")).toHaveAttribute("data-bridge-camera-count", "1");
  await expect(page.locator("#bridge-camera-preview-detail")).toHaveText("Left camera selected.");
  expect(await page.evaluate(() => window.__bridgeCameras.requests)).toEqual(["camera-left"]);
  await page.getByLabel("Camera to stream").selectOption("camera-right");
  await expect.poll(() => liveCameras(page)).toEqual(["camera-right"]);
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
  await expect(page.locator("#app")).toHaveAttribute("data-bridge-camera-count", "1");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => liveCameras(page)).toEqual([]);
});

test("selected-camera failure releases the previous stream and permits retry", async ({ page }) => {
  await enableCamera(page);
  await page.evaluate(() => { window.__bridgeCameras.failLeft = true; });
  await page.getByLabel("Camera to stream").selectOption("camera-left");
  await expect(page.locator("#join-camera-state")).toHaveText("ERR");
  await expect(page.locator("#camera-field-status")).toHaveText("Left camera is busy");
  await expect.poll(() => liveCameras(page)).toEqual([]);
  await page.getByLabel("Camera to stream").selectOption("camera-right");
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
  await expect.poll(() => liveCameras(page)).toEqual(["camera-right"]);
});

test("an ended selected camera clears readiness and releases its stream", async ({ page }) => {
  await enableCamera(page);
  await page.getByLabel("Camera to stream").selectOption("camera-left");
  await expect(page.locator("#app")).toHaveAttribute("data-bridge-camera-count", "1");
  await expect(page.locator("#bridge-camera-preview-detail")).toHaveText("Left camera selected.");
  await page.evaluate(() => {
    const camera = window.__bridgeCameras.tracks.find(({ deviceId, track }) => deviceId === "camera-left" && track.readyState === "live")!;
    camera.track.stop();
    camera.track.dispatchEvent(new Event("ended"));
  });
  await expect(page.locator("#join-camera-state")).toHaveText("ERR");
  await expect(page.getByRole("button", { name: "Start streaming" })).toBeDisabled();
  await expect.poll(() => liveCameras(page)).toEqual([]);
});

test("a late camera acquisition cannot replace a newer selection and disposal releases the active camera", async ({ page }) => {
  await enableCamera(page);
  await page.evaluate(() => { window.__bridgeCameras.holdLeft = true; });
  await page.getByLabel("Camera to stream").selectOption("camera-left");
  await expect.poll(() => page.evaluate(() => Boolean(window.__bridgeCameras.releaseLeft))).toBe(true);
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("#camera-select")!;
    select.value = "camera-right";
    select.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
  await page.evaluate(() => window.__bridgeCameras.releaseLeft!());
  await expect.poll(() => page.evaluate(() => window.__bridgeCameras.tracks.some(({ deviceId, track }) => deviceId === "camera-left" && track.readyState === "ended"))).toBe(true);
  await expect.poll(() => liveCameras(page)).toEqual(["camera-right"]);
  await expect(page.locator("#bridge-camera-preview-detail")).toHaveText("Right camera selected.");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => liveCameras(page)).toEqual([]);
});

test("Bridge offers a single camera when the other physical camera is unavailable", async ({ page }) => {
  await page.goto("/bridge/");
  await page.evaluate(() => { window.__bridgeCameras.includeLeft = false; });
  await page.getByRole("button", { name: "Enable camera", exact: true }).click();
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
  await expect(page.locator("#camera-select option")).toHaveText(["camera2 0/right"]);
});

for (const rightAvailable of [true, false]) {
  test(`a restored Both value falls back to one ${rightAvailable ? "right" : "left"} camera`, async ({ page }) => {
    await page.goto("/bridge/");
    await page.evaluate(available => { window.__bridgeCameras.includeRight = available; }, rightAvailable);
    await page.getByRole("button", { name: "Enable camera", exact: true }).click();
    await expect(page.locator("#join-camera-state")).toHaveText("OK");
    await page.evaluate(() => {
      window.__bridgeCameras.requests = [];
      const select = document.querySelector<HTMLSelectElement>("#camera-select")!;
      select.add(new Option("Old camera setting", "bridge-both-cameras"));
      select.value = "bridge-both-cameras";
      select.dispatchEvent(new Event("change"));
    });
    const selected = rightAvailable ? "camera-right" : "camera-left";
    await expect(page.getByLabel("Camera to stream")).toHaveValue(selected);
    await expect(page.locator("#join-camera-state")).toHaveText("OK");
    await expect(page.locator("#app")).toHaveAttribute("data-bridge-camera-count", "1");
    await expect.poll(() => liveCameras(page)).toEqual([selected]);
    expect(await page.evaluate(() => window.__bridgeCameras.requests)).toEqual([selected]);
  });
}
