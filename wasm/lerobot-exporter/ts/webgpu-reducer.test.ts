import assert from "node:assert/strict";
import test from "node:test";

import { REDUCTION_SHADER, reducePending, type ReducibleExporter } from "./webgpu-reducer.ts";

test("the deterministic Wasm fallback drains a pending reduction", async () => {
  let cpuCalls = 0;
  const exporter: ReducibleExporter = {
    pendingReductionRows: () => 2,
    pendingReductionDimensions: () => 2,
    pendingReductionValues: () => new Float32Array([1, 10, 2, 20]),
    acceptGpuReduction: () => assert.fail("GPU results were not expected"),
    reducePendingCpu: () => {
      cpuCalls += 1;
    },
  };
  assert.equal(await reducePending(exporter, undefined), "wasm-cpu");
  assert.equal(cpuCalls, 1);
});

test("the WebGPU kernel performs parallel Welford reductions", () => {
  assert.match(REDUCTION_SHADER, /@workgroup_size\(256\)/);
  assert.match(REDUCTION_SHADER, /dispatchWorkgroups|workgroupBarrier/);
  assert.match(REDUCTION_SHADER, /delta \* delta/);
  assert.doesNotMatch(REDUCTION_SHADER, /atomicAdd/);
});
