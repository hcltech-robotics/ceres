import assert from "node:assert/strict";
import test from "node:test";
import { captureMetadataFromStatus } from "../shared/capture-metadata.js";
import { CAMERA_REGISTRATION_SCHEMA, type CameraRegistration } from "../shared/camera-registration.js";
import { cameraCaptureFrame, cameraRegistrationForCaptureFrame } from "../shared/camera-capture-frame.js";
import { generateDemonstratorDesignator, pgpFamilyNameFromHeadsetId } from "../shared/demonstrator-designator.js";
import { defaultCaptureStatus, defaultConfiguration } from "../shared/protocol.js";

const registration: CameraRegistration = {
  schema: CAMERA_REGISTRATION_SCHEMA,
  cameraDeviceId: "quest-camera-device-0",
  cameraLabel: "camera2 0",
  side: "right",
  width: 1280,
  height: 960,
  fx: 760,
  fy: 762,
  cx: 638,
  cy: 481,
  distortion: [0, 0, 0, 0, 0],
  rms: .31,
  sampleCount: 18,
  reprojection: {
    centre: { near: .31, middle: .31, far: .31 },
    edges: { near: .31, middle: .31, far: .31 },
    maximumRms: .31,
  },
  calibratedAtMs: 4_000,
};

test("freezes matching camera calibration without persisting its device identifier", () => {
  const metadata = captureMetadataFromStatus({
    ...defaultCaptureStatus,
    headsetModel: "Quest 3",
    sensorSource: "native-webxr",
    questBrowser: true,
    camera: "ready",
    selectedCameraDeviceId: registration.cameraDeviceId,
    selectedCameraLabel: registration.cameraLabel,
    selectedCameraWidth: registration.width,
    selectedCameraHeight: registration.height,
    selectedCameraFrameRate: 30,
    selectedCameraSide: registration.side,
    handTracking: "active",
  }, registration);

  assert.deepEqual(metadata.camera.selection, {
    availability: "known",
    value: { label: "camera2 0", side: "right" },
  });
  assert.deepEqual(metadata.camera.calibration, {
    availability: "known",
    value: {
      model: "pinhole-radtan5",
      width: 1280,
      height: 960,
      fx: 760,
      fy: 762,
      cx: 638,
      cy: 481,
      distortion: [0, 0, 0, 0, 0],
      rms: .31,
      sampleCount: 18,
      calibratedAt: "1970-01-01T00:00:04.000Z",
    },
  });
  assert.equal(JSON.stringify(metadata).includes(registration.cameraDeviceId), false);
});

test("keeps camera and calibration availability explicit when capture was not ready", () => {
  const metadata = captureMetadataFromStatus(defaultCaptureStatus, registration);

  assert.deepEqual(metadata.camera.selection, { availability: "unavailable" });
  assert.deepEqual(metadata.camera.calibration, { availability: "unavailable" });
  assert.deepEqual(metadata.device.handTracking, { availability: "known", value: "waiting" });
});

test("does not reuse a framed calibration when capture-frame provenance is absent", () => {
  const frame = cameraCaptureFrame(1_280, 960);
  const composed = cameraRegistrationForCaptureFrame(registration, frame);
  assert.ok(composed);
  const status = {
    ...defaultCaptureStatus,
    camera: "ready" as const,
    selectedCameraDeviceId: registration.cameraDeviceId,
    selectedCameraLabel: registration.cameraLabel,
    selectedCameraWidth: 640,
    selectedCameraHeight: 480,
    selectedCameraSide: registration.side,
  };

  assert.deepEqual(
    captureMetadataFromStatus(status, composed).camera.calibration,
    { availability: "unknown" },
  );
  assert.equal(
    captureMetadataFromStatus({ ...status, selectedCameraFrame: frame }, composed)
      .camera.calibration.availability,
    "known",
  );
});

test("persists optional study metadata without retaining a raw camera device identifier", () => {
  const configuration = {
    ...defaultConfiguration,
    recordAudio: false,
    studyMetadata: {
      headsetId: "quest-rig-9e",
      demonstratorId: "demonstrator-042",
      projectId: "project-canterbury",
      consentDate: "2026-08-02",
      consentDocumentId: "consent-v4-042",
    },
  };
  const metadata = captureMetadataFromStatus({
    ...defaultCaptureStatus,
    selectedCameraDeviceId: registration.cameraDeviceId,
  }, registration, configuration);

  assert.deepEqual(metadata.study, {
    headsetId: "quest-rig-9e",
    demonstratorId: "demonstrator-042",
    demonstratorIdOrigin: "entered",
    projectId: "project-canterbury",
    consentDate: "2026-08-02",
    consentDocumentId: "consent-v4-042",
  });
  assert.deepEqual(metadata.audio, { rawMicrophoneAudioRetained: false });
  assert.equal(JSON.stringify(metadata).includes(registration.cameraDeviceId), false);
});

test("generates a readable demonstrator designator from the headset identifier", () => {
  assert.equal(pgpFamilyNameFromHeadsetId("quest-rig-009e"), "aardvark-onlooker");
  assert.equal(pgpFamilyNameFromHeadsetId("quest-rig-ff9e"), "Zulu-onlooker");
  assert.equal(
    generateDemonstratorDesignator("quest-rig-0000", () => 0),
    "aardvark-adroitness,,axolotl,aluminium",
  );
  assert.equal(
    generateDemonstratorDesignator("quest-rig-ff9e", () => 1),
    "Zulu-onlooker,,zorilla,zirconium",
  );
});
