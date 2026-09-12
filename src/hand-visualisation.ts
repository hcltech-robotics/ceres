export const handRenderModes = ["off", "outline", "keypoints", "mesh"] as const;
export type HandRenderMode = typeof handRenderModes[number];

export const handShadingModes = ["side", "velocity", "normal", "motion"] as const;
export type HandShadingMode = typeof handShadingModes[number];

export const handTrailModes = ["off", "cog"] as const;
export type HandTrailMode = typeof handTrailModes[number];

export type Rgba = readonly [number, number, number, number];

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface MotionSample extends Vec3Like {
  timestampMs: number;
}

export interface ManoAsset {
  version: 1;
  side: "left" | "right";
  vertexCount: number;
  faceCount: number;
  jointCount: number;
  jointNames: string[];
  tipVertexIds: Record<string, number>;
  vertices: number[];
  faces: number[];
  joints: number[];
  parents: number[];
  weights: number[];
}

export type HandSide = "left" | "right";

export const jointNames = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
] as const;

export const bonePairs = [
  ["wrist", "thumb-metacarpal"], ["thumb-metacarpal", "thumb-phalanx-proximal"], ["thumb-phalanx-proximal", "thumb-phalanx-distal"], ["thumb-phalanx-distal", "thumb-tip"],
  ["wrist", "index-finger-metacarpal"], ["index-finger-metacarpal", "index-finger-phalanx-proximal"], ["index-finger-phalanx-proximal", "index-finger-phalanx-intermediate"], ["index-finger-phalanx-intermediate", "index-finger-phalanx-distal"], ["index-finger-phalanx-distal", "index-finger-tip"],
  ["wrist", "middle-finger-metacarpal"], ["middle-finger-metacarpal", "middle-finger-phalanx-proximal"], ["middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate"], ["middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal"], ["middle-finger-phalanx-distal", "middle-finger-tip"],
  ["wrist", "ring-finger-metacarpal"], ["ring-finger-metacarpal", "ring-finger-phalanx-proximal"], ["ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate"], ["ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal"], ["ring-finger-phalanx-distal", "ring-finger-tip"],
  ["wrist", "pinky-finger-metacarpal"], ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal"], ["pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate"], ["pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal"], ["pinky-finger-phalanx-distal", "pinky-finger-tip"],
] as const;

export const manoJointTargets: Readonly<Record<string, typeof jointNames[number]>> = {
  wrist: "wrist",
  index1: "index-finger-phalanx-proximal",
  index2: "index-finger-phalanx-intermediate",
  index3: "index-finger-phalanx-distal",
  middle1: "middle-finger-phalanx-proximal",
  middle2: "middle-finger-phalanx-intermediate",
  middle3: "middle-finger-phalanx-distal",
  pinky1: "pinky-finger-phalanx-proximal",
  pinky2: "pinky-finger-phalanx-intermediate",
  pinky3: "pinky-finger-phalanx-distal",
  ring1: "ring-finger-phalanx-proximal",
  ring2: "ring-finger-phalanx-intermediate",
  ring3: "ring-finger-phalanx-distal",
  thumb1: "thumb-metacarpal",
  thumb2: "thumb-phalanx-proximal",
  thumb3: "thumb-phalanx-distal",
  thumbTip: "thumb-tip",
  indexTip: "index-finger-tip",
  middleTip: "middle-finger-tip",
  ringTip: "ring-finger-tip",
  pinkyTip: "pinky-finger-tip",
};

