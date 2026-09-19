import {
  DEPTH_FRAGMENT_HEADER_BYTES, DEPTH_FRAGMENT_PAYLOAD_BYTES, DEPTH_MAX_FRAME_BYTES,
  DEPTH_MAX_HEADER_BYTES, validateDepthHeader, type DepthHeader,
} from "./bridge-depth.js";

export const DEPTH_DEMAND_INTERVAL_MS = 1_000;
export const DEPTH_DEMAND_LEASE_MS = 3_000;

export interface DepthDemand {
  type: "depth-demand";
  version: 1;
  sequence: number;
  enabled: boolean;
}

export function isDepthDemand(value: unknown): value is DepthDemand {
  if (!value || typeof value !== "object") return false;
  const demand = value as Partial<DepthDemand>;
  return demand.type === "depth-demand" && demand.version === 1 && typeof demand.enabled === "boolean"
    && Number.isInteger(demand.sequence) && demand.sequence! >= 0 && demand.sequence! <= 0xffffffff;
}

export interface DecodedDepthFrame {
  header: DepthHeader;
  millimetres: Uint16Array<ArrayBuffer>;
}

export function decodeDepthFrame(bytes: Uint8Array): DecodedDepthFrame {
  if (bytes.length < 8 || bytes.length > DEPTH_MAX_FRAME_BYTES
    || bytes[0] !== 67 || bytes[1] !== 69 || bytes[2] !== 68 || bytes[3] !== 49) {
    throw new Error("Invalid depth frame");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true);
  if (length === 0 || length > DEPTH_MAX_HEADER_BYTES || 8 + length > bytes.length) throw new Error("Invalid depth header length");
  const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + length))) as DepthHeader;
  validateDepthHeader(header);
  const count = header.width * header.height;
  if (bytes.length !== 8 + length + count * 2) throw new Error("Invalid depth image length");
  const millimetres = new Uint16Array(count);
  for (let index = 0; index < count; index++) millimetres[index] = view.getUint16(8 + length + index * 2, true);
  return { header, millimetres };
}

const newer = (candidate: number, previous: number) => {
  const distance = (candidate - previous) >>> 0;
  return distance !== 0 && distance < 0x80000000;
};

/** Holds at most one bounded frame from the unordered, lossy depth channel. */
export class DepthFrameAssembler {
  private pending: {
    epoch: number; space: number; sequence: number; count: number; received: number;
    bytes: Uint8Array<ArrayBuffer>; seen: boolean[]; startedAt: number;
  } | null = null;
  private latest: { epoch: number; space: number; sequence: number } | null = null;

  reset() {
    this.pending = null;
    this.latest = null;
  }

  push(bytes: Uint8Array, now = performance.now()): DecodedDepthFrame | null {
    if (bytes.length < DEPTH_FRAGMENT_HEADER_BYTES || bytes.length > DEPTH_FRAGMENT_HEADER_BYTES + DEPTH_FRAGMENT_PAYLOAD_BYTES
      || bytes[0] !== 67 || bytes[1] !== 68 || bytes[2] !== 70 || bytes[3] !== 49) throw new Error("Invalid depth fragment");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const epoch = view.getUint32(4, true), space = view.getUint32(8, true), sequence = view.getUint32(12, true);
    const index = view.getUint16(16, true), count = view.getUint16(18, true), length = view.getUint32(20, true);
    if (length < 8 || length > DEPTH_MAX_FRAME_BYTES || count !== Math.ceil(length / DEPTH_FRAGMENT_PAYLOAD_BYTES)
      || index >= count || bytes.length !== DEPTH_FRAGMENT_HEADER_BYTES + Math.min(DEPTH_FRAGMENT_PAYLOAD_BYTES, length - index * DEPTH_FRAGMENT_PAYLOAD_BYTES)) {
      throw new Error("Invalid depth fragment accounting");
    }
    const latest = this.latest;
    if (latest && (epoch !== latest.epoch ? !newer(epoch, latest.epoch)
      : space !== latest.space ? !newer(space, latest.space)
      : sequence === latest.sequence ? !this.pending : !newer(sequence, latest.sequence))) return null;
    if (this.pending && now - this.pending.startedAt > 250) this.pending = null;
    let pending = this.pending;
    if (!pending || pending.epoch !== epoch || pending.space !== space || pending.sequence !== sequence) {
      // Do not resurrect an expired or completed frame with a late fragment.
      if (latest && latest.epoch === epoch && latest.space === space && latest.sequence === sequence) return null;
      this.latest = { epoch, space, sequence };
      pending = this.pending = { epoch, space, sequence, count, received: 0,
        bytes: new Uint8Array(length), seen: Array<boolean>(count).fill(false), startedAt: now };
    }
    if (pending.count !== count || pending.bytes.length !== length) throw new Error("Conflicting depth fragments");
    const payload = bytes.subarray(DEPTH_FRAGMENT_HEADER_BYTES);
    const offset = index * DEPTH_FRAGMENT_PAYLOAD_BYTES;
    if (pending.seen[index]) {
      if (payload.some((byte, at) => byte !== pending.bytes[offset + at])) throw new Error("Conflicting depth fragment duplicate");
      return null;
    }
    pending.bytes.set(payload, offset);
    pending.seen[index] = true;
    if (++pending.received !== count) return null;
    this.pending = null;
    const frame = decodeDepthFrame(pending.bytes);
    if (frame.header.epoch !== epoch || frame.header.space_epoch !== space || frame.header.sequence !== sequence) throw new Error("Depth identity mismatch");
    return frame;
  }
}
