import {
  assertCalibrationCoverage,
  calibrationBoard,
  calibrationDepthForScale,
  calibrationDepthThresholds,
  isCentreCalibrationObservation,
  type CalibrationDepth,
  type CalibrationObservation,
  type CameraCalibrationResult,
} from "./camera-calibration.js";

interface CameraModel {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion: [number, number, number, number, number];
}

interface BoardPose {
  rotation: number[];
  translation: [number, number, number];
}

interface ErrorTotal {
  squared: number;
  count: number;
}

const pointCount = calibrationBoard.cornersX * calibrationBoard.cornersY;

export function solveCalibrationModel(
  observations: readonly CalibrationObservation[],
  width: number,
  height: number,
): CameraCalibrationResult {
  assertCalibrationCoverage(observations, width, height);
  const initial = initialiseLensModel(observations, width, height);
  let camera = initial.camera;
  const homographies = initial.homographies;
  let poses = homographies.map((homography) => poseFromHomography(homography, camera));

  for (let round = 0; round < 2; round += 1) {
    poses = observations.map((observation, index) => optimisePose(observation, camera, poses[index]));
    const optimised = optimiseCameraAndPoses(observations, poses, camera, width, height);
    camera = optimised.camera;
    poses = optimised.poses;
  }
  poses = observations.map((observation, index) => optimisePose(observation, camera, poses[index]));

  const checks = reprojectionChecks(observations, poses, camera, width, height);
  return {
    width,
    height,
    fx: camera.fx,
    fy: camera.fy,
    cx: camera.cx,
    cy: camera.cy,
    distortion: [...camera.distortion],
    rms: checks.rms,
    sampleCount: observations.length,
    reprojection: checks.reprojection,
  };
}

function initialiseLensModel(observations: readonly CalibrationObservation[], width: number, height: number) {
  let homographies = observations.map((observation) => fitHomography(observationPoints(observation)));
  let camera: CameraModel = {
    ...initialIntrinsics(homographies, width, height),
    distortion: [0, 0, 0, 0, 0],
  };
  for (let iteration = 0; iteration < 4; iteration += 1) {
    camera = { ...camera, distortion: optimiseStraightLineDistortion(observations, camera) };
    homographies = observations.map((observation) => fitHomography(undistortedObservationPoints(observation, camera)));
    camera = { ...initialIntrinsics(homographies, width, height), distortion: camera.distortion };
  }
  return { camera, homographies };
}

function optimiseStraightLineDistortion(
  observations: readonly CalibrationObservation[],
  camera: CameraModel,
): CameraModel["distortion"] {
  const values: CameraModel["distortion"] = [...camera.distortion];
  const steps = [.04, .025, .003, .003, .012];
  let error = straightLineError(observations, { ...camera, distortion: values });
  for (let iteration = 0; iteration < 55; iteration += 1) {
    let improved = false;
    for (let axis = 0; axis < values.length; axis += 1) for (const direction of [-1, 1]) {
      const candidate: CameraModel["distortion"] = [...values];
      candidate[axis] += steps[axis] * direction;
      if (Math.abs(candidate[0]) > 1.5 || Math.abs(candidate[1]) > 1.5
        || Math.abs(candidate[2]) > .25 || Math.abs(candidate[3]) > .25 || Math.abs(candidate[4]) > 1.5) continue;
      const nextError = straightLineError(observations, { ...camera, distortion: candidate });
      if (nextError < error) {
        values.splice(0, values.length, ...candidate);
        error = nextError;
        improved = true;
      }
    }
    if (!improved) for (let axis = 0; axis < steps.length; axis += 1) steps[axis] *= .58;
    if (Math.max(...steps) < 1e-6) break;
  }
  return values;
}

