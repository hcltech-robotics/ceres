import type { Episode, EpisodeSegment } from "../shared/protocol.js";
import { workerErrorFromEvent } from "./worker-errors.js";


export const SOLO_RUN_QUALITY_MAX_BIN_COUNT = 96;
export const SOLO_RUN_QUALITY_READ_BATCH_SIZE = 4;
export const SOLO_RUN_QUALITY_STORAGE_ROOT = "ceres-solo-recordings" as const;

export type SoloRunQualityStorageRoot =
  | "ceres-monitor-recordings"
  | typeof SOLO_RUN_QUALITY_STORAGE_ROOT;

export interface SoloRunQualityEpisode {
  id: string;
  cycle: number;
  repetition: number;
  take: number;
  taskId: string | null;
  taskLabel: string;
  startedAt: string;
  endedAt?: string;
  frameCount: number;
  recorderSlotCount?: number;
  gapCount?: number;
  firstRecorderSequence?: number;
  lastRecorderSequence?: number;
  segments?: Array<Pick<
    EpisodeSegment,
    | "taskId"
    | "taskLabel"
    | "repetition"
    | "take"
    | "startedAt"
    | "endedAt"
    | "startSourceTimestampUs"
    | "endSourceTimestampUs"
    | "outcome"
  >>;
}

export interface SoloRunQualityLoadOptions {
  sessionId: string;
  recorderRateHz: number;
  storageRoot?: SoloRunQualityStorageRoot;
  episodes: readonly Episode[];
  maximumBinCount?: number;
}

export interface SoloRunQualityBin {
  index: number;
  startMs: number;
  endMs: number;
  leftHandSpeedMps: number | null;
  rightHandSpeedMps: number | null;
  /** Fraction of durable sensor frames where the hand was tracked. */
  leftVisibility: number | null;
  /** Fraction of durable sensor frames where the hand was tracked. */
  rightVisibility: number | null;
  /** Fraction of expected active recorder slots represented by explicit gap blocks. */
  recorderGapFraction: number;
  /** Fraction of this bin outside any recorded episode. */
  unrecordedFraction: number;
  recordedFrameCount: number;
  recorderGapCount: number;
}

export interface SoloRunQualityDelineation {
  timestampMs: number;
  cycle: number;
  taskId: string | null;
  taskLabel: string;
  repetition: number;
  take: number;
  startsCycle: boolean;
  startsTask: boolean;
  startsRepetition: boolean;
}

export interface SoloRunQualityResult {
  requestId: string;
  episodeIds: readonly string[];
  startedAtMs: number;
  endedAtMs: number;
  bins: readonly SoloRunQualityBin[];
  delineations: readonly SoloRunQualityDelineation[];
  sourceBlockCount: number;
  recordedFrameCount: number;
  recorderGapCount: number;
}

export interface SoloRunQualityWorkerRequest {
  type: "start";
  requestId: string;
  sessionId: string;
  recorderRateHz: number;
  storageRoot: SoloRunQualityStorageRoot;
  episodes: SoloRunQualityEpisode[];
  maximumBinCount: number;
}

export type SoloRunQualityWorkerMessage = SoloRunQualityWorkerRequest | {
  type: "cancel";
  requestId: string;
};

export type SoloRunQualityWorkerResponse =
  | { type: "complete"; requestId: string; result: SoloRunQualityResult }
  | { type: "cancelled"; requestId: string }
  | { type: "error"; requestId: string; error: string };

