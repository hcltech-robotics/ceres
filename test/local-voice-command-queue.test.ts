import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  LocalVoiceCommandController,
  type LocalVoiceCommandControllerOptions,
} from "../src/local-voice-command.js";
import { LocalVoiceCommandQueue } from "../src/local-voice-command-queue.js";
import {
  LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS,
  LOCAL_VOICE_COMMAND_MAX_AGE_MS,
} from "../src/local-voice-command-timing.js";

function capture(queue: LocalVoiceCommandQueue, id: number, now: number, context = "run-a") {
  queue.start(id, now, context);
  queue.capture(id, new Float32Array([id]), 16_000, now + 100);
}

test("keeps only the latest complete retry while one utterance is running", () => {
  const queue = new LocalVoiceCommandQueue();
  capture(queue, 1, 0);
  const first = queue.next(100)!;
  capture(queue, 2, 200);
  capture(queue, 3, 400);
  assert.equal(queue.next(500), null);
  assert.equal(queue.complete(first.requestId + 1, 600), null);
  assert.equal(queue.complete(first.requestId, 600)?.fresh, true);
  const next = queue.next(600)!;
  assert.equal(next.utteranceId, 3);
  assert.equal(next.samples[0], 3);
  assert.equal(next.context, "run-a");
  assert.equal(queue.complete(first.requestId, 700), null);
  queue.complete(next.requestId, 700);
  assert.equal(queue.next(700), null);
});

test("captures context at speech onset and rejects duplicate or cancelled audio", () => {
  const queue = new LocalVoiceCommandQueue();
  queue.start(1, 0, "run-a");
  queue.start(1, 100, "run-b");
  queue.capture(1, new Float32Array([1]), 16_000, 200);
  const request = queue.next(200)!;
  assert.equal(request.context, "run-a");
  assert.equal(request.capturedAtMs, 0);
  queue.complete(request.requestId, 300);
  queue.capture(1, new Float32Array([1]), 16_000, 300);
  queue.start(1, 300, "run-b");
  queue.capture(1, new Float32Array([1]), 16_000, 300);
  assert.equal(queue.next(300), null);
  queue.start(2, 400, "run-b");
  queue.cancel(2);
  queue.capture(2, new Float32Array([2]), 16_000, 500);
  assert.equal(queue.next(500), null);
});

test("expires queued speech and late results from the time speech started", () => {
  const queue = new LocalVoiceCommandQueue();
  capture(queue, 1, 0);
  assert.equal(queue.next(LOCAL_VOICE_COMMAND_MAX_AGE_MS), null);
  capture(queue, 2, 10_000);
  const request = queue.next(10_100)!;
  assert.equal(queue.complete(request.requestId, 10_000 + LOCAL_VOICE_COMMAND_MAX_AGE_MS)?.fresh, false);
  queue.start(3, 20_000);
  queue.capture(3, new Float32Array([3]), 16_000, 20_000 + LOCAL_VOICE_COMMAND_MAX_AGE_MS);
  assert.equal(queue.next(20_000 + LOCAL_VOICE_COMMAND_MAX_AGE_MS), null);
});

test("abandons only the requested inference and releases captured audio on clear", () => {
  const queue = new LocalVoiceCommandQueue();
  capture(queue, 1, 0);
  const first = queue.next(100)!;
  capture(queue, 2, 200);
  assert.equal(queue.abandon(first.requestId + 1), false);
  assert.equal(queue.next(300), null);
  assert.equal(queue.abandon(first.requestId), true);
  const next = queue.next(300)!;
  assert.equal(next.utteranceId, 2);
  queue.start(3, 400);
  queue.clear();
  queue.capture(3, new Float32Array([3]), 16_000, 500);
  assert.equal(queue.next(500), null);
  assert.equal(queue.complete(next.requestId, 500), null);
});

test("tracks capture and pending expiry without hiding an outstanding inference", () => {
  const queue = new LocalVoiceCommandQueue();
  assert.deepEqual(queue.activity(0), { outstanding: false, expiresAtMs: null });
  queue.start(1, 0, "run-a", "xr-a");
  assert.deepEqual(queue.activity(1), { outstanding: true, expiresAtMs: LOCAL_VOICE_COMMAND_MAX_AGE_MS });
  queue.capture(1, new Float32Array([1]), 16_000, 100);
  const first = queue.next(100)!;
  assert.equal(first.exitContext, "xr-a");
  capture(queue, 2, 200);
  assert.deepEqual(queue.activity(300), { outstanding: true, expiresAtMs: 200 + LOCAL_VOICE_COMMAND_MAX_AGE_MS });
  assert.deepEqual(queue.activity(200 + LOCAL_VOICE_COMMAND_MAX_AGE_MS), { outstanding: true, expiresAtMs: null });
  queue.complete(first.requestId, 5_000);
  assert.deepEqual(queue.activity(5_000), { outstanding: false, expiresAtMs: null });
  assert.equal(queue.next(5_000), null);
});

