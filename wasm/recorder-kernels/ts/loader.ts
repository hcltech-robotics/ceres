export type RecorderKernelBackend = "wasm-simd" | "wasm-scalar" | "javascript";

export interface RecordInput {
  sessionId: string;
  episodeId: string;
  sequence: number;
  recorderFrameIndex: number;
  sourceTimestampUs: number;
  flags: number;
  payload: Uint8Array;
}

export interface DecodedRecord extends RecordInput {
  checksum: number;
}

export interface FixedSignalRing {
  readonly capacity: number;
  readonly length: number;
  readonly isEmpty: boolean;
  push(value: number): void;
  pushMany(values: Float32Array): void;
  clear(): void;
  copyChronological(): Float32Array;
  mean(): number;
  rms(): number;
  dispose(): void;
}

export interface RecorderKernels {
  readonly backend: RecorderKernelBackend;
  crc32(data: Uint8Array): number;
  crc32c(data: Uint8Array): number;
  encodeRecord(record: RecordInput): Uint8Array;
  decodeRecord(frame: Uint8Array): DecodedRecord;
  createFixedRing(capacity: number): FixedSignalRing;
  normaliseQuaternions(values: Float32Array): Float32Array;
  signalRmsWindows(values: Float32Array, windowSize: number): Float32Array;
}

interface WasmRecord {
  readonly session_id: string;
  readonly episode_id: string;
  readonly sequence: bigint;
  readonly recorder_frame_index: bigint;
  readonly source_timestamp_us: bigint;
  readonly flags: number;
  readonly checksum: number;
  payload(): Uint8Array;
  free(): void;
}

interface WasmRing {
  readonly capacity: number;
  readonly len: number;
  readonly is_empty: boolean;
  push(value: number): void;
  push_many(values: Float32Array): void;
  clear(): void;
  copy_chronological(): Float32Array;
  mean(): number;
  rms(): number;
  free(): void;
}

interface WasmBindings {
  default(): Promise<unknown>;
  crc32_ieee(data: Uint8Array): number;
  crc32c(data: Uint8Array): number;
  encode_record(
    sessionId: string,
    episodeId: string,
    sequence: bigint,
    recorderFrameIndex: bigint,
    sourceTimestampUs: bigint,
    flags: number,
    payload: Uint8Array,
  ): Uint8Array;
  decode_record(frame: Uint8Array): WasmRecord;
  FixedF32Ring: new (capacity: number) => WasmRing;
  normalise_quaternions(values: Float32Array): Float32Array;
  signal_rms_windows(values: Float32Array, windowSize: number): Float32Array;
}

const RECORD_MAGIC = [0x43, 0x52, 0x42, 0x31] as const;
const RECORD_HEADER_LENGTH = 48;
const RECORD_CHECKSUM_OFFSET = 40;

function crc32cUpdate(initialState: number, data: Uint8Array): number {
  let state = initialState >>> 0;
  for (const byte of data) {
    state = (state ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(state & 1);
      state = ((state >>> 1) ^ (0x82f63b78 & mask)) >>> 0;
    }
  }
  return state;
}

function crc32cParts(parts: readonly Uint8Array[]): number {
  let state = 0xffffffff;
  for (const part of parts) {
    state = crc32cUpdate(state, part);
  }
  return (~state) >>> 0;
}

function crc32IeeeUpdate(initialState: number, data: Uint8Array): number {
  let state = initialState >>> 0;
  for (const byte of data) {
    state = (state ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(state & 1);
      state = ((state >>> 1) ^ (0xedb88320 & mask)) >>> 0;
    }
  }
  return state;
}

function recorderChecksum(frame: Uint8Array): number {
  let state = crc32IeeeUpdate(0xffffffff, frame.subarray(0, RECORD_CHECKSUM_OFFSET));
  state = crc32IeeeUpdate(state, Uint8Array.of(0, 0, 0, 0));
  state = crc32IeeeUpdate(state, frame.subarray(RECORD_CHECKSUM_OFFSET + 4));
  return (~state) >>> 0;
}

function assertMagic(frame: Uint8Array, magic: readonly number[], kind: string): void {
  for (let index = 0; index < magic.length; index += 1) {
    if (frame[index] !== magic[index]) {
      throw new Error(`${kind} frame magic is invalid`);
    }
  }
}

class JavaScriptFixedRing implements FixedSignalRing {
  readonly capacity: number;
  private readonly values: Float32Array;
  private writeIndex = 0;
  private used = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("ring capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.values = new Float32Array(capacity);
  }

  get length(): number {
    return this.used;
  }

  get isEmpty(): boolean {
    return this.used === 0;
  }