function straightLineError(observations: readonly CalibrationObservation[], camera: CameraModel) {
  let squared = 0;
  let count = 0;
  for (const observation of observations) {
    const points = Array.from({ length: pointCount }, (_, index) => undistortPixel(
      observation.corners[index * 2],
      observation.corners[index * 2 + 1],
      camera,
    ));
    for (let row = 0; row < calibrationBoard.cornersY; row += 1) {
      const line = points.slice(row * calibrationBoard.cornersX, (row + 1) * calibrationBoard.cornersX);
      const error = lineStraightness(line);
      squared += error.squared;
      count += error.count;
    }
    for (let column = 0; column < calibrationBoard.cornersX; column += 1) {
      const line = Array.from({ length: calibrationBoard.cornersY }, (_, row) => points[row * calibrationBoard.cornersX + column]);
      const error = lineStraightness(line);
      squared += error.squared;
      count += error.count;
    }
  }
  const [k1, k2, p1, p2, k3] = camera.distortion;
  return squared / Math.max(1, count) + 1e-9 * (k1 * k1 + k2 * k2 + 4 * p1 * p1 + 4 * p2 * p2 + k3 * k3);
}

function lineStraightness(points: Array<[number, number]>): ErrorTotal {
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const length2 = Math.max(1e-12, dx * dx + dy * dy);
  let squared = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const crossValue = (points[index][0] - first[0]) * dy - (points[index][1] - first[1]) * dx;
    squared += crossValue * crossValue / length2;
  }
  return { squared, count: Math.max(0, points.length - 2) };
}

function undistortedObservationPoints(observation: CalibrationObservation, camera: CameraModel) {
  const points: Array<{ worldX: number; worldY: number; imageX: number; imageY: number }> = [];
  for (let index = 0; index < pointCount; index += 1) {
    const [imageX, imageY] = undistortPixel(observation.corners[index * 2], observation.corners[index * 2 + 1], camera);
    points.push({
      worldX: index % calibrationBoard.cornersX,
      worldY: Math.floor(index / calibrationBoard.cornersX),
      imageX,
      imageY,
    });
  }
  return points;
}

function undistortPixel(pixelX: number, pixelY: number, camera: CameraModel): [number, number] {
  const distortedX = (pixelX - camera.cx) / camera.fx;
  const distortedY = (pixelY - camera.cy) / camera.fy;
  let x = distortedX;
  let y = distortedY;
  const [k1, k2, p1, p2, k3] = camera.distortion;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const radius2 = x * x + y * y;
    const radial = 1 + k1 * radius2 + k2 * radius2 * radius2 + k3 * radius2 * radius2 * radius2;
    if (Math.abs(radial) < 1e-6) break;
    const tangentialX = 2 * p1 * x * y + p2 * (radius2 + 2 * x * x);
    const tangentialY = p1 * (radius2 + 2 * y * y) + 2 * p2 * x * y;
    x = (distortedX - tangentialX) / radial;
    y = (distortedY - tangentialY) / radial;
  }
  return [camera.fx * x + camera.cx, camera.fy * y + camera.cy];
}

function observationPoints(observation: CalibrationObservation) {
  const points: Array<{ worldX: number; worldY: number; imageX: number; imageY: number }> = [];
  for (let index = 0; index < observation.corners.length; index += 2) {
    const corner = index / 2;
    points.push({
      worldX: corner % calibrationBoard.cornersX,
      worldY: Math.floor(corner / calibrationBoard.cornersX),
      imageX: observation.corners[index],
      imageY: observation.corners[index + 1],
    });
  }
  return points;
}

function initialIntrinsics(homographies: number[][], width: number, height: number) {
  let best = { values: [width, width, width / 2, height / 2], error: Number.POSITIVE_INFINITY };
  for (const factor of [.55, .8, 1.1, 1.5]) {
    const values = [width * factor, width * factor, width / 2, height / 2];
    const steps = [width * .22, width * .22, width * .12, height * .12];
    let error = intrinsicConstraintError(values, homographies);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      let improved = false;
      for (const axes of [[0], [1], [2], [3], [0, 1]]) for (const direction of [-1, 1]) {
        const candidate = [...values];
        for (const axis of axes) candidate[axis] += steps[axis] * direction;
        if (!validIntrinsics(candidate, width, height)) continue;
        const nextError = intrinsicConstraintError(candidate, homographies);
        if (nextError < error) {
          values.splice(0, values.length, ...candidate);
          error = nextError;
          improved = true;
        }
      }
      if (!improved) for (let axis = 0; axis < steps.length; axis += 1) steps[axis] *= .62;
      if (Math.max(...steps) < .005) break;
    }
    if (error < best.error) best = { values, error };
  }
  if (!Number.isFinite(best.error) || best.error > .025) {
    throw new Error("Calibration views do not contain enough perspective variation. Retry with the board tilted in several directions.");
  }
  const [fx, fy, cx, cy] = best.values;
  return { fx, fy, cx, cy };
}

