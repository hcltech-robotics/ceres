import type { CameraSide } from "./protocol.js";

export const CAMERA_REGISTRATION_SCHEMA = "ceres-camera-registration-v2" as const;
export const CAMERA_CAPTURE_REGISTRATION_SCHEMA = "ceres-camera-registration-v3" as const;

export interface CalibrationDepthChecks {
  near: number;
  middle: number;
  far: number;
}

export interface CalibrationReprojectionChecks {
  centre: CalibrationDepthChecks;
  edges: CalibrationDepthChecks;
  maximumRms: number;
}

export interface CameraRegistration {
  schema: typeof CAMERA_REGISTRATION_SCHEMA | typeof CAMERA_CAPTURE_REGISTRATION_SCHEMA;
  captureFrameKey?: string;
  cameraDeviceId: string;
  cameraLabel: string;
  side: CameraSide;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion: number[];
  rms: number;
  sampleCount: number;
  reprojection: CalibrationReprojectionChecks;
  calibratedAtMs: number;
}

export function normaliseCameraLabel(label: string) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normaliseCameraDeviceId(deviceId: string) {
  return deviceId.trim();
}

export function cameraRegistrationKey(
  cameraDeviceId: string,
  side: CameraSide,
  width: number,
  height: number,
) {
  return JSON.stringify([normaliseCameraDeviceId(cameraDeviceId), side, Math.trunc(width), Math.trunc(height)]);
}

export function cameraRegistrationMatches(
  registration: CameraRegistration | null | undefined,
  cameraDeviceId: string | null | undefined,
  side: CameraSide,
  width: number | null | undefined,
  height: number | null | undefined,
) {
  if (!registration || !cameraDeviceId || !width || !height) return false;
  return cameraRegistrationKey(registration.cameraDeviceId, registration.side, registration.width, registration.height)
    === cameraRegistrationKey(cameraDeviceId, side, width, height);
}

export function normaliseCameraRegistration(value: unknown): CameraRegistration | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Camera registration must be an object or null");
  const candidate = value as Partial<CameraRegistration>;
  if (candidate.schema !== CAMERA_REGISTRATION_SCHEMA
    && candidate.schema !== CAMERA_CAPTURE_REGISTRATION_SCHEMA) {
    throw new Error("Camera registration schema is unsupported");
  }
  const captureFrameKey = candidate.captureFrameKey;
  if ((candidate.schema === CAMERA_CAPTURE_REGISTRATION_SCHEMA && captureFrameKey === undefined)
    || (candidate.schema === CAMERA_REGISTRATION_SCHEMA && captureFrameKey !== undefined)
    || (captureFrameKey !== undefined
      && (typeof captureFrameKey !== "string"
      || captureFrameKey.length > 128
      || !/^\d+x\d+:\d+,\d+,\d+,\d+:\d+x\d+$/u.test(captureFrameKey)))) {
    throw new Error("Camera registration capture frame is invalid");
  }
  const cameraDeviceId = typeof candidate.cameraDeviceId === "string" ? normaliseCameraDeviceId(candidate.cameraDeviceId) : "";
  if (!cameraDeviceId || cameraDeviceId.length > 512) throw new Error("Camera registration device identity is invalid");
  const cameraLabel = typeof candidate.cameraLabel === "string" ? candidate.cameraLabel.trim() : "";
  if (!cameraLabel || cameraLabel.length > 256) throw new Error("Camera registration label is invalid");
  if (candidate.side !== "left" && candidate.side !== "right" && candidate.side !== "unknown") {
    throw new Error("Camera registration side is invalid");
  }
  const width = finiteInteger(candidate.width, "width", 1, 16_384);
  const height = finiteInteger(candidate.height, "height", 1, 16_384);
  const fx = finiteNumber(candidate.fx, "fx");
  const fy = finiteNumber(candidate.fy, "fy");
  const cx = finiteNumber(candidate.cx, "cx");
  const cy = finiteNumber(candidate.cy, "cy");
  const rms = finiteNumber(candidate.rms, "rms");
  const sampleCount = finiteInteger(candidate.sampleCount, "sample count", 18, 1_000);
  const reprojection = normaliseReprojection(candidate.reprojection);
  const calibratedAtMs = finiteNumber(candidate.calibratedAtMs, "calibration time");
  const distortion = Array.isArray(candidate.distortion)
    ? candidate.distortion.map((entry) => finiteNumber(entry, "distortion coefficient"))
    : [];
  if (distortion.length !== 5
    || Math.abs(distortion[0]) > 1.5
    || Math.abs(distortion[1]) > 1.5
    || Math.abs(distortion[2]) > .25
    || Math.abs(distortion[3]) > .25
    || Math.abs(distortion[4]) > 1.5) {
    throw new Error("Camera registration contains an invalid distortion model");
  }
  if (fx <= 0 || fy <= 0 || cx < 0 || cx > width || cy < 0 || cy > height || rms < 0 || rms > 4) {
    throw new Error("Camera registration contains an invalid pinhole model");
  }
  return {
    schema: candidate.schema,
    ...(captureFrameKey ? { captureFrameKey } : {}),
    cameraDeviceId,
    cameraLabel,
    side: candidate.side,
    width,
    height,
    fx,
    fy,
    cx,
    cy,
    distortion,
    rms,
    sampleCount,
    reprojection,
    calibratedAtMs,
  };
}

function normaliseReprojection(value: unknown): CalibrationReprojectionChecks {
  if (!value || typeof value !== "object") throw new Error("Camera registration reprojection checks are invalid");
  const candidate = value as Partial<CalibrationReprojectionChecks>;
  const depthChecks = (entry: unknown, label: string): CalibrationDepthChecks => {
    if (!entry || typeof entry !== "object") throw new Error(`Camera registration ${label} reprojection checks are invalid`);
    const checks = entry as Partial<CalibrationDepthChecks>;
    return {
      near: finiteNumber(checks.near, `${label} near reprojection error`),
      middle: finiteNumber(checks.middle, `${label} middle reprojection error`),
      far: finiteNumber(checks.far, `${label} far reprojection error`),
    };
  };
  const reprojection = {
    centre: depthChecks(candidate.centre, "centre"),
    edges: depthChecks(candidate.edges, "edge"),
    maximumRms: finiteNumber(candidate.maximumRms, "maximum reprojection error"),
  };
  const regionalErrors = [
    ...Object.values(reprojection.centre),
    ...Object.values(reprojection.edges),
  ];
  if ([...regionalErrors, reprojection.maximumRms].some((error) => error < 0 || error > 6)
    || Math.abs(Math.max(...regionalErrors) - reprojection.maximumRms) > 1e-6) {
    throw new Error("Camera registration reprojection checks exceed the accepted limit");
  }
  return reprojection;
}

function finiteInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Camera registration ${label} is invalid`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Camera registration ${label} is invalid`);
  }
  return value;
}