type WorkerMessage = Record<string, unknown>;

function controllerHarness(t: TestContext, options: Partial<LocalVoiceCommandControllerOptions> = {}) {
  let now = 0;
  const workers: FakeWorker[] = [];
  class FakeWorker {
    readonly messages: WorkerMessage[] = [];
    readonly listeners = new Map<string, Array<(event: { data?: WorkerMessage; message?: string }) => void>>();
    terminated = false;

    constructor() { workers.push(this); }

    addEventListener(type: string, listener: (event: { data?: WorkerMessage; message?: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    postMessage(message: WorkerMessage) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(data: WorkerMessage) {
      for (const listener of this.listeners.get("message") ?? []) listener({ data });
    }
    crash() {
      for (const listener of this.listeners.get("error") ?? []) listener({ message: "old worker crashed" });
    }
    get audio() { return this.messages.filter(({ type }) => type === "audio"); }
  }

  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands: Array<{ command: string; context?: string }> = [];
  const activity: boolean[] = [];
  const statuses: string[] = [];
  const results: boolean[] = [];
  let successes = 0;
  const controller = new LocalVoiceCommandController({
    stream: {} as MediaStream,
    onCommand: (command, context) => commands.push({ command, context }),
    onStatus: (status) => statuses.push(status),
    onRecognitionChange: (active) => activity.push(active),
    onRecognitionSuccess: () => { successes += 1; },
    onRecognitionResult: (matched) => results.push(matched),
    ...options,
  });
  t.after(() => {
    controller.dispose();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  const input = controller as unknown as { receiveAudioMessage(message: WorkerMessage): void };
  return {
    controller,
    workers,
    commands,
    activity,
    statuses,
    results,
    successes: () => successes,
    tick(ms: number) { now += ms; t.mock.timers.tick(ms); },
    start(id: number) { input.receiveAudioMessage({ type: "speech-start", utteranceId: id }); },
    cancel(id: number) { input.receiveAudioMessage({ type: "speech-cancel", utteranceId: id }); },
    finish(id: number) {
      input.receiveAudioMessage({ type: "audio", utteranceId: id, samples: new Float32Array([id]), sampleRate: 16_000 });
    },
  };
}

test("immediately recognises the latest retry after a miss and accepts repeated words", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2); h.finish(2);
  h.start(3); h.finish(3);
  assert.equal(worker.audio.length, 1);
  const first = worker.audio[0]!.requestId;
  worker.emit({ type: "result", requestId: first, successful: true });
  assert.equal(worker.audio.length, 2);
  assert.equal((worker.audio[1]!.samples as Float32Array)[0], 3);
  const retry = worker.audio[1]!.requestId;
  worker.emit({ type: "result", requestId: retry, successful: true, command: "pause" });
  worker.emit({ type: "result", requestId: retry, successful: true, command: "pause" });
  h.start(4); h.finish(4);
  worker.emit({ type: "result", requestId: worker.audio[2]!.requestId, successful: true, command: "pause" });
  assert.deepEqual(h.commands.map(({ command }) => command), ["pause", "pause"]);
  assert.equal(h.successes(), 3);
  assert.deepEqual(h.activity, [true, false, true, false]);
  assert.deepEqual(h.results, [false, true, true]);
  assert.deepEqual(h.statuses, ["ready"]);
});

test("retries immediately after inference failure and clears activity on disposal", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2); h.finish(2);
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: false });
  assert.equal(worker.audio.length, 2);
  assert.equal(h.successes(), 0);
  h.controller.dispose();
  h.tick(LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS);
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: true, command: "next" });
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.activity, [true, false]);
  assert.deepEqual(h.results, []);
  assert.deepEqual(h.commands, []);
});

test("continues the pending retry when applying a recognised command throws", (t) => {
  const h = controllerHarness(t, { onCommand: () => { throw new Error("Control rejected"); } });
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2); h.finish(2);
  assert.throws(() => worker.emit({
    type: "result",
    requestId: worker.audio[0]!.requestId,
    successful: true,
    command: "next",
  }), /Control rejected/);
  assert.equal(worker.audio.length, 2);
  assert.equal((worker.audio[1]!.samples as Float32Array)[0], 2);
});