function validIntrinsics(values: number[], width: number, height: number) {
  return values[0] >= width * .2 && values[0] <= width * 4
    && values[1] >= width * .2 && values[1] <= width * 4
    && values[2] >= 0 && values[2] <= width
    && values[3] >= 0 && values[3] <= height;
}

function intrinsicConstraintError([fx, fy, cx, cy]: number[], homographies: number[][]) {
  let error = 0;
  for (const homography of homographies) {
    const first = inverseIntrinsicColumn(homography[0], homography[3], homography[6], fx, fy, cx, cy);
    const second = inverseIntrinsicColumn(homography[1], homography[4], homography[7], fx, fy, cx, cy);
    const aa = dot(first, first);
    const bb = dot(second, second);
    const ab = dot(first, second);
    error += ab * ab / Math.max(1e-12, aa * bb)
      + (aa - bb) * (aa - bb) / Math.max(1e-12, (aa + bb) * (aa + bb));
  }
  return error / homographies.length;
}

function inverseIntrinsicColumn(
  x: number,
  y: number,
  z: number,
  fx: number,
  fy: number,
  cx: number,
  cy: number,
) {
  return [(x - cx * z) / fx, (y - cy * z) / fy, z];
}

function poseFromHomography(homography: number[], camera: CameraModel): BoardPose {
  let first = inverseIntrinsicColumn(homography[0], homography[3], homography[6], camera.fx, camera.fy, camera.cx, camera.cy);
  let second = inverseIntrinsicColumn(homography[1], homography[4], homography[7], camera.fx, camera.fy, camera.cx, camera.cy);
  let translation = inverseIntrinsicColumn(homography[2], homography[5], 1, camera.fx, camera.fy, camera.cx, camera.cy);
  const scale = 2 / Math.max(1e-12, magnitude(first) + magnitude(second));
  first = first.map((value) => value * scale);
  second = second.map((value) => value * scale);
  translation = translation.map((value) => value * scale);
  if (translation[2] < 0) {
    first = first.map((value) => -value);
    second = second.map((value) => -value);
    translation = translation.map((value) => -value);
  }
  const firstUnit = normalise(first);
  const projection = dot(firstUnit, second);
  const secondUnit = normalise(second.map((value, index) => value - firstUnit[index] * projection));
  const thirdUnit = cross(firstUnit, secondUnit);
  return {
    rotation: [
      firstUnit[0], secondUnit[0], thirdUnit[0],
      firstUnit[1], secondUnit[1], thirdUnit[1],
      firstUnit[2], secondUnit[2], thirdUnit[2],
    ],
    translation: [translation[0], translation[1], translation[2]],
  };
}

function optimisePose(observation: CalibrationObservation, camera: CameraModel, initial: BoardPose, maximumIterations = 55) {
  let pose = clonePose(initial);
  let error = reprojectionError(observation, camera, pose).squared;
  const depth = Math.max(1, Math.abs(pose.translation[2]));
  const steps = [.025, .025, .025, depth * .012, depth * .012, depth * .018];
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    let improved = false;
    for (let axis = 0; axis < steps.length; axis += 1) for (const direction of [-1, 1]) {
      const candidate = axis < 3
        ? rotatePose(pose, axis, steps[axis] * direction)
        : translatePose(pose, axis - 3, steps[axis] * direction);
      if (candidate.translation[2] <= .1) continue;
      const nextError = reprojectionError(observation, camera, candidate).squared;
      if (nextError < error) {
        pose = candidate;
        error = nextError;
        improved = true;
      }
    }
    if (!improved) for (let axis = 0; axis < steps.length; axis += 1) steps[axis] *= .58;
    if (Math.max(...steps) < 1e-5) break;
  }
  return pose;
}

