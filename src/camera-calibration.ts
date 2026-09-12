import type { CalibrationReprojectionChecks } from "../shared/camera-registration.js";
import { workerErrorFromEvent } from "./worker-errors.js";


export const calibrationBoard = {
  squaresX: 12,
  squaresY: 8,
  cornersX: 11,
  cornersY: 7,
  squareSizeM: .03,
} as const;

export const calibrationViewTarget = 18;

export type CalibrationDepth = "near" | "middle" | "far";

export interface CalibrationObservation {
  corners: number[];
  centroidX: number;
  centroidY: number;
  scale: number;
  angle: number;
  perspective: number;
}

export interface CameraCalibrationResult {
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
}

export interface CalibrationCoverage {
  ready: boolean;
  missing: string[];
}

type CalibrationWorkerRequest =
  | { type: "detect"; width: number; height: number; rgba: ArrayBuffer }
  | { type: "solve"; observations: CalibrationObservation[]; width: number; height: number };

type CalibrationWorkerResponse =
  | { id: number; ok: true; result: CalibrationObservation | CameraCalibrationResult | null }
  | { id: number; ok: false; error: string };

let calibrationWorker: Worker | null = null;
let calibrationRequestId = 0;
const calibrationRequests = new Map<number, {
  resolve: (value: CalibrationObservation | CameraCalibrationResult | null) => void;
  reject: (error: Error) => void;
}>();

export async function captureCalibrationObservation(video: HTMLVideoElement): Promise<CalibrationObservation | null> {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Camera calibration canvas is unavailable");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return await requestCalibrationWorker({
    type: "detect",
    width: canvas.width,
    height: canvas.height,
    rgba: image.data.buffer as ArrayBuffer,
  }, [image.data.buffer as ArrayBuffer]) as CalibrationObservation | null;
}

export async function solveCameraIntrinsics(
  observations: readonly CalibrationObservation[],
  width: number,
  height: number,
): Promise<CameraCalibrationResult> {
  if (observations.length < calibrationViewTarget) {
    throw new Error(`At least ${calibrationViewTarget} calibration views are required`);
  }
  const expectedValues = calibrationBoard.cornersX * calibrationBoard.cornersY * 2;
  if (observations.some((observation) => observation.corners.length !== expectedValues)) {
    throw new Error("Calibration observations do not match the board dimensions");
  }
  assertCalibrationCoverage(observations, width, height);
  const result = await requestCalibrationWorker({
    type: "solve",
    observations: observations.map((observation) => ({ ...observation, corners: [...observation.corners] })),
    width,
    height,
  }) as CameraCalibrationResult;
  assertCalibrationResult(result);
  return result;
}

export function describeObservation(corners: readonly number[]): CalibrationObservation {
  if (corners.length < 8 || corners.length % 2 !== 0) throw new Error("Calibration corner coordinates are invalid");
  let centroidX = 0;
  let centroidY = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < corners.length; index += 2) {
    const x = corners[index];
    const y = corners[index + 1];
    centroidX += x;
    centroidY += y;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const count = corners.length / 2;
  const end = (calibrationBoard.cornersX - 1) * 2;
  const bottomLeft = (calibrationBoard.cornersY - 1) * calibrationBoard.cornersX * 2;
  const bottomRight = bottomLeft + end;
  const topWidth = Math.hypot(corners[end] - corners[0], corners[end + 1] - corners[1]);
  const bottomWidth = Math.hypot(
    corners[bottomRight] - corners[bottomLeft],
    corners[bottomRight + 1] - corners[bottomLeft + 1],
  );
  const leftHeight = Math.hypot(corners[bottomLeft] - corners[0], corners[bottomLeft + 1] - corners[1]);
  const rightHeight = Math.hypot(corners[bottomRight] - corners[end], corners[bottomRight + 1] - corners[end + 1]);
  return {
    corners: [...corners],
    centroidX: centroidX / count,
    centroidY: centroidY / count,
    scale: Math.sqrt(Math.max(0, (maxX - minX) * (maxY - minY))),
    angle: Math.atan2(corners[end + 1] - corners[1], corners[end] - corners[0]),
    perspective: Math.max(
      Math.abs(Math.log(Math.max(1, topWidth) / Math.max(1, bottomWidth))),
      Math.abs(Math.log(Math.max(1, leftHeight) / Math.max(1, rightHeight))),
    ),
  };
}

