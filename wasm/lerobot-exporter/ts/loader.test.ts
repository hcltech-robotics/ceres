import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { updateCeresDatasetCard } from "../../../shared/dataset-card.ts";
import { isMonitorWorker, loadLeRobotExporter, supportsWasmSimd } from "./loader.ts";

const config = {
  fps: 10,
  task: { index: 0, text: "loader test" },
  tasks: [
    { index: 0, text: "loader test" },
    { index: 1, text: "second task" },
  ],
  action_names: ["left_hand.pinch_distance", "right_hand.pinch_distance"],
  row_group_size: 16,
  reduction_batch_rows: 16,
  max_frames: 100,
};

test("the loader gate accepts a worker and rejects a document", () => {
  assert.equal(isMonitorWorker({ postMessage() {} }), true);
  assert.equal(isMonitorWorker({ document: {}, postMessage() {} }), false);
  assert.equal(typeof supportsWasmSimd(), "boolean");
});

test("the scalar Wasm loader exports a semantic LeRobot bundle", async () => {
  const wasmBytes = await readFile(
    new URL("../pkg-scalar/ceres_lerobot_exporter_bg.wasm", import.meta.url),
  );
  const module = await loadLeRobotExporter({
    preferSimd: false,
    allowOutsideWorkerForTests: true,
    wasmBytesForTests: wasmBytes,
  });
  assert.equal(module.backend, "wasm-scalar");
  assert.equal((module.compatibilityProfile() as { format: string }).format, "v3.0");

  const exporter = module.create(config);
  try {
    for (let frame = 0; frame < 2; frame += 1) {
      const telemetry = new Float64Array(411);
      telemetry[0] = 1_000_000 + frame * 100_000;
      telemetry.fill(frame + 0.5, 1);
      exporter.pushCeresFrame(BigInt(frame), telemetry, new Float32Array([0.25, 0.75]));
    }
    exporter.pushCeresSensorFrameJsonForTask(JSON.stringify({
      timestampMs: 1_200,
      frameIndex: 2,
      head: null,
      leftHand: { tracked: false, joints: {}, pinch: 0.5 },
      rightHand: { tracked: false, joints: {}, pinch: 0.75 },
    }), 1n);
    const bundle = exporter.finish();
    try {
      const paths = Array.from({ length: bundle.artifactCount() }, (_, index) =>
        bundle.artifactPath(index),
      );
      assert(paths.includes("data/chunk-000/file-000.parquet"));
      assert(paths.includes("meta/info.json"));
      const dataIndex = paths.indexOf("data/chunk-000/file-000.parquet");
      const parquet = bundle.artifactBytes(dataIndex);
      assert.deepEqual(Array.from(parquet.subarray(0, 4)), [0x50, 0x41, 0x52, 0x31]);
    } finally {
      bundle.free();
    }
  } finally {
    exporter.free();
  }
});

test("the managed card makes the real exporter output load through the Parquet builder", {
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ceres-hf-loader-"));
  try {
    const wasmBytes = await readFile(
      new URL("../pkg-scalar/ceres_lerobot_exporter_bg.wasm", import.meta.url),
    );
    const module = await loadLeRobotExporter({
      preferSimd: false,
      allowOutsideWorkerForTests: true,
      wasmBytesForTests: wasmBytes,
    });
    const episodeMetadata: unknown[] = [];
    for (let episodeIndex = 0; episodeIndex < 2; episodeIndex += 1) {
      const exporter = module.create({
        ...config,
        episode_index: episodeIndex,
        global_frame_index: episodeIndex * 2,
      });
      try {
        for (let frame = 0; frame < 2; frame += 1) {
          const telemetry = new Float64Array(411);
          telemetry[0] = 1_000_000 + frame * 100_000;
          telemetry.fill(episodeIndex + frame + 0.5, 1);
          exporter.pushCeresFrame(
            BigInt(frame),
            telemetry,
            new Float32Array([0.25, 0.75]),
          );
        }
        const bundle = exporter.finish();
        try {
          const shard = path.join(
            root,
            "shards",
            `episode-${String(episodeIndex).padStart(6, "0")}`,
          );
          for (let index = 0; index < bundle.artifactCount(); index += 1) {
            const destination = path.join(shard, bundle.artifactPath(index));
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bundle.artifactBytes(index));
          }
        } finally {
          bundle.free();
        }
      } finally {
        exporter.free();
      }
      episodeMetadata.push({
        episodeId: `episode-${String(episodeIndex).padStart(6, "0")}`,
        segments: [{ outcome: "completed", recorderSlotCount: 2, gapCount: 0 }],
      });
    }
    await writeFile(
      path.join(root, "README.md"),
      (await updateCeresDatasetCard(null, "research/ceres-loader-test", episodeMetadata)).content,
      "utf8",
    );

    const python = [
      "import json, sys",
      "from datasets import load_dataset",
      "dataset = load_dataset(sys.argv[1], split='train', streaming=True)",
      "rows = list(dataset)",
      "first = rows[0]",
      "print(json.dumps({",
      "    'builder': dataset.info.builder_name,",
      "    'columns': dataset.column_names,",
      "    'rows': len(rows),",
      "    'episodes': sorted(set(row['episode_index'] for row in rows)),",
      "    'state_length': len(first['observation.state']),",
      "    'action_length': len(first['action']),",
      "}))",
    ].join("\n");
    const oraclePython = process.env.CERES_LEROBOT_ORACLE_PYTHON || "python";
    const loaded = spawnSync(oraclePython, ["-c", python, root], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(loaded.status, 0, loaded.stderr || loaded.stdout);
    const result = JSON.parse(loaded.stdout.trim()) as {
      builder: string;
      columns: string[];
      rows: number;
      episodes: number[];
      state_length: number;
      action_length: number;
    };
    assert.equal(result.builder, "parquet");
    assert.equal(result.rows, 4);
    assert.deepEqual(result.episodes, [0, 1]);
    assert.equal(result.state_length, 410);
    assert.equal(result.action_length, 2);
    assert.deepEqual(result.columns, [
      "observation.state",
      "action",
      "timestamp",
      "frame_index",
      "episode_index",
      "index",
      "task_index",
      "ceres.source_frame_index",
      "ceres.source_timestamp",
      "ceres.source_gap",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the simd128 Wasm loader selects the accelerated module", async (context) => {
  if (!supportsWasmSimd()) {
    context.skip("this JavaScript runtime does not support Wasm simd128");
    return;
  }
  const wasmBytes = await readFile(
    new URL("../pkg-simd/ceres_lerobot_exporter_bg.wasm", import.meta.url),
  );
  const module = await loadLeRobotExporter({
    preferSimd: true,
    allowOutsideWorkerForTests: true,
    wasmBytesForTests: wasmBytes,
  });
  assert.equal(module.backend, "wasm-simd");
  const exporter = module.create(config);
  exporter.free();
});
