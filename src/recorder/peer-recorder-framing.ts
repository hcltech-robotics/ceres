const PEER_RECORDER_FRAGMENT_MAGIC = 0x31524643;
export const PEER_RECORDER_FRAGMENT_HEADER_BYTES = 24;
export const PEER_RECORDER_FRAGMENT_PAYLOAD_BYTES = 12 * 1024;
const MAX_PEER_RECORDER_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_PEER_RECORDER_FRAGMENTS = 8_192;

interface PendingBlock {
  sequence: number;
  partCount: number;
  totalBytes: number;
  parts: Array<Uint8Array | undefined>;
  receivedParts: number;
  receivedBytes: number;
}

export interface CompletePeerRecorderBlock {
  sequence: number;
  block: Uint8Array;
}

export function fragmentPeerRecorderBlock(sequence: number, value: Uint8Array, payloadBytes = PEER_RECORDER_FRAGMENT_PAYLOAD_BYTES) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Recorder sequence must be a non-negative safe integer");
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1) throw new Error("Recorder fragment payload size must be a positive integer");
  if (value.byteLength > MAX_PEER_RECORDER_BLOCK_BYTES) throw new Error("Recorder block exceeds the peer transport limit");
  const partCount = Math.max(1, Math.ceil(value.byteLength / payloadBytes));
  if (partCount > MAX_PEER_RECORDER_FRAGMENTS) throw new Error("Recorder block requires too many peer transport fragments");
  return Array.from({ length: partCount }, (_, index) => {
    const start = index * payloadBytes;
    const payload = value.subarray(start, Math.min(value.byteLength, start + payloadBytes));
    const fragment = new Uint8Array(PEER_RECORDER_FRAGMENT_HEADER_BYTES + payload.byteLength);
    const view = new DataView(fragment.buffer);
    view.setUint32(0, PEER_RECORDER_FRAGMENT_MAGIC, true);
    view.setBigUint64(4, BigInt(sequence), true);
    view.setUint32(12, index, true);
    view.setUint32(16, partCount, true);
    view.setUint32(20, value.byteLength, true);
    fragment.set(payload, PEER_RECORDER_FRAGMENT_HEADER_BYTES);
    return fragment;
  });
}

export class PeerRecorderAssembler {
  private pending: PendingBlock | null = null;

  accept(value: ArrayBuffer | ArrayBufferView): CompletePeerRecorderBlock | null {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.byteLength < PEER_RECORDER_FRAGMENT_HEADER_BYTES) throw new Error("Recorder peer fragment is shorter than its header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== PEER_RECORDER_FRAGMENT_MAGIC) throw new Error("Recorder peer fragment magic is invalid");
    const sequence = Number(view.getBigUint64(4, true));
    const partIndex = view.getUint32(12, true);
    const partCount = view.getUint32(16, true);
    const totalBytes = view.getUint32(20, true);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Recorder peer fragment sequence is invalid");
    if (partCount < 1 || partCount > MAX_PEER_RECORDER_FRAGMENTS || partIndex >= partCount) throw new Error("Recorder peer fragment part range is invalid");
    if (totalBytes > MAX_PEER_RECORDER_BLOCK_BYTES) throw new Error("Recorder peer fragment declares an oversized block");
    const payload = bytes.slice(PEER_RECORDER_FRAGMENT_HEADER_BYTES);
    let pending = this.pending;
    if (!pending) {
      pending = {
        sequence,
        partCount,
        totalBytes,
        parts: new Array(partCount),
        receivedParts: 0,
        receivedBytes: 0,
      };
      this.pending = pending;
    }
    if (pending.sequence !== sequence || pending.partCount !== partCount || pending.totalBytes !== totalBytes) {
      throw new Error("Recorder peer fragment does not match the in-flight block");
    }
    const existing = pending.parts[partIndex];
    if (existing) {
      if (!sameBytes(existing, payload)) throw new Error("Recorder peer fragment conflicts with a previously received part");
      return null;
    }
    pending.parts[partIndex] = payload;
    pending.receivedParts += 1;
    pending.receivedBytes += payload.byteLength;
    if (pending.receivedParts !== pending.partCount) return null;
    if (pending.receivedBytes !== pending.totalBytes) throw new Error("Recorder peer fragments do not match their declared block size");
    const block = new Uint8Array(pending.totalBytes);
    let offset = 0;
    for (const part of pending.parts) {
      if (!part) throw new Error("Recorder peer fragment assembly is incomplete");
      block.set(part, offset);
      offset += part.byteLength;
    }
    this.pending = null;
    return { sequence, block };
  }

  reset() {
    this.pending = null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
