import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer } from "hyparquet";
import { XR_HAND_JOINTS } from "../../shared/xr-hand-joints.js";
import { normaliseTaskSpecification, taskSpecificationSha256Hex } from "../../shared/task-specification.js";
import { loadLeRobotExporter, type LoadedExporterModule } from "../../wasm/lerobot-exporter/ts/loader.js";
import { replayParquetCompressors } from "../dataset-replay-zstd.js";
import { withStoredExport, type StoredExportReference, type StoredExportOptions } from "../monitor-stored-exports.js";
import { openBrowserExportStorage } from "./storage.js";
import type { StoredExportArtifact } from "./types.js";

export interface RebuildStoredExportsOptions {
  storedExports: readonly StoredExportReference[];
  sessionId: string;
  episodeIndexBase: number;
  globalFrameIndexBase: number;
  signal: AbortSignal;
  onProgress?: (completed: number, total: number, detail: string) => void;
  /** Supplies the same Wasm implementation without browser worker detection in Node tests. */
  moduleForTests?: LoadedExporterModule;
  storageOptionsForTests?: StoredExportOptions;
}

export async function rebuildStoredExports(options: RebuildStoredExportsOptions): Promise<{
  artefacts: StoredExportArtifact[];
  episodeIds: string[];
  episodeCount: number;
}> {
  const { signal } = options;
  if (options.storedExports.length === 0 || options.storedExports.length > 1000
    || !Number.isSafeInteger(options.episodeIndexBase) || options.episodeIndexBase < 0
    || !Number.isSafeInteger(options.globalFrameIndexBase) || options.globalFrameIndexBase < 0) {
    throw new Error("The saved capture transfer allocation is invalid");
  }
  const module = options.moduleForTests ?? await loadLeRobotExporter();
  const storage = await openBrowserExportStorage(options.sessionId);
  const artefacts: StoredExportArtifact[] = [];
  const episodeIds: string[] = [];
  const references = new Set(options.storedExports.map((entry) => `${entry.sessionId}:${entry.episodeIndex}:${entry.receiptSha256}`));
  if (references.size !== options.storedExports.length) throw new Error("The saved capture selection contains duplicates");
  let globalIndex = options.globalFrameIndexBase;
  for (const [index, reference] of options.storedExports.entries()) {
    signal.throwIfAborted();
    const prepared = await withStoredExport(reference, async (saved) => {
      const prefix = `shards/episode-${String(reference.episodeIndex).padStart(6, "0")}/`;
      const artifact = (relative: string) => {
        const found = saved.artefacts.find((entry) => entry.path === `${prefix}${relative}`);
        if (!found) throw new Error(`The saved capture is missing ${relative}`);
        return found.file;
      };
      const info = object(JSON.parse(await artifact("meta/info.json").text()));
      const features = object(info.features);
      const stateFeature = object(features["observation.state"]);
      const actionFeature = object(features.action);
      if (!Array.isArray(stateFeature.shape) || stateFeature.shape[0] !== 410
        || !Array.isArray(stateFeature.names) || stateFeature.names.length !== observationNames.length
        || !stateFeature.names.every((name, index) => name === observationNames[index])
        || !Array.isArray(actionFeature.names) || actionFeature.names.length !== 2
        || !actionFeature.names.every((name) => typeof name === "string")
        || !Number.isSafeInteger(info.fps) || Number(info.fps) <= 0) throw new Error("The saved capture has an incompatible data format");
      const tasks = (await parquetReadObjects({ file: blobBuffer(artifact("meta/tasks.parquet")), compressors: replayParquetCompressors }))
        .map((row) => ({ index: integer(row.task_index), text: typeof row.__index_level_0__ === "string" ? row.__index_level_0__ : "" }));
      if (tasks.length === 0 || tasks.some((task) => task.text.length === 0)) throw new Error("The saved capture task catalogue is invalid");
      const dataFiles = saved.artefacts.filter((entry) => /^data\/chunk-\d+\/file-\d+\.parquet$/.test(entry.path.slice(prefix.length)));
      if (dataFiles.length !== 1) throw new Error("The saved capture must contain one observation file");
      const sourceFile = blobBuffer(dataFiles[0].file);
      const sourceMetadata = await parquetMetadataAsync(sourceFile);
      const frameCount = integer(sourceMetadata.num_rows);
      if (frameCount <= 0 || !Number.isSafeInteger(globalIndex + frameCount)) throw new Error("The saved capture frame accounting is invalid");
      const episodeIndex = options.episodeIndexBase + index;
      if (!Number.isSafeInteger(episodeIndex)) throw new Error("The saved capture transfer allocation is invalid");
      const exporter = module.create({
        fps: info.fps,
        robot_type: typeof info.robot_type === "string" ? info.robot_type : "ceres_xr",
        episode_index: episodeIndex,
        global_frame_index: globalIndex,
        task: tasks[0], tasks,
        action_names: actionFeature.names,
        row_group_size: 256,
        reduction_batch_rows: 256,
        max_frames: frameCount,
      });
      try {
        for (let start = 0; start < frameCount; start += 256) {
          signal.throwIfAborted();
          const end = Math.min(start + 256, frameCount);
          const rows = await parquetReadObjects({
            file: sourceFile, metadata: sourceMetadata, compressors: replayParquetCompressors,
            rowStart: start, rowEnd: end,
          });
          if (rows.length !== end - start) throw new Error("The saved capture observation file is incomplete");
          for (const [offset, row] of rows.entries()) {
            if (integer(row.frame_index) !== start + offset || integer(row.episode_index) !== reference.episodeIndex) {
              throw new Error("The saved capture observation indexes are inconsistent");
            }
            if (exporter.reductionReady()) exporter.reducePendingCpu();
            exporter.pushCeresSensorFrameJsonForTask(JSON.stringify(sensorFrame(row)), BigInt(integer(row.task_index)));
          }
          options.onProgress?.(index + end / frameCount, options.storedExports.length, `Preparing ${saved.capture.title}`);
        }
        for (const entry of saved.artefacts) {
          const match = /^videos\/(.+)\/chunk-\d+\/file-\d+\.mp4$/.exec(entry.path.slice(prefix.length));
          if (!match) continue;
          signal.throwIfAborted();
          const feature = object(features[match[1]]);
          const video = object(feature.info);
          exporter.attachVideo(match[1], JSON.stringify({
            width: video["video.width"], height: video["video.height"], channels: video["video.channels"],
            fps: video["video.fps"], frame_count: video["video.frame_count"], duration_s: video["video.duration_s"],
            codec: video["video.codec"], pixel_format: video["video.pix_fmt"], has_audio: video.has_audio,
            is_depth_map: video["video.is_depth_map"], backend: video["video.video_backend"],
          }), new Uint8Array(await entry.file.arrayBuffer()));
        }
        let task;
        if (saved.metadata.taskSpecHash || saved.metadata.taskSpecificationPath || saved.metadata.taskSpecVersion) {
          if (saved.metadata.taskSpecVersion !== 1 || !/^[a-f0-9]{64}$/.test(saved.metadata.taskSpecHash ?? "")
            || saved.metadata.taskSpecificationPath !== `ceres/task-specifications/${saved.metadata.taskSpecHash}.json`) {
            throw new Error("The saved capture task provenance is invalid");
          }
          const specification = normaliseTaskSpecification(JSON.parse(await artifact(saved.metadata.taskSpecificationPath).text()));
          if (await taskSpecificationSha256Hex(specification) !== saved.metadata.taskSpecHash) throw new Error("The saved capture task provenance hash is invalid");
          task = { version: 1, hash: saved.metadata.taskSpecHash!, specification };
        }
        const episodeId = `saved-${await transferIdentity(reference)}`;
        return {
          bundle: exporter.finish(), episodeIndex, episodeId, frameCount, title: saved.capture.title,
          provenance: {
            ...(saved.metadata.captureMetadata ? { captureMetadata: saved.metadata.captureMetadata } : {}),
            segments: saved.metadata.segments,
            capture: { runTitle: saved.capture.title, cycle: saved.capture.cycle ?? 1, taskLabel: saved.capture.taskLabel },
            ...(task ? { task } : {}),
          },
        };
      } finally {
        exporter.free();
      }
    }, { ...options.storageOptionsForTests, signal, allowArchivedFallback: true });
    try {
      // The bundle owns the rebuilt bytes. Release the source lock before writing
      // an allocation that may reuse the source session and shard index.
      artefacts.push(...await storage.writeBundle(prepared.episodeIndex, prepared.episodeId, prepared.bundle,
        prepared.provenance, undefined, signal, () => undefined));
      episodeIds.push(prepared.episodeId);
      globalIndex += prepared.frameCount;
      options.onProgress?.(index + 1, options.storedExports.length, `Prepared ${prepared.title}`);
    } finally { prepared.bundle.free(); }
  }
  return { artefacts, episodeIds, episodeCount: episodeIds.length };
}