test("shows activity during capture and model waiting and clears it on cancellation, expiry and errors", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  h.start(1);
  assert.deepEqual(h.activity, [true]);
  h.cancel(1);
  assert.deepEqual(h.activity, [true, false]);
  h.start(2); h.finish(2);
  assert.equal(worker.audio.length, 0);
  h.tick(LOCAL_VOICE_COMMAND_MAX_AGE_MS);
  assert.deepEqual(h.activity, [true, false, true, false]);
  h.start(3);
  worker.emit({ type: "status", status: "error", detail: "Model could not load" });
  assert.deepEqual(h.activity, [true, false, true, false, true, false]);
  h.finish(3);
  worker.emit({ type: "status", status: "ready" });
  assert.equal(worker.audio.length, 0);
  h.start(4); h.finish(4);
  worker.crash();
  assert.equal(h.activity.at(-1), false);
  h.tick(LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS);
  assert.deepEqual(h.results, []);
});

test("cancelling a new capture keeps activity while the previous utterance is still processing", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2);
  h.cancel(2);
  assert.deepEqual(h.activity, [true]);
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true });
  assert.deepEqual(h.activity, [true, false]);
  assert.deepEqual(h.results, [false]);
});

test("keeps processing feedback continuous when a result arrives during another capture", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2);
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true, command: "pause" });
  assert.deepEqual(h.activity, [true]);
  h.finish(2);
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: true });
  assert.deepEqual(h.activity, [true, false]);
  assert.deepEqual(h.results, [true, false]);
});

test("drains a waiting retry even if a recognition feedback callback throws", (t) => {
  const h = controllerHarness(t, { onRecognitionResult: () => { throw new Error("Feedback failed"); } });
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2); h.finish(2);
  assert.throws(() => worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true }), /Feedback failed/);
  assert.equal(worker.audio.length, 2);
  assert.deepEqual(h.activity, [true]);
});

test("replaces a repeatedly failing native worker and preserves the microphone and pending retry", (t) => {
  const h = controllerHarness(t);
  let audioClosed = 0;
  let portClosed = 0;
  const audioContext = { state: "running", close: async () => { audioClosed += 1; } };
  const captureNode = { port: { close: () => { portClosed += 1; } }, disconnect() {} };
  const state = h.controller as unknown as { audioContext: unknown; captureNode: unknown };
  state.audioContext = audioContext;
  state.captureNode = captureNode;
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2); h.finish(2);
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: false });
  assert.equal(worker.audio.length, 2);
  assert.equal(h.workers.length, 1);
  h.start(3); h.finish(3);
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: false });
  assert.equal(worker.terminated, true);
  assert.equal(h.workers.length, 2);
  assert.equal(audioClosed, 0);
  assert.equal(portClosed, 0);
  assert.equal(state.audioContext, audioContext);
  assert.equal(state.captureNode, captureNode);
  const replacement = h.workers[1]!;
  assert.deepEqual(replacement.messages, [{ type: "initialise" }]);
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: false });
  worker.crash();
  replacement.emit({ type: "status", status: "ready" });
  assert.equal((replacement.audio[0]!.samples as Float32Array)[0], 3);
  replacement.emit({ type: "result", requestId: replacement.audio[0]!.requestId, successful: false });
  assert.equal(h.workers.length, 2);
  h.start(4); h.finish(4);
  replacement.emit({ type: "result", requestId: replacement.audio[1]!.requestId, successful: true, command: "pause" });
  assert.deepEqual(h.commands, [{ command: "pause", context: undefined }]);
  assert.deepEqual(h.statuses, ["ready", "loading", "ready"]);
  h.tick(LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS);
  assert.equal(h.workers.length, 2);
});

test("ordinary misses reset native failure recovery and foreign result IDs do not affect it", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  const firstId = worker.audio[0]!.requestId;
  worker.emit({ type: "result", requestId: firstId, successful: false });
  worker.emit({ type: "result", requestId: firstId, successful: false });
  worker.emit({ type: "result", requestId: 999, successful: false });
  assert.equal(h.workers.length, 1);
  h.start(2); h.finish(2);
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: true });
  h.start(3); h.finish(3);
  worker.emit({ type: "result", requestId: worker.audio[2]!.requestId, successful: false });
  assert.equal(h.workers.length, 1);
  worker.emit({ type: "result", requestId: firstId, successful: true });
  worker.emit({ type: "result", requestId: 999, successful: true });
  h.start(4); h.finish(4);
  worker.emit({ type: "result", requestId: worker.audio[3]!.requestId, successful: false });
  assert.equal(h.workers.length, 2);
  assert.equal(h.successes(), 1);
});

