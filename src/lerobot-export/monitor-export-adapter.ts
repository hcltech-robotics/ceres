import { isExportableEpisode } from "../../shared/lerobot-export.js";
import type { Episode } from "../../shared/protocol.js";
import { isWorkerErrorDetail, serialiseWorkerError } from "../worker-errors.js";
import type {
  MonitorExportErrorStage,
  MonitorExportStage,
  MonitorExportWorkerEvent,
  MonitorExportWorkerRequest,
} from "./types.js";

export interface BrowserExportStartOptions {
  requestId?: string;
  sessionId: string;
  episodes: Episode[];
  episodeIds?: string[];
  exportCapability?: string;
  source?: "server" | "monitor-opfs" | "solo-opfs";
  recorderRateHz?: number;
  episodeIndexBase?: number;
  globalFrameIndexBase?: number;
  directoryHandle?: FileSystemDirectoryHandle;
}

type Listener = (event: MonitorExportWorkerEvent) => void;

export const BROWSER_EXPORT_INACTIVITY_TIMEOUT_MS = 120_000;
const BROWSER_EXPORT_WORKER_FAILURE_MESSAGE = "The browser export worker stopped unexpectedly. Retry the export.";
const MONITOR_EXPORT_STAGES = new Set<MonitorExportStage>([
  "queued",
  "reading",
  "reducing",
  "media",
  "writing",
  "uploading",
  "completed",
  "cancelled",
  "failed",
]);
const MONITOR_EXPORT_ERROR_STAGES = new Set<MonitorExportErrorStage>([
  ...MONITOR_EXPORT_STAGES,
  "ffmpeg_load",
  "ffmpeg_write",
  "ffmpeg_exec",
  "ffmpeg_read",
  "ffmpeg_inspect",
]);
const EXPORT_VIDEO_BACKENDS = new Set([
  "mediabunny-remux",
  "mediabunny-webcodecs",
  "ffmpeg-wasm",
]);
const EXPORT_VIDEO_REMUX_DECISIONS = new Set([
  "exact_alignment",
  "normalised_prefix",
  "rejected_frame_selection",
  "rejected_source_codec",
  "rejected_packet_shortage",
  "rejected_keyframe",
  "rejected_unverified",
  "failed",
]);
const EXPORT_VIDEO_HARDWARE_ATTEMPTS = new Set([
  "not_needed",
  "prefer_hardware_succeeded",
  "prefer_hardware_failed_no_preference_succeeded",
  "no_preference_only_succeeded",
  "webcodecs_unavailable_or_failed",
]);
const EXPORT_VIDEO_FALLBACK_REASONS = new Set([
  "none",
  "mediabunny_input_failed",
  "mediabunny_remux_output_validation_failed",
  "webcodecs_api_unavailable",
  "webcodecs_config_unsupported",
  "webcodecs_conversion_failed",
  "webcodecs_output_validation_failed",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function episodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function nonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

function validArtefact(value: unknown) {
  const candidate = record(value);
  return candidate !== null
    && typeof candidate.path === "string"
    && candidate.path.length >= 1
    && candidate.path.length <= 512
    && /^[A-Za-z0-9._/-]+$/.test(candidate.path)
    && !candidate.path.split("/").includes("..")
    && typeof candidate.sha256 === "string"
    && /^[0-9a-f]{64}$/.test(candidate.sha256)
    && nonNegativeInteger(candidate.byteLength, Number.MAX_SAFE_INTEGER)
    && typeof candidate.mediaType === "string"
    && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(candidate.mediaType);
}

function monitorExportWorkerEvent(value: unknown): MonitorExportWorkerEvent | null {
  const candidate = record(value);
  if (!candidate || !requestId(candidate.requestId)) return null;
  if (candidate.type === "progress") {
    return MONITOR_EXPORT_STAGES.has(candidate.stage as MonitorExportStage)
      && typeof candidate.detail === "string"
      && candidate.detail.length <= 512
      && typeof candidate.completed === "number"
      && Number.isFinite(candidate.completed)
      && candidate.completed >= 0
      && typeof candidate.total === "number"
      && Number.isFinite(candidate.total)
      && candidate.total >= 0
      && (candidate.episodeId === undefined || episodeId(candidate.episodeId))
      && (candidate.backend === undefined || (
        typeof candidate.backend === "string"
        && /^[A-Za-z0-9._+-]{1,64}$/.test(candidate.backend)
      ))
      ? candidate as unknown as Extract<MonitorExportWorkerEvent, { type: "progress" }>
      : null;
  }
  if (candidate.type === "media-profile") {
    const profile = record(candidate.profile);
    return profile
      && episodeId(candidate.episodeId)
      && EXPORT_VIDEO_BACKENDS.has(profile.backend as string)
      && EXPORT_VIDEO_REMUX_DECISIONS.has(profile.remuxDecision as string)
      && EXPORT_VIDEO_HARDWARE_ATTEMPTS.has(profile.hardwareAttempt as string)
      && EXPORT_VIDEO_FALLBACK_REASONS.has(profile.fallbackReason as string)
      && typeof profile.elapsedMs === "number"
      && Number.isFinite(profile.elapsedMs)
      && profile.elapsedMs >= 0
      ? candidate as unknown as Extract<MonitorExportWorkerEvent, { type: "media-profile" }>
      : null;
  }
  if (candidate.type === "complete") {
    if (
      !nonNegativeInteger(candidate.episodeCount, 10_000)
      || !nonNegativeInteger(candidate.artifactCount, 100_000)
      || !Array.isArray(candidate.episodeIds)
      || candidate.episodeIds.some((value) => !episodeId(value))
      || new Set(candidate.episodeIds).size !== candidate.episodeIds.length
      || !Array.isArray(candidate.artefacts)
      || candidate.artefacts.some((value) => !validArtefact(value))
      || candidate.episodeCount !== candidate.episodeIds.length
      || candidate.artifactCount !== candidate.artefacts.length
    ) return null;
    return candidate as unknown as Extract<MonitorExportWorkerEvent, { type: "complete" }>;
  }
  if (candidate.type !== "error") return null;
  return typeof candidate.error === "string"
    && candidate.error.length >= 1
    && candidate.error.length <= 1_024
    && (candidate.errorType === undefined || (
      typeof candidate.errorType === "string"
      && /^(?:StringRejection|Error|[A-Za-z][A-Za-z0-9_.-]{0,54}(?:Error|Exception))$/.test(candidate.errorType)
    ))
    && (candidate.errorTelemetry === undefined || isWorkerErrorDetail(candidate.errorTelemetry))
    && (candidate.stage === undefined || MONITOR_EXPORT_ERROR_STAGES.has(candidate.stage as MonitorExportErrorStage))
    && typeof candidate.cancelled === "boolean"
    ? candidate as unknown as Extract<MonitorExportWorkerEvent, { type: "error" }>
    : null;
}

export interface BrowserExportAdapterOptions {
  inactivityTimeoutMs?: number;
}

export class BrowserExportAdapter {
  private worker: Worker;
  private readonly listeners = new Set<Listener>();
  private readonly inactivityTimeoutMs: number;
  private activeRequestId: string | null = null;
  private activeStage: MonitorExportStage = "queued";
  private inactivityTimer: number | null = null;

  constructor(options: BrowserExportAdapterOptions = {}) {
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? BROWSER_EXPORT_INACTIVITY_TIMEOUT_MS;
    if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
      throw new RangeError("Browser export inactivity timeout must be positive");
    }
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.worker = this.createWorker();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(options: BrowserExportStartOptions): string {
    if (this.activeRequestId) throw new Error("An export is already running");
    const exportableIds = new Set(eligibleEpisodeIds(options.episodes));
    const episodeIds = options.episodeIds ?? [...exportableIds];
    if (new Set(episodeIds).size !== episodeIds.length || episodeIds.some((episodeId) => !exportableIds.has(episodeId))) {
      throw new Error("Episode export selection contains an ineligible or duplicate episode");
    }
    if (episodeIds.length === 0) throw new Error("There are no episodes with durable sensor frames to export");
    const hasEpisodeIndexBase = options.episodeIndexBase !== undefined;
    const hasGlobalFrameIndexBase = options.globalFrameIndexBase !== undefined;
    if (hasEpisodeIndexBase !== hasGlobalFrameIndexBase) {
      throw new Error("Hugging Face episode and frame allocation must be supplied together");
    }
    if (
      hasEpisodeIndexBase
      && (
        !Number.isSafeInteger(options.episodeIndexBase)
        || options.episodeIndexBase! < 0
        || !Number.isSafeInteger(options.globalFrameIndexBase)
        || options.globalFrameIndexBase! < 0
      )
    ) {
      throw new Error("Hugging Face episode and frame allocation is invalid");
    }
    const browserOpfs = options.source === "monitor-opfs" || options.source === "solo-opfs";
    if (!browserOpfs && !options.exportCapability) {
      throw new Error("Server export authorisation is not available");
    }
    const requestId = options.requestId ?? crypto.randomUUID();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
      throw new Error("Browser export request identifier is invalid");
    }
    this.activeRequestId = requestId;
    this.activeStage = "queued";
    try {
      this.post({
        type: "start",
        requestId,
        sessionId: options.sessionId,
        episodeIds,
        exportCapability: browserOpfs ? undefined : options.exportCapability,
        source: options.source,
        monitorEpisodes: browserOpfs ? structuredClone(options.episodes) : undefined,
        monitorRecorderRateHz: browserOpfs ? options.recorderRateHz : undefined,
        episodeIndexBase: options.episodeIndexBase,
        globalFrameIndexBase: options.globalFrameIndexBase,
        directoryHandle: options.directoryHandle,
      });
    } catch (error) {
      this.clearInactivityTimer();
      this.activeRequestId = null;
      this.activeStage = "queued";
      throw error;
    }
    this.resetInactivityTimer();
    return requestId;
  }

  cancel(): void {
    if (!this.activeRequestId) return;
    this.post({ type: "cancel", requestId: this.activeRequestId });
  }

  isRunning(): boolean {
    return this.activeRequestId !== null;
  }

  close(): void {
    this.cancel();
    this.clearInactivityTimer();
    this.worker.terminate();
    this.activeRequestId = null;
    this.listeners.clear();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./monitor-export.worker.ts", import.meta.url), {
      type: "module",
      name: "ceres-lerobot-export",
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = monitorExportWorkerEvent(event.data);
      if (!message) {
        const error = new Error("The browser export worker returned an invalid response");
        error.name = "ExportWorkerProtocolError";
        this.failActiveExport(BROWSER_EXPORT_WORKER_FAILURE_MESSAGE, error);
        return;
      }
      if (message.requestId !== this.activeRequestId) return;
      if (message.type === "progress") this.activeStage = message.stage;
      if (message.type === "complete" || message.type === "error") {
        this.clearInactivityTimer();
        this.activeRequestId = null;
      } else {
        this.resetInactivityTimer();
      }
      this.listeners.forEach((listener) => listener(message));
    });
    worker.addEventListener("error", (event) => {
      const error = event.error instanceof Error
        ? event.error
        : new Error(event.message || "The browser export worker stopped");
      this.failActiveExport(BROWSER_EXPORT_WORKER_FAILURE_MESSAGE, error);
    });
    worker.addEventListener("messageerror", () => {
      const error = new Error("The browser export worker returned an unreadable response");
      error.name = "ExportWorkerProtocolError";
      this.failActiveExport(BROWSER_EXPORT_WORKER_FAILURE_MESSAGE, error);
    });
    return worker;
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    if (!this.activeRequestId) return;
    this.inactivityTimer = window.setTimeout(() => {
      this.inactivityTimer = null;
      const error = new Error("The browser export stopped reporting progress");
      error.name = "ExportInactivityError";
      this.failActiveExport(
        "The browser export stopped reporting progress. It was stopped safely; retry when ready.",
        error,
      );
    }, this.inactivityTimeoutMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer === null) return;
    window.clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private failActiveExport(error: string, cause: unknown): void {
    const requestId = this.activeRequestId;
    if (!requestId) return;
    const stage = this.activeStage;
    const errorTelemetry = serialiseWorkerError(cause, currentOrigin());
    this.clearInactivityTimer();
    this.activeRequestId = null;
    this.worker.terminate();
    this.worker = this.createWorker();
    const event = {
      type: "error",
      requestId,
      error,
      errorType: errorTelemetry.type,
      errorTelemetry,
      stage,
      cancelled: false,
    } satisfies MonitorExportWorkerEvent;
    this.listeners.forEach((listener) => listener(event));
  }

  private post(message: MonitorExportWorkerRequest): void {
    this.worker.postMessage(message);
  }
}

function currentOrigin(): string | undefined {
  try {
    return location.origin;
  } catch {
    return undefined;
  }
}

export type MonitorExportStartOptions = BrowserExportStartOptions;

export class MonitorExportAdapter extends BrowserExportAdapter {}

export function eligibleEpisodeIds(episodes: Episode[]): string[] {
  return episodes.filter(isExportableEpisode).map((episode) => episode.id);
}