interface ActiveRequest {
  id: string;
  resolve: (result: SoloRunQualityResult) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class SoloRunQualityService {
  private readonly worker: Worker;
  private active: ActiveRequest | null = null;
  private closed = false;
  private workerFailure: Error | null = null;

  constructor(worker = new Worker(new URL("./solo-run-quality.worker.ts", import.meta.url), {
    type: "module",
    name: "ceres-solo-run-quality",
  })) {
    this.worker = worker;
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.worker.addEventListener("messageerror", this.handleWorkerMessageError);
  }

  load(options: SoloRunQualityLoadOptions, signal?: AbortSignal): Promise<SoloRunQualityResult> {
    if (this.closed) return Promise.reject(new Error("Solo run quality service is closed"));
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    if (signal?.aborted) return Promise.reject(abortError("Solo run quality analysis was cancelled"));
    this.cancelActive("Solo run quality analysis was superseded");
    const request = createWorkerRequest(options);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.cancelRequest(request.requestId, "Solo run quality analysis was cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.active = {
        id: request.requestId,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      };
      try {
        this.worker.postMessage(request satisfies SoloRunQualityWorkerMessage);
      } catch (error) {        this.settleActive(request.requestId, (active) => {
          active.reject(error instanceof Error ? error : new Error("Solo run quality analysis could not start"));
        });
      }
    });
  }

  cancel(): void {
    this.cancelActive("Solo run quality analysis was cancelled");
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelActive("Solo run quality service was closed");
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.removeEventListener("messageerror", this.handleWorkerMessageError);
    this.worker.terminate();
  }

  private readonly handleMessage = (event: MessageEvent<SoloRunQualityWorkerResponse>) => {
    const response = event.data;
    if (!response || typeof response.requestId !== "string") return;
    this.settleActive(response.requestId, (active) => {
      if (response.type === "complete") active.resolve(response.result);
      else if (response.type === "cancelled") active.reject(abortError("Solo run quality analysis was cancelled"));
      else {
        const error = new Error(response.error);        active.reject(error);
      }
    });
  };

  private readonly handleWorkerError = (event: ErrorEvent) => {
    const candidate = workerErrorFromEvent(event);
    const error = candidate instanceof Error
      ? candidate
      : new Error("Solo run quality worker stopped");
    this.failWorker(error, "worker_crash");
  };

  private readonly handleWorkerMessageError = () => {
    this.failWorker(
      new Error("Solo run quality worker returned an unreadable response"),
      "protocol",
    );
  };

  private failWorker(error: Error, stage: "protocol" | "worker_crash") {
    if (this.closed || this.workerFailure) return;
    this.workerFailure = error;    const active = this.active;
    if (!active) return;
    this.active = null;
    active.removeAbortListener();
    active.reject(error);
  }

  private cancelActive(message: string) {
    if (!this.active) return;
    this.cancelRequest(this.active.id, message);
  }

  private cancelRequest(requestId: string, message: string) {
    const active = this.active;
    if (!active || active.id !== requestId) return;
    this.active = null;
    active.removeAbortListener();
    try {
      this.worker.postMessage({ type: "cancel", requestId } satisfies SoloRunQualityWorkerMessage);
    } catch {
      // The request still settles locally if the worker has already stopped.
    }
    active.reject(abortError(message));
  }

  private settleActive(requestId: string, settle: (active: ActiveRequest) => void) {
    const active = this.active;
    if (!active || active.id !== requestId) return;
    this.active = null;
    active.removeAbortListener();
    settle(active);
  }
}

export function createWorkerRequest(options: SoloRunQualityLoadOptions): SoloRunQualityWorkerRequest {
  assertSessionId(options.sessionId);
  if (!Number.isSafeInteger(options.recorderRateHz)
    || options.recorderRateHz <= 0
    || options.recorderRateHz > 1_000) {
    throw new Error("Solo run quality recorder rate is invalid");
  }
  const maximumBinCount = options.maximumBinCount ?? SOLO_RUN_QUALITY_MAX_BIN_COUNT;
  if (!Number.isSafeInteger(maximumBinCount)
    || maximumBinCount < 1
    || maximumBinCount > SOLO_RUN_QUALITY_MAX_BIN_COUNT) {
    throw new Error(`Solo run quality bin count must be between 1 and ${SOLO_RUN_QUALITY_MAX_BIN_COUNT}`);
  }
  const storageRoot = options.storageRoot ?? SOLO_RUN_QUALITY_STORAGE_ROOT;
  if (storageRoot !== "ceres-monitor-recordings" && storageRoot !== SOLO_RUN_QUALITY_STORAGE_ROOT) {
    throw new Error("Solo run quality storage root is invalid");
  }
  const episodes = options.episodes.map(toWorkerEpisode);
  if (episodes.length === 0) throw new Error("Solo run quality requires at least one completed episode");
  const episodeIds = new Set<string>();
  for (const episode of episodes) {
    assertSoloRunQualityEpisode(episode);
    if (episodeIds.has(episode.id)) throw new Error("Solo run quality episodes must be unique");
    episodeIds.add(episode.id);
  }
  return {
    type: "start",
    requestId: crypto.randomUUID(),
    sessionId: options.sessionId,
    recorderRateHz: options.recorderRateHz,
    storageRoot,
    episodes,
    maximumBinCount,
  };
}

