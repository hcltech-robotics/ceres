/** Sparse WebXR environment depth. All integers on the wire are little endian. */
export const DEPTH_CHANNEL = "ceres-depth-v1";
export const DEPTH_MAX_DIMENSION = 256;
export const DEPTH_MAX_HEADER_BYTES = 4096;
export const DEPTH_MAX_FRAME_BYTES = 8 + DEPTH_MAX_HEADER_BYTES + 256 * 256 * 2;
export const DEPTH_FRAGMENT_BYTES = 16384;
export const DEPTH_FRAGMENT_HEADER_BYTES = 24;
export const DEPTH_FRAGMENT_PAYLOAD_BYTES = DEPTH_FRAGMENT_BYTES - DEPTH_FRAGMENT_HEADER_BYTES;
export type DepthUsage = "cpu-optimized" | "gpu-optimized";
export type DepthSourceFormat = "luminance-alpha" | "float32" | "unsigned-short";
export type DepthGeometrySource = "sensor" | "view" | "view-fallback";
export interface DepthCaptureDiagnostics {
  /** Sender-normalised matrix, applied once to this packet's stored pixels. */
  mapping_version?: 2;
  geometry_source?: DepthGeometrySource;
  /** Copy/readback elapsed time, including asynchronous fence polling. */
  readback_us?: number;
  /** Requested pose target minus observation time, without a latency correction. */
  target_lead_us?: number;
}
export interface DepthHeader extends DepthCaptureDiagnostics {
  version: 1;
  epoch: number;
  space_epoch: number;
  sequence: number;
  observed_us: number;
  target_us: number;
  width: number;
  height: number;
  source_width: number;
  source_height: number;
  eye: "left" | "right" | "none";
  usage: DepthUsage;
  source_format: DepthSourceFormat;
  depth_format: "uint16-mm";
  world_from_view: number[];
  projection: number[];
  norm_depth_from_norm_view: number[];
}
export interface DepthFeature {
  version: 1;
  channel: typeof DEPTH_CHANNEL;
  format: "uint16-mm";
  max_width: 256;
  max_height: 256;
}
export const DEPTH_FEATURE: DepthFeature = {
  version: 1, channel: DEPTH_CHANNEL, format: "uint16-mm", max_width: 256, max_height: 256,
};
export interface DepthSourceDiagnostics extends DepthCaptureDiagnostics {
  source_encoding?: "linear" | "perspective";
  raw_value_to_metres?: number | null;
  depth_near?: number | null;
  depth_far?: number | "infinity" | null;
  texture_type?: "texture" | "texture-array";
  image_index?: number | null;
  source_valid?: boolean;
}
export interface DepthStatus extends DepthSourceDiagnostics {
  type: "depth-status";
  version: 1;
  epoch: number;
  status: "unsupported" | "waiting" | "streaming" | "paused" | "error";
  usage: DepthUsage | null;
  source_format: DepthSourceFormat | null;
  error?: string;
}
const uint32 = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const time = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const dimension = (n: unknown, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= max;
const matrix = (n: unknown): n is number[] => Array.isArray(n) && n.length === 16 && n.every(v => typeof v === "number" && Number.isFinite(v));
export const isDepthUsage = (v: unknown): v is DepthUsage => v === "cpu-optimized" || v === "gpu-optimized";
export const isDepthFormat = (v: unknown): v is DepthSourceFormat => v === "luminance-alpha" || v === "float32" || v === "unsigned-short";
const validCaptureDiagnostics = (v: DepthCaptureDiagnostics) =>
  (v.mapping_version === undefined || v.mapping_version === 2)
  && (v.geometry_source === undefined || ["sensor", "view", "view-fallback"].includes(v.geometry_source))
  && (v.readback_us === undefined || time(v.readback_us))
  && (v.target_lead_us === undefined || Number.isSafeInteger(v.target_lead_us));
export function validDepthFeature(value: unknown): value is DepthFeature {
  if (!value || typeof value !== "object") return false;
  const v = value as DepthFeature;
  return v.version === 1 && v.channel === DEPTH_CHANNEL && v.format === "uint16-mm"
    && v.max_width === 256 && v.max_height === 256;
}
export function validDepthStatus(value: unknown): value is DepthStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as DepthStatus;
  return v.type === "depth-status" && v.version === 1 && uint32(v.epoch)
    && ["unsupported", "waiting", "streaming", "paused", "error"].includes(v.status)
    && (v.usage === null || isDepthUsage(v.usage)) && (v.source_format === null || isDepthFormat(v.source_format))
    && validCaptureDiagnostics(v);
}
export function validateDepthHeader(h: DepthHeader): void {
  if (h.version !== 1 || ![h.epoch, h.space_epoch, h.sequence].every(uint32)
    || ![h.observed_us, h.target_us].every(time)
    || !dimension(h.width, 256) || !dimension(h.height, 256)
    || !dimension(h.source_width, 8192) || !dimension(h.source_height, 8192)
    || h.width > h.source_width || h.height > h.source_height
    || !["left", "right", "none"].includes(h.eye) || !isDepthUsage(h.usage)
    || !isDepthFormat(h.source_format) || h.depth_format !== "uint16-mm"
    || ![h.world_from_view, h.projection, h.norm_depth_from_norm_view].every(matrix)
    || !validCaptureDiagnostics(h)
    || (h.target_lead_us !== undefined && h.target_lead_us !== h.target_us - h.observed_us)) {
    throw new Error("Invalid Bridge depth header");
  }
}
export function encodeDepthFrame(header: DepthHeader, millimetres: Uint16Array): Uint8Array<ArrayBuffer> {
  validateDepthHeader(header);
  if (millimetres.length !== header.width * header.height) throw new Error("Invalid Bridge depth dimensions");
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > DEPTH_MAX_HEADER_BYTES) throw new Error("Bridge depth header exceeds its budget");
  const bytes = new Uint8Array(8 + json.length + millimetres.length * 2);
  bytes.set([67, 69, 68, 49]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, json.length, true);
  bytes.set(json, 8);
  for (let i = 0; i < millimetres.length; i++) view.setUint16(8 + json.length + i * 2, millimetres[i], true);
  return bytes;
}
export function fragmentDepthFrame(frame: Uint8Array, header: Pick<DepthHeader, "epoch" | "space_epoch" | "sequence">): Uint8Array<ArrayBuffer>[] {
  if (frame.length < 8 || frame.length > DEPTH_MAX_FRAME_BYTES
    || ![header.epoch, header.space_epoch, header.sequence].every(uint32)) throw new Error("Invalid Bridge depth frame");
  const count = Math.ceil(frame.length / DEPTH_FRAGMENT_PAYLOAD_BYTES);
  const result: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * DEPTH_FRAGMENT_PAYLOAD_BYTES;
    const payload = frame.subarray(offset, offset + DEPTH_FRAGMENT_PAYLOAD_BYTES);
    const bytes = new Uint8Array(DEPTH_FRAGMENT_HEADER_BYTES + payload.length);
    bytes.set([67, 68, 70, 49]);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, header.epoch, true);
    view.setUint32(8, header.space_epoch, true);
    view.setUint32(12, header.sequence, true);
    view.setUint16(16, index, true);
    view.setUint16(18, count, true);
    view.setUint32(20, frame.length, true);
    bytes.set(payload, DEPTH_FRAGMENT_HEADER_BYTES);
    result.push(bytes);
  }
  return result;
}