function blobBuffer(file: Blob): AsyncBuffer {
  return { byteLength: file.size, slice: (start, end) => file.slice(start, end).arrayBuffer() };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved capture metadata is invalid");
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error("The saved capture numeric metadata is invalid");
  return parsed;
}

function vector(value: unknown, length: number): number[] {
  const values = Array.isArray(value) ? value : ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : [];
  if (values.length !== length || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("The saved capture sensor values are invalid");
  }
  return values;
}

function sensorFrame(row: Record<string, unknown>) {
  const state = vector(row["observation.state"], 410);
  const action = vector(row.action, 2);
  const seconds = row["ceres.source_timestamp"];
  const gap = row["ceres.source_gap"];
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || typeof gap !== "boolean") {
    throw new Error("The saved capture source timing is invalid");
  }
  for (const [offset, length] of [[0, 8], [8, 201], [209, 201]]) {
    if (state[offset] !== 0 && state[offset] !== 1) throw new Error("The saved capture tracking state is invalid");
    if (state[offset] === 0 && state.slice(offset + 1, offset + length).some((value) => value !== 0)) {
      throw new Error("The saved capture contains values outside its tracked state");
    }
  }
  if (gap && (state.some((value) => value !== 0) || action.some((value) => value !== 0))) {
    throw new Error("The saved capture gap row contains observations");
  }
  const transform = (offset: number) => ({
    position: { x: state[offset], y: state[offset + 1], z: state[offset + 2] },
    rotation: { x: state[offset + 3], y: state[offset + 4], z: state[offset + 5], w: state[offset + 6] },
  });
  const hand = (offset: number, pinch: number) => ({
    tracked: state[offset] === 1, pinch,
    joints: Object.fromEntries(XR_HAND_JOINTS.map((name, index) => {
      const jointOffset = offset + 1 + index * 8;
      return [name, { ...transform(jointOffset), radius: state[jointOffset + 7] }];
    })),
  });
  return {
    timestampMs: sourceMilliseconds(seconds),
    frameIndex: integer(row["ceres.source_frame_index"]),
    gap,
    head: state[0] === 1 ? transform(1) : null,
    leftHand: hand(8, action[0]),
    rightHand: hand(209, action[1]),
  };
}

const transformNames = ["position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z", "rotation.w"];
const observationNames = [
  "head.tracked", ...transformNames.map((name) => `head.${name}`),
  ...["left_hand", "right_hand"].flatMap((hand) => [
    `${hand}.tracked`, ...XR_HAND_JOINTS.flatMap((joint) => [...transformNames, "radius"].map((name) => `${hand}.${joint}.${name}`)),
  ]),
];

function sourceMilliseconds(seconds: number): number {
  const initial = seconds * 1000;
  if (initial * 1000 / 1_000_000 === seconds) return initial;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, initial);
  const bits = view.getBigUint64(0);
  for (const offset of [-2n, -1n, 1n, 2n]) {
    if (bits + offset < 0n) continue;
    view.setBigUint64(0, bits + offset);
    const candidate = view.getFloat64(0);
    if (candidate * 1000 / 1_000_000 === seconds) return candidate;
  }
  throw new Error("The saved capture source timestamp cannot be preserved exactly");
}

async function transferIdentity(reference: StoredExportReference): Promise<string> {
  const bytes = new TextEncoder().encode(`${reference.sessionId}:${reference.episodeId}:${reference.receiptSha256}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
