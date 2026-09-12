import assert from "node:assert/strict";
import test from "node:test";

import { loadRecorderKernels, supportsWasmSimd } from "./loader.js";

test("JavaScript fallback preserves recorder accounting and detects corruption", async () => {
  const kernels = await loadRecorderKernels({ forceJavaScript: true });
  assert.equal(kernels.backend, "javascript");
  assert.equal(kernels.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(kernels.crc32c(new TextEncoder().encode("123456789")), 0xe3069283);

  const frame = kernels.encodeRecord({
    sessionId: "session-7",
    episodeId: "episode-11",
    sequence: 13,
    recorderFrameIndex: 17,
    sourceTimestampUs: 19_000_000,
    flags: 0x21,
    payload: Uint8Array.of(1, 2, 3, 4),
  });
  assert.deepEqual(kernels.decodeRecord(frame), {
    sessionId: "session-7",
    episodeId: "episode-11",
    sequence: 13,
    recorderFrameIndex: 17,
    sourceTimestampUs: 19_000_000,
    flags: 0x21,
    checksum: new DataView(frame.buffer).getUint32(40, true),
    payload: Uint8Array.of(1, 2, 3, 4),
  });

  frame[frame.length - 1] ^= 1;
  assert.throws(() => kernels.decodeRecord(frame), /checksum/);
});

test("fixed ring, quaternion and signal fallback kernels are deterministic", async () => {
  const kernels = await loadRecorderKernels({ forceJavaScript: true });
  const ring = kernels.createFixedRing(3);
  ring.pushMany(Float32Array.of(1, 2, 3, 4, 5));
  assert.deepEqual(ring.copyChronological(), Float32Array.of(3, 4, 5));
  assert.equal(ring.mean(), 4);
  assert.ok(Math.abs(ring.rms() - Math.sqrt(50 / 3)) < 1e-6);
  ring.dispose();

  assert.deepEqual(
    kernels.normaliseQuaternions(Float32Array.of(0, 0, 0, 2, 0, 0, 0, 0)),
    Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1),
  );
  const rms = kernels.signalRmsWindows(Float32Array.of(3, 4, 0, 12, 5), 2);
  assert.ok(Math.abs(rms[0] - Math.sqrt(12.5)) < 1e-6);
  assert.ok(Math.abs(rms[1] - Math.sqrt(72)) < 1e-6);
  assert.equal(rms[2], 5);
});

test("simd capability probe returns a boolean", () => {
  assert.equal(typeof supportsWasmSimd(), "boolean");
});
