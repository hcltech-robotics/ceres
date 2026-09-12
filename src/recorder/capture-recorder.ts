import type { CameraSide, RecorderRunEvent, SensorFrame } from "../../shared/protocol.js";

import { workerErrorFromEvent } from "../worker-errors.js";

import { TELEMETRY_BYTE_LENGTH, TELEMETRY_VALUE_COUNT, writeSensorTelemetry, writeXrTelemetry } from "./telemetry-buffer.js";

const TRANSFER_POOL_SIZE = 48;
const SHARED_RING_CAPACITY = 64;
const WORKER_SHUTDOWN_TIMEOUT_MS = 1_000;
const EPISODE_START_TIMEOUT_MS = 10_000;
const EPISODE_FINISH_NO_PROGRESS_TIMEOUT_MS = 30_000;
const RING_WRITE_INDEX = 0;
const RING_READ_INDEX = 1;
const RING_OVERRUN_COUNT = 2;

export type DurableRecorderState = "idle" | "arming" | "armed" | "recording" | "paused" | "failed";

export interface DurableRecorderStatus {
  state: DurableRecorderState;
  transport: "offline" | "connecting" | "connected";
  recorderFrameIndex: number;
  durableAckSequence: number;
  pendingBlocks: number;
  queuedBlocks: number;
  finaliseStartAckSequence: number | null;
  finaliseTargetSequence: number | null;
  explicitGaps: number;
  captureOverruns: number;
  error: string | null;
}

type TransferEntry = { buffer: ArrayBuffer; values: Float64Array };
type ArmedWaiter = { resolve: (armed: boolean) => void; timeoutId: number };
type RecorderArmRequest = { sessionId: string; rateHz: number; pairingId: string };
type PeerRecorderBlockSender = (sequence: number, block: ArrayBuffer) => boolean;
export type CaptureRecorderStorageRoot = "ceres-recorder" | "ceres-solo-recordings";

export interface CaptureRecorderOptions {
  storageRootName?: CaptureRecorderStorageRoot;
}

export class CaptureRecorder {
  private worker: Worker;
  private disposed = false;
  private state: DurableRecorderState = "idle";
  private sessionId = "";
  private rateHz = 30;
  private error: string | null = null;
  private readonly transferPool: TransferEntry[] = [];
  private readonly sharedControl: Int32Array | null;
  private readonly sharedValues: Float64Array | null;
  private captureOverruns = 0;
  private finishPromise: Promise<void> | null = null;
  private resolveFinish: (() => void) | null = null;
  private rejectFinish: ((error: Error) => void) | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private finishNoProgressTimeoutMs = EPISODE_FINISH_NO_PROGRESS_TIMEOUT_MS;
  private finishProgressSignature: string | null = null;
  private startPromise: Promise<boolean> | null = null;
  private resolveStart: ((started: boolean) => void) | null = null;
  private startingEpisodeId: string | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly armedWaiters = new Set<ArmedWaiter>();
  private shutdownTimer: number | null = null;
  private workerTerminated = false;
  private captureRegistered = false;
  private pendingArm: RecorderArmRequest | null = null;
  private peerBlockSender: PeerRecorderBlockSender | null = null;
  private readonly pendingWorkerStates: DurableRecorderState[] = [];
  private readonly storageRootName: CaptureRecorderStorageRoot;
  private failureDiagnosticReported = false;
  private lastWorkerStatus: DurableRecorderStatus | null = null;

  constructor(
    private readonly onStatus: (status: DurableRecorderStatus) => void,
    options: CaptureRecorderOptions = {},
  ) {
    this.storageRootName = options.storageRootName ?? "ceres-recorder";
    this.worker = this.createWorker();
    if (crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      this.sharedControl = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
      this.sharedValues = new Float64Array(new SharedArrayBuffer(SHARED_RING_CAPACITY * TELEMETRY_BYTE_LENGTH));
    } else {
      this.sharedControl = null;
      this.sharedValues = null;
      for (let index = 0; index < TRANSFER_POOL_SIZE; index += 1) this.transferPool.push(this.createTransferEntry());
    }
  }

  get recorderState() {
    return this.state;
  }

  get isArmed() {
    return this.state === "armed" || this.state === "recording" || this.state === "paused";
  }

  get failureReason() {
    return this.error;
  }

  arm(sessionId: string, rateHz: number, pairingId: string) {
    if (this.disposed || this.state === "failed" || !sessionId || !pairingId) return;
    this.pendingArm = { sessionId, rateHz, pairingId };
    this.flushPendingArm();
  }

