import assert from "node:assert/strict";
import test from "node:test";
import { serialiseWorkerError, workerErrorContext } from "../src/worker-errors.js";
import { cameraAccessCapability, enumerateOutwardCameras } from "../src/quest-camera.js";

const supportedMediaDevices = {
  enumerateDevices: async () => [],
  getUserMedia: async () => { throw new Error("not invoked by capability checks"); },
};

test("camera access rejects an insecure network context with an actionable HTTPS message", () => {
  const capability = cameraAccessCapability({ secureContext: false, mediaDevices: supportedMediaDevices });
  assert.equal(capability.available, false);
  assert.match(capability.message ?? "", /requires HTTPS/i);
  assert.doesNotMatch(capability.message ?? "", /undefined|enumerateDevices/);
});

test("camera access rejects incomplete browser media support without leaking a TypeError", () => {
  const capability = cameraAccessCapability({ secureContext: true, mediaDevices: {} });
  assert.equal(capability.available, false);
  assert.match(capability.message ?? "", /unavailable in this browser/i);
});

test("camera access accepts a secure context with the required media APIs", () => {
  assert.deepEqual(
    cameraAccessCapability({ secureContext: true, mediaDevices: supportedMediaDevices }),
    { available: true, message: null },
  );
});

function videoDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "quest-cameras",
    kind: "videoinput",
    label,
    toJSON: () => ({ deviceId, groupId: "quest-cameras", kind: "videoinput", label }),
  } as MediaDeviceInfo;
}

function provisionalStream(onStop: () => void, videoTracks: MediaStreamTrack[] = []): MediaStream {
  return {
    getTracks: () => [{ stop: onStop } as MediaStreamTrack],
    getVideoTracks: () => videoTracks,
  } as MediaStream;
}

function provisionalVideoTrack(
  deviceId: string,
  label: string,
  readyState: MediaStreamTrackState = "live",
): MediaStreamTrack {
  return { label, readyState, getSettings: () => ({ deviceId }) } as MediaStreamTrack;
}

for (const [name, devices] of [
  ["empty", []],
  ["anonymous", [videoDevice("", "")]],
  ["unlabelled", [videoDevice("camera-left", "")]],
] as const) {
  test(`camera enumeration uses the live camera identity when the device list remains ${name}`, async () => {
    let stopped = false;
    const choices = await enumerateOutwardCameras({
      secureContext: true,
      mediaDevices: {
        getUserMedia: async () => provisionalStream(() => { stopped = true; }, [
          provisionalVideoTrack("camera-left", "camera2 1"),
        ]),
        enumerateDevices: async () => [...devices],
      },
    }, "OculusBrowser/40.0");

    assert.deepEqual(choices, [{ deviceId: "camera-left", label: "camera2 1", side: "left" }]);
    assert.equal(stopped, true);
  });
}

for (const [name, track] of [
  ["front camera", provisionalVideoTrack("front-camera", "Quest front camera")],
  ["missing device ID", provisionalVideoTrack("", "camera2 0")],
  ["missing label", provisionalVideoTrack("camera-right", "")],
  ["ended track", provisionalVideoTrack("camera-right", "camera2 0", "ended")],
] as const) {
  test(`Quest camera enumeration rejects a provisional ${name}`, async () => {
    let stopped = false;
    const choices = await enumerateOutwardCameras({
      secureContext: true,
      mediaDevices: {
        getUserMedia: async () => provisionalStream(() => { stopped = true; }, [track]),
        enumerateDevices: async () => [],
      },
    }, "OculusBrowser/40.0");

    assert.deepEqual(choices, []);
    assert.equal(stopped, true);
  });
}

test("Quest camera fallback respects an enumerated front-camera label", async () => {
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async () => provisionalStream(() => undefined, [
        provisionalVideoTrack("front-camera", "camera2 0"),
      ]),
      enumerateDevices: async () => [videoDevice("front-camera", "Quest front camera")],
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(choices, []);
});

test("camera enumeration preserves the device list and order when outward cameras are available", async () => {
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async () => provisionalStream(() => undefined, [
        provisionalVideoTrack("camera-left", "camera2 1"),
      ]),
      enumerateDevices: async () => [
        videoDevice("camera-right", "camera2 0"),
        videoDevice("camera-left", "camera2 1"),
      ],
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(choices, [
    { deviceId: "camera-right", label: "camera2 0", side: "right" },
    { deviceId: "camera-left", label: "camera2 1", side: "left" },
  ]);
});