const clamp = (value: number, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

export const sideColour = (side: "left" | "right", alpha = .92): Rgba => side === "left"
  ? [.28, .64, 1, alpha]
  : [1, .48, .72, alpha];

export const jetColour = (value: number, alpha = .94): Rgba => {
  const t = clamp(value);
  const channel = (offset: number) => clamp(1.5 - Math.abs(4 * t - offset));
  return [channel(3), channel(2), channel(1), alpha];
};

const middleburyWheel = (() => {
  const segments = [
    [15, [1, 0, 0], [1, 1, 0]],
    [6, [1, 1, 0], [0, 1, 0]],
    [4, [0, 1, 0], [0, 1, 1]],
    [11, [0, 1, 1], [0, 0, 1]],
    [13, [0, 0, 1], [1, 0, 1]],
    [6, [1, 0, 1], [1, 0, 0]],
  ] as const;
  const colours: Array<readonly [number, number, number]> = [];
  for (const [count, from, to] of segments) {
    for (let index = 0; index < count; index += 1) {
      const amount = index / count;
      colours.push([
        lerp(from[0], to[0], amount),
        lerp(from[1], to[1], amount),
        lerp(from[2], to[2], amount),
      ]);
    }
  }
  return colours;
})();

export const middleburyColour = (x: number, y: number, maximumMagnitude = 2): Rgba => {
  const magnitude = Math.hypot(x, y);
  if (magnitude < 1e-6) return [1, 1, 1, 0];
  const direction = (Math.atan2(-y, -x) / Math.PI + 1) / 2;
  const wheelPosition = direction * middleburyWheel.length;
  const lower = Math.floor(wheelPosition) % middleburyWheel.length;
  const upper = (lower + 1) % middleburyWheel.length;
  const amount = wheelPosition - Math.floor(wheelPosition);
  return [
    lerp(middleburyWheel[lower][0], middleburyWheel[upper][0], amount),
    lerp(middleburyWheel[lower][1], middleburyWheel[upper][1], amount),
    lerp(middleburyWheel[lower][2], middleburyWheel[upper][2], amount),
    clamp(magnitude / maximumMagnitude),
  ];
};

export const normalColour = (normal: Vec3Like, alpha = .94): Rgba => [
  clamp(normal.x * .5 + .5),
  clamp(normal.y * .5 + .5),
  clamp(normal.z * .5 + .5),
  alpha,
];

const subtract = (a: Vec3Like, b: Vec3Like): [number, number, number] => [a.x - b.x, a.y - b.y, a.z - b.z];
const length = (value: readonly number[]) => Math.hypot(value[0], value[1], value[2]);
const normalise = (value: readonly number[]): [number, number, number] => {
  const magnitude = length(value);
  return magnitude > 1e-8 ? [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude] : [0, 0, 0];
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];
const identity: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const applyMatrix = (matrix: Matrix3, value: readonly number[]): [number, number, number] => [
  matrix[0] * value[0] + matrix[1] * value[1] + matrix[2] * value[2],
  matrix[3] * value[0] + matrix[4] * value[1] + matrix[5] * value[2],
  matrix[6] * value[0] + matrix[7] * value[1] + matrix[8] * value[2],
];
const transpose = (matrix: Matrix3): Matrix3 => [matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5], matrix[8]];
const multiplyMatrices = (left: Matrix3, right: Matrix3): Matrix3 => {
  const output = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let index = 0; index < 3; index += 1) output[row * 3 + column] += left[row * 3 + index] * right[index * 3 + column];
    }
  }
  return output as unknown as Matrix3;
};

const palmBasis = (root: Vec3Like, index: Vec3Like, middle: Vec3Like, pinky: Vec3Like): Matrix3 => {
  const x = normalise(subtract(index, pinky));
  const z = normalise(cross(x, subtract(middle, root)));
  const y = normalise(cross(z, x));
  if (length(x) < 1e-8 || length(y) < 1e-8 || length(z) < 1e-8) return identity;
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
};

