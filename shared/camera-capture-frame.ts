import {
  CAMERA_CAPTURE_REGISTRATION_SCHEMA,
  normaliseCameraRegistration,
  type CameraRegistration,
} from "./camera-registration.js";

export const CAMERA_CAPTURE_SOURCE_SCALE = .8;
export const CAMERA_CAPTURE_VERTICAL_CENTRE = .6;
export const CAMERA_CAPTURE_OUTPUT_WIDTH = 640;

export interface CameraCaptureFrame {
  sourceWidth: number;
  sourceHeight: number;
  sourceX: number;
  sourceY: number;
  sourceCropWidth: number;
  sourceCropHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export interface NormalisedCameraPoint {
  x: number;
  y: number;
}

const evenFloor = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

const evenClamp = (value: number, maximum: number) => (
  Math.max(0, Math.min(evenFloor(maximum), Math.floor(value / 2) * 2))
);

export function cameraCaptureFrame(sourceWidth: number, sourceHeight: number): CameraCaptureFrame {
  if (!Number.isSafeInteger(sourceWidth)
    || !Number.isSafeInteger(sourceHeight)
    || sourceWidth < 4
    || sourceHeight < 4) {
    throw new Error("The camera source dimensions are unavailable");
  }
  const sourceCropWidth = Math.min(sourceWidth, evenFloor(sourceWidth * CAMERA_CAPTURE_SOURCE_SCALE));
  const sourceCropHeight = Math.min(sourceHeight, evenFloor(sourceHeight * CAMERA_CAPTURE_SOURCE_SCALE));
  const sourceX = evenClamp((sourceWidth - sourceCropWidth) / 2, sourceWidth - sourceCropWidth);
  const desiredSourceY = sourceHeight * CAMERA_CAPTURE_VERTICAL_CENTRE - sourceCropHeight / 2;
  const sourceY = evenClamp(desiredSourceY, sourceHeight - sourceCropHeight);
  const outputWidth = CAMERA_CAPTURE_OUTPUT_WIDTH;
  const outputHeight = evenFloor(outputWidth * sourceCropHeight / sourceCropWidth);
  return Object.freeze({
    sourceWidth,
    sourceHeight,
    sourceX,
    sourceY,
    sourceCropWidth,
    sourceCropHeight,
    outputWidth,
    outputHeight,
  });
}

export function cameraCaptureFrameKey(frame: CameraCaptureFrame) {
  return [
    `${frame.sourceWidth}x${frame.sourceHeight}`,
    `${frame.sourceX},${frame.sourceY},${frame.sourceCropWidth},${frame.sourceCropHeight}`,
    `${frame.outputWidth}x${frame.outputHeight}`,
  ].join(":");
}

export function cameraProjectionForCaptureFrame(
  point: NormalisedCameraPoint,
  frame: CameraCaptureFrame,
): NormalisedCameraPoint {
  const sourcePixelX = (point.x + 1) / 2 * frame.sourceWidth;
  const sourcePixelY = (point.y + 1) / 2 * frame.sourceHeight;
  const outputPixelX = (sourcePixelX - frame.sourceX) * frame.outputWidth / frame.sourceCropWidth;
  const outputPixelY = (sourcePixelY - frame.sourceY) * frame.outputHeight / frame.sourceCropHeight;
  return {
    x: outputPixelX / frame.outputWidth * 2 - 1,
    y: outputPixelY / frame.outputHeight * 2 - 1,
  };
}

export function normaliseCameraCaptureFrame(value: unknown): CameraCaptureFrame | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") throw new Error("The camera capture frame is invalid");
  const candidate = value as Partial<CameraCaptureFrame>;
  const sourceWidth = safeInteger(candidate.sourceWidth);
  const sourceHeight = safeInteger(candidate.sourceHeight);
  const expected = cameraCaptureFrame(sourceWidth, sourceHeight);
  const supplied = {
    sourceWidth,
    sourceHeight,
    sourceX: safeInteger(candidate.sourceX),
    sourceY: safeInteger(candidate.sourceY),
    sourceCropWidth: safeInteger(candidate.sourceCropWidth),
    sourceCropHeight: safeInteger(candidate.sourceCropHeight),
    outputWidth: safeInteger(candidate.outputWidth),
    outputHeight: safeInteger(candidate.outputHeight),
  };
  if (cameraCaptureFrameKey(supplied) !== cameraCaptureFrameKey(expected)) {
    throw new Error("The camera capture frame does not match the recording window");
  }
  return expected;
}

export function cameraRegistrationForCaptureFrame(
  registration: CameraRegistration | null | undefined,
  value: CameraCaptureFrame | null | undefined,
): CameraRegistration | null {
  if (!registration) return null;
  let frame: CameraCaptureFrame | null;
  try {
    frame = normaliseCameraCaptureFrame(value);
  } catch {
    return null;
  }
  if (!frame) return null;
  const captureFrameKey = cameraCaptureFrameKey(frame);
  if (registration.captureFrameKey) {
    return registration.captureFrameKey === captureFrameKey
      && registration.width === frame.outputWidth
      && registration.height === frame.outputHeight
      ? registration
      : null;
  }
  if (registration.width !== frame.sourceWidth || registration.height !== frame.sourceHeight) return null;
  const scaleX = frame.outputWidth / frame.sourceCropWidth;
  const scaleY = frame.outputHeight / frame.sourceCropHeight;
  const errorScale = Math.max(scaleX, scaleY);
  const scaleDepthChecks = (checks: CameraRegistration["reprojection"]["centre"]) => ({
    near: checks.near * errorScale,
    middle: checks.middle * errorScale,
    far: checks.far * errorScale,
  });
  try {
    return normaliseCameraRegistration({
      ...registration,
      schema: CAMERA_CAPTURE_REGISTRATION_SCHEMA,
      captureFrameKey,
      width: frame.outputWidth,
      height: frame.outputHeight,
      fx: registration.fx * scaleX,
      fy: registration.fy * scaleY,
      cx: (registration.cx - frame.sourceX) * scaleX,
      cy: (registration.cy - frame.sourceY) * scaleY,
      rms: registration.rms * errorScale,
      reprojection: {
        centre: scaleDepthChecks(registration.reprojection.centre),
        edges: scaleDepthChecks(registration.reprojection.edges),
        maximumRms: registration.reprojection.maximumRms * errorScale,
      },
    });
  } catch {
    return null;
  }
}

function safeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 16_384) {
    throw new Error("The camera capture frame is invalid");
  }
  return Number(value);
}
