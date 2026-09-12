import assert from "node:assert/strict";
import test from "node:test";

import { DirectSessionReducer } from "../src/direct-session-reducer.js";
import {
  MonitorRecorder,
  MonitorRecorderFailureLatch,
  shouldFlushSoloRecorderBatch,
  SOLO_RECORDER_BATCH_MAX_BYTES,
  SOLO_RECORDER_BATCH_SIZE,
  SOLO_RECORDER_STORAGE_ROOT,
  type MonitorRecorderEvent,
} from "../src/recorder/monitor-recorder.js";
import { MonitorRecordingSummaryAccumulator } from "../src/recorder/monitor-recording-summary.js";

class FakeWorker {
  readonly messages: unknown[] = [];
  terminateCalls = 0;
  private readonly messageListeners: Array<(event: MessageEvent<MonitorRecorderEvent>) => void> = [];
  private readonly errorListeners: Array<(event: ErrorEvent) => void> = [];
  private readonly messageErrorListeners: Array<(event: MessageEvent<unknown>) => void> = [];

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    if (type === "message") this.messageListeners.push(callback as (event: MessageEvent<MonitorRecorderEvent>) => void);
    if (type === "error") this.errorListeners.push(callback as (event: ErrorEvent) => void);
    if (type === "messageerror") this.messageErrorListeners.push(callback as (event: MessageEvent<unknown>) => void);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  terminate() {
    this.terminateCalls += 1;
  }

  emitMessage(message: MonitorRecorderEvent) {
    const event = { data: message } as MessageEvent<MonitorRecorderEvent>;
    for (const listener of this.messageListeners) listener(event);
  }

  emitMessageError() {
    const event = { data: { session: "session_secretvalue123" } } as MessageEvent<unknown>;
    for (const listener of this.messageErrorListeners) listener(event);
  }
}

test("waits for the worker to finish queued writes before completing shutdown", async () => {
  const worker = new FakeWorker();
  const events: MonitorRecorderEvent[] = [];
  const recorder = new MonitorRecorder((event) => events.push(event), {
    worker: worker as unknown as Worker,
    closeTimeoutMs: 100,
  });

  recorder.open("session_12345678");
  recorder.append(new ArrayBuffer(4));
  const closing = recorder.close();
  let settled = false;
  void closing.then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(worker.terminateCalls, 0);
  assert.deepEqual(worker.messages.map((message) => (message as { type: string }).type), ["open", "block", "close"]);

  worker.emitMessage({ type: "closed", sessionId: "session_12345678" });
  await closing;
  assert.equal(settled, true);
  assert.equal(worker.terminateCalls, 0);
  assert.equal(events.at(-1)?.type, "closed");
  assert.equal(recorder.close(), closing);

  recorder.append(new ArrayBuffer(4));
  assert.equal(worker.messages.length, 3);
});

test("bounds shutdown when the worker does not acknowledge close", async () => {
  const worker = new FakeWorker();
  const events: MonitorRecorderEvent[] = [];
  const recorder = new MonitorRecorder((event) => events.push(event), {
    worker: worker as unknown as Worker,
    closeTimeoutMs: 5,
  });

  await recorder.close();

  assert.equal(worker.terminateCalls, 1);
  assert.match(events.at(-1)?.message ?? "", /shutdown timed out/i);
});

