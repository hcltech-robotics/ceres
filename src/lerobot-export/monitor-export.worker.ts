/// <reference lib="webworker" />

import {
  CERES_LEROBOT_ACTION_NAMES,
  episodeExportTimeline,
  type EpisodeExportTimeline,
} from "../../shared/lerobot-export.js";
import { loadLeRobotExporter, type CeresLeRobotExporter } from "../../wasm/lerobot-exporter/ts/loader.js";
import { resolveMonitorEpisodeAllocation } from "./allocation.js";
import { reducePending } from "../../wasm/lerobot-exporter/ts/webgpu-reducer.js";
import { serialiseWorkerError, workerErrorContext } from "../worker-errors.js";
import {
  fetchMonitorEpisodeExportManifest,
  loadMonitorOpfsEpisodeExportManifest,
  MONITOR_RECORDING_STORAGE_ROOT,
  SOLO_RECORDING_STORAGE_ROOT,
  streamSensorRows,
} from "./episode-source.js";
import { prepareEpisodeVideo } from "./media.js";
import { openBrowserExportStorage } from "./storage.js";
import { prepareEpisodeExportRow } from "./timeline.js";
import type {
  MonitorExportFfmpegStage,
  MonitorExportProgressEvent,
  MonitorExportStartMessage,
  MonitorExportWorkerEvent,
  MonitorExportWorkerRequest,
  StoredExportArtifact,
} from "./types.js";

const workerScope = self as DedicatedWorkerGlobalScope;
const PROGRESS_INTERVAL_MS = 750;
const EXPORT_FAILURE_MESSAGE = "Browser export failed before the artefacts were ready. Retry the export.";
const FFMPEG_ERROR_STAGES = new Set<MonitorExportFfmpegStage>([
  "ffmpeg_load",
  "ffmpeg_write",
  "ffmpeg_exec",
  "ffmpeg_read",
  "ffmpeg_inspect",
]);
let activeRequest: { requestId: string; controller: AbortController } | null = null;
let activeStage: MonitorExportProgressEvent["stage"] = "queued";
let pendingProgress: MonitorExportProgressEvent | null = null;
let progressTimer: number | null = null;
let lastProgressAt = Number.NEGATIVE_INFINITY;
let lastProgressStage: MonitorExportProgressEvent["stage"] | null = null;

workerScope.onmessage = (event: MessageEvent<MonitorExportWorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    if (activeRequest?.requestId === message.requestId) activeRequest.controller.abort(new DOMException("Export cancelled", "AbortError"));
    return;
  }
  if (activeRequest) {
    const error = new Error("Another export is already running. Wait for it to finish, then retry.");
    error.name = "ExportBusyError";
    const errorTelemetry = serialiseWorkerError(error, workerOrigin());
    post({
      type: "error",
      requestId: message.requestId,
      error: error.message,
      errorType: errorTelemetry.type,
      errorTelemetry,
      stage: "queued",
      cancelled: false,
    });
    return;
  }
  const controller = new AbortController();
  activeRequest = { requestId: message.requestId, controller };
  activeStage = "queued";
  void runExport(message, controller.signal).finally(() => {
    if (activeRequest?.requestId === message.requestId) activeRequest = null;
  });
};

