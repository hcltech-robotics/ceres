import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encodeRecorderBlock } from "../../../shared/protocol.js";
import { supportsWasmSimd } from "./loader.js";

interface GeneratedBindings {
  initSync(input: { module: Uint8Array }): unknown;
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
  decode_record(frame: Uint8Array): {
    readonly session_id: string;
    readonly episode_id: string;
    readonly sequence: bigint;
    readonly recorder_frame_index: bigint;
    payload(): Uint8Array;
    free(): void;
  };
  normalise_quaternions(values: Float32Array): Float32Array;
}

async function loadGeneratedBindings(directory: string): Promise<GeneratedBindings> {
  const javascriptUrl = new URL(`../${directory}/recorder_kernels.js`, import.meta.url);
  const wasmUrl = new URL(`../${directory}/recorder_kernels_bg.wasm`, import.meta.url);
  const bindings = (await import(javascriptUrl.href)) as GeneratedBindings;
  bindings.initSync({ module: new Uint8Array(await readFile(wasmUrl)) });
  return bindings;
}

async function verifyGeneratedPackage(directory: string): Promise<void> {
  const bindings = await loadGeneratedBindings(directory);
  assert.equal(bindings.crc32_ieee(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(bindings.crc32c(new TextEncoder().encode("123456789")), 0xe3069283);

  const payload = Uint8Array.of(1, 3, 5, 7);
  const recordFrame = bindings.encode_record("session-2", "episode-3", 5n, 7n, 11n, 13, payload);
  assert.deepEqual(
    recordFrame,
    encodeRecorderBlock({
      sessionId: "session-2",
      episodeId: "episode-3",
      sequence: 5,
      recorderFrameIndex: 7,
      sourceTimestampUs: 11,
      flags: 13,
      payload,
    }),
  );
  const record = bindings.decode_record(recordFrame);
  try {
    assert.equal(record.session_id, "session-2");
    assert.equal(record.episode_id, "episode-3");
    assert.equal(record.sequence, 5n);
    assert.equal(record.recorder_frame_index, 7n);
    assert.deepEqual(record.payload(), payload);
  } finally {
    record.free();
  }

  assert.deepEqual(
    bindings.normalise_quaternions(Float32Array.of(0, 0, 0, 2)),
    Float32Array.of(0, 0, 0, 1),
  );
}

test("generated scalar Wasm package runs deterministic kernels", async () => {
  await verifyGeneratedPackage("pkg-scalar");
});

test("generated simd128 Wasm package runs deterministic kernels", { skip: !supportsWasmSimd() }, async () => {
  await verifyGeneratedPackage("pkg-simd");
});
