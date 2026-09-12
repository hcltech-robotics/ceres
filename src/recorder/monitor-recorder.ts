import type { SessionSnapshot } from "../../shared/protocol.js";
import { workerErrorFromEvent } from "../worker-errors.js";

import type { MonitorRecordingSummary } from "./monitor-recording-summary.js";

export interface MonitorRecorderEvent {
  type: "ready" | "ack" | "error" | "snapshot" | "snapshot-saved" | "summary" | "closed";
  sessionId?: string;
  nextSequence?: number;
  sequence?: number;
  status?: "stored" | "duplicate";
  message?: string;
  snapshot?: SessionSnapshot;
  episodeId?: string;
  summary?: MonitorRecordingSummary;
  snapshotRequestId?: number;
  snapshotGeneration?: number;
}

export class MonitorRecorderFailureLatch {
  private message: string | null = null;

  remember(message?: string) {
    this.message = message?.trim() || "Monitor recorder failed";
    return this.message;
  }

  get current() {
    return this.message;
  }

  get controlMessage() {
    return this.message ? { type: "recorder-error" as const, message: this.message } : null;
  }
}

export interface MonitorRecorderOptions {
  worker?: Worker;
  closeTimeoutMs?: number;
  storageRootName?: MonitorRecorderStorageRootName;
  soloBatchDelayMs?: number;
}

export type MonitorRecorderStorageRootName = "ceres-monitor-recordings" | "ceres-solo-recordings";
export const DEFAULT_MONITOR_RECORDER_STORAGE_ROOT: MonitorRecorderStorageRootName = "ceres-monitor-recordings";
export const SOLO_RECORDER_STORAGE_ROOT: MonitorRecorderStorageRootName = "ceres-solo-recordings";
export const SOLO_RECORDER_BATCH_SIZE = 64;
export const SOLO_RECORDER_BATCH_DELAY_MS = 1_000;
export const SOLO_RECORDER_BATCH_MAX_BYTES = 64 * 1024 * 1024;

export function shouldFlushSoloRecorderBatch(blockCount: number, byteLength: number) {
  return blockCount >= SOLO_RECORDER_BATCH_SIZE
    || byteLength >= SOLO_RECORDER_BATCH_MAX_BYTES;
}