test("coalesces Solo blocks into bounded ordered batches and flushes the tail before close", async () => {
  const worker = new FakeWorker();
  const recorder = new MonitorRecorder(() => undefined, {
    worker: worker as unknown as Worker,
    closeTimeoutMs: 100,
    storageRootName: SOLO_RECORDER_STORAGE_ROOT,
  });

  recorder.open("solo_batch_session");
  for (let sequence = 0; sequence < SOLO_RECORDER_BATCH_SIZE; sequence += 1) {
    assert.equal(recorder.append(Uint8Array.of(sequence).buffer), true);
  }

  assert.deepEqual(
    worker.messages.map((message) => (message as { type: string }).type),
    ["open", "blocks"],
  );
  const fullBatch = worker.messages[1] as { type: "blocks"; blocks: ArrayBuffer[] };
  assert.equal(fullBatch.blocks.length, SOLO_RECORDER_BATCH_SIZE);
  assert.deepEqual(
    fullBatch.blocks.map((block) => new Uint8Array(block)[0]),
    Array.from({ length: SOLO_RECORDER_BATCH_SIZE }, (_value, sequence) => sequence),
  );

  assert.equal(recorder.append(Uint8Array.of(SOLO_RECORDER_BATCH_SIZE).buffer), true);
  assert.equal(recorder.append(Uint8Array.of(SOLO_RECORDER_BATCH_SIZE + 1).buffer), true);
  const closing = recorder.close();
  assert.deepEqual(
    worker.messages.map((message) => (message as { type: string }).type),
    ["open", "blocks", "blocks", "close"],
  );
  const tailBatch = worker.messages[2] as { type: "blocks"; blocks: ArrayBuffer[] };
  assert.deepEqual(
    tailBatch.blocks.map((block) => new Uint8Array(block)[0]),
    [SOLO_RECORDER_BATCH_SIZE, SOLO_RECORDER_BATCH_SIZE + 1],
  );

  worker.emitMessage({ type: "closed", sessionId: "solo_batch_session" });
  await closing;
});

test("flushes Solo batches at each count and byte bound", () => {
  assert.equal(shouldFlushSoloRecorderBatch(SOLO_RECORDER_BATCH_SIZE - 1, 1), false);
  assert.equal(shouldFlushSoloRecorderBatch(SOLO_RECORDER_BATCH_SIZE, 1), true);
  assert.equal(shouldFlushSoloRecorderBatch(1, SOLO_RECORDER_BATCH_MAX_BYTES - 1), false);
  assert.equal(shouldFlushSoloRecorderBatch(1, SOLO_RECORDER_BATCH_MAX_BYTES), true);
});