  setCaptureRegistered(registered: boolean) {
    if (this.disposed || this.workerTerminated || this.captureRegistered === registered) return;
    this.captureRegistered = registered;
    if (registered && this.pendingArm) {
      this.flushPendingArm();
      return;
    }
    this.worker.postMessage({ type: "capture-registration", registered });
  }

  setPeerBlockSender(sender: PeerRecorderBlockSender | null) {
    if (this.disposed || this.workerTerminated || this.peerBlockSender === sender) return;
    this.peerBlockSender = sender;
    this.worker.postMessage({ type: "peer-transport", connected: Boolean(sender) });
    if (sender && this.pendingArm) this.flushPendingArm();
  }

  receivePeerControl(message: unknown) {
    if (!this.disposed && !this.workerTerminated) {
      this.worker.postMessage({ type: "peer-control", message });
    }
  }

  private flushPendingArm() {
    const request = this.pendingArm;
    if (this.disposed
      || this.workerTerminated
      || this.state === "failed"
      || (!this.captureRegistered && !this.peerBlockSender)
      || !request) return;
    this.pendingArm = null;
    this.settleArmedWaiters(false);
    this.sessionId = request.sessionId;
    this.rateHz = request.rateHz;
    this.error = null;
    this.failureDiagnosticReported = false;
    this.lastWorkerStatus = null;
    this.state = "arming";
    this.pendingWorkerStates.length = 0;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.worker.postMessage({
      type: "arm",
      sessionId: request.sessionId,
      pairingId: request.pairingId,
      storageRootName: this.storageRootName ?? "ceres-recorder",
      rateHz: request.rateHz,
      captureRegistered: true,
      transportMode: this.peerBlockSender ? "peer" : "websocket",
      transportUrl: `${scheme}://${location.host}/ws`,
      wallClockOffsetMs: 0,
      sharedRing: this.sharedControl && this.sharedValues ? {
        control: this.sharedControl.buffer,
        values: this.sharedValues.buffer,
        capacity: SHARED_RING_CAPACITY,
      } : undefined,
    });
  }

  waitUntilArmed(timeoutMs = 5_000) {
    if (this.state === "armed") return Promise.resolve(true);
    if (this.state !== "arming") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: ArmedWaiter = {
        resolve,
        timeoutId: window.setTimeout(() => {
          this.armedWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      this.armedWaiters.add(waiter);
    });
  }

  startEpisode(
    episodeId: string,
    initialEvent: RecorderRunEvent,
    startTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000),
    timeoutMs = EPISODE_START_TIMEOUT_MS,
  ) {
    if (this.startPromise) {
      return this.startingEpisodeId === episodeId ? this.startPromise : Promise.resolve(false);
    }
    if (this.disposed
      || this.workerTerminated
      || this.state !== "armed"
      || initialEvent.type !== "segment-start") {
      return Promise.resolve(false);
    }
    this.startingEpisodeId = episodeId;
    this.startPromise = new Promise<boolean>((resolve) => {
      this.resolveStart = resolve;
    });
    this.startTimer = globalThis.setTimeout(() => {
      this.startTimer = null;
      if (!this.startPromise || this.startingEpisodeId !== episodeId) return;
      try {
        this.worker.postMessage({ type: "cancel-start", episodeId });
      } catch {
        // The local failure latch must not depend on a responsive worker.
      }
      this.failLocally("Recorder initial durable write timed out");
    }, timeoutMs);
    this.worker.postMessage({ type: "start", episodeId, initialEvent, startTimestampUs, rateHz: this.rateHz });
    return this.startPromise;
  }