function optimiseCameraAndPoses(
  observations: readonly CalibrationObservation[],
  initialPoses: readonly BoardPose[],
  initial: CameraModel,
  width: number,
  height: number,
) {
  const values = cameraValues(initial);
  let poses = initialPoses.map(clonePose);
  const steps = [width * .025, width * .025, width * .01, height * .01, .025, .018, .004, .004, .012];
  let error = totalReprojectionError(observations, poses, cameraFromValues(values)).squared;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    let improved = false;
    for (const axes of [[4], [5], [6], [7], [8], [0], [1], [2], [3], [0, 1]]) for (const direction of [-1, 1]) {
      const candidate = [...values];
      for (const axis of axes) candidate[axis] += steps[axis] * direction;
      if (!validCameraValues(candidate, width, height)) continue;
      const candidateCamera = cameraFromValues(candidate);
      const adaptedPoses = adaptPoses(poses, cameraFromValues(values), candidateCamera);
      const candidatePoses = observations.map((observation, index) => optimisePose(
        observation,
        candidateCamera,
        adaptedPoses[index],
        2,
      ));
      const nextError = totalReprojectionError(observations, candidatePoses, candidateCamera).squared;
      if (nextError < error) {
        values.splice(0, values.length, ...candidate);
        poses = candidatePoses;
        error = nextError;
        improved = true;
      }
    }
    if (!improved) for (let axis = 0; axis < steps.length; axis += 1) steps[axis] *= .58;
    if (Math.max(steps[0], steps[1], steps[2], steps[3]) < .005
      && Math.max(...steps.slice(4)) < 1e-5) break;
  }
  return { camera: cameraFromValues(values), poses };
}

function adaptPoses(poses: readonly BoardPose[], previous: CameraModel, next: CameraModel) {
  const scale = Math.sqrt(next.fx / previous.fx * next.fy / previous.fy);
  return poses.map((pose) => {
    const translation: [number, number, number] = [
      pose.translation[0] * scale,
      pose.translation[1] * scale,
      pose.translation[2] * scale,
    ];
    translation[0] += (previous.cx - next.cx) * translation[2] / next.fx;
    translation[1] += (previous.cy - next.cy) * translation[2] / next.fy;
    return { rotation: [...pose.rotation], translation };
  });
}

function cameraValues(camera: CameraModel) {
  return [camera.fx, camera.fy, camera.cx, camera.cy, ...camera.distortion];
}

function cameraFromValues(values: number[]): CameraModel {
  return {
    fx: values[0],
    fy: values[1],
    cx: values[2],
    cy: values[3],
    distortion: [values[4], values[5], values[6], values[7], values[8]],
  };
}

function validCameraValues(values: number[], width: number, height: number) {
  return validIntrinsics(values, width, height)
    && Math.abs(values[4]) <= 1.5
    && Math.abs(values[5]) <= 1.5
    && Math.abs(values[6]) <= .25
    && Math.abs(values[7]) <= .25
    && Math.abs(values[8]) <= 1.5;
}

function reprojectionError(observation: CalibrationObservation, camera: CameraModel, pose: BoardPose): ErrorTotal {
  let squared = 0;
  let count = 0;
  for (let index = 0; index < observation.corners.length; index += 2) {
    const corner = index / 2;
    const projected = projectBoardPoint(
      corner % calibrationBoard.cornersX,
      Math.floor(corner / calibrationBoard.cornersX),
      camera,
      pose,
    );
    if (!projected) return { squared: Number.POSITIVE_INFINITY, count: pointCount };
    squared += (projected[0] - observation.corners[index]) ** 2
      + (projected[1] - observation.corners[index + 1]) ** 2;
    count += 1;
  }
  return { squared, count };
}

function totalReprojectionError(
  observations: readonly CalibrationObservation[],
  poses: readonly BoardPose[],
  camera: CameraModel,
) {
  return observations.reduce<ErrorTotal>((total, observation, index) => {
    const current = reprojectionError(observation, camera, poses[index]);
    total.squared += current.squared;
    total.count += current.count;
    return total;
  }, { squared: 0, count: 0 });
}