test("drops speech when context changes before dispatch or before the result", (t) => {
  let context = "task-a";
  const h = controllerHarness(t, { getContext: () => context });
  const worker = h.workers[0]!;
  h.start(1);
  context = "task-b";
  h.finish(1);
  worker.emit({ type: "status", status: "ready" });
  assert.equal(worker.audio.length, 0);
  h.start(2); h.finish(2);
  context = "task-c";
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true, command: "next" });
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.results, []);
  h.start(3); h.finish(3);
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: true, command: "next" });
  assert.deepEqual(h.commands, [{ command: "next", context: "task-c" }]);
  assert.deepEqual(h.results, [true]);
});

test("does not apply expired results or dispatch expired pending speech", (t) => {
  const h = controllerHarness(t);
  const worker = h.workers[0]!;
  worker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.start(2); h.finish(2);
  h.tick(LOCAL_VOICE_COMMAND_MAX_AGE_MS);
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true, command: "next" });
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.results, []);
  assert.equal(worker.audio.length, 1);
  h.tick(LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS);
  assert.equal(h.workers.length, 1);
});

test("allows exit across task changes but keeps other commands and their feedback bound to the captured task", (t) => {
  let context = "task-a";
  const h = controllerHarness(t, { getContext: () => context, getExitContext: () => "session:1:active" });
  const worker = h.workers[0]!;
  h.start(1);
  context = "task-b";
  h.finish(1);
  worker.emit({ type: "status", status: "ready" });
  assert.equal(worker.audio.length, 1);
  context = "task-c";
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true, command: "exit" });
  assert.deepEqual(h.commands, [{ command: "exit", context: "session:1:active" }]);
  assert.deepEqual(h.results, [true]);
  h.start(2); h.finish(2);
  context = "task-d";
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: true, command: "next" });
  assert.equal(h.commands.length, 1);
  assert.deepEqual(h.results, [true]);
  assert.equal(h.successes(), 2);
});

test("drops speech and exit results from an earlier XR presentation", (t) => {
  let exitContext = "session:1:active";
  const h = controllerHarness(t, { getContext: () => "task-a", getExitContext: () => exitContext });
  const worker = h.workers[0]!;
  h.start(1); h.finish(1);
  exitContext = "session:2:active";
  worker.emit({ type: "status", status: "ready" });
  assert.equal(worker.audio.length, 0);
  assert.deepEqual(h.activity, [true, false]);
  h.start(2); h.finish(2);
  exitContext = "session:2:inactive";
  worker.emit({ type: "result", requestId: worker.audio[0]!.requestId, successful: true, command: "exit" });
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.results, []);
  h.start(3); h.finish(3);
  exitContext = "session:3:active";
  worker.emit({ type: "result", requestId: worker.audio[1]!.requestId, successful: true, command: "next" });
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.results, []);
});

test("replaces stalled inference without closing the microphone and ignores old results", (t) => {
  const h = controllerHarness(t);
  let audioClosed = 0;
  let portClosed = 0;
  const audioContext = { state: "running", close: async () => { audioClosed += 1; } };
  const captureNode = { port: { close: () => { portClosed += 1; } }, disconnect() {} };
  const state = h.controller as unknown as { audioContext: unknown; captureNode: unknown };
  state.audioContext = audioContext;
  state.captureNode = captureNode;
  const oldWorker = h.workers[0]!;
  oldWorker.emit({ type: "status", status: "ready" });
  h.start(1); h.finish(1);
  h.tick(LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS - 500);
  h.start(2); h.finish(2);
  h.tick(500);
  assert.equal(oldWorker.terminated, true);
  assert.equal(h.workers.length, 2);
  assert.equal(audioClosed, 0);
  assert.equal(portClosed, 0);
  assert.equal(state.audioContext, audioContext);
  assert.equal(state.captureNode, captureNode);
  assert.deepEqual(h.activity, [true]);
  const replacement = h.workers[1]!;
  assert.deepEqual(replacement.messages, [{ type: "initialise" }]);
  oldWorker.emit({ type: "result", requestId: oldWorker.audio[0]!.requestId, successful: true, command: "stop" });
  oldWorker.emit({ type: "status", status: "ready" });
  oldWorker.crash();
  assert.equal(replacement.audio.length, 0);
  replacement.emit({ type: "status", status: "ready" });
  assert.equal(replacement.audio.length, 1);
  assert.equal((replacement.audio[0]!.samples as Float32Array)[0], 2);
  replacement.emit({ type: "result", requestId: replacement.audio[0]!.requestId, successful: true, command: "pause" });
  assert.deepEqual(h.commands, [{ command: "pause", context: undefined }]);
  assert.deepEqual(h.results, [true]);
  assert.deepEqual(h.activity, [true, false]);
  assert.deepEqual(h.statuses, ["ready", "loading", "ready"]);
  h.controller.dispose();
  assert.equal(audioClosed, 1);
  assert.equal(portClosed, 1);
});