  stopEpisode(stopTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000)) {
    if (this.workerTerminated || (this.state !== "recording" && this.state !== "paused")) return;
    this.worker.postMessage({ type: "stop", stopTimestampUs });
  }

  pauseEpisode(pauseTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000)) {
    if (this.workerTerminated || this.state !== "recording") return false;
    this.state = "paused";
    this.pendingWorkerStates.push("paused");
    this.worker.postMessage({ type: "pause", pauseTimestampUs });
    return true;
  }

  resumeEpisode(resumeTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000)) {
    if (this.workerTerminated || this.state !== "paused") return false;
    this.state = "recording";
    this.pendingWorkerStates.push("recording");
    this.worker.postMessage({ type: "resume", resumeTimestampUs });
    return true;
  }

  finishEpisode(timeoutMs = EPISODE_FINISH_NO_PROGRESS_TIMEOUT_MS) {
    if (this.finishPromise) return this.finishPromise;
    if (this.disposed) return Promise.resolve();
    if (this.state === "failed") {
      return Promise.reject(new Error(this.error || "The durable recorder failed while finalising"));
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.resolveFinish = resolve;
      this.rejectFinish = reject;
    });
    this.finishPromise = promise;
    this.finishNoProgressTimeoutMs = Math.max(1, timeoutMs);
    this.finishProgressSignature = this.lastWorkerStatus
      ? this.finalisationProgressSignature(this.lastWorkerStatus)
      : null;
    this.scheduleFinishWatchdog();
    try {
      this.worker.postMessage({ type: "finish" });
    } catch (error) {
      this.failFinalisation(error);
    }
    return promise;
  }

  failFinalisation(error: unknown) {
    if (this.disposed || this.workerTerminated || this.state === "failed") return;
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : typeof error === "string" && error.trim()
        ? error.trim()
        : "The durable recorder did not finish cleanly";
    const cause = error instanceof Error ? error : new Error(message);
    this.failLocally(message, cause, "finalising");
  }

  enqueueMedia(kind: "media" | "audio", mimeType: string, buffer: ArrayBuffer) {
    if (this.disposed || this.workerTerminated || this.state === "failed") return false;
    this.worker.postMessage({ type: "media", kind, mimeType, buffer }, [buffer]);
    return true;
  }

  enqueueRunEvent(
    event: RecorderRunEvent,
    sourceTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000),
  ) {
    if (this.disposed
      || this.workerTerminated
      || (this.state !== "recording" && this.state !== "paused")) return false;
    this.worker.postMessage({ type: "run-event", event, sourceTimestampUs });
    return true;
  }

  enqueueXrFrame(xrFrame: any, referenceSpace: any, xrSession: any, sourceTimestampUs: number, cameraSide: CameraSide) {
    if (this.disposed || this.workerTerminated || this.state === "failed") return false;
    if (this.sharedControl && this.sharedValues) {
      const writeIndex = Atomics.load(this.sharedControl, RING_WRITE_INDEX);
      const readIndex = Atomics.load(this.sharedControl, RING_READ_INDEX);
      const nextWriteIndex = (writeIndex + 1) % SHARED_RING_CAPACITY;
      if (nextWriteIndex === readIndex) {
        this.captureOverruns += 1;
        Atomics.add(this.sharedControl, RING_OVERRUN_COUNT, 1);
        return false;
      }
      writeXrTelemetry(this.sharedValues, writeIndex * TELEMETRY_VALUE_COUNT, sourceTimestampUs, xrFrame, referenceSpace, xrSession, cameraSide);
      Atomics.store(this.sharedControl, RING_WRITE_INDEX, nextWriteIndex);
      Atomics.notify(this.sharedControl, RING_WRITE_INDEX, 1);
      return true;
    }

    const entry = this.transferPool.pop();
    if (!entry) {
      this.captureOverruns += 1;
      this.worker.postMessage({ type: "capture-overrun", sourceTimestampUs });
      return false;
    }
    writeXrTelemetry(entry.values, 0, sourceTimestampUs, xrFrame, referenceSpace, xrSession, cameraSide);
    this.worker.postMessage({ type: "sample", buffer: entry.buffer }, [entry.buffer]);
    return true;
  }

  enqueueSensorFrame(frame: SensorFrame, sourceTimestampUs: number) {
    if (this.disposed || this.workerTerminated || this.state === "failed") return false;
    if (this.sharedControl && this.sharedValues) {
      const writeIndex = Atomics.load(this.sharedControl, RING_WRITE_INDEX);
      const readIndex = Atomics.load(this.sharedControl, RING_READ_INDEX);
      const nextWriteIndex = (writeIndex + 1) % SHARED_RING_CAPACITY;
      if (nextWriteIndex === readIndex) {
        this.captureOverruns += 1;
        Atomics.add(this.sharedControl, RING_OVERRUN_COUNT, 1);
        return false;
      }
      writeSensorTelemetry(this.sharedValues, writeIndex * TELEMETRY_VALUE_COUNT, sourceTimestampUs, frame);
      Atomics.store(this.sharedControl, RING_WRITE_INDEX, nextWriteIndex);
      Atomics.notify(this.sharedControl, RING_WRITE_INDEX, 1);
      return true;
    }

    const entry = this.transferPool.pop();
    if (!entry) {
      this.captureOverruns += 1;
      this.worker.postMessage({ type: "capture-overrun", sourceTimestampUs });
      return false;
    }
    writeSensorTelemetry(entry.values, 0, sourceTimestampUs, frame);
    this.worker.postMessage({ type: "sample", buffer: entry.buffer }, [entry.buffer]);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    const finalisationInterruption = this.finishPromise
      ? new Error("Recorder finalisation was interrupted before the recorder finished")
      : undefined;
    this.disposed = true;
    this.pendingArm = null;
    this.captureRegistered = false;
    this.settleArmedWaiters(false);
    this.settleEpisodeStart(false);
    this.settleEpisodeFinish(finalisationInterruption);
    if (!this.workerTerminated) {
      this.worker.postMessage({ type: "close" });
      this.shutdownTimer = window.setTimeout(() => this.completeWorkerShutdown(), WORKER_SHUTDOWN_TIMEOUT_MS);
    }
    this.state = "idle";
    this.pendingWorkerStates.length = 0;
  }

  private createTransferEntry(buffer = new ArrayBuffer(TELEMETRY_BYTE_LENGTH)): TransferEntry {
    return { buffer, values: new Float64Array(buffer) };
  }

  private createWorker() {
    const worker = new Worker(new URL("./capture-recorder.worker.ts", import.meta.url), { type: "module", name: "ceres-capture-recorder" });
    worker.addEventListener("message", (event) => {
      if (this.workerTerminated) return;
      const message = event.data;
      if (message.type === "closed") {
        this.completeWorkerShutdown();
        return;
      }
      if (message.type === "recycle" && message.buffer instanceof ArrayBuffer) {
        this.transferPool.push(this.createTransferEntry(message.buffer));
        return;
      }
      if (message.type === "finished") {
        this.settleEpisodeFinish();
        return;
      }
      if (message.type === "episode-started") {
        if (message.episodeId === this.startingEpisodeId) this.settleEpisodeStart(true);
        return;
      }
      if (message.type === "peer-block" && Number.isSafeInteger(message.sequence) && message.block instanceof ArrayBuffer) {
        let accepted = false;
        try {
          accepted = this.peerBlockSender?.(message.sequence, message.block) === true;
        } catch {
          accepted = false;
        }
        if (!this.workerTerminated) {
          this.worker.postMessage({ type: "peer-delivery", sequence: message.sequence, accepted });
        }
        return;
      }
      if (message.type === "peer-blocks" && Array.isArray(message.blocks)) {
        const generation = message.generation;
        if (!Number.isSafeInteger(generation)) return;
        const blocks = message.blocks as Array<{ sequence?: unknown; block?: unknown }>;
        if (blocks.some(({ sequence, block }) => !Number.isSafeInteger(sequence) || !(block instanceof ArrayBuffer))) {
          this.worker.postMessage({ type: "peer-deliveries", generation, deliveries: [] });
          return;
        }
        let accepting = true;
        const deliveries = blocks.map(({ sequence, block }) => {
          let accepted = false;
          if (accepting) {
            try {
              accepted = this.peerBlockSender?.(sequence as number, block as ArrayBuffer) === true;
            } catch {
              accepted = false;
            }
          }
          if (!accepted) accepting = false;
          return { sequence: sequence as number, accepted };
        });
        if (!this.workerTerminated) {
          this.worker.postMessage({ type: "peer-deliveries", generation, deliveries });
        }
        return;
      }
      if (message.type !== "status") return;
      const state = this.applyWorkerState(message.status.state);
      if (state !== "failed" || message.status.state === "failed") {
        this.error = message.status.error ?? null;
      }
      const status: DurableRecorderStatus = {
        ...message.status,
        state,
        captureOverruns: this.captureOverruns + (message.status.captureOverruns ?? 0),
        error: this.error,
      };
      this.lastWorkerStatus = status;
      const wasFinalising = this.finishPromise !== null;
      if (this.state === "armed") this.settleArmedWaiters(true);
      else if (this.state !== "arming") this.settleArmedWaiters(false);
      if (this.state === "failed") {
        this.settleEpisodeFinish(new Error(this.error || "The durable recorder failed while finalising"));
      } else this.observeFinishProgress(status);
      if (this.state === "failed") this.settleEpisodeStart(false);
      if (this.state === "failed" && !this.failureDiagnosticReported) {      }
      if (this.state === "failed") this.reportFailureDiagnostic();
      this.onStatus(status);
    });
    worker.addEventListener("error", (event) => {
      const cause = workerErrorFromEvent(event);
      this.failLocally(
        event.message || "The durable recorder worker stopped",
        cause ?? undefined,
        "worker_crash",
      );
    });
    worker.addEventListener("messageerror", () => {
      const error = new Error("The durable recorder worker returned an unreadable response");
      this.failLocally(error.message, error, "protocol");
    });
    return worker;
  }

  private applyWorkerState(state: DurableRecorderState) {
    if (this.state === "failed" && state !== "failed") return this.state;
    if (state === "failed") {
      this.pendingWorkerStates.length = 0;
      this.state = state;
      return state;
    }
    const expected = this.pendingWorkerStates[0];
    if (expected && (state === "armed" || state === "recording" || state === "paused")) {
      if (state === expected) this.pendingWorkerStates.shift();
      const latestRequested = this.pendingWorkerStates.at(-1);
      if (latestRequested) {
        this.state = latestRequested;
        return latestRequested;
      }
      if (state !== expected) return this.state;
    }
    this.state = state;
    return state;
  }

  private failLocally(error: string, cause?: unknown, stage = "recording") {
    this.state = "failed";
    this.error = error;
    if (!this.failureDiagnosticReported) {    }
    this.reportFailureDiagnostic();
    this.pendingArm = null;
    this.pendingWorkerStates.length = 0;
    this.settleArmedWaiters(false);
    this.settleEpisodeStart(false);
    this.settleEpisodeFinish(cause instanceof Error ? cause : new Error(error));
    this.completeWorkerShutdown();
    const previous = this.lastWorkerStatus;
    const status: DurableRecorderStatus = {
      state: "failed",
      transport: "offline",
      recorderFrameIndex: previous?.recorderFrameIndex ?? 0,
      durableAckSequence: previous?.durableAckSequence ?? -1,
      pendingBlocks: previous?.pendingBlocks ?? 0,
      queuedBlocks: previous?.queuedBlocks ?? 0,
      finaliseStartAckSequence: previous?.finaliseStartAckSequence ?? null,
      finaliseTargetSequence: previous?.finaliseTargetSequence ?? null,
      explicitGaps: previous?.explicitGaps ?? 0,
      captureOverruns: previous?.captureOverruns ?? this.captureOverruns,
      error,
    };
    this.lastWorkerStatus = status;
    this.onStatus(status);
  }

  private reportFailureDiagnostic() {
    if (this.failureDiagnosticReported) return;
    this.failureDiagnosticReported = true;  }

  private settleArmedWaiters(armed: boolean) {
    for (const waiter of this.armedWaiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve(armed);
    }
    this.armedWaiters.clear();
  }

  private settleEpisodeStart(started: boolean) {
    if (this.startTimer != null) globalThis.clearTimeout(this.startTimer);
    this.startTimer = null;
    this.resolveStart?.(started);
    this.startPromise = null;
    this.resolveStart = null;
    this.startingEpisodeId = null;
  }

  private settleEpisodeFinish(error?: Error) {
    const resolve = this.resolveFinish;
    const reject = this.rejectFinish;
    if (this.finishTimer !== null) globalThis.clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.finishProgressSignature = null;
    this.finishPromise = null;
    this.resolveFinish = null;
    this.rejectFinish = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private observeFinishProgress(status: DurableRecorderStatus) {
    if (!this.finishPromise) return;
    const signature = this.finalisationProgressSignature(status);
    if (signature === this.finishProgressSignature) return;
    this.finishProgressSignature = signature;
    this.scheduleFinishWatchdog();
  }

  private finalisationProgressSignature(status: DurableRecorderStatus) {
    return [
      status.durableAckSequence,
      status.pendingBlocks,
      status.queuedBlocks,
      status.finaliseStartAckSequence ?? "open",
      status.finaliseTargetSequence ?? "open",
    ].join(":");
  }

  private scheduleFinishWatchdog() {
    const pending = this.finishPromise;
    if (!pending) return;
    if (this.finishTimer !== null) globalThis.clearTimeout(this.finishTimer);
    this.finishTimer = globalThis.setTimeout(() => {
      this.finishTimer = null;
      if (this.finishPromise !== pending) return;
      const failure = new Error("Recorder finalisation timed out without durable progress");
      failure.name = "TimeoutError";
      this.failFinalisation(failure);
    }, this.finishNoProgressTimeoutMs);
  }

  private completeWorkerShutdown() {
    if (this.workerTerminated) return;
    this.workerTerminated = true;
    if (this.shutdownTimer !== null) window.clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
    this.worker.terminate();
  }
}
