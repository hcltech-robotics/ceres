import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_CAPTURE_OUTPUT_WIDTH,
  CAMERA_CAPTURE_SOURCE_SCALE,
  CAMERA_CAPTURE_VERTICAL_CENTRE,
  CameraCaptureComposer,
  cameraCaptureFrame,
  cameraCaptureFrameKey,
  cameraRegistrationForCaptureFrame,
} from "../src/camera-capture-frame.js";
import { cameraProjectionForCaptureFrame } from "../shared/camera-capture-frame.js";
import { CAMERA_CAPTURE_REGISTRATION_SCHEMA, CAMERA_REGISTRATION_SCHEMA, type CameraRegistration } from "../shared/camera-registration.js";

test("captures a large native-aspect window with its centre ten per cent lower", () => {
  const frame = cameraCaptureFrame(1_280, 960);

  assert.deepEqual(frame, {
    sourceWidth: 1_280,
    sourceHeight: 960,
    sourceX: 128,
    sourceY: 192,
    sourceCropWidth: 1_024,
    sourceCropHeight: 768,
    outputWidth: 640,
    outputHeight: 480,
  });
  assert.equal(frame.sourceCropWidth / frame.sourceWidth, CAMERA_CAPTURE_SOURCE_SCALE);
  assert.equal(frame.sourceCropHeight / frame.sourceHeight, CAMERA_CAPTURE_SOURCE_SCALE);
  assert.equal(
    (frame.sourceY + frame.sourceCropHeight / 2) / frame.sourceHeight,
    CAMERA_CAPTURE_VERTICAL_CENTRE,
  );
});

test("maps source projection coordinates into the composed capture frame once", () => {
  const frame = cameraCaptureFrame(640, 480);
  const centre = cameraProjectionForCaptureFrame({ x: 0, y: 0 }, frame);
  assert.deepEqual(centre, { x: 0, y: -.25 });

  const edges = [
    [{ x: -.8, y: 0 }, { x: -1, y: -.25 }],
    [{ x: .8, y: 0 }, { x: 1, y: -.25 }],
    [{ x: 0, y: -.6 }, { x: 0, y: -1 }],
    [{ x: 0, y: 1 }, { x: 0, y: 1 }],
  ] as const;
  for (const [source, expected] of edges) {
    const projected = cameraProjectionForCaptureFrame(source, frame);
    assert.ok(Math.abs(projected.x - expected.x) < 1e-12);
    assert.ok(Math.abs(projected.y - expected.y) < 1e-12);
  }
});

test("preserves the negotiated aspect instead of forcing a square export", () => {
  const wide = cameraCaptureFrame(1_920, 1_080);

  assert.equal(wide.outputWidth, CAMERA_CAPTURE_OUTPUT_WIDTH);
  assert.equal(wide.sourceCropWidth / wide.sourceCropHeight, 16 / 9);
  assert.equal(wide.outputWidth / wide.outputHeight, 16 / 9);
  assert.equal(cameraCaptureFrameKey(wide), "1920x1080:192,216,1536,864:640x360");
});

test("keeps every crop coordinate even and inside odd-sized sources", () => {
  const frame = cameraCaptureFrame(1_281, 961);

  for (const value of [
    frame.sourceX,
    frame.sourceY,
    frame.sourceCropWidth,
    frame.sourceCropHeight,
    frame.outputWidth,
    frame.outputHeight,
  ]) assert.equal(value % 2, 0);
  assert.ok(frame.sourceX + frame.sourceCropWidth <= frame.sourceWidth);
  assert.ok(frame.sourceY + frame.sourceCropHeight <= frame.sourceHeight);
});

test("rejects missing source dimensions before capture can be armed", () => {
  assert.throws(() => cameraCaptureFrame(0, 960), /dimensions are unavailable/);
  assert.throws(() => cameraCaptureFrame(1_280, Number.NaN), /dimensions are unavailable/);
});