  push(value: number): void {
    this.values[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.used = Math.min(this.used + 1, this.capacity);
  }

  pushMany(values: Float32Array): void {
    for (const value of values) {
      this.push(value);
    }
  }

  clear(): void {
    this.writeIndex = 0;
    this.used = 0;
  }

  copyChronological(): Float32Array {
    const output = new Float32Array(this.used);
    const start = this.used === this.capacity ? this.writeIndex : 0;
    for (let offset = 0; offset < this.used; offset += 1) {
      output[offset] = this.values[(start + offset) % this.capacity];
    }
    return output;
  }

  mean(): number {
    if (this.used === 0) return 0;
    const start = this.used === this.capacity ? this.writeIndex : 0;
    let total = 0;
    for (let offset = 0; offset < this.used; offset += 1) {
      total += this.values[(start + offset) % this.capacity];
    }
    return total / this.used;
  }

  rms(): number {
    if (this.used === 0) return 0;
    const start = this.used === this.capacity ? this.writeIndex : 0;
    let total = 0;
    for (let offset = 0; offset < this.used; offset += 1) {
      const value = this.values[(start + offset) % this.capacity];
      total += value * value;
    }
    return Math.sqrt(total / this.used);
  }

  dispose(): void {}
}

function encodeRecordJs(record: RecordInput): Uint8Array {
  const sessionId = new TextEncoder().encode(record.sessionId);
  const episodeId = new TextEncoder().encode(record.episodeId);
  if (sessionId.byteLength === 0 || sessionId.byteLength > 0xffff) {
    throw new Error("record session identifier length is invalid");
  }
  if (episodeId.byteLength === 0 || episodeId.byteLength > 0xffff) {
    throw new Error("record episode identifier length is invalid");
  }
  for (const [label, value] of [
    ["sequence", record.sequence],
    ["recorder frame index", record.recorderFrameIndex],
    ["source timestamp", record.sourceTimestampUs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`record ${label} is invalid`);
  }
  if (!Number.isInteger(record.flags) || record.flags < 0 || record.flags > 0xffff) {
    throw new Error("record flags exceed the u16 field");
  }
  if (record.payload.byteLength > 0xffffffff) {
    throw new Error("record payload exceeds the u32 frame limit");
  }
  const frame = new Uint8Array(
    RECORD_HEADER_LENGTH + sessionId.byteLength + episodeId.byteLength + record.payload.byteLength,
  );
  frame.set(RECORD_MAGIC, 0);
  const view = new DataView(frame.buffer);
  view.setUint8(4, 1);
  view.setUint8(5, RECORD_HEADER_LENGTH);
  view.setUint16(6, record.flags, true);
  view.setBigUint64(8, BigInt(record.sequence), true);
  view.setBigUint64(16, BigInt(record.recorderFrameIndex), true);
  view.setBigUint64(24, BigInt(record.sourceTimestampUs), true);
  view.setUint32(32, record.payload.byteLength, true);
  view.setUint16(36, sessionId.byteLength, true);
  view.setUint16(38, episodeId.byteLength, true);
  let offset = RECORD_HEADER_LENGTH;
  frame.set(sessionId, offset);
  offset += sessionId.byteLength;
  frame.set(episodeId, offset);
  offset += episodeId.byteLength;
  frame.set(record.payload, offset);
  const checksum = recorderChecksum(frame);
  view.setUint32(RECORD_CHECKSUM_OFFSET, checksum, true);
  return frame;
}

function decodeRecordJs(frame: Uint8Array): DecodedRecord {
  if (frame.byteLength < RECORD_HEADER_LENGTH) {
    throw new Error("record frame is shorter than its header");
  }
  assertMagic(frame, RECORD_MAGIC, "record");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint8(4) !== 1 || view.getUint8(5) !== RECORD_HEADER_LENGTH) {
    throw new Error("record frame version or header length is invalid");
  }
  if (view.getUint32(44, true) !== 0) throw new Error("record frame reserved field must be zero");
  const payloadLength = view.getUint32(32, true);
  const sessionLength = view.getUint16(36, true);
  const episodeLength = view.getUint16(38, true);
  if (frame.byteLength !== RECORD_HEADER_LENGTH + sessionLength + episodeLength + payloadLength) {
    throw new Error("record frame payload length does not match");
  }
  const checksum = view.getUint32(RECORD_CHECKSUM_OFFSET, true);
  const actualChecksum = recorderChecksum(frame);
  if (checksum !== actualChecksum) {
    throw new Error("record frame checksum does not match");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = RECORD_HEADER_LENGTH;
  const sessionId = decoder.decode(frame.subarray(offset, offset + sessionLength));
  offset += sessionLength;
  const episodeId = decoder.decode(frame.subarray(offset, offset + episodeLength));
  offset += episodeLength;
  if (!sessionId || !episodeId) throw new Error("record identifiers must not be empty");
  const safeInteger = (value: bigint, label: string): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error(`record ${label} exceeds the safe integer range`);
    return result;
  };
  return {
    sessionId,
    episodeId,
    sequence: safeInteger(view.getBigUint64(8, true), "sequence"),
    recorderFrameIndex: safeInteger(view.getBigUint64(16, true), "recorder frame index"),
    sourceTimestampUs: safeInteger(view.getBigUint64(24, true), "source timestamp"),
    flags: view.getUint16(6, true),
    checksum,
    payload: frame.slice(offset),
  };
}

function normaliseQuaternionsJs(values: Float32Array): Float32Array {
  if (values.length % 4 !== 0) {
    throw new Error("quaternion input length must be a multiple of four");
  }
  const output = new Float32Array(values.length);
  for (let offset = 0; offset < values.length; offset += 4) {
    const x = values[offset];
    const y = values[offset + 1];
    const z = values[offset + 2];
    const w = values[offset + 3];
    const normSquared = x * x + y * y + z * z + w * w;
    if (!Number.isFinite(normSquared) || normSquared <= Number.EPSILON) {
      output[offset + 3] = 1;
      continue;
    }
    const inverseNorm = 1 / Math.sqrt(normSquared);
    output[offset] = x * inverseNorm;
    output[offset + 1] = y * inverseNorm;
    output[offset + 2] = z * inverseNorm;
    output[offset + 3] = w * inverseNorm;
  }
  return output;
}

function signalRmsWindowsJs(values: Float32Array, windowSize: number): Float32Array {
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new Error("signal RMS window size must be a positive integer");
  }
  const output = new Float32Array(Math.ceil(values.length / windowSize));
  for (let windowIndex = 0; windowIndex < output.length; windowIndex += 1) {
    const start = windowIndex * windowSize;
    const end = Math.min(start + windowSize, values.length);
    let sumSquares = 0;
    for (let index = start; index < end; index += 1) {
      sumSquares += values[index] * values[index];
    }
    output[windowIndex] = Math.sqrt(sumSquares / (end - start));
  }
  return output;
}

