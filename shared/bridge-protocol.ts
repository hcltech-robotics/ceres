import { XR_HAND_JOINTS } from "./xr-hand-joints.js";
import { validDepthFeature, validDepthStatus, type DepthFeature, type DepthStatus } from "./bridge-depth.js";

export { XR_HAND_JOINTS };
export const BRIDGE_VERSION = 1;
export const BRIDGE_MAGIC = 0x31524243; // CBR1, little endian.
export const HEADER_BYTES = 40;
export const HEAD_BYTES = 68;
export const HAND_BYTES = 844;
export const OBSERVATION_BYTES = HEAD_BYTES + 2 * HAND_BYTES;
export const POSE_QUEUE_BYTES = 2048;
export const JOINT_MASK = 0x01ffffff;
export type PoseKind = 1 | 2 | 3;

export interface PoseHeader {
  kind: PoseKind;
  valid: boolean;
  epoch: number;
  spaceEpoch: number;
  sequence: number;
  observedUs: number;
  targetUs: number;
}

export interface PosePacket extends PoseHeader {
  jointMask: number;
  values: Float32Array;
}

export function newerSequence(candidate: number, previous: number): boolean {
  const distance = (candidate - previous) >>> 0;
  return distance !== 0 && distance < 0x80000000;
}

function uint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function microseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Buffers can be reused after RTCDataChannel.send has copied their contents. */
export function createPoseBuffer(kind: PoseKind): ArrayBuffer {
  return new ArrayBuffer(kind === 1 ? HEAD_BYTES : HAND_BYTES);
}

export function writePoseHeader(buffer: ArrayBuffer, header: PoseHeader, jointMask = 0): DataView {
  const length = header.kind === 1 ? HEAD_BYTES : HAND_BYTES;
  if (buffer.byteLength !== length || ![1, 2, 3].includes(header.kind)
    || !uint32(header.epoch) || !uint32(header.spaceEpoch) || !uint32(header.sequence)
    || !microseconds(header.observedUs) || !microseconds(header.targetUs)
    || !uint32(jointMask) || (jointMask & ~JOINT_MASK) !== 0) {
    throw new Error("Invalid Bridge pose header");
  }
  const view = new DataView(buffer);
  view.setUint32(0, BRIDGE_MAGIC, true);
  view.setUint8(4, BRIDGE_VERSION);
  view.setUint8(5, header.kind);
  view.setUint16(6, header.valid ? 1 : 0, true);
  view.setUint32(8, header.epoch, true);
  view.setUint32(12, header.spaceEpoch, true);
  view.setUint32(16, header.sequence, true);
  view.setUint32(20, length - HEADER_BYTES, true);
  view.setBigUint64(24, BigInt(header.observedUs), true);
  view.setBigUint64(32, BigInt(header.targetUs), true);
  if (header.kind !== 1) view.setUint32(40, jointMask, true);
  return view;
}

export function decodePose(buffer: ArrayBuffer): PosePacket {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Truncated Bridge pose");
  const view = new DataView(buffer);
  const kind = view.getUint8(5) as PoseKind;
  const length = kind === 1 ? HEAD_BYTES : HAND_BYTES;
  const flags = view.getUint16(6, true);
  const observed = view.getBigUint64(24, true);
  const target = view.getBigUint64(32, true);
  if (view.getUint32(0, true) !== BRIDGE_MAGIC || view.getUint8(4) !== BRIDGE_VERSION
    || ![1, 2, 3].includes(kind) || buffer.byteLength !== length
    || view.getUint32(20, true) !== length - HEADER_BYTES || flags > 1
    || observed > BigInt(Number.MAX_SAFE_INTEGER) || target > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid Bridge pose envelope");
  }
  const valid = flags === 1;
  const jointMask = kind === 1 ? 0 : view.getUint32(40, true);
  if ((jointMask & ~JOINT_MASK) !== 0 || (kind !== 1 && valid !== (jointMask !== 0))) {
    throw new Error("Invalid Bridge joint validity");
  }
  const offset = kind === 1 ? 40 : 44;
  const values = new Float32Array((length - offset) / 4);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(offset + i * 4, true);
  const count = kind === 1 ? 1 : 25;
  const stride = kind === 1 ? 7 : 8;
  for (let joint = 0; joint < count; joint++) {
    const start = joint * stride;
    const tracked = kind === 1 ? valid : (jointMask & (1 << joint)) !== 0;
    for (let i = 0; i < stride; i++) {
      if (!Number.isFinite(values[start + i])) throw new Error("Non-finite Bridge pose");
      if (!tracked && values[start + i] !== 0) throw new Error("Untracked Bridge transforms must be zero");
    }
    if (!tracked) continue;
    let norm = 0;
    for (let i = 3; i < 7; i++) norm += values[start + i] ** 2;
    if (norm < 0.5 || norm > 1.5 || (stride === 8 && values[start + 7] < 0)) {
      throw new Error("Invalid Bridge transform");
    }
  }
  return {
    kind, valid, jointMask, values,
    epoch: view.getUint32(8, true), spaceEpoch: view.getUint32(12, true),
    sequence: view.getUint32(16, true), observedUs: Number(observed), targetUs: Number(target),
  };
}

