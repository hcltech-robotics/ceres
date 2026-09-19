import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadLeRobotExporter } from "./loader.ts";

const execFileAsync = promisify(execFile);

test(
  "official LeRobot v0.4.0 optional conformance oracle",
  { skip: process.env.CERES_LEROBOT_ORACLE !== "1" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ceres-lerobot-oracle-"));
    const wasmBytes = await readFile(
      new URL("../pkg-scalar/ceres_lerobot_exporter_bg.wasm", import.meta.url),
    );
    const module = await loadLeRobotExporter({
      preferSimd: false,
      allowOutsideWorkerForTests: true,
      wasmBytesForTests: wasmBytes,
    });
    const exporter = module.create({
      fps: 10,
      task: { index: 0, text: "oracle test" },
      action_names: ["left.pinch", "right.pinch"],
      row_group_size: 16,
      reduction_batch_rows: 16,
      max_frames: 100,
    });
    try {
      for (let frame = 0; frame < 3; frame += 1) {
        const telemetry = new Float64Array(411);
        telemetry[0] = 1_000_000 + frame * 100_000;
        telemetry.fill(frame + 0.5, 1);
        exporter.pushCeresFrame(BigInt(frame), telemetry, new Float32Array([0.25, 0.75]));
      }
      const bundle = exporter.finish();
      try {
        for (let index = 0; index < bundle.artifactCount(); index += 1) {
          const path = bundle.artifactPath(index);
          const destination = join(root, ...path.split("/"));
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, bundle.artifactBytes(index));
        }
      } finally {
        bundle.free();
      }
      const script = fileURLToPath(new URL("../tests/oracle/verify_lerobot.py", import.meta.url));
      const oraclePython = process.env.CERES_LEROBOT_ORACLE_PYTHON || "python";
      const result = await execFileAsync(oraclePython, [script, root], {
        env: process.env,
      });
      assert.match(result.stdout, /PASS: LeRobot v0\.4\.0 oracle/);
    } finally {
      exporter.free();
      await rm(root, { recursive: true, force: true });
    }
  },
);
