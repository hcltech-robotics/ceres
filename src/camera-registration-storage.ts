import {
  CAMERA_CAPTURE_REGISTRATION_SCHEMA,
  CAMERA_REGISTRATION_SCHEMA,
  cameraRegistrationKey,
  normaliseCameraRegistration,
  type CameraRegistration,
} from "../shared/camera-registration.js";
import type { CameraSide } from "../shared/protocol.js";
import {
  cameraCaptureFrameKey,
  cameraRegistrationForCaptureFrame,
  normaliseCameraCaptureFrame,
  type CameraCaptureFrame,
} from "../shared/camera-capture-frame.js";
import type { CameraCalibrationResult } from "./camera-calibration.js";

const storageKey = "ceres.camera-registrations.v2";
const maximumStoredRegistrations = 16;

export function cameraRegistrationFromCalibration(
  calibration: CameraCalibrationResult,
  cameraDeviceId: string,
  cameraLabel: string,
  side: CameraSide,
  calibratedAtMs = Date.now(),
  captureFrame: CameraCaptureFrame | null = null,
): CameraRegistration {
  const normalisedCaptureFrame = normaliseCameraCaptureFrame(captureFrame);
  return normaliseCameraRegistration({
    schema: normalisedCaptureFrame ? CAMERA_CAPTURE_REGISTRATION_SCHEMA : CAMERA_REGISTRATION_SCHEMA,
    ...(normalisedCaptureFrame ? { captureFrameKey: cameraCaptureFrameKey(normalisedCaptureFrame) } : {}),
    cameraDeviceId,
    cameraLabel,
    side,
    width: calibration.width,
    height: calibration.height,
    fx: calibration.fx,
    fy: calibration.fy,
    cx: calibration.cx,
    cy: calibration.cy,
    distortion: calibration.distortion,
    rms: calibration.rms,
    sampleCount: calibration.sampleCount,
    reprojection: calibration.reprojection,
    calibratedAtMs,
  })!;
}

export function loadCameraRegistration(
  storage: Pick<Storage, "getItem">,
  cameraDeviceId: string,
  side: CameraSide,
  width: number,
  height: number,
): CameraRegistration | null {
  const key = cameraRegistrationKey(cameraDeviceId, side, width, height);
  return readCameraRegistrations(storage).find((registration) => (
    !registration.captureFrameKey
    && cameraRegistrationKey(registration.cameraDeviceId, registration.side, registration.width, registration.height) === key
  )) ?? null;
}

export function loadCameraRegistrationForCaptureFrame(
  storage: Pick<Storage, "getItem">,
  cameraDeviceId: string,
  side: CameraSide,
  width: number,
  height: number,
  value: CameraCaptureFrame | null | undefined,
): CameraRegistration | null {
  let frame: CameraCaptureFrame | null;
  try {
    frame = normaliseCameraCaptureFrame(value);
  } catch {
    return null;
  }
  if (!frame) return loadCameraRegistration(storage, cameraDeviceId, side, width, height);
  if (frame.outputWidth !== width || frame.outputHeight !== height) return null;
  const frameKey = cameraCaptureFrameKey(frame);
  const outputKey = cameraRegistrationKey(cameraDeviceId, side, width, height);
  const composed = readCameraRegistrations(storage).find((registration) => (
    registration.captureFrameKey === frameKey
    && cameraRegistrationKey(registration.cameraDeviceId, registration.side, registration.width, registration.height) === outputKey
  ));
  if (composed) return composed;
  const source = loadCameraRegistration(
    storage,
    cameraDeviceId,
    side,
    frame.sourceWidth,
    frame.sourceHeight,
  );
  return cameraRegistrationForCaptureFrame(source, frame);
}

export function storeCameraRegistration(
  storage: Pick<Storage, "getItem" | "setItem">,
  registration: CameraRegistration,
) {
  const normalised = normaliseCameraRegistration(registration)!;
  const key = storedCameraRegistrationKey(normalised);
  const registrations = readCameraRegistrations(storage)
    .filter((entry) => storedCameraRegistrationKey(entry) !== key);
  registrations.unshift(normalised);
  storage.setItem(storageKey, JSON.stringify(registrations.slice(0, maximumStoredRegistrations)));
}

function storedCameraRegistrationKey(registration: CameraRegistration) {
  return JSON.stringify([
    cameraRegistrationKey(
      registration.cameraDeviceId,
      registration.side,
      registration.width,
      registration.height,
    ),
    registration.captureFrameKey ?? null,
  ]);
}

function readCameraRegistrations(storage: Pick<Storage, "getItem">) {
  try {
    const value = JSON.parse(storage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    const registrations: CameraRegistration[] = [];
    for (const entry of value) {
      try {
        const registration = normaliseCameraRegistration(entry);
        if (registration) registrations.push(registration);
      } catch {
        // Ignore only the malformed stored entry and preserve valid calibrations.
      }
    }
    return registrations;
  } catch {
    return [];
  }
}