export class MonitorRecorder {
  private readonly worker: Worker;
  private readonly closeTimeoutMs: number;
  private readonly soloBatchDelayMs: number;
  private readonly storageRootName: MonitorRecorderStorageRootName;
  private readonly onEvent: (event: MonitorRecorderEvent) => void;
  private closed = false;
  private ready = false;
  private openedSessionId: string | null = null;
  private closePromise: Promise<void> | null = null;
  private resolveClose: (() => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingBlocks: ArrayBuffer[] = [];
  private pendingBlockBytes = 0;
  private nextSnapshotRequestId = 1;
  private readonly pendingSnapshots = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private failureDiagnosticReported = false;

  constructor(onEvent: (event: MonitorRecorderEvent) => void, options: MonitorRecorderOptions = {}) {
    this.onEvent = (event) => {
      if (event.type === "error") {
        this.reportFailureDiagnostic(event.message || "Monitor recorder failed");
      }
      onEvent(event);
    };
    this.worker = options.worker ?? new Worker(new URL("./monitor-recorder.worker.ts", import.meta.url), { type: "module", name: "ceres-monitor-recorder" });
    this.closeTimeoutMs = options.closeTimeoutMs ?? 10_000;
    this.soloBatchDelayMs = Math.max(1, options.soloBatchDelayMs ?? SOLO_RECORDER_BATCH_DELAY_MS);
    this.storageRootName = options.storageRootName ?? DEFAULT_MONITOR_RECORDER_STORAGE_ROOT;
    this.worker.addEventListener("message", (event: MessageEvent<MonitorRecorderEvent>) => {
      if (event.data.type === "ready" && event.data.sessionId === this.openedSessionId) this.ready = true;
      if (event.data.type === "error" || event.data.type === "closed") this.ready = false;
      this.onEvent(event.data);
      this.settleSnapshot(event.data);
      if (event.data.type === "closed") this.completeClose(false);
    });
    this.worker.addEventListener("error", (event) => {
      const message = event.message || "Monitor recorder worker stopped";
      this.ready = false;
      this.reportFailureDiagnostic(
        message,
        workerErrorFromEvent(event) ?? new Error(message),
        "worker_crash",
      );
      this.onEvent({ type: "error", message });
      this.rejectPendingSnapshots(message);
      if (this.closed) this.completeClose(true);
    });
    this.worker.addEventListener("messageerror", () => {
      const message = "Monitor recorder worker returned an unreadable response";
      this.ready = false;
      this.reportFailureDiagnostic(message, new Error(message), "protocol");
      this.onEvent({ type: "error", message });
      this.rejectPendingSnapshots(message);
      if (this.closed) this.completeClose(true);
    });
  }

  get isReady() {
    return this.ready && !this.closed;
  }

  open(sessionId: string) {
    if (this.closed || this.openedSessionId === sessionId) return;
    if (this.openedSessionId !== null) {
      this.onEvent({ type: "error", message: "Monitor recorder is already open for another session" });
      return;
    }
    this.failureDiagnosticReported = false;
    this.openedSessionId = sessionId;
    try {
      this.worker.postMessage({ type: "open", sessionId, storageRootName: this.storageRootName });
    } catch (error) {
      this.reportFailureDiagnostic(
        error instanceof Error
          ? error.message
          : "Monitor recorder could not open persistent storage",
        error,
        "opening",
      );
      throw error;
    }
  }

  append(block: ArrayBuffer) {
    if (this.closed || !(block instanceof ArrayBuffer)) return false;
    if (this.storageRootName === SOLO_RECORDER_STORAGE_ROOT) {
      if (this.pendingBlocks.length > 0
        && this.pendingBlockBytes + block.byteLength > SOLO_RECORDER_BATCH_MAX_BYTES
        && !this.flushPendingBlocks()) return false;
      this.pendingBlocks.push(block);
      this.pendingBlockBytes += block.byteLength;
      if (shouldFlushSoloRecorderBatch(this.pendingBlocks.length, this.pendingBlockBytes)) {
        return this.flushPendingBlocks();
      }
      if (this.batchTimer === null) {
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null;
          this.flushPendingBlocks();
        }, this.soloBatchDelayMs);
      }
      return true;
    }
    try {
      this.worker.postMessage({ type: "block", block }, [block]);
      return true;
    } catch (error) {
      this.onEvent({
        type: "error",
        message: error instanceof Error ? error.message : "Monitor recorder could not queue a block",
      });
      return false;
    }
  }

  saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Monitor recorder is closed"));
    if (!this.openedSessionId) return Promise.reject(new Error("Monitor recorder is not open"));
    if (snapshot.sessionId !== this.openedSessionId) return Promise.reject(new Error("Monitor snapshot session does not match the recorder"));
    if (!this.flushPendingBlocks()) {
      return Promise.reject(new Error("Monitor recorder could not queue pending recorder blocks"));
    }
    const snapshotRequestId = this.nextSnapshotRequestId;
    this.nextSnapshotRequestId += 1;
    const pending = new Promise<void>((resolve, reject) => {
      this.pendingSnapshots.set(snapshotRequestId, { resolve, reject });
    });
    try {
      this.worker.postMessage({ type: "save-snapshot", snapshotRequestId, snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Monitor recorder could not queue the session catalogue";
      this.onEvent({ type: "error", message, snapshotRequestId });
      const request = this.pendingSnapshots.get(snapshotRequestId);
      this.pendingSnapshots.delete(snapshotRequestId);
      request?.reject(new Error(message));
    }
    return pending;
  }

  summarise(episodeId: string) {
    if (this.closed || !this.flushPendingBlocks()) return false;
    try {
      this.worker.postMessage({ type: "summarise", episodeId });
      return true;
    } catch (error) {
      this.onEvent({
        type: "error",
        message: error instanceof Error
          ? error.message
          : "Monitor recorder could not queue the finalisation summary",
      });
      return false;
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.flushPendingBlocks();
    this.closed = true;
    this.closePromise = new Promise<void>((resolve) => { this.resolveClose = resolve; });
    this.closeTimer = setTimeout(() => {
      this.onEvent({ type: "error", message: "Monitor recorder shutdown timed out before queued writes completed" });
      this.completeClose(true);
    }, this.closeTimeoutMs);
    try {
      this.worker.postMessage({ type: "close" });
    } catch (error) {
      this.onEvent({ type: "error", message: error instanceof Error ? error.message : "Monitor recorder could not request a graceful shutdown" });
      this.completeClose(true);
    }
    return this.closePromise;
  }

  private completeClose(terminate: boolean) {
    const resolve = this.resolveClose;
    if (!resolve) return;
    this.resolveClose = null;
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (terminate) this.worker.terminate();
    this.rejectPendingSnapshots(terminate
      ? "Monitor recorder stopped before saving the session catalogue"
      : "Monitor recorder closed before saving the session catalogue");
    resolve();
  }

  private flushPendingBlocks() {
    if (this.batchTimer !== null) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (this.pendingBlocks.length === 0) return true;
    const blocks = this.pendingBlocks.splice(0, SOLO_RECORDER_BATCH_SIZE);
    this.pendingBlockBytes -= blocks.reduce((total, block) => total + block.byteLength, 0);
    try {
      this.worker.postMessage({ type: "blocks", blocks }, blocks);
    } catch (error) {
      this.onEvent({
        type: "error",
        message: error instanceof Error ? error.message : "Monitor recorder could not queue a block batch",
      });
      this.pendingBlocks.length = 0;
      this.pendingBlockBytes = 0;
      return false;
    }
    if (this.pendingBlocks.length > 0) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flushPendingBlocks();
      }, 0);
    }
    return true;
  }

  private settleSnapshot(event: MonitorRecorderEvent) {
    const snapshotRequestId = event.snapshotRequestId;
    if (!Number.isSafeInteger(snapshotRequestId)) return;
    const pending = this.pendingSnapshots.get(snapshotRequestId!);
    if (!pending) return;
    if (event.type === "snapshot-saved") {
      this.pendingSnapshots.delete(snapshotRequestId!);
      if (event.sessionId !== this.openedSessionId) {
        pending.reject(new Error("Monitor recorder acknowledged a snapshot for another session"));
      } else {
        pending.resolve();
      }
      return;
    }
    if (event.type === "error") {
      this.pendingSnapshots.delete(snapshotRequestId!);
      pending.reject(new Error(event.message || "Monitor recorder could not persist the session catalogue"));
    }
  }

  private rejectPendingSnapshots(message: string) {
    if (this.pendingSnapshots.size === 0) return;
    const error = new Error(message);
    for (const pending of this.pendingSnapshots.values()) pending.reject(error);
    this.pendingSnapshots.clear();
  }

  private reportFailureDiagnostic(
    message: string,
    cause: unknown = new Error(message),
    stage = "storage",
  ) {
    if (this.failureDiagnosticReported) return;
    this.failureDiagnosticReported = true;  }
}
