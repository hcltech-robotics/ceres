import type { CalibrationObservation, CameraCalibrationResult } from "./camera-calibration.js";
import { solveCalibrationModel } from "./camera-calibration-solver.js";

const board = { cornersX: 11, cornersY: 7, squareSizeM: .03 } as const;
const cornerCount = board.cornersX * board.cornersY;

type WorkerRequest =
  | { type: "detect"; width: number; height: number; rgba: ArrayBuffer }
  | { type: "solve"; observations: CalibrationObservation[]; width: number; height: number };

const scope = globalThis as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<{ id: number; request: WorkerRequest }>) => void): void;
  postMessage(message: unknown): void;
};

scope.addEventListener("message", (event) => {
  const { id, request } = event.data;
  try {
    const result = request.type === "detect" ? detectCheckerboard(request) : solveIntrinsics(request);
    scope.postMessage({ id, ok: true, result });
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Camera calibration failed",
    });
  }
});

function detectCheckerboard(request: Extract<WorkerRequest, { type: "detect" }>): CalibrationObservation | null {
  const source = new Uint8ClampedArray(request.rgba);
  const scale = Math.max(1, request.width / 720, request.height / 480);
  const width = Math.max(1, Math.floor(request.width / scale));
  const height = Math.max(1, Math.floor(request.height / scale));
  const grey = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(request.height - 1, Math.floor(y * scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(request.width - 1, Math.floor(x * scale));
      const offset = (sourceY * request.width + sourceX) * 4;
      grey[y * width + x] = source[offset] * .299 + source[offset + 1] * .587 + source[offset + 2] * .114;
    }
  }

  const response = new Float32Array(width * height);
  const sampleCount = 24;
  const radii = [4, 7];
  for (let y = 8; y < height - 8; y += 1) for (let x = 8; x < width - 8; x += 1) {
    let score = Number.POSITIVE_INFINITY;
    for (const radius of radii) {
      let cosine = 0;
      let sine = 0;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const angle = sample / sampleCount * Math.PI * 2;
        const sx = Math.round(x + Math.cos(angle) * radius);
        const sy = Math.round(y + Math.sin(angle) * radius);
        const value = grey[sy * width + sx];
        cosine += value * Math.cos(angle * 2);
        sine += value * Math.sin(angle * 2);
      }
      score = Math.min(score, Math.hypot(cosine, sine) * 2 / sampleCount);
    }
    response[y * width + x] = score;
  }

  const candidates: Array<{ x: number; y: number; score: number }> = [];
  for (let y = 12; y < height - 12; y += 1) for (let x = 12; x < width - 12; x += 1) {
    const score = response[y * width + x];
    if (score < 22) continue;
    let maximum = true;
    for (let dy = -4; dy <= 4 && maximum; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      if ((dx || dy) && response[(y + dy) * width + x + dx] > score) {
        maximum = false;
        break;
      }
    }
    if (maximum) candidates.push({ x, y, score });
  }
  candidates.sort((left, right) => right.score - left.score);
  const spaced: typeof candidates = [];
  for (const candidate of candidates) {
    if (spaced.every((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) >= 10)) spaced.push(candidate);
    if (spaced.length >= cornerCount * 2) break;
  }
  if (spaced.length < cornerCount) return null;

  const ordered = orderGrid(spaced.slice(0, cornerCount));
  if (!ordered) return null;
  const corners = ordered.flatMap((point) => [point.x * scale, point.y * scale]);
  return describeObservation(corners);
}