function createJavaScriptKernels(): RecorderKernels {
  return {
    backend: "javascript",
    crc32: (data) => (~crc32IeeeUpdate(0xffffffff, data)) >>> 0,
    crc32c: (data) => crc32cParts([data]),
    encodeRecord: encodeRecordJs,
    decodeRecord: decodeRecordJs,
    createFixedRing: (capacity) => new JavaScriptFixedRing(capacity),
    normaliseQuaternions: normaliseQuaternionsJs,
    signalRmsWindows: signalRmsWindowsJs,
  };
}

function createWasmKernels(bindings: WasmBindings, backend: RecorderKernelBackend): RecorderKernels {
  const safeInteger = (value: bigint, label: string): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error(`record ${label} exceeds the safe integer range`);
    return result;
  };
  return {
    backend,
    crc32: bindings.crc32_ieee,
    crc32c: bindings.crc32c,
    encodeRecord: (record) =>
      bindings.encode_record(
        record.sessionId,
        record.episodeId,
        BigInt(record.sequence),
        BigInt(record.recorderFrameIndex),
        BigInt(record.sourceTimestampUs),
        record.flags,
        record.payload,
      ),
    decodeRecord: (frame) => {
      const decoded = bindings.decode_record(frame);
      try {
        return {
          sessionId: decoded.session_id,
          episodeId: decoded.episode_id,
          sequence: safeInteger(decoded.sequence, "sequence"),
          recorderFrameIndex: safeInteger(decoded.recorder_frame_index, "recorder frame index"),
          sourceTimestampUs: safeInteger(decoded.source_timestamp_us, "source timestamp"),
          flags: decoded.flags,
          checksum: decoded.checksum,
          payload: decoded.payload(),
        };
      } finally {
        decoded.free();
      }
    },
    createFixedRing: (capacity) => {
      const ring = new bindings.FixedF32Ring(capacity);
      return {
        get capacity() {
          return ring.capacity;
        },
        get length() {
          return ring.len;
        },
        get isEmpty() {
          return ring.is_empty;
        },
        push: (value) => ring.push(value),
        pushMany: (values) => ring.push_many(values),
        clear: () => ring.clear(),
        copyChronological: () => ring.copy_chronological(),
        mean: () => ring.mean(),
        rms: () => ring.rms(),
        dispose: () => ring.free(),
      };
    },
    normaliseQuaternions: bindings.normalise_quaternions,
    signalRmsWindows: bindings.signal_rms_windows,
  };
}

const SIMD_PROBE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x0b,
);

export function supportsWasmSimd(): boolean {
  return typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
}

export async function loadRecorderKernels(options: {
  forceJavaScript?: boolean;
  preferSimd?: boolean;
} = {}): Promise<RecorderKernels> {
  if (options.forceJavaScript || typeof WebAssembly === "undefined") {
    return createJavaScriptKernels();
  }

  const candidates: Array<{ directory: string; backend: RecorderKernelBackend }> = [];
  if (options.preferSimd !== false && supportsWasmSimd()) {
    candidates.push({ directory: "pkg-simd", backend: "wasm-simd" });
  }
  candidates.push({ directory: "pkg-scalar", backend: "wasm-scalar" });

  for (const candidate of candidates) {
    try {
      const moduleUrl = typeof location === "undefined"
        ? new URL(`../${candidate.directory}/recorder_kernels.js`, import.meta.url).href
        : new URL(`/wasm/recorder-kernels/${candidate.directory}/recorder_kernels.js`, location.origin).href;
      const bindings = (await import(/* @vite-ignore */ moduleUrl)) as WasmBindings;
      await bindings.default();
      return createWasmKernels(bindings, candidate.backend);
    } catch {
      continue;
    }
  }

  return createJavaScriptKernels();
}
