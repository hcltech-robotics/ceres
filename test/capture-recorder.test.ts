import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptureRecorder,
  type DurableRecorderStatus,
} from "../src/recorder/capture-recorder.js";
const createRecorderHarness = (state: "arming" | "armed") => {
  const messages: unknown[] = [];
  const statuses: DurableRecorderStatus[] = [];
  const terminations: boolean[] = [];
  const recorder = Object.create(CaptureRecorder.prototype) as CaptureRecorder & {
    state: "arming" | "armed" | "recording" | "failed";
    rateHz: number;
    captureOverruns: number;
    disposed: boolean;
    workerTerminated: boolean;
    shutdownTimer: number | null;
    finishPromise: Promise<void> | null;
    resolveFinish: (() => void) | null;
    rejectFinish: ((error: Error) => void) | null;
    finishTimer: ReturnType<typeof setTimeout> | null;
    finishNoProgressTimeoutMs: number;
    finishProgressSignature: string | null;
    lastWorkerStatus: DurableRecorderStatus | null;
    armedWaiters: Set<unknown>;
    pendingWorkerStates: Array<"armed" | "recording" | "paused" | "failed">;
    worker: { postMessage: (message: unknown) => void; terminate: () => void };
    onStatus: (status: DurableRecorderStatus) => void;
    settleArmedWaiters: (armed: boolean) => void;
    settleEpisodeStart: (started: boolean) => void;
    applyWorkerState: (
      state: "armed" | "recording" | "paused",
    ) => "armed" | "recording" | "paused" | "failed";
  };
  recorder.state = state;
  recorder.rateHz = 30;
  recorder.captureOverruns = 0;
  recorder.disposed = false;
  recorder.workerTerminated = false;
  recorder.shutdownTimer = null;
  recorder.finishPromise = null;
  recorder.resolveFinish = null;
  recorder.rejectFinish = null;
  recorder.finishTimer = null;
  recorder.finishNoProgressTimeoutMs = 30_000;
  recorder.finishProgressSignature = null;
  recorder.lastWorkerStatus = null;
  recorder.armedWaiters = new Set();
  recorder.pendingWorkerStates = [];
  recorder.worker = {
    postMessage: (message) => messages.push(message),
    terminate: () => terminations.push(true),
  };
  recorder.onStatus = (status) => statuses.push(status);
  return { recorder, messages, statuses, terminations };
};