async function runExport(message: MonitorExportStartMessage, signal: AbortSignal): Promise<void> {
  try {
    if (message.storedExports) {
      const { rebuildStoredExports } = await import("./stored-export.js");
      const result = await rebuildStoredExports({
        storedExports: message.storedExports,
        sessionId: message.sessionId,
        episodeIndexBase: message.episodeIndexBase ?? Number.NaN,
        globalFrameIndexBase: message.globalFrameIndexBase ?? Number.NaN,
        signal,
        onProgress: (completed, total, detail) => progress(message, "writing", detail, completed, total),
      });
      post({ type: "complete", requestId: message.requestId, episodeCount: result.episodeCount,
        episodeIds: result.episodeIds, artifactCount: result.artefacts.length,
        artefacts: result.artefacts.map(({ file: _file, ...artifact }) => artifact),
      });
      return;
    }
    if (message.episodeIds.length === 0) throw new Error("There are no episodes with durable sensor frames to export");
    if (new Set(message.episodeIds).size !== message.episodeIds.length) throw new Error("Episode export selection contains duplicates");
    const hasEpisodeIndexBase = message.episodeIndexBase !== undefined;
    const hasGlobalFrameIndexBase = message.globalFrameIndexBase !== undefined;
    if (
      hasEpisodeIndexBase !== hasGlobalFrameIndexBase
      || (hasEpisodeIndexBase && (
        !Number.isSafeInteger(message.episodeIndexBase)
        || message.episodeIndexBase! < 0
        || !Number.isSafeInteger(message.globalFrameIndexBase)
        || message.globalFrameIndexBase! < 0
      ))
    ) {
      throw new Error("Hugging Face episode and frame allocation is invalid");
    }
    progress(message, "queued", "Loading the Rust LeRobot v3 exporter", 0, message.episodeIds.length);
    const [module, storage] = await Promise.all([loadLeRobotExporter(), openBrowserExportStorage(message.sessionId)]);
    const manifests = [];
    for (const episodeId of message.episodeIds) {
      manifests.push(message.source === "monitor-opfs" || message.source === "solo-opfs"
        ? await loadMonitorOpfsEpisodeExportManifest({
          sessionId: message.sessionId,
          episodes: message.monitorEpisodes ?? [],
          recorderRateHz: message.monitorRecorderRateHz ?? Number.NaN,
          sourceEpisodeIds: message.sourceEpisodeIds,
          storageRoot: message.source === "solo-opfs"
            ? SOLO_RECORDING_STORAGE_ROOT
            : MONITOR_RECORDING_STORAGE_ROOT,
        }, episodeId, signal)
        : await fetchMonitorEpisodeExportManifest({
          sessionId: message.sessionId, episodes: message.monitorEpisodes ?? [], sourceEpisodeIds: message.sourceEpisodeIds,
        }, episodeId, signal, message.exportCapability));
    }
    manifests.sort((left, right) => left.episodeIndex - right.episodeIndex);
    const artifacts: StoredExportArtifact[] = [];
    let completedEpisodes = 0;
    let allocatedGlobalFrameIndex = message.globalFrameIndexBase;
    for (const manifest of manifests) {
      signal.throwIfAborted();
      const timeline = episodeExportTimeline(manifest.episode);
      const allocation = resolveMonitorEpisodeAllocation({
        episodeIndexBase: message.episodeIndexBase,
        completedEpisodes,
        globalFrameIndexCursor: allocatedGlobalFrameIndex,
        manifestEpisodeIndex: manifest.episodeIndex,
        manifestGlobalFrameIndex: manifest.globalFrameIndex,
        frameCount: timeline.frameCount,
      });
      const { episodeIndex, globalFrameIndex } = allocation;
      const exporter = module.create({
        fps: manifest.fps,
        robot_type: "ceres_xr",
        episode_index: episodeIndex,
        global_frame_index: globalFrameIndex,
        task: manifest.task,
        tasks: manifest.tasks,
        action_names: [...CERES_LEROBOT_ACTION_NAMES],
        row_group_size: 256,
        reduction_batch_rows: 256,
        max_frames: timeline.frameCount,
        data_files_size_in_mb: 100,
        video_files_size_in_mb: 500,
      });
      let bundle;
      try {
        await pushEpisodeRows(exporter, manifest, timeline, message, signal);
        const video = await prepareEpisodeVideo(manifest, signal, (value, backend) => {
          progress(message, "media", `Preparing MP4 with ${backend}`, value, 1, manifest.episode.id, backend);
        }, message.exportCapability);
        if (video) {
          post({
            type: "media-profile",
            requestId: message.requestId,
            episodeId: manifest.episode.id,
            profile: video.profile,
          });
          exporter.attachVideo("observation.images.passthrough", JSON.stringify(video.metadata), video.bytes);
        }
        bundle = exporter.finish();
        const stored = await storage.writeBundle(
          episodeIndex,
          manifest.episode.id,
          bundle,
          {
            capture: { runTitle: manifest.episode.runTitle, cycle: manifest.episode.cycle, taskLabel: manifest.episode.taskLabel },
            ...(manifest.episode.captureMetadata ? { captureMetadata: manifest.episode.captureMetadata } : {}),
            segments: timeline.segments,
            ...(manifest.taskSpecification && manifest.taskSpecVersion !== undefined && manifest.taskSpecHash
              ? {
                  task: {
                    version: manifest.taskSpecVersion,
                    hash: manifest.taskSpecHash,
                    specification: manifest.taskSpecification,
                  },
                }
              : {}),
          },
          message.directoryHandle,
          signal,
          (completed, total, path) => progress(message, "writing", `Writing ${path} to browser storage`, completed, total, manifest.episode.id, module.backend),
        );
        artifacts.push(...stored);
      } finally {
        bundle?.free();
        exporter.free();
      }
      completedEpisodes += 1;
      allocatedGlobalFrameIndex = allocation.nextGlobalFrameIndex;
      progress(message, "writing", `Saved capture ${episodeIndex + 1} in browser storage`, completedEpisodes, manifests.length, manifest.episode.id, module.backend);
    }

    post({
      type: "complete",
      requestId: message.requestId,
      episodeCount: completedEpisodes,
      artifactCount: artifacts.length,
      episodeIds: [...message.episodeIds],
      artefacts: artifacts
        .map(({ path, sha256, byteLength, mediaType }) => ({ path, sha256, byteLength, mediaType }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    });
  } catch (error) {
    const cancelled = signal.aborted || isAbortError(error);
    const report = {
      error: serialiseWorkerError(cancelled ? new DOMException("Export cancelled", "AbortError") : error, workerOrigin()),
      context: workerErrorContext(error),
    };
    const errorStage = FFMPEG_ERROR_STAGES.has(report.context.stage as MonitorExportFfmpegStage)
      ? report.context.stage as MonitorExportFfmpegStage
      : activeStage;
    post({
      type: "error",
      requestId: message.requestId,
      error: cancelled ? "Export cancelled" : EXPORT_FAILURE_MESSAGE,
      errorType: report.error.type,
      errorTelemetry: report.error,
      stage: errorStage,
      cancelled,
    });
  }
}

async function pushEpisodeRows(
  exporter: CeresLeRobotExporter,
  manifest: Awaited<ReturnType<typeof fetchMonitorEpisodeExportManifest>>,
  timeline: EpisodeExportTimeline,
  message: MonitorExportStartMessage,
  signal: AbortSignal,
): Promise<void> {
  let sourceSlotCount = 0;
  let exportedFrameCount = 0;
  let reductionBackend = "wasm-cpu";
  for await (const line of streamSensorRows(manifest, signal, (completed, total) => {
    progress(message, "reading", `Streaming sensor rows for episode ${manifest.episodeIndex}`, completed, total, manifest.episode.id, reductionBackend);
  }, message.exportCapability)) {
    signal.throwIfAborted();
    sourceSlotCount += 1;
    const row = prepareEpisodeExportRow(line, manifest.episode, timeline, manifest.tasks);
    if (!row) continue;
    exporter.pushCeresSensorFrameJsonForTask(row.json, BigInt(row.taskIndex));
    exportedFrameCount += 1;
    if (exporter.reductionReady()) {
      progress(message, "reducing", "Reducing feature statistics", exportedFrameCount, timeline.frameCount, manifest.episode.id, reductionBackend);
      reductionBackend = await reducePending(exporter);
    }
  }
  if (sourceSlotCount !== timeline.sourceSlotCount) {
    throw new Error(`Episode timeline declares ${timeline.sourceSlotCount} recorder slots but ${sourceSlotCount} sensor rows were read`);
  }
  if (exportedFrameCount !== timeline.frameCount) {
    throw new Error(`Episode timeline declares ${timeline.frameCount} retained frames but ${exportedFrameCount} task rows were written`);
  }
}

function progress(
  message: MonitorExportStartMessage,
  stage: MonitorExportProgressEvent["stage"],
  detail: string,
  completed: number,
  total: number,
  episodeId?: string,
  backend?: string,
): void {
  activeStage = stage;
  const next = {
    type: "progress",
    requestId: message.requestId,
    stage,
    detail,
    completed,
    total,
    episodeId,
    backend,
  } satisfies MonitorExportProgressEvent;
  const now = performance.now();
  if (lastProgressStage !== next.stage || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
    flushProgress();
    lastProgressStage = next.stage;
    lastProgressAt = now;
    workerScope.postMessage(next);
    return;
  }
  pendingProgress = next;
  if (progressTimer === null) {
    progressTimer = workerScope.setTimeout(
      flushProgress,
      Math.max(0, PROGRESS_INTERVAL_MS - (now - lastProgressAt)),
    );
  }
}

function post(event: MonitorExportWorkerEvent): void {
  if (event.type !== "progress") {
    flushProgress();
    lastProgressStage = null;
    lastProgressAt = Number.NEGATIVE_INFINITY;
  }
  workerScope.postMessage(event);
}

function flushProgress() {
  if (progressTimer !== null) {
    workerScope.clearTimeout(progressTimer);
    progressTimer = null;
  }
  if (!pendingProgress) return;
  lastProgressAt = performance.now();
  workerScope.postMessage(pendingProgress);
  pendingProgress = null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function workerOrigin(): string | undefined {
  try {
    return workerScope.location.origin;
  } catch {
    return undefined;
  }
}
