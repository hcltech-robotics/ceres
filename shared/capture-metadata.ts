import { cameraRegistrationMatches, type CameraRegistration } from "./camera-registration.js";
import { cameraRegistrationForCaptureFrame } from "./camera-capture-frame.js";
import { generateDemonstratorDesignator } from "./demonstrator-designator.js";
import type { CaptureConfiguration, CaptureSensorSource, CaptureStatus, CameraSide, CaptureStudyMetadata } from "./protocol.js";

export const CAPTURE_METADATA_SCHEMA = "ceres-capture-metadata-v1" as const;
export const CAPTURE_METADATA_VERSION = 1 as const;

export type CaptureMetadataValue<T> =
  | { availability: "known"; value: T }
  | { availability: "unknown" }
  | { availability: "unavailable" };

export interface SavedCameraSelection {
  label: string;
  side: CameraSide;
}

export interface SavedCameraCalibration {
  model: "pinhole-radtan5";
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion: number[];
  rms: number;
  sampleCount: number;
  calibratedAt: string;
}

export interface CaptureMetadata {
  schema: typeof CAPTURE_METADATA_SCHEMA;
  version: typeof CAPTURE_METADATA_VERSION;
  camera: {
    selection: CaptureMetadataValue<SavedCameraSelection>;
    width: CaptureMetadataValue<number>;
    height: CaptureMetadataValue<number>;
    frameRate: CaptureMetadataValue<number>;
    calibration: CaptureMetadataValue<SavedCameraCalibration>;
  };
  device: {
    headsetModel: CaptureMetadataValue<string>;
    questBrowser: CaptureMetadataValue<boolean>;
    sensorSource: CaptureMetadataValue<CaptureSensorSource>;
    handTracking: CaptureMetadataValue<"waiting" | "active">;
  };
  recorder: {
    rateHz: CaptureMetadataValue<number>;
  };
  study: {
    headsetId: string | null;
    demonstratorId: string;
    demonstratorIdOrigin: "entered" | "generated";
    projectId: string | null;
    consentDate: string | null;
    consentDocumentId: string | null;
  };
  audio: {
    rawMicrophoneAudioRetained: boolean;
  };
}

export function captureMetadataFromStatus(
  status: CaptureStatus,
  registration: CameraRegistration | null | undefined,
  configuration?: Pick<CaptureConfiguration, "recordAudio" | "studyMetadata">,
): CaptureMetadata {
  const cameraReady = status.camera === "ready";
  const selection = !cameraReady
    ? unavailable<SavedCameraSelection>()
    : nonEmptyText(status.selectedCameraLabel)
      ? known({ label: status.selectedCameraLabel.trim(), side: status.selectedCameraSide })
      : unknown<SavedCameraSelection>();
  const outputRegistration = status.selectedCameraFrame
    ? cameraRegistrationForCaptureFrame(registration, status.selectedCameraFrame)
    : registration?.captureFrameKey ? null : registration ?? null;
  const registrationMatches = cameraRegistrationMatches(
    outputRegistration,
    status.selectedCameraDeviceId,
    status.selectedCameraSide,
    status.selectedCameraWidth,
    status.selectedCameraHeight,
  );

  return {
    schema: CAPTURE_METADATA_SCHEMA,
    version: CAPTURE_METADATA_VERSION,
    camera: {
      selection,
      width: numberValue(status.selectedCameraWidth, cameraReady, true),
      height: numberValue(status.selectedCameraHeight, cameraReady, true),
      frameRate: numberValue(status.selectedCameraFrameRate, cameraReady),
      calibration: !cameraReady
        ? unavailable<SavedCameraCalibration>()
        : registrationMatches && outputRegistration
          ? known(calibrationMetadata(outputRegistration))
          : unknown<SavedCameraCalibration>(),
    },
    device: {
      headsetModel: nonEmptyText(status.headsetModel)
        ? known(status.headsetModel.trim())
        : unknown<string>(),
      questBrowser: status.questBrowser === undefined
        ? unknown<boolean>()
        : known(status.questBrowser),
      sensorSource: status.sensorSource === undefined
        ? unknown<CaptureSensorSource>()
        : known(status.sensorSource),
      handTracking: status.handTracking === "unavailable"
        ? unavailable<"waiting" | "active">()
        : known(status.handTracking),
    },
    recorder: {
      rateHz: numberValue(status.recorderRateHz, true, true),
    },
    study: captureStudyMetadata(status, configuration?.studyMetadata),
    audio: {
      rawMicrophoneAudioRetained: configuration?.recordAudio !== false,
    },
  };
}

function captureStudyMetadata(
  status: CaptureStatus,
  source: CaptureStudyMetadata | undefined,
): CaptureMetadata["study"] {
  const headsetId = optionalText(source?.headsetId);
  const demonstratorId = optionalText(source?.demonstratorId);
  const generatedSeed = headsetId ?? status.selectedCameraDeviceId ?? status.headsetModel ?? "ceres-headset";
  return {
    headsetId,
    demonstratorId: demonstratorId ?? generateDemonstratorDesignator(generatedSeed),
    demonstratorIdOrigin: demonstratorId ? "entered" : "generated",
    projectId: optionalText(source?.projectId),
    consentDate: optionalText(source?.consentDate),
    consentDocumentId: optionalText(source?.consentDocumentId),
  };
}

function calibrationMetadata(registration: CameraRegistration): SavedCameraCalibration {
  return {
    model: "pinhole-radtan5",
    width: registration.width,
    height: registration.height,
    fx: registration.fx,
    fy: registration.fy,
    cx: registration.cx,
    cy: registration.cy,
    distortion: [...registration.distortion],
    rms: registration.rms,
    sampleCount: registration.sampleCount,
    calibratedAt: new Date(registration.calibratedAtMs).toISOString(),
  };
}

function numberValue(value: number | null, available: boolean, integer = false): CaptureMetadataValue<number> {
  if (!available) return unavailable<number>();
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    return unknown<number>();
  }
  return known(value);
}

function nonEmptyText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalText(value: string | null | undefined): string | null {
  return nonEmptyText(value) ? value.trim() : null;
}

function known<T>(value: T): CaptureMetadataValue<T> {
  return { availability: "known", value };
}

function unknown<T>(): CaptureMetadataValue<T> {
  return { availability: "unknown" };
}

function unavailable<T>(): CaptureMetadataValue<T> {
  return { availability: "unavailable" };
}