test("waits for the capture worker to finish arming before starting an episode", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  try {
    const { recorder, messages } = createRecorderHarness("arming");
    const ready = recorder.waitUntilArmed(1_000);

    assert.equal(messages.length, 0);
    recorder.state = "armed";
    recorder.settleArmedWaiters(true);

    assert.equal(await ready, true);
    const initialEvent = {
      type: "segment-start" as const,
      segmentId: "segment-0001",
      taskId: "task-a",
      taskLabel: "Pick sample",
    };
    const started = recorder.startEpisode("episode-1", initialEvent, 123_000);
    assert.equal(recorder.recorderState, "armed");
    assert.deepEqual(messages, [{
      type: "start",
      episodeId: "episode-1",
      initialEvent,
      startTimestampUs: 123_000,
      rateHz: 30,
    }]);
    recorder.applyWorkerState("recording");
    recorder.settleEpisodeStart(true);
    assert.equal(await started, true);
    assert.equal(recorder.recorderState, "recording");
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("fails a bounded episode start when the initial durable write does not finish", async () => {
  const {
    recorder,
    messages,
    statuses,
    terminations,
  } = createRecorderHarness("armed");
  const initialEvent = {
    type: "segment-start" as const,
    segmentId: "segment-timeout",
    taskId: "task-timeout",
    taskLabel: "Timeout task",
  };

  const started = recorder.startEpisode("episode-timeout", initialEvent, 123_000, 5);

  assert.equal(await started, false);
  assert.equal(recorder.recorderState, "failed");
  assert.equal(recorder.isArmed, false);
  assert.match(recorder.failureReason ?? "", /initial durable write timed out/i);
  assert.deepEqual(statuses, [{
    state: "failed",
    transport: "offline",
    recorderFrameIndex: 0,
    durableAckSequence: -1,
    pendingBlocks: 0,
    queuedBlocks: 0,
    finaliseStartAckSequence: null,
    finaliseTargetSequence: null,
    explicitGaps: 0,
    captureOverruns: 0,
    error: "Recorder initial durable write timed out",
  }]);
  assert.deepEqual(messages, [
    {
      type: "start",
      episodeId: "episode-timeout",
      initialEvent,
      startTimestampUs: 123_000,
      rateHz: 30,
    },
    {
      type: "cancel-start",
      episodeId: "episode-timeout",
    },
  ]);
  assert.equal(await recorder.startEpisode("episode-late", initialEvent, 124_000, 5), false);
  assert.equal(recorder.applyWorkerState("armed"), "failed");
  recorder.arm("session-late", 30, "pairing-late");
  assert.equal(recorder.recorderState, "failed");
  assert.equal(messages.length, 2);
  assert.equal(terminations.length, 1);

  recorder.setCaptureRegistered(true);
  recorder.setPeerBlockSender(() => true);
  recorder.receivePeerControl({ type: "recorder-ready" });
  assert.equal(recorder.enqueueMedia("media", "video/webm", new ArrayBuffer(1)), false);
  assert.equal(recorder.enqueueRunEvent(initialEvent, 125_000), false);
  assert.equal(recorder.enqueueXrFrame(undefined, undefined, undefined, 126_000, "right"), false);
  assert.equal(recorder.enqueueSensorFrame({} as never, 127_000), false);
  assert.equal(messages.length, 2);
});

test("keeps rapid pause and resume requests ahead of stale worker statuses", async () => {
  const { recorder } = createRecorderHarness("armed");
  const stateful = recorder as unknown as {
    pauseEpisode: (timestampUs: number) => boolean;
    resumeEpisode: (timestampUs: number) => boolean;
    applyWorkerState: (state: "armed" | "recording" | "paused") => "armed" | "recording" | "paused";
    settleEpisodeStart: (started: boolean) => void;
    recorderState: "armed" | "recording" | "paused";
  };

  const started = recorder.startEpisode("episode-ordered", {
    type: "segment-start",
    segmentId: "segment-0001",
    taskId: "task-a",
    taskLabel: "Pick sample",
  }, 100);
  assert.equal(stateful.applyWorkerState("armed"), "armed");
  assert.equal(stateful.applyWorkerState("recording"), "recording");
  stateful.settleEpisodeStart(true);
  assert.equal(await started, true);
  assert.equal(stateful.pauseEpisode(200), true);
  assert.equal(stateful.resumeEpisode(300), true);
  assert.equal(stateful.applyWorkerState("paused"), "recording");
  assert.equal(stateful.applyWorkerState("recording"), "recording");
  assert.equal(stateful.recorderState, "recording");
});

test("starts with a durable segment boundary and pauses before journalling its end", async () => {
  const { recorder, messages } = createRecorderHarness("armed");
  const segment = {
    segmentId: "segment-0001",
    taskId: "task-a",
    taskLabel: "Pick sample",
  };

  const initialEvent = { type: "segment-start" as const, ...segment };
  const started = recorder.startEpisode("episode-cycle-1", initialEvent, 100);
  recorder.applyWorkerState("recording");
  recorder.settleEpisodeStart(true);
  assert.equal(await started, true);
  assert.equal(recorder.pauseEpisode(200), true);
  assert.equal(recorder.enqueueRunEvent({ type: "segment-end", ...segment }, 200), true);
  assert.deepEqual(messages, [
    { type: "start", episodeId: "episode-cycle-1", initialEvent, startTimestampUs: 100, rateHz: 30 },
    { type: "pause", pauseTimestampUs: 200 },
    { type: "run-event", event: { type: "segment-end", ...segment }, sourceTimestampUs: 200 },
  ]);
});

test("fails a pending arm wait cleanly when the recorder never becomes ready", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  try {
    const { recorder, messages } = createRecorderHarness("arming");
    assert.equal(await recorder.waitUntilArmed(5), false);
    assert.equal(messages.length, 0);
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("rejects finalisation immediately when the recorder has already failed", async () => {
  const messages: unknown[] = [];
  const recorder = Object.create(CaptureRecorder.prototype) as CaptureRecorder & {
    disposed: boolean;
    state: "failed";
    error: string;
    finishPromise: Promise<void> | null;
    worker: { postMessage: (message: unknown) => void };
  };
  recorder.disposed = false;
  recorder.state = "failed";
  recorder.error = "Recorder storage failed";
  recorder.finishPromise = null;
  recorder.worker = { postMessage: (message) => messages.push(message) };

  await assert.rejects(recorder.finishEpisode(), /recorder storage failed/i);
  assert.deepEqual(messages, []);
});

test("fails finalisation after no durable progress and preserves the last worker status", async () => {
  const {
    recorder,
    messages,
    statuses,
    terminations,
  } = createRecorderHarness("armed");
  const lastStatus: DurableRecorderStatus = {
    state: "armed",
    transport: "connected",
    recorderFrameIndex: 47,
    durableAckSequence: 12,
    pendingBlocks: 3,
    queuedBlocks: 4,
    finaliseStartAckSequence: 10,
    finaliseTargetSequence: 16,
    explicitGaps: 2,
    captureOverruns: 5,
    error: null,
  };
  const stateful = recorder as unknown as {
    lastWorkerStatus: DurableRecorderStatus | null;
    finishTimer: ReturnType<typeof setTimeout> | null;
  };
  stateful.lastWorkerStatus = lastStatus;

  await assert.rejects(
    recorder.finishEpisode(5),
    (error: Error) => error.name === "TimeoutError"
      && /finalisation timed out without durable progress/i.test(error.message),
  );

  assert.equal(recorder.recorderState, "failed");
  assert.match(recorder.failureReason ?? "", /finalisation timed out without durable progress/i);
  assert.deepEqual(messages, [{ type: "finish" }]);
  assert.equal(terminations.length, 1);
  assert.equal(stateful.finishTimer, null);
  assert.deepEqual(statuses, [{
    ...lastStatus,
    state: "failed",
    transport: "offline",
    error: "Recorder finalisation timed out without durable progress",
  }]);
});

test("refreshes and clears the finalisation watchdog when durable progress arrives", async () => {
  const {
    recorder,
    messages,
    statuses,
    terminations,
  } = createRecorderHarness("armed");
  const initialStatus: DurableRecorderStatus = {
    state: "armed",
    transport: "connected",
    recorderFrameIndex: 47,
    durableAckSequence: 12,
    pendingBlocks: 3,
    queuedBlocks: 4,
    finaliseStartAckSequence: 10,
    finaliseTargetSequence: 16,
    explicitGaps: 2,
    captureOverruns: 5,
    error: null,
  };
  const stateful = recorder as unknown as {
    lastWorkerStatus: DurableRecorderStatus | null;
    finishTimer: ReturnType<typeof setTimeout> | null;
    observeFinishProgress: (status: DurableRecorderStatus) => void;
    settleEpisodeFinish: (error?: Error) => void;
  };
  stateful.lastWorkerStatus = initialStatus;

  const finishing = recorder.finishEpisode(1_000);
  const initialTimer = stateful.finishTimer;
  assert.ok(initialTimer);

  const progressedStatus = {
    ...initialStatus,
    durableAckSequence: 13,
    pendingBlocks: 2,
    queuedBlocks: 3,
  };
  stateful.observeFinishProgress(progressedStatus);
  const refreshedTimer = stateful.finishTimer;
  assert.ok(refreshedTimer);
  assert.notEqual(refreshedTimer, initialTimer);

  stateful.observeFinishProgress(progressedStatus);
  assert.equal(stateful.finishTimer, refreshedTimer);

  stateful.settleEpisodeFinish();
  await finishing;
  assert.equal(stateful.finishTimer, null);
  assert.deepEqual(messages, [{ type: "finish" }]);
  assert.deepEqual(statuses, []);
  assert.equal(terminations.length, 0);
});

test("rejects a pending finalisation when recorder disposal interrupts it", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: () => 73,
    },
  });
  try {
    const { recorder, messages } = createRecorderHarness("armed");
    const finishing = recorder.finishEpisode(1_000);

    recorder.dispose();

    await assert.rejects(
      finishing,
      /finalisation was interrupted before the recorder finished/i,
    );
    assert.deepEqual(messages, [{ type: "finish" }, { type: "close" }]);
    assert.equal(recorder.recorderState, "idle");
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("rejects a pending finish when the recorder worker fails", async () => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");

  class TestWorker {
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    readonly messages: unknown[] = [];

    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) return;
      const callback = typeof listener === "function"
        ? listener as (event: MessageEvent) => void
        : (event: MessageEvent) => listener.handleEvent(event);
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(callback);
      this.listeners.set(type, listeners);
    }

    postMessage(message: unknown) {
      this.messages.push(message);
    }

    terminate() {}

    dispatchMessage(data: unknown) {
      const event = { data } as MessageEvent;
      for (const listener of this.listeners.get("message") ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  });
  try {
    const { recorder } = createRecorderHarness("armed");
    const stateful = recorder as unknown as {
      createWorker: () => Worker;
      worker: Worker;
    };
    const worker = stateful.createWorker() as unknown as TestWorker;
    stateful.worker = worker as unknown as Worker;
    const finishing = recorder.finishEpisode(1_000);

    worker.dispatchMessage({
      type: "status",
      status: {
        state: "failed",
        transport: "offline",
        recorderFrameIndex: 12,
        durableAckSequence: 7,
        pendingBlocks: 1,
        queuedBlocks: 1,
        finaliseStartAckSequence: 6,
        finaliseTargetSequence: 8,
        explicitGaps: 0,
        captureOverruns: 0,
        error: "Recorder server rejected the final block",
      },
    });

    await assert.rejects(finishing, /rejected the final block/i);
  } finally {
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("queues recorder arming until capture registration and gates reconnects", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "capture.test" },
  });
  try {
    const messages: unknown[] = [];
    const recorder = Object.create(CaptureRecorder.prototype) as CaptureRecorder & {
      disposed: boolean;
      captureRegistered: boolean;
      pendingArm: unknown;
      state: "idle" | "arming";
      rateHz: number;
      error: string | null;
      armedWaiters: Set<unknown>;
      pendingWorkerStates: Array<"armed" | "recording" | "paused">;
      sharedControl: null;
      sharedValues: null;
      worker: { postMessage: (message: unknown) => void };
    };
    recorder.disposed = false;
    recorder.captureRegistered = false;
    recorder.pendingArm = null;
    recorder.state = "idle";
    recorder.rateHz = 30;
    recorder.error = null;
    recorder.armedWaiters = new Set();
    recorder.pendingWorkerStates = [];
    recorder.sharedControl = null;
    recorder.sharedValues = null;
    recorder.worker = { postMessage: (message) => messages.push(message) };

    recorder.arm("paired-session", 60, "paired-capture");
    assert.equal(recorder.recorderState, "idle");
    assert.deepEqual(messages, []);

    recorder.setCaptureRegistered(true);
    assert.equal(recorder.recorderState, "arming");
    assert.deepEqual(messages, [
      {
        type: "arm",
        sessionId: "paired-session",
        pairingId: "paired-capture",
        storageRootName: "ceres-recorder",
        rateHz: 60,
        captureRegistered: true,
        transportMode: "websocket",
        transportUrl: "wss://capture.test/ws",
        wallClockOffsetMs: 0,
        sharedRing: undefined,
      },
    ]);

    recorder.setCaptureRegistered(false);
    recorder.setCaptureRegistered(true);
    assert.deepEqual(messages.slice(1), [
      { type: "capture-registration", registered: false },
      { type: "capture-registration", registered: true },
    ]);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("waits for worker shutdown acknowledgement and keeps a bounded termination fallback", () => {
  const previousWindow = globalThis.window;
  let scheduledFallback: (() => void) | null = null;
  const clearedTimers: number[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => {
        scheduledFallback = callback;
        return 73;
      },
      clearTimeout: (handle: number) => clearedTimers.push(handle),
    },
  });
  try {
    const acknowledged = createShutdownHarness();
    acknowledged.recorder.dispose();
    assert.deepEqual(acknowledged.messages, [{ type: "close" }]);
    assert.equal(acknowledged.terminations.length, 0);
    acknowledged.recorder.completeWorkerShutdown();
    assert.equal(acknowledged.terminations.length, 1);
    assert.deepEqual(clearedTimers, [73]);

    scheduledFallback = null;
    const timedOut = createShutdownHarness();
    timedOut.recorder.dispose();
    assert.equal(timedOut.terminations.length, 0);
    assert.ok(scheduledFallback);
    (scheduledFallback as () => void)();
    assert.equal(timedOut.terminations.length, 1);
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

function createShutdownHarness() {
  const messages: unknown[] = [];
  const terminations: boolean[] = [];
  const recorder = Object.create(CaptureRecorder.prototype) as CaptureRecorder & {
    disposed: boolean;
    state: "armed" | "idle";
    armedWaiters: Set<unknown>;
    pendingWorkerStates: Array<"armed" | "recording" | "paused">;
    finishPromise: Promise<void> | null;
    resolveFinish: (() => void) | null;
    rejectFinish: ((error: Error) => void) | null;
    shutdownTimer: number | null;
    workerTerminated: boolean;
    worker: { postMessage: (message: unknown) => void; terminate: () => void };
    completeWorkerShutdown: () => void;
  };
  recorder.disposed = false;
  recorder.state = "armed";
  recorder.armedWaiters = new Set();
  recorder.pendingWorkerStates = [];
  recorder.finishPromise = null;
  recorder.resolveFinish = null;
  recorder.rejectFinish = null;
  recorder.shutdownTimer = null;
  recorder.workerTerminated = false;
  recorder.worker = {
    postMessage: (message) => messages.push(message),
    terminate: () => { terminations.push(true); },
  };
  return { recorder, messages, terminations };
}