export function assertSoloRunQualityWorkerRequest(value: SoloRunQualityWorkerRequest): void {
  assertSessionId(value.sessionId);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)) throw new Error("Solo run quality request identifier is invalid");
  if (!Number.isSafeInteger(value.recorderRateHz) || value.recorderRateHz <= 0 || value.recorderRateHz > 1_000) {
    throw new Error("Solo run quality recorder rate is invalid");
  }
  if (value.storageRoot !== "ceres-monitor-recordings" && value.storageRoot !== SOLO_RUN_QUALITY_STORAGE_ROOT) {
    throw new Error("Solo run quality storage root is invalid");
  }
  if (!Number.isSafeInteger(value.maximumBinCount)
    || value.maximumBinCount < 1
    || value.maximumBinCount > SOLO_RUN_QUALITY_MAX_BIN_COUNT) {
    throw new Error("Solo run quality bin count is invalid");
  }
  if (!Array.isArray(value.episodes) || value.episodes.length === 0) {
    throw new Error("Solo run quality requires at least one completed episode");
  }
  const episodeIds = new Set<string>();
  for (const episode of value.episodes) {
    assertSoloRunQualityEpisode(episode);
    if (episodeIds.has(episode.id)) throw new Error("Solo run quality episodes must be unique");
    episodeIds.add(episode.id);
  }
}

function assertSoloRunQualityEpisode(episode: SoloRunQualityEpisode) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(episode.id)) {
    throw new Error("Solo run quality episode identifier is invalid");
  }
  if (!Number.isSafeInteger(episode.frameCount) || episode.frameCount < 0) {
    throw new Error(`Solo run quality episode ${episode.id} frame count is invalid`);
  }
  if (episode.gapCount !== undefined
    && (!Number.isSafeInteger(episode.gapCount) || episode.gapCount < 0)) {
    throw new Error(`Solo run quality episode ${episode.id} gap count is invalid`);
  }
  if (episode.recorderSlotCount !== undefined
    && (!Number.isSafeInteger(episode.recorderSlotCount) || episode.recorderSlotCount < 0)) {
    throw new Error(`Solo run quality episode ${episode.id} recorder slot count is invalid`);
  }
  const expectedGapCount = episode.gapCount
    ?? Math.max(0, (episode.recorderSlotCount ?? episode.frameCount) - episode.frameCount);
  if (episode.recorderSlotCount !== undefined
    && episode.recorderSlotCount !== episode.frameCount + expectedGapCount) {
    throw new Error(`Solo run quality episode ${episode.id} recorder accounting is inconsistent`);
  }
  for (const sequence of [episode.firstRecorderSequence, episode.lastRecorderSequence]) {
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) {
      throw new Error(`Solo run quality episode ${episode.id} recorder sequence is invalid`);
    }
  }
  if (episode.firstRecorderSequence !== undefined
    && episode.lastRecorderSequence !== undefined
    && episode.lastRecorderSequence < episode.firstRecorderSequence) {
    throw new Error(`Solo run quality episode ${episode.id} recorder sequence range is invalid`);
  }
}

function toWorkerEpisode(episode: Episode): SoloRunQualityEpisode {
  return {
    id: episode.id,
    cycle: episode.cycle,
    repetition: episode.repetition,
    take: episode.take,
    taskId: episode.taskId,
    taskLabel: episode.taskLabel,
    startedAt: episode.startedAt,
    ...(episode.endedAt ? { endedAt: episode.endedAt } : {}),
    frameCount: episode.frameCount,
    ...(episode.recorderSlotCount === undefined ? {} : { recorderSlotCount: episode.recorderSlotCount }),
    ...(episode.gapCount === undefined ? {} : { gapCount: episode.gapCount }),
    ...(episode.firstRecorderSequence === undefined ? {} : { firstRecorderSequence: episode.firstRecorderSequence }),
    ...(episode.lastRecorderSequence === undefined ? {} : { lastRecorderSequence: episode.lastRecorderSequence }),
    ...(episode.segments ? {
      segments: episode.segments.map((segment) => ({
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
        repetition: segment.repetition,
        take: segment.take,
        startedAt: segment.startedAt,
        ...(segment.endedAt ? { endedAt: segment.endedAt } : {}),
        ...(segment.startSourceTimestampUs === undefined ? {} : { startSourceTimestampUs: segment.startSourceTimestampUs }),
        ...(segment.endSourceTimestampUs === undefined ? {} : { endSourceTimestampUs: segment.endSourceTimestampUs }),
        outcome: segment.outcome,
      })),
    } : {}),
  };
}

function assertSessionId(sessionId: string) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    throw new Error("Solo run quality session identifier is invalid");
  }
}

function abortError(message: string) {
  return new DOMException(message, "AbortError");
}