export function calibrationDepthThresholds(observations: readonly CalibrationObservation[]) {
  const scales = observations.map((observation) => observation.scale).filter((scale) => Number.isFinite(scale) && scale > 0);
  const minimum = Math.min(...scales);
  const maximum = Math.max(...scales);
  const logMinimum = Math.log(minimum);
  const logMaximum = Math.log(maximum);
  return {
    minimum,
    maximum,
    farMiddle: Math.exp(logMinimum + (logMaximum - logMinimum) / 3),
    middleNear: Math.exp(logMinimum + (logMaximum - logMinimum) * 2 / 3),
  };
}

export function calibrationDepthForScale(
  scale: number,
  thresholds: ReturnType<typeof calibrationDepthThresholds>,
): CalibrationDepth {
  if (scale <= thresholds.farMiddle) return "far";
  if (scale >= thresholds.middleNear) return "near";
  return "middle";
}

export function isCentreCalibrationObservation(observation: CalibrationObservation, width: number, height: number) {
  const x = observation.centroidX / Math.max(1, width);
  const y = observation.centroidY / Math.max(1, height);
  return x >= .3 && x <= .7 && y >= .3 && y <= .7;
}

export function analyseCalibrationCoverage(
  observations: readonly CalibrationObservation[],
  width: number,
  height: number,
): CalibrationCoverage {
  const missing: string[] = [];
  if (observations.length < calibrationViewTarget) {
    missing.push(`${calibrationViewTarget - observations.length} more varied views`);
  }
  if (!(width > 0 && height > 0)) return { ready: false, missing: ["valid capture dimensions"] };
  if (!observations.length) return { ready: false, missing };

  const horizontal = observations.map((observation) => observation.centroidX / width);
  const vertical = observations.map((observation) => observation.centroidY / height);
  if (!horizontal.some((value) => value <= .38)) missing.push("a view towards the left edge");
  if (!horizontal.some((value) => value >= .62)) missing.push("a view towards the right edge");
  if (!vertical.some((value) => value <= .38)) missing.push("a view towards the top edge");
  if (!vertical.some((value) => value >= .62)) missing.push("a view towards the bottom edge");
  if (!observations.some((observation) => isCentreCalibrationObservation(observation, width, height))) {
    missing.push("a view near the frame centre");
  }

  const thresholds = calibrationDepthThresholds(observations);
  if (!Number.isFinite(thresholds.minimum)
    || !Number.isFinite(thresholds.maximum)
    || thresholds.maximum / Math.max(1, thresholds.minimum) < 1.55) {
    missing.push("clearly separated near, middle and far distances");
  } else {
    const cells = new Set(observations.map((observation) => {
      const region = isCentreCalibrationObservation(observation, width, height) ? "centre" : "edges";
      return `${region}-${calibrationDepthForScale(observation.scale, thresholds)}`;
    }));
    for (const region of ["centre", "edges"] as const) for (const depth of ["near", "middle", "far"] as const) {
      if (!cells.has(`${region}-${depth}`)) missing.push(`a ${depth} view near the frame ${region}`);
    }
  }

  let maximumAngleChange = 0;
  for (let left = 0; left < observations.length; left += 1) for (let right = left + 1; right < observations.length; right += 1) {
    const difference = observations[left].angle - observations[right].angle;
    maximumAngleChange = Math.max(maximumAngleChange, Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference))));
  }
  if (maximumAngleChange < .2) missing.push("more board rotation");
  if (Math.max(...observations.map((observation) => observation.perspective)) < .08) missing.push("a stronger board tilt");
  return { ready: missing.length === 0, missing };
}

export function calibrationCoverageGuidance(
  observations: readonly CalibrationObservation[],
  width: number,
  height: number,
) {
  const missing = analyseCalibrationCoverage(observations, width, height).missing;
  return missing.find((message) => !message.endsWith("more varied views")) ?? missing[0] ?? "coverage complete";
}

export function assertCalibrationCoverage(
  observations: readonly CalibrationObservation[],
  width: number,
  height: number,
): void {
  const coverage = analyseCalibrationCoverage(observations, width, height);
  if (coverage.ready) return;
  throw new Error(`Calibration sample coverage is incomplete: ${coverage.missing.join("; ")}. Retry and cover the full frame at varied angles and distances.`);
}

