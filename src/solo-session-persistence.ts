import {
  decodeRecorderBlock,
  SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
  type SessionSnapshot,
  type SoloStorageHeadroom,
} from "../shared/protocol.js";
import {
  MonitorRecorder,
  SOLO_RECORDER_STORAGE_ROOT,
  type MonitorRecorderEvent,
  type MonitorRecorderOptions,
} from "./recorder/monitor-recorder.js";
import type { MonitorRecordingSummary } from "./recorder/monitor-recording-summary.js";

export const SOLO_ACTIVE_SESSION_STORAGE_KEY = "ceres.solo.active-session.v1";
export const SOLO_SESSION_QUERY_PARAMETER = "session";
export const SOLO_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

const browserStorage = () => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function rememberSoloSession(
  requestedSessionId: string | null,
  storage: Storage | null = browserStorage(),
) {
  if (requestedSessionId && SOLO_SESSION_ID_PATTERN.test(requestedSessionId)) {
    try {
      storage?.setItem(SOLO_ACTIVE_SESSION_STORAGE_KEY, requestedSessionId);
    } catch {
      // URL state remains authoritative when browser storage is unavailable.
    }
    return requestedSessionId;
  }
  try {
    const stored = storage?.getItem(SOLO_ACTIVE_SESSION_STORAGE_KEY) ?? null;
    return stored && SOLO_SESSION_ID_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function resolveSoloSessionId(
  search = typeof location === "undefined" ? "" : location.search,
  storage: Storage | null = browserStorage(),
  allocateId: () => string = () => crypto.randomUUID(),
) {
  const requested = new URLSearchParams(search).get(SOLO_SESSION_QUERY_PARAMETER);
  const restored = rememberSoloSession(requested, storage);
  if (restored) return restored;
  const created = allocateId();
  if (!SOLO_SESSION_ID_PATTERN.test(created)) throw new Error("Allocated Solo session identifier is invalid");
  return rememberSoloSession(created, storage)!;
}

export function soloSessionUrl(sessionId: string, baseUrl?: string) {
  if (!SOLO_SESSION_ID_PATTERN.test(sessionId)) throw new Error("Solo session identifier is invalid");
  const base = baseUrl ?? (
    typeof location === "undefined"
      ? "https://ceres.invalid/launch/capture/?mode=solo"
      : location.href
  );
  const url = new URL(base);
  url.pathname = "/launch/capture/";
  url.searchParams.set("mode", "solo");
  url.searchParams.set(SOLO_SESSION_QUERY_PARAMETER, sessionId);
  return url;
}

export type SoloRecorderControlMessage =
  | { type: "recorder-ready"; sessionId: string; nextSequence: number }
  | {
    type: "recorder-ack";
    sessionId: string;
    episodeId: string;
    sequence: number;
    recorderFrameIndex: number;
    status: "durable" | "duplicate";
  }
  | { type: "recorder-error"; fatal: true; code: "write-failed"; message: string };

export interface SoloSessionOpenResult {
  snapshot: SessionSnapshot | null;
  nextSequence: number;
}

export interface SoloStorageEstimateProvider {
  estimate(): Promise<{
    quota?: number;
    usage?: number;
  }>;
}

export async function checkSoloStorageHeadroom(
  provider: SoloStorageEstimateProvider | null = browserStorageEstimateProvider(),
  now: () => number = Date.now,
): Promise<SoloStorageHeadroom> {
  const checkedAtMs = safeStorageCheckTimestamp(now);
  if (!provider || typeof provider.estimate !== "function") {
    return blockedSoloStorageHeadroom(
      checkedAtMs,
      null,
      "Storage estimate is unavailable",
    );
  }
  try {
    const estimate = await provider.estimate();
    const quota = estimate.quota;
    const usage = estimate.usage;
    if (typeof quota !== "number"
      || !Number.isFinite(quota)
      || quota < 0
      || typeof usage !== "number"
      || !Number.isFinite(usage)
      || usage < 0) {
      return blockedSoloStorageHeadroom(
        checkedAtMs,
        null,
        "Storage estimate did not report valid quota and usage",
      );
    }
    const availableBytes = Math.max(0, Math.floor(quota - usage));
    if (availableBytes < SOLO_MINIMUM_STORAGE_HEADROOM_BYTES) {
      return blockedSoloStorageHeadroom(
        checkedAtMs,
        availableBytes,
        `Solo capture requires at least 512 MiB of available storage; ${formatStorageMiB(availableBytes)} MiB is available`,
      );
    }
    return {
      state: "ready",
      availableBytes,
      requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
      checkedAtMs,
      detail: `${formatStorageMiB(availableBytes)} MiB is available for Solo capture`,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message.trim()
      ? `Storage estimate is unavailable: ${error.message.trim()}`
      : "Storage estimate is unavailable";
    return blockedSoloStorageHeadroom(checkedAtMs, null, reason);
  }
}

export interface SoloSessionPersistencePort {
  open(sessionId: string): Promise<SoloSessionOpenResult>;
  checkStorageHeadroom(): Promise<SoloStorageHeadroom>;
  saveSnapshot(snapshot: SessionSnapshot): Promise<void>;
  appendRecorderBlock(sequence: number, block: ArrayBuffer): boolean;
  summarise(episodeId: string): Promise<MonitorRecordingSummary>;
  sendRecorderReady(nextSequence: number): void;
  setRecorderControlSink(sink: ((message: SoloRecorderControlMessage) => void) | null): void;
  close(): Promise<void>;
}

export interface SoloSessionPersistenceOptions {
  monitorRecorderOptions?: Omit<MonitorRecorderOptions, "storageRootName">;
  acquireSessionLease?: SoloSessionLeaseAcquirer;
  summaryTimeoutMs?: number;
}

export type SoloSessionLeaseRelease = () => Promise<void>;
export type SoloSessionLeaseAcquirer = (sessionId: string) => Promise<SoloSessionLeaseRelease>;

interface PendingSummary {
  promise: Promise<MonitorRecordingSummary>;
  resolve: (summary: MonitorRecordingSummary) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingBlockMetadata {
  episodeId: string;
  recorderFrameIndex: number;
  sourceTimestampUs: number;
  flags: number;
  checksum: number;
  byteLength: number;
}

export class SoloSessionPersistence implements SoloSessionPersistencePort {
  private readonly recorder: MonitorRecorder;
  private openedSessionId: string | null = null;
  private recoveredSnapshot: SessionSnapshot | null = null;
  private openPromise: Promise<SoloSessionOpenResult> | null = null;
  private resolveOpen: ((result: SoloSessionOpenResult) => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;
  private recorderControlSink: ((message: SoloRecorderControlMessage) => void) | null = null;
  private lastReadyControl: Extract<SoloRecorderControlMessage, { type: "recorder-ready" }> | null = null;
  private durableNextSequence = 0;
  private failure: string | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private releaseSessionLease: SoloSessionLeaseRelease | null = null;
  private readonly acquireSessionLease: SoloSessionLeaseAcquirer;
  private readonly summaryTimeoutMs: number;
  private readonly pendingSummaries = new Map<string, PendingSummary>();
  private readonly pendingBlockMetadata = new Map<number, PendingBlockMetadata>();

  constructor(options: SoloSessionPersistenceOptions = {}) {
    this.acquireSessionLease = options.acquireSessionLease ?? acquireBrowserSoloSessionLease;
    this.summaryTimeoutMs = Math.max(1, options.summaryTimeoutMs ?? 15_000);
    this.recorder = new MonitorRecorder(
      (event) => this.handleRecorderEvent(event),
      {
        ...options.monitorRecorderOptions,
        storageRootName: SOLO_RECORDER_STORAGE_ROOT,
      },
    );
  }

  open(sessionId: string): Promise<SoloSessionOpenResult> {
    if (this.openPromise) {
      if (this.openedSessionId !== sessionId) {
        return Promise.reject(new Error("Solo persistence is already open for another session"));
      }
      return this.openPromise;
    }
    if (!SOLO_SESSION_ID_PATTERN.test(sessionId)) {
      return Promise.reject(new Error("Solo session identifier is invalid"));
    }
    this.openedSessionId = sessionId;
    this.durableNextSequence = 0;
    this.openPromise = this.openWithExclusiveLease(sessionId);
    return this.openPromise;
  }

  checkStorageHeadroom() {
    return checkSoloStorageHeadroom();
  }

  saveSnapshot(snapshot: SessionSnapshot) {
    if (this.failure) return Promise.reject(new Error(this.failure));
    if (!this.openedSessionId || snapshot.sessionId !== this.openedSessionId) {
      return Promise.reject(new Error("Solo snapshot session does not match the open persistence session"));
    }
    return this.recorder.saveSnapshot(snapshot);
  }

  readonly appendRecorderBlock = (sequence: number, block: ArrayBuffer) => {
    if (this.failure
      || this.closing
      || !this.openedSessionId
      || !this.recorder.isReady
      || !Number.isSafeInteger(sequence)
      || sequence < 0
      || !(block instanceof ArrayBuffer)) return false;
    try {
      const decoded = decodeRecorderBlock(new Uint8Array(block));
      if (decoded.sessionId !== this.openedSessionId || decoded.sequence !== sequence) {
        this.fail("Solo recorder received a block with conflicting session or sequence accounting");
        return false;
      }
      const metadata: PendingBlockMetadata = {
        episodeId: decoded.episodeId,
        recorderFrameIndex: decoded.recorderFrameIndex,
        sourceTimestampUs: decoded.sourceTimestampUs,
        flags: decoded.flags,
        checksum: decoded.checksum,
        byteLength: block.byteLength,
      };
      const pending = this.pendingBlockMetadata.get(sequence);
      if (pending) {
        if (samePendingBlock(pending, metadata)) return true;
        this.fail(`Solo recorder received a conflicting retransmission for sequence ${sequence}`);
        return false;
      }
      this.pendingBlockMetadata.set(sequence, metadata);
      if (this.recorder.append(block)) return true;
      this.pendingBlockMetadata.delete(sequence);
      return false;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Solo recorder received an invalid block");
      return false;
    }
  };

  summarise(episodeId: string): Promise<MonitorRecordingSummary> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    if (!this.openedSessionId) return Promise.reject(new Error("Solo persistence is not open"));
    const existing = this.pendingSummaries.get(episodeId);
    if (existing) return existing.promise;
    let resolveSummary!: (summary: MonitorRecordingSummary) => void;
    let rejectSummary!: (error: Error) => void;
    const promise = new Promise<MonitorRecordingSummary>((resolve, reject) => {
      resolveSummary = resolve;
      rejectSummary = reject;
    });
    const timeout = setTimeout(() => {
      const pending = this.pendingSummaries.get(episodeId);
      if (!pending) return;
      this.pendingSummaries.delete(episodeId);
      pending.reject(new Error("Solo recorder finalisation timed out before the episode summary was available"));
    }, this.summaryTimeoutMs);
    this.pendingSummaries.set(episodeId, {
      promise,
      resolve: resolveSummary,
      reject: rejectSummary,
      timeout,
    });
    if (!this.recorder.summarise(episodeId)) {
      const pending = this.pendingSummaries.get(episodeId);
      if (pending) {
        this.pendingSummaries.delete(episodeId);
        clearTimeout(pending.timeout);
        pending.reject(new Error("Solo recorder could not queue the finalisation summary"));
      }
    }
    return promise;
  }

  sendRecorderReady(nextSequence: number) {
    if (!this.openedSessionId || !Number.isSafeInteger(nextSequence) || nextSequence < 0) {
      throw new Error("Solo recorder ready state is invalid");
    }
    if (this.failure) throw new Error(this.failure);
    if (nextSequence > this.durableNextSequence) {
      throw new Error("Solo recorder ready state exceeds the durable journal");
    }
    this.lastReadyControl = {
      type: "recorder-ready",
      sessionId: this.openedSessionId,
      nextSequence: this.durableNextSequence,
    };
    this.recorderControlSink?.(this.lastReadyControl);
  }

  setRecorderControlSink(sink: ((message: SoloRecorderControlMessage) => void) | null) {
    this.recorderControlSink = sink;
    if (sink && this.failure) {
      sink({ type: "recorder-error", fatal: true, code: "write-failed", message: this.failure });
    } else if (sink && this.lastReadyControl) {
      sink(this.lastReadyControl);
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async openWithExclusiveLease(sessionId: string) {
    this.releaseSessionLease = await this.acquireSessionLease(sessionId);
    try {
      const opened = new Promise<SoloSessionOpenResult>((resolve, reject) => {
        this.resolveOpen = resolve;
        this.rejectOpen = reject;
      });
      this.recorder.open(sessionId);
      return await opened;
    } catch (error) {
      const release = this.releaseSessionLease;
      this.releaseSessionLease = null;
      await release?.();
      throw error;
    }
  }

  private async closeInternal() {
    this.rejectOutstanding(
      new Error("Solo persistence closed before the operation completed"),
      false,
    );
    try {
      await this.recorder.close();
    } finally {
      this.pendingBlockMetadata.clear();
      const release = this.releaseSessionLease;
      this.releaseSessionLease = null;
      await release?.();
    }
  }

  private handleRecorderEvent(event: MonitorRecorderEvent) {
    if (event.type === "snapshot"
      && event.sessionId === this.openedSessionId
      && event.snapshot) {
      this.recoveredSnapshot = structuredClone(event.snapshot);
      return;
    }
    if (event.type === "ready"
      && event.sessionId === this.openedSessionId
      && Number.isSafeInteger(event.nextSequence)
      && (event.nextSequence ?? -1) >= 0) {
      const resolve = this.resolveOpen;
      this.durableNextSequence = event.nextSequence!;
      this.resolveOpen = null;
      this.rejectOpen = null;
      resolve?.({
        snapshot: structuredClone(this.recoveredSnapshot),
        nextSequence: event.nextSequence!,
      });
      return;
    }
    if (event.type === "ack"
      && event.sessionId === this.openedSessionId
      && Number.isSafeInteger(event.sequence)
      && (event.sequence ?? -1) >= 0
      && (event.status === "stored" || event.status === "duplicate")) {
      const metadata = this.pendingBlockMetadata.get(event.sequence!);
      if (!metadata) {
        this.fail("Solo recorder acknowledged a block without pending accounting metadata");
        return;
      }
      this.pendingBlockMetadata.delete(event.sequence!);
      this.durableNextSequence = Math.max(this.durableNextSequence, event.sequence! + 1);
      if (this.lastReadyControl) {
        this.lastReadyControl = {
          ...this.lastReadyControl,
          nextSequence: this.durableNextSequence,
        };
      }
      this.recorderControlSink?.({
        type: "recorder-ack",
        sessionId: event.sessionId!,
        episodeId: metadata.episodeId,
        sequence: event.sequence!,
        recorderFrameIndex: metadata.recorderFrameIndex,
        status: event.status === "duplicate" ? "duplicate" : "durable",
      });
      return;
    }
    if (event.type === "summary"
      && event.sessionId === this.openedSessionId
      && event.episodeId
      && event.summary) {
      const pending = this.pendingSummaries.get(event.episodeId);
      if (!pending) return;
      this.pendingSummaries.delete(event.episodeId);
      clearTimeout(pending.timeout);
      pending.resolve(structuredClone(event.summary));
      return;
    }
    if (event.type === "error") this.fail(event.message);
  }

  private fail(message?: string) {
    if (this.failure) return;
    this.failure = message?.trim() || "Solo recorder persistence failed";
    const error = new Error(this.failure);
    this.rejectOutstanding(error);
    this.recorderControlSink?.({
      type: "recorder-error",
      fatal: true,
      code: "write-failed",
      message: this.failure,
    });
  }

  private rejectOutstanding(error: Error, clearBlocks = true) {
    const rejectOpen = this.rejectOpen;
    this.resolveOpen = null;
    this.rejectOpen = null;
    rejectOpen?.(error);
    for (const pending of this.pendingSummaries.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingSummaries.clear();
    if (clearBlocks) this.pendingBlockMetadata.clear();
  }
}

function samePendingBlock(left: PendingBlockMetadata, right: PendingBlockMetadata) {
  return left.episodeId === right.episodeId
    && left.recorderFrameIndex === right.recorderFrameIndex
    && left.sourceTimestampUs === right.sourceTimestampUs
    && left.flags === right.flags
    && left.checksum === right.checksum
    && left.byteLength === right.byteLength;
}

function browserStorageEstimateProvider(): SoloStorageEstimateProvider | null {
  if (typeof navigator === "undefined") return null;
  return navigator.storage ?? null;
}

async function acquireBrowserSoloSessionLease(sessionId: string): Promise<SoloSessionLeaseRelease> {
  if (typeof window === "undefined") return async () => undefined;
  const lockManager = navigator.locks;
  if (!lockManager) {
    throw new Error("This browser cannot guarantee exclusive Solo session authority");
  }
  let releaseHold!: () => void;
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: Error) => void;
  let granted = false;
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const lifecycle = lockManager.request(
    `ceres.solo.session.${sessionId}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        rejectAcquired(new Error("This Solo session is already active in another tab"));
        return;
      }
      granted = true;
      resolveAcquired();
      await held;
    },
  ).catch((error) => {
    if (!granted) {
      rejectAcquired(error instanceof Error
        ? error
        : new Error("The Solo session authority lock could not be acquired"));
    }
  });
  await acquired;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseHold();
    await lifecycle;
  };
}

function blockedSoloStorageHeadroom(
  checkedAtMs: number,
  availableBytes: number | null,
  detail: string,
): SoloStorageHeadroom {
  return {
    state: "blocked",
    availableBytes,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs,
    detail,
  };
}

function safeStorageCheckTimestamp(now: () => number) {
  try {
    const timestamp = now();
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp;
  } catch {
    // The storage result remains fail-closed when the supplied clock is invalid.
  }
  return Date.now();
}

function formatStorageMiB(bytes: number) {
  return Math.floor(bytes / (1024 * 1024));
}