test("camera enumeration recovers when a fresh origin initially exposes no video inputs", async () => {
  const events: string[] = [];
  let enumerationCount = 0;
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async (constraints) => {
        events.push("permission");
        assert.deepEqual(constraints, {
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        return provisionalStream(() => events.push("stop"));
      },
      enumerateDevices: async () => {
        enumerationCount += 1;
        events.push(`enumerate:${enumerationCount}`);
        return enumerationCount === 1 ? [] : [videoDevice("camera-right", "camera2 0")];
      },
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(choices, [{
    deviceId: "camera-right",
    label: "camera2 0",
    side: "right",
  }]);
  assert.deepEqual(events, ["permission", "enumerate:1", "enumerate:2", "stop"]);
});

test("camera enumeration refreshes blank labels before applying the Quest front-camera filter", async () => {
  const events: string[] = [];
  let enumerationCount = 0;
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async () => provisionalStream(() => events.push("stop")),
      enumerateDevices: async () => {
        enumerationCount += 1;
        events.push(`enumerate:${enumerationCount}`);
        if (enumerationCount === 1) return [videoDevice("opaque-camera", "")];
        return [
          videoDevice("front-camera", "Quest front camera"),
          videoDevice("camera-left", "camera2 1"),
        ];
      },
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(choices, [{
    deviceId: "camera-left",
    label: "camera2 1",
    side: "left",
  }]);
  assert.deepEqual(events, ["enumerate:1", "enumerate:2", "stop"]);
});

test("Quest camera enumeration fails closed when refreshed devices remain anonymous", async () => {
  let enumerationCount = 0;
  let stopped = false;
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async () => provisionalStream(() => { stopped = true; }),
      enumerateDevices: async () => {
        enumerationCount += 1;
        return [videoDevice("", "")];
      },
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(choices, []);
  assert.equal(enumerationCount, 2);
  assert.equal(stopped, true);
});

test("Quest camera enumeration keeps identified outward cameras beside anonymous inputs", async () => {
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async () => provisionalStream(() => undefined),
      enumerateDevices: async () => [
        videoDevice("", ""),
        videoDevice("front-camera", "Quest front camera"),
        videoDevice("camera-right", "camera2 0"),
      ],
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(choices, [{
    deviceId: "camera-right",
    label: "camera2 0",
    side: "right",
  }]);
});

test("non-Quest enumeration requires an exact device ID but permits a fallback label", async () => {
  const choices = await enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: async () => provisionalStream(() => undefined),
      enumerateDevices: async () => [
        videoDevice("", "Camera without an ID"),
        videoDevice("camera-valid", ""),
      ],
    },
  }, "Chrome/140.0");

  assert.deepEqual(choices, [{
    deviceId: "camera-valid",
    label: "Outward camera 1",
    side: "right",
  }]);
});

test("camera permission acquisition begins before enumeration waits on browser permission", async () => {
  const events: string[] = [];
  let resolvePermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    resolvePermission = resolve;
  });
  const choicesPromise = enumerateOutwardCameras({
    secureContext: true,
    mediaDevices: {
      getUserMedia: () => {
        events.push("permission");
        return permission;
      },
      enumerateDevices: async () => {
        events.push("enumerate");
        return [videoDevice("camera-right", "camera2 0")];
      },
    },
  }, "OculusBrowser/40.0");

  assert.deepEqual(events, ["permission"]);
  resolvePermission(provisionalStream(() => events.push("stop")));
  await choicesPromise;
  assert.deepEqual(events, ["permission", "enumerate", "stop"]);
});

test("camera permission denial preserves the browser DOMException name and skips enumeration", async () => {
  const denial = new DOMException("Camera permission was denied", "NotAllowedError");
  let enumerationCount = 0;

  await assert.rejects(
    enumerateOutwardCameras({
      secureContext: true,
      mediaDevices: {
        getUserMedia: async () => { throw denial; },
        enumerateDevices: async () => {
          enumerationCount += 1;
          return [];
        },
      },
    }, "OculusBrowser/40.0"),
    (error: unknown) => {
      assert.equal(error, denial);
      assert.equal((error as DOMException).name, "NotAllowedError");
      assert.equal(
        workerErrorContext(error)?.stage,
        "permission_request",
      );
      return true;
    },
  );
  assert.equal(enumerationCount, 0);
});

test("camera enumeration failures retain their phase after permission succeeds", async () => {
  const enumerationFailure = new DOMException("Device enumeration failed", "NotReadableError");
  let stopped = false;

  await assert.rejects(
    enumerateOutwardCameras({
      secureContext: true,
      mediaDevices: {
        getUserMedia: async () => provisionalStream(() => { stopped = true; }),
        enumerateDevices: async () => { throw enumerationFailure; },
      },
    }, "OculusBrowser/40.0"),
    (error: unknown) => {
      assert.equal(error, enumerationFailure);
      const report = { error: serialiseWorkerError(error), context: workerErrorContext(error)! };
      assert.equal(report.error.type, "NotReadableError");
      assert.equal(report.context.stage, "device_enumeration");
      return true;
    },
  );
  assert.equal(stopped, true);
});