test("flushes a partial Solo batch when its deadline expires", async () => {
  const worker = new FakeWorker();
  const recorder = new MonitorRecorder(() => undefined, {
    worker: worker as unknown as Worker,
    closeTimeoutMs: 100,
    storageRootName: SOLO_RECORDER_STORAGE_ROOT,
    soloBatchDelayMs: 5,
  });

  recorder.open("solo_deadline_session");
  assert.equal(recorder.append(Uint8Array.of(7).buffer), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(
    worker.messages.map((message) => (message as { type: string }).type),
    ["open", "blocks"],
  );

  const closing = recorder.close();
  worker.emitMessage({ type: "closed", sessionId: "solo_deadline_session" });
  await closing;
});

test("retains a recorder failure for a later control channel", () => {
  const failure = new MonitorRecorderFailureLatch();

  assert.equal(failure.current, null);
  assert.equal(failure.controlMessage, null);
  assert.equal(failure.remember("OPFS write failed"), "OPFS write failed");
  assert.equal(failure.current, "OPFS write failed");
  assert.deepEqual(failure.controlMessage, { type: "recorder-error", message: "OPFS write failed" });
  assert.equal(failure.remember("  "), "Monitor recorder failed");
  assert.equal(failure.current, "Monitor recorder failed");
  assert.deepEqual(failure.controlMessage, { type: "recorder-error", message: "Monitor recorder failed" });
});

test("correlates a snapshot save with its durable worker acknowledgement", async () => {
  const worker = new FakeWorker();
  const recorder = new MonitorRecorder(() => undefined, { worker: worker as unknown as Worker });
  const snapshot = new DirectSessionReducer("snapshot_ack_session").snapshot;
  recorder.open(snapshot.sessionId);

  const saving = recorder.saveSnapshot(snapshot);
  let settled = false;
  void saving.then(() => { settled = true; });
  const request = worker.messages.at(-1) as { type: string; snapshotRequestId: number };
  assert.equal(request.type, "save-snapshot");
  assert.equal(Number.isSafeInteger(request.snapshotRequestId), true);

  worker.emitMessage({
    type: "snapshot-saved",
    sessionId: snapshot.sessionId,
    snapshotRequestId: request.snapshotRequestId + 1,
    snapshotGeneration: 1,
  });
  await Promise.resolve();
  assert.equal(settled, false);

  worker.emitMessage({
    type: "snapshot-saved",
    sessionId: snapshot.sessionId,
    snapshotRequestId: request.snapshotRequestId,
    snapshotGeneration: 1,
  });
  await saving;
  assert.equal(settled, true);
});

test("rejects only the snapshot request named by a persistence error", async () => {
  const worker = new FakeWorker();
  const recorder = new MonitorRecorder(() => undefined, { worker: worker as unknown as Worker });
  const snapshot = new DirectSessionReducer("snapshot_error_session").snapshot;
  recorder.open(snapshot.sessionId);

  const first = recorder.saveSnapshot(snapshot);
  const second = recorder.saveSnapshot(snapshot);
  const requests = worker.messages.slice(-2) as Array<{ snapshotRequestId: number }>;
  worker.emitMessage({
    type: "error",
    sessionId: snapshot.sessionId,
    snapshotRequestId: requests[0]!.snapshotRequestId,
    message: "OPFS snapshot flush failed",
  });
  await assert.rejects(first, /OPFS snapshot flush failed/);

  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  worker.emitMessage({
    type: "snapshot-saved",
    sessionId: snapshot.sessionId,
    snapshotRequestId: requests[1]!.snapshotRequestId,
    snapshotGeneration: 1,
  });
  await second;
});

test("rejects pending snapshots immediately after an unreadable worker response", async () => {
  const worker = new FakeWorker();
  const events: MonitorRecorderEvent[] = [];
  try {
    const recorder = new MonitorRecorder((event) => events.push(event), {
      worker: worker as unknown as Worker,
    });
    const snapshot = new DirectSessionReducer("snapshot_message_error_session").snapshot;
    recorder.open(snapshot.sessionId);
    worker.emitMessage({ type: "ready", sessionId: snapshot.sessionId });
    assert.equal(recorder.isReady, true);

    const saving = recorder.saveSnapshot(snapshot);
    worker.emitMessageError();

    await assert.rejects(saving, /unreadable response/);
    assert.equal(recorder.isReady, false);
    assert.match(events.at(-1)?.message ?? "", /unreadable response/);
  } finally {
  }
});

test("attributes recorder slots to the open task segment", () => {
  const summary = new MonitorRecordingSummaryAccumulator();
  const firstSegmentId = "episode-segment-1";
  const secondSegmentId = "episode-segment-2";

  summary.recordSequence(4);
  summary.recordRunEvent(4, 1_000_000, {
    type: "segment-start",
    segmentId: firstSegmentId,
    taskId: "task-001",
    taskLabel: "First task",
  });
  summary.recordSequence(5);
  summary.recordSensorFrame();
  summary.recordSequence(6);
  summary.recordGap();
  summary.recordSequence(7);
  summary.recordRunEvent(7, 1_300_000, {
    type: "annotation",
    segmentId: firstSegmentId,
    annotationId: "annotation-0001",
    action: "pass",
    actor: "director",
  });
  summary.recordSequence(8);
  summary.recordRunEvent(8, 1_400_000, {
    type: "segment-end",
    segmentId: firstSegmentId,
    taskId: "task-001",
    taskLabel: "First task",
  });
  summary.recordSequence(9);
  summary.recordSensorFrame();
  summary.recordSequence(10);
  summary.recordRunEvent(10, 1_600_000, {
    type: "segment-start",
    segmentId: secondSegmentId,
    taskId: "task-002",
    taskLabel: "Second task",
  });
  summary.recordSequence(11);
  summary.recordGap();
  summary.recordSequence(12);
  summary.recordRunEvent(12, 1_800_000, {
    type: "segment-end",
    segmentId: secondSegmentId,
    taskId: "task-002",
    taskLabel: "Second task",
  });

  assert.equal(summary.summary.frameCount, 2);
  assert.equal(summary.summary.gapCount, 2);
  assert.equal(summary.summary.recorderSlotCount, 4);
  assert.equal(summary.summary.firstRecorderSequence, 4);
  assert.equal(summary.summary.lastRecorderSequence, 12);
  assert.deepEqual(summary.summary.segmentSummaries?.[firstSegmentId], {
    frameCount: 1,
    gapCount: 1,
    recorderSlotCount: 2,
  });
  assert.deepEqual(summary.summary.segmentSummaries?.[secondSegmentId], {
    frameCount: 0,
    gapCount: 1,
    recorderSlotCount: 1,
  });
  assert.equal(summary.summary.runEvents?.length, 5);
});