function orderGrid(points: Array<{ x: number; y: number }>) {
  const centreX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centreY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const x = point.x - centreX;
    const y = point.y - centreY;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const angle = .5 * Math.atan2(2 * xy, xx - yy);
  let ux = Math.cos(angle);
  let uy = Math.sin(angle);
  if (ux < 0) { ux = -ux; uy = -uy; }
  let vx = -uy;
  let vy = ux;
  if (vy < 0) { vx = -vx; vy = -vy; }
  const projected = points.map((point) => ({
    ...point,
    u: (point.x - centreX) * ux + (point.y - centreY) * uy,
    v: (point.x - centreX) * vx + (point.y - centreY) * vy,
  })).sort((left, right) => left.v - right.v);
  const ordered: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < board.cornersY; row += 1) {
    const rowPoints = projected.slice(row * board.cornersX, (row + 1) * board.cornersX).sort((left, right) => left.u - right.u);
    ordered.push(...rowPoints);
  }
  const homography = fitHomography(ordered.map((point, index) => ({
    worldX: index % board.cornersX,
    worldY: Math.floor(index / board.cornersX),
    imageX: point.x,
    imageY: point.y,
  })));
  const rms = homographyRms(homography, ordered);
  const spacing = median(ordered.flatMap((point, index) => {
    const column = index % board.cornersX;
    return column ? [Math.hypot(point.x - ordered[index - 1].x, point.y - ordered[index - 1].y)] : [];
  }));
  return Number.isFinite(rms) && rms <= Math.max(2, spacing * .28) ? ordered : null;
}

function solveIntrinsics(request: Extract<WorkerRequest, { type: "solve" }>): CameraCalibrationResult {
  return solveCalibrationModel(request.observations, request.width, request.height);
}

function fitHomography(points: Array<{ worldX: number; worldY: number; imageX: number; imageY: number }>) {
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const target = Array(8).fill(0);
  for (const point of points) {
    const rows = [
      { coefficients: [point.worldX, point.worldY, 1, 0, 0, 0, -point.imageX * point.worldX, -point.imageX * point.worldY], value: point.imageX },
      { coefficients: [0, 0, 0, point.worldX, point.worldY, 1, -point.imageY * point.worldX, -point.imageY * point.worldY], value: point.imageY },
    ];
    for (const row of rows) for (let left = 0; left < 8; left += 1) {
      target[left] += row.coefficients[left] * row.value;
      for (let right = 0; right < 8; right += 1) normal[left][right] += row.coefficients[left] * row.coefficients[right];
    }
  }
  for (let index = 0; index < 8; index += 1) normal[index][index] += 1e-9;
  return [...solveLinear(normal, target), 1];
}

function solveLinear(matrix: number[][], target: number[]) {
  const augmented = matrix.map((row, index) => [...row, target[index]]);
  for (let column = 0; column < target.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < target.length; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error("Calibration geometry is singular");
    for (let entry = column; entry <= target.length; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < target.length; row += 1) if (row !== column) {
      const factor = augmented[row][column];
      for (let entry = column; entry <= target.length; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row[target.length]);
}

function homographyRms(homography: number[], points: Array<{ x: number; y: number }>) {
  let squaredError = 0;
  for (let index = 0; index < points.length; index += 1) {
    const worldX = index % board.cornersX;
    const worldY = Math.floor(index / board.cornersX);
    const divisor = homography[6] * worldX + homography[7] * worldY + 1;
    const x = (homography[0] * worldX + homography[1] * worldY + homography[2]) / divisor;
    const y = (homography[3] * worldX + homography[4] * worldY + homography[5]) / divisor;
    squaredError += (x - points[index].x) ** 2 + (y - points[index].y) ** 2;
  }
  return Math.sqrt(squaredError / points.length);
}

function describeObservation(corners: number[]): CalibrationObservation {
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
  const end = (board.cornersX - 1) * 2;
  const bottomLeft = (board.cornersY - 1) * board.cornersX * 2;
  const bottomRight = bottomLeft + end;
  const topWidth = Math.hypot(corners[end] - corners[0], corners[end + 1] - corners[1]);
  const bottomWidth = Math.hypot(corners[bottomRight] - corners[bottomLeft], corners[bottomRight + 1] - corners[bottomLeft + 1]);
  const leftHeight = Math.hypot(corners[bottomLeft] - corners[0], corners[bottomLeft + 1] - corners[1]);
  const rightHeight = Math.hypot(corners[bottomRight] - corners[end], corners[bottomRight + 1] - corners[end + 1]);
  return {
    corners,
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

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