test("transforms source camera intrinsics into the exact exported pixel window", () => {
  const registration: CameraRegistration = {
    schema: CAMERA_REGISTRATION_SCHEMA,
    cameraDeviceId: "quest-camera-0",
    cameraLabel: "Camera2 0",
    side: "right",
    width: 1_280,
    height: 960,
    fx: 760,
    fy: 762,
    cx: 638,
    cy: 481,
    distortion: [.01, -.02, .001, -.001, .003],
    rms: .8,
    sampleCount: 24,
    reprojection: {
      centre: { near: .4, middle: .5, far: .6 },
      edges: { near: .7, middle: .8, far: .9 },
      maximumRms: .9,
    },
    calibratedAtMs: 1_800_000_000_000,
  };

  const transformed = cameraRegistrationForCaptureFrame(
    registration,
    cameraCaptureFrame(1_280, 960),
  );

  assert.ok(transformed);
  assert.equal(transformed.schema, CAMERA_CAPTURE_REGISTRATION_SCHEMA);
  assert.equal(transformed.captureFrameKey, "1280x960:128,192,1024,768:640x480");
  assert.equal(transformed.width, 640);
  assert.equal(transformed.height, 480);
  assert.equal(transformed.fx, 475);
  assert.equal(transformed.fy, 476.25);
  assert.equal(transformed.cx, 318.75);
  assert.equal(transformed.cy, 180.625);
  assert.equal(transformed.rms, .5);
  assert.deepEqual(transformed.distortion, registration.distortion);
  assert.equal(transformed.reprojection.maximumRms, .5625);
});

test("fails closed for a malformed or mismatched capture frame", () => {
  const registration = {
    schema: CAMERA_REGISTRATION_SCHEMA,
    cameraDeviceId: "quest-camera-0",
    cameraLabel: "Camera2 0",
    side: "right",
    width: 1_280,
    height: 960,
    fx: 760,
    fy: 762,
    cx: 638,
    cy: 481,
    distortion: [0, 0, 0, 0, 0],
    rms: .8,
    sampleCount: 24,
    reprojection: {
      centre: { near: .4, middle: .5, far: .6 },
      edges: { near: .7, middle: .8, far: .9 },
      maximumRms: .9,
    },
    calibratedAtMs: 1_800_000_000_000,
  } satisfies CameraRegistration;
  const malformed = {
    ...cameraCaptureFrame(1_280, 960),
    sourceX: 130,
  };

  assert.equal(cameraRegistrationForCaptureFrame(registration, malformed), null);
  assert.equal(
    cameraRegistrationForCaptureFrame(registration, cameraCaptureFrame(2_560, 1_920)),
    null,
  );
});

test("disposes the composed track and listeners when the initial draw fails", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousHtmlMediaElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLMediaElement");
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let outputStops = 0;
  const eventTarget = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const entries = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
  };
  const sourceTrack = {
    ...eventTarget,
    readyState: "live",
    muted: false,
  } as unknown as MediaStreamTrack;
  const outputTrack = {
    ...eventTarget,
    readyState: "live",
    stop: () => { outputStops += 1; },
  } as unknown as MediaStreamTrack;
  const sourceListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const source = {
    readyState: 2,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const entries = sourceListeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      entries.add(listener);
      sourceListeners.set(type, entries);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      sourceListeners.get(type)?.delete(listener);
    },
  } as unknown as HTMLVideoElement;
  const stream = {
    getVideoTracks: () => [outputTrack],
    getTracks: () => [outputTrack],
  } as unknown as MediaStream;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage: () => { throw new Error("initial draw failed"); },
    }),
    captureStream: () => stream,
  } as unknown as HTMLCanvasElement;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "HTMLMediaElement", {
    configurable: true,
    value: { HAVE_CURRENT_DATA: 2 },
  });
  try {
    assert.throws(
      () => new CameraCaptureComposer(
        source,
        sourceTrack,
        cameraCaptureFrame(1_280, 960),
        30,
        () => undefined,
      ),
      /initial draw failed/,
    );
    assert.equal(outputStops, 1);
    assert.equal(listeners.get("ended")?.size ?? 0, 0);
    assert.equal(listeners.get("mute")?.size ?? 0, 0);
    assert.equal(sourceListeners.get("error")?.size ?? 0, 0);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousHtmlMediaElement) Object.defineProperty(globalThis, "HTMLMediaElement", previousHtmlMediaElement);
    else Reflect.deleteProperty(globalThis, "HTMLMediaElement");
  }
});