export interface BridgeCameraDescription {
  side: "left" | "right" | "unknown";
  width: number;
  height: number;
  requestedWidth: number;
  fps: number | null;
  calibration: null;
}

export interface BridgeDescription {
  type: "description";
  version: 1;
  epoch: number;
  clock: { id: string; units: "microseconds"; domain: "sender-monotonic" };
  referenceSpace: "local-floor" | "local";
  axes: "right-handed-x-right-y-up-z-back";
  units: "metres";
  quaternion: "xyzw";
  joints: readonly string[];
  camera?: BridgeCameraDescription;
  cameras?: (BridgeCameraDescription & { mid: string })[];
  environment_depth?: DepthFeature;
  depth_control_version?: 1;
}

export type BridgeMetadata = BridgeDescription
  | DepthStatus
  | { type: "ack"; version: 1; epoch: number; depth_control_version?: 1; depth_enabled?: boolean }
  | { type: "depth-control"; version: 1; epoch: number; enabled: boolean }
  | { type: "ping"; version: 1; epoch: number; id: number; t0: number }
  | { type: "pong"; version: 1; epoch: number; id: number; t0: number; t1: number; t2: number };

function validCamera(value: unknown): value is BridgeCameraDescription {
  if (!value || typeof value !== "object") return false;
  const camera = value as BridgeCameraDescription;
  return ["left", "right", "unknown"].includes(camera.side)
    && [camera.width, camera.height, camera.requestedWidth].every(n => Number.isInteger(n) && n > 0 && n <= 8192)
    && (camera.fps === null || typeof camera.fps === "number" && Number.isFinite(camera.fps) && camera.fps > 0)
    && camera.calibration === null;
}

export function parseMetadata(text: string): BridgeMetadata {
  if (text.length > 8192) throw new Error("Bridge metadata exceeds its budget");
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || !uint32(value.epoch)) throw new Error("Incompatible Bridge metadata");
  if (value.type === "ack") {
    if (value.depth_control_version === 1 && typeof value.depth_enabled !== "boolean") {
      throw new Error("Invalid Bridge depth acknowledgement");
    }
    return value;
  }
  if (value.type === "depth-control") {
    if (typeof value.enabled !== "boolean") throw new Error("Invalid Bridge depth control");
    return value;
  }
  if (value.type === "depth-status") {
    if (!validDepthStatus(value)) throw new Error("Invalid Bridge depth status");
    return value;
  }
  if (value.type === "ping" || value.type === "pong") {
    if (!uint32(value.id) || !microseconds(value.t0)
      || (value.type === "pong" && (!microseconds(value.t1) || !microseconds(value.t2) || value.t2 < value.t1))) {
      throw new Error("Invalid Bridge clock exchange");
    }
    return value;
  }
  if (value.type !== "description" || value.axes !== "right-handed-x-right-y-up-z-back"
    || value.units !== "metres" || value.quaternion !== "xyzw"
    || !["local", "local-floor"].includes(value.referenceSpace)
    || value.clock?.units !== "microseconds" || value.clock?.domain !== "sender-monotonic"
    || typeof value.clock.id !== "string" || value.clock.id.length > 128
    || !Array.isArray(value.joints) || value.joints.length !== 25
    || !XR_HAND_JOINTS.every((name, index) => value.joints[index] === name)
    || (value.environment_depth !== undefined && !validDepthFeature(value.environment_depth))
    || (value.depth_control_version !== undefined && (value.depth_control_version !== 1 || !value.environment_depth))
    || (value.camera === undefined ? !validDepthFeature(value.environment_depth) : !validCamera(value.camera))) {
    throw new Error("Invalid Bridge stream description");
  }
  if (value.cameras !== undefined) {
    const cameras: unknown[] = value.cameras;
    if (!value.camera || !Array.isArray(cameras) || cameras.length < 1 || cameras.length > 2
      || !cameras.every(camera => validCamera(camera) && "mid" in camera
        && typeof camera.mid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(camera.mid))) {
      throw new Error("Invalid Bridge camera tracks");
    }
    const tracks = cameras as NonNullable<BridgeDescription["cameras"]>;
    if (new Set(tracks.map(camera => camera.mid)).size !== tracks.length
      || tracks.length === 2 && (new Set(tracks.map(camera => camera.side)).size !== 2
        || tracks.some(camera => camera.side === "unknown"))
      || (["side", "width", "height", "requestedWidth", "fps", "calibration"] as const)
        .some(key => tracks[0][key] !== value.camera[key])) {
      throw new Error("Invalid Bridge camera identity");
    }
  }
  return value;
}

/** Sender-side admission keeps all components of one observation below the queue cap. */
export function canSendObservation(channel: Pick<RTCDataChannel, "readyState" | "bufferedAmount">): boolean {
  return channel.readyState === "open" && channel.bufferedAmount + OBSERVATION_BYTES <= POSE_QUEUE_BYTES;
}
