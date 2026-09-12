import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const variants = ["pkg-scalar", "pkg-simd"] as const;
const MAX_WASM_BYTES = 8 * 1024 * 1024;

for (const variant of variants) {
  test(`${variant} is valid Wasm and remains within the size budget`, async () => {
    const path = new URL(`../${variant}/ceres_lerobot_exporter_bg.wasm`, import.meta.url);
    const [bytes, details] = await Promise.all([readFile(path), stat(path)]);
    assert.equal(WebAssembly.validate(bytes), true);
    assert(details.size > 0);
    assert(
      details.size <= MAX_WASM_BYTES,
      `${variant} is ${details.size} bytes, above the ${MAX_WASM_BYTES} byte budget`,
    );
  });
}