const rotationBetween = (fromValue: readonly number[], toValue: readonly number[]): Matrix3 => {
  const from = normalise(fromValue);
  const to = normalise(toValue);
  if (length(from) < 1e-8 || length(to) < 1e-8) return identity;
  const axis = cross(from, to);
  const sine = length(axis);
  const cosine = clamp(dot(from, to), -1, 1);
  if (sine < 1e-7) {
    if (cosine > 0) return identity;
    const helper = Math.abs(from[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
    const perpendicular = normalise(cross(from, helper));
    const [x, y, z] = perpendicular;
    return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
  }
  const [x, y, z] = [axis[0] / sine, axis[1] / sine, axis[2] / sine];
  const oneMinusCosine = 1 - cosine;
  return [
    cosine + x * x * oneMinusCosine, x * y * oneMinusCosine - z * sine, x * z * oneMinusCosine + y * sine,
    y * x * oneMinusCosine + z * sine, cosine + y * y * oneMinusCosine, y * z * oneMinusCosine - x * sine,
    z * x * oneMinusCosine - y * sine, z * y * oneMinusCosine + x * sine, cosine + z * z * oneMinusCosine,
  ];
};

export const validateManoAsset = (asset: ManoAsset) => asset.version === 1
  && asset.vertexCount === 778
  && asset.jointCount === 16
  && asset.vertices.length === asset.vertexCount * 3
  && asset.faces.length === asset.faceCount * 3
  && asset.joints.length === asset.jointCount * 3
  && asset.parents.length === asset.jointCount
  && Object.keys(asset.tipVertexIds).length === 5
  && Object.values(asset.tipVertexIds).every((vertex) => Number.isInteger(vertex) && vertex >= 0 && vertex < asset.vertexCount)
  && asset.weights.length === asset.vertexCount * asset.jointCount;

export const fitManoVertices = (asset: ManoAsset, targets: Readonly<Record<string, Vec3Like>>) => {
  if (!validateManoAsset(asset)) return null;
  const targetJoints = asset.jointNames.map((name) => targets[name]);
  if (targetJoints.some((joint) => !joint)) return null;
  const restJoint = (index: number): Vec3Like => ({ x: asset.joints[index * 3], y: asset.joints[index * 3 + 1], z: asset.joints[index * 3 + 2] });
  const ratios: number[] = [];
  for (let joint = 1; joint < asset.jointCount; joint += 1) {
    const parent = asset.parents[joint];
    if (parent < 0) continue;
    const restLength = length(subtract(restJoint(joint), restJoint(parent)));
    const targetLength = length(subtract(targetJoints[joint], targetJoints[parent]));
    if (restLength > 1e-6 && targetLength > 1e-6) ratios.push(targetLength / restLength);
  }
  ratios.sort((a, b) => a - b);
  const scale = clamp(ratios[Math.floor(ratios.length / 2)] ?? 1, .55, 1.8);
  const rootRest = restJoint(0);
  const scaledJoint = (index: number): Vec3Like => {
    const joint = restJoint(index);
    return {
      x: rootRest.x + (joint.x - rootRest.x) * scale,
      y: rootRest.y + (joint.y - rootRest.y) * scale,
      z: rootRest.z + (joint.z - rootRest.z) * scale,
    };
  };
  const indexIndex = asset.jointNames.indexOf("index1");
  const middleIndex = asset.jointNames.indexOf("middle1");
  const pinkyIndex = asset.jointNames.indexOf("pinky1");
  const rootRotation = indexIndex >= 0 && middleIndex >= 0 && pinkyIndex >= 0
    ? multiplyMatrices(
      palmBasis(targetJoints[0], targetJoints[indexIndex], targetJoints[middleIndex], targetJoints[pinkyIndex]),
      transpose(palmBasis(scaledJoint(0), scaledJoint(indexIndex), scaledJoint(middleIndex), scaledJoint(pinkyIndex))),
    )
    : identity;
  const rotatedRoot = applyMatrix(rootRotation, [rootRest.x, rootRest.y, rootRest.z]);
  const rotations: Matrix3[] = [rootRotation];
  const translations: Array<readonly [number, number, number]> = [[
    targetJoints[0].x - rotatedRoot[0],
    targetJoints[0].y - rotatedRoot[1],
    targetJoints[0].z - rotatedRoot[2],
  ]];
  for (let joint = 1; joint < asset.jointCount; joint += 1) {
    const parent = asset.parents[joint];
    const rest = scaledJoint(joint);
    const restParent = scaledJoint(parent);
    const target = targetJoints[joint];
    const targetParent = targetJoints[parent];
    const rotation = rotationBetween(subtract(rest, restParent), subtract(target, targetParent));
    const rotatedJoint = applyMatrix(rotation, [rest.x, rest.y, rest.z]);
    rotations[joint] = rotation;
    translations[joint] = [target.x - rotatedJoint[0], target.y - rotatedJoint[1], target.z - rotatedJoint[2]];
  }
  const output = new Float32Array(asset.vertexCount * 3);
  for (let vertex = 0; vertex < asset.vertexCount; vertex += 1) {
    const source = [
      rootRest.x + (asset.vertices[vertex * 3] - rootRest.x) * scale,
      rootRest.y + (asset.vertices[vertex * 3 + 1] - rootRest.y) * scale,
      rootRest.z + (asset.vertices[vertex * 3 + 2] - rootRest.z) * scale,
    ];
    for (let joint = 0; joint < asset.jointCount; joint += 1) {
      const weight = asset.weights[vertex * asset.jointCount + joint];
      if (weight < 1e-5) continue;
      const rotated = applyMatrix(rotations[joint], source);
      output[vertex * 3] += (rotated[0] + translations[joint][0]) * weight;
      output[vertex * 3 + 1] += (rotated[1] + translations[joint][1]) * weight;
      output[vertex * 3 + 2] += (rotated[2] + translations[joint][2]) * weight;
    }
  }
  for (const [tipName, tipVertex] of Object.entries(asset.tipVertexIds)) {
    const target = targets[tipName];
    const distalJoint = asset.jointNames.indexOf(tipName.replace(/Tip$/, "3"));
    if (!target || distalJoint < 0) continue;
    const tipOffset = tipVertex * 3;
    const correction = [target.x - output[tipOffset], target.y - output[tipOffset + 1], target.z - output[tipOffset + 2]];
    for (let vertex = 0; vertex < asset.vertexCount; vertex += 1) {
      const weight = asset.weights[vertex * asset.jointCount + distalJoint];
      const influence = weight * weight;
      output[vertex * 3] += correction[0] * influence;
      output[vertex * 3 + 1] += correction[1] * influence;
      output[vertex * 3 + 2] += correction[2] * influence;
    }
  }
  return output;
};