export function isNovelCalibrationObservation(
  candidate: CalibrationObservation,
  accepted: readonly CalibrationObservation[],
  width: number,
  height: number,
): boolean {
  const diagonal = Math.hypot(width, height) || 1;
  return accepted.every((previous) => {
    const centreDistance = Math.hypot(candidate.centroidX - previous.centroidX, candidate.centroidY - previous.centroidY) / diagonal;
    const scaleChange = Math.abs(Math.log(Math.max(1, candidate.scale) / Math.max(1, previous.scale)));
    const angleChange = Math.abs(Math.atan2(Math.sin(candidate.angle - previous.angle), Math.cos(candidate.angle - previous.angle)));
    const perspectiveChange = Math.abs(candidate.perspective - previous.perspective);
    return centreDistance >= .035 || scaleChange >= .045 || angleChange >= .055 || perspectiveChange >= .03;
  });
}

export function assertCalibrationResult(result: CameraCalibrationResult): void {
  const reprojectionValues = [
    result.reprojection.centre.near,
    result.reprojection.centre.middle,
    result.reprojection.centre.far,
    result.reprojection.edges.near,
    result.reprojection.edges.middle,
    result.reprojection.edges.far,
    result.reprojection.maximumRms,
  ];
  const values = [result.fx, result.fy, result.cx, result.cy, result.rms, ...result.distortion, ...reprojectionValues];
  if (result.width <= 0 || result.height <= 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Camera calibration returned non-finite values");
  }
  if (result.fx <= 0 || result.fy <= 0 || result.cx < 0 || result.cx > result.width || result.cy < 0 || result.cy > result.height) {
    throw new Error("Camera calibration returned an invalid pinhole model");
  }
  if (result.distortion.length !== 5
    || Math.abs(result.distortion[0]) > 1.5
    || Math.abs(result.distortion[1]) > 1.5
    || Math.abs(result.distortion[2]) > .25
    || Math.abs(result.distortion[3]) > .25
    || Math.abs(result.distortion[4]) > 1.5) {
    throw new Error("Camera calibration returned an invalid distortion model");
  }
  if (result.sampleCount < calibrationViewTarget) throw new Error("Camera calibration used too few views");
  if (result.rms < 0 || result.rms > 4) throw new Error(`Camera calibration reprojection error is too high (${result.rms.toFixed(2)} px)`);
  if (Math.abs(Math.max(...reprojectionValues.slice(0, 6)) - result.reprojection.maximumRms) > 1e-6) {
    throw new Error("Camera calibration regional reprojection checks are inconsistent");
  }
  if (result.reprojection.maximumRms > 6) {
    throw new Error(`Camera calibration has a poorly aligned frame region (${result.reprojection.maximumRms.toFixed(2)} px RMS)`);
  }
}

function requestCalibrationWorker(request: CalibrationWorkerRequest, transfer: Transferable[] = []) {
  const worker = getCalibrationWorker();
  const id = ++calibrationRequestId;
  return new Promise<CalibrationObservation | CameraCalibrationResult | null>((resolve, reject) => {
    calibrationRequests.set(id, { resolve, reject });
    worker.postMessage({ id, request }, transfer);
  });
}

function getCalibrationWorker() {
  if (calibrationWorker) return calibrationWorker;
  const worker = new Worker(new URL("./camera-calibration.worker.ts", import.meta.url), {
    type: "module",
    name: "ceres-camera-calibration",
  });
  let workerFailed = false;
  const failWorker = (error: Error, stage: "protocol" | "worker_crash") => {
    if (workerFailed) return;
    workerFailed = true;    for (const pending of calibrationRequests.values()) pending.reject(error);
    calibrationRequests.clear();
    if (calibrationWorker === worker) calibrationWorker = null;
    worker.terminate();
  };
  worker.addEventListener("message", (event: MessageEvent<CalibrationWorkerResponse>) => {
    const response = event.data;
    const pending = calibrationRequests.get(response.id);
    if (!pending) return;
    calibrationRequests.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else {
      const error = new Error(response.error);      pending.reject(error);
    }
  });
  worker.addEventListener("error", (event) => {
    const candidate = workerErrorFromEvent(event);
    const error = candidate instanceof Error
      ? candidate
      : new Error("Camera calibration worker stopped");
    failWorker(error, "worker_crash");
  });
  worker.addEventListener("messageerror", () => {
    failWorker(new Error("Camera calibration worker returned an unreadable response"), "protocol");
  });
  calibrationWorker = worker;
  return worker;
}