function projectBoardPoint(worldX: number, worldY: number, camera: CameraModel, pose: BoardPose): [number, number] | null {
  const rotation = pose.rotation;
  const cameraX = rotation[0] * worldX + rotation[1] * worldY + pose.translation[0];
  const cameraY = rotation[3] * worldX + rotation[4] * worldY + pose.translation[1];
  const cameraZ = rotation[6] * worldX + rotation[7] * worldY + pose.translation[2];
  if (cameraZ <= 1e-6) return null;
  const x = cameraX / cameraZ;
  const y = cameraY / cameraZ;
  const radius2 = x * x + y * y;
  const [k1, k2, p1, p2, k3] = camera.distortion;
  const radial = 1 + k1 * radius2 + k2 * radius2 * radius2 + k3 * radius2 * radius2 * radius2;
  return [
    camera.fx * (x * radial + 2 * p1 * x * y + p2 * (radius2 + 2 * x * x)) + camera.cx,
    camera.fy * (y * radial + p1 * (radius2 + 2 * y * y) + 2 * p2 * x * y) + camera.cy,
  ];
}

function reprojectionChecks(
  observations: readonly CalibrationObservation[],
  poses: readonly BoardPose[],
  camera: CameraModel,
  width: number,
  height: number,
) {
  const depths = calibrationDepthThresholds(observations);
  const cells: Record<"centre" | "edges", Record<CalibrationDepth, ErrorTotal>> = {
    centre: { near: { squared: 0, count: 0 }, middle: { squared: 0, count: 0 }, far: { squared: 0, count: 0 } },
    edges: { near: { squared: 0, count: 0 }, middle: { squared: 0, count: 0 }, far: { squared: 0, count: 0 } },
  };
  const total = { squared: 0, count: 0 };
  observations.forEach((observation, index) => {
    const current = reprojectionError(observation, camera, poses[index]);
    const region = isCentreCalibrationObservation(observation, width, height) ? "centre" : "edges";
    const depth = calibrationDepthForScale(observation.scale, depths);
    cells[region][depth].squared += current.squared;
    cells[region][depth].count += current.count;
    total.squared += current.squared;
    total.count += current.count;
  });
  const rms = (value: ErrorTotal) => Math.sqrt(value.squared / Math.max(1, value.count));
  const centre = { near: rms(cells.centre.near), middle: rms(cells.centre.middle), far: rms(cells.centre.far) };
  const edges = { near: rms(cells.edges.near), middle: rms(cells.edges.middle), far: rms(cells.edges.far) };
  return {
    rms: rms(total),
    reprojection: {
      centre,
      edges,
      maximumRms: Math.max(...Object.values(centre), ...Object.values(edges)),
    },
  };
}

function clonePose(pose: BoardPose): BoardPose {
  return { rotation: [...pose.rotation], translation: [...pose.translation] };
}

function rotatePose(pose: BoardPose, axis: number, angle: number): BoardPose {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const delta = axis === 0
    ? [1, 0, 0, 0, cosine, -sine, 0, sine, cosine]
    : axis === 1
      ? [cosine, 0, sine, 0, 1, 0, -sine, 0, cosine]
      : [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1];
  return { rotation: multiplyRotation(delta, pose.rotation), translation: [...pose.translation] };
}

function translatePose(pose: BoardPose, axis: number, distance: number): BoardPose {
  const translation: [number, number, number] = [...pose.translation];
  translation[axis] += distance;
  return { rotation: [...pose.rotation], translation };
}

function multiplyRotation(left: number[], right: number[]) {
  const result = Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
    for (let entry = 0; entry < 3; entry += 1) result[row * 3 + column] += left[row * 3 + entry] * right[entry * 3 + column];
  }
  return result;
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
    for (let row = column + 1; row < target.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error("Calibration geometry is singular. Retry with more varied board positions and tilts.");
    for (let entry = column; entry <= target.length; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < target.length; row += 1) if (row !== column) {
      const factor = augmented[row][column];
      for (let entry = column; entry <= target.length; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row[target.length]);
}

function dot(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function magnitude(vector: number[]) {
  return Math.sqrt(dot(vector, vector));
}

function normalise(vector: number[]) {
  const length = magnitude(vector);
  if (length < 1e-12) throw new Error("Calibration geometry is singular. Retry with more varied board positions and tilts.");
  return vector.map((value) => value / length);
}

function cross(left: number[], right: number[]) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}
