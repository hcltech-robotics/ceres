import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { loadRecorderKernels, type RecorderKernels } from "./loader.js";

interface GeneratedBindings {
  initSync(input: { module: Uint8Array }): unknown;
  crc32_ieee(data: Uint8Array): number;
  encode_record(
    sessionId: string,
    episodeId: string,
    sequence: bigint,
    recorderFrameIndex: bigint,
    sourceTimestampUs: bigint,
    flags: number,
    payload: Uint8Array,
  ): Uint8Array;
}

interface BenchmarkBackend {
  name: "scalar" | "simd128" | "javascript";
  checksum(data: Uint8Array): number;
  encode(payload: Uint8Array): Uint8Array;
}

interface BenchmarkResult {
  backend: BenchmarkBackend["name"];
  operation: "binary encode" | "checksum";
  medianMs: number;
  operationsPerSecond: number;
  inputMiBPerSecond: number;
  inputBytesPerOperation: number;
  outputBytesPerOperation: number;
}

const SAMPLE_ROUNDS = 7;
const WARMUP_ITERATIONS = 25;

const recordPayload = Uint8Array.from({ length: 1024 }, (_, index) => (index * 31 + 7) & 0xff);
const checksumPayload = Uint8Array.from({ length: 16 * 1024 }, (_, index) => (index * 17 + 11) & 0xff);
async function loadGeneratedBackend(
  directory: "pkg-scalar" | "pkg-simd",
  name: "scalar" | "simd128",
): Promise<BenchmarkBackend> {
  const javascriptUrl = new URL(`../${directory}/recorder_kernels.js`, import.meta.url);
  const wasmUrl = new URL(`../${directory}/recorder_kernels_bg.wasm`, import.meta.url);
  const bindings = (await import(javascriptUrl.href)) as GeneratedBindings;
  bindings.initSync({ module: new Uint8Array(await readFile(wasmUrl)) });
  return {
    name,
    checksum: (data) => bindings.crc32_ieee(data),
    encode: (payload) =>
      bindings.encode_record(
        "benchmark-session",
        "benchmark-episode",
        17n,
        19n,
        23_000_000n,
        2,
        payload,
      ),
  };
}

function javascriptBackend(kernels: RecorderKernels): BenchmarkBackend {
  return {
    name: "javascript",
    checksum: kernels.crc32,
    encode: (payload) =>
      kernels.encodeRecord({
        sessionId: "benchmark-session",
        episodeId: "benchmark-episode",
        sequence: 17,
        recorderFrameIndex: 19,
        sourceTimestampUs: 23_000_000,
        flags: 2,
        payload,
      }),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(
  backend: BenchmarkBackend,
  operation: BenchmarkResult["operation"],
  inputBytesPerOperation: number,
  outputBytesPerOperation: number,
  iterations: number,
  action: () => number,
): BenchmarkResult {
  let guard = 0;
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) guard ^= action();

  const samples: number[] = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) guard ^= action();
    samples.push(performance.now() - startedAt);
  }
  if (guard === Number.MIN_SAFE_INTEGER) throw new Error("unreachable benchmark guard");

  const medianMs = median(samples);
  const seconds = medianMs / 1000;
  return {
    backend: backend.name,
    operation,
    medianMs,
    operationsPerSecond: iterations / seconds,
    inputMiBPerSecond: (iterations * inputBytesPerOperation) / (1024 * 1024 * seconds),
    inputBytesPerOperation,
    outputBytesPerOperation,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const backends = [
  await loadGeneratedBackend("pkg-scalar", "scalar"),
  await loadGeneratedBackend("pkg-simd", "simd128"),
  javascriptBackend(await loadRecorderKernels({ forceJavaScript: true })),
];

const referenceRecord = backends[0].encode(recordPayload);
const referenceChecksum = backends[0].checksum(checksumPayload);
for (const backend of backends.slice(1)) {
  if (!equalBytes(backend.encode(recordPayload), referenceRecord)) {
    throw new Error(`${backend.name} binary encoding does not match the scalar backend`);
  }
  if (backend.checksum(checksumPayload) !== referenceChecksum) {
    throw new Error(`${backend.name} checksum does not match the scalar backend`);
  }
}

const results: BenchmarkResult[] = [];
for (const backend of backends) {
  results.push(
    measure(backend, "binary encode", recordPayload.byteLength, referenceRecord.byteLength, 3_000, () => {
      const output = backend.encode(recordPayload);
      return output[40] ^ output[output.length - 1];
    }),
    measure(backend, "checksum", checksumPayload.byteLength, 4, 500, () => backend.checksum(checksumPayload)),
  );
}

const report = {
  environment: {
    platform: `${process.platform} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    node: process.version,
    v8: process.versions.v8,
  },
  configuration: {
    sampleRounds: SAMPLE_ROUNDS,
    statistic: "median",
    binaryEncodeIterationsPerRound: 3_000,
    checksumIterationsPerRound: 500,
    recordPayloadBytes: recordPayload.byteLength,
    checksumPayloadBytes: checksumPayload.byteLength,
    recordOutputBytes: referenceRecord.byteLength,
  },
  results: results.map((result) => ({
    ...result,
    medianMs: Number(result.medianMs.toFixed(3)),
    operationsPerSecond: Number(result.operationsPerSecond.toFixed(1)),
    inputMiBPerSecond: Number(result.inputMiBPerSecond.toFixed(1)),
  })),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
