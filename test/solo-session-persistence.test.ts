import assert from "node:assert/strict";
import test from "node:test";

import {
  RecorderBlockFlags,
  SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
  encodeRecorderBlock,
} from "../shared/protocol.js";
import {
  SOLO_RECORDER_BATCH_DELAY_MS,
  type MonitorRecorderEvent,
} from "../src/recorder/monitor-recorder.js";
import {
  SOLO_ACTIVE_SESSION_STORAGE_KEY,
  SoloSessionPersistence,
  checkSoloStorageHeadroom,
  resolveSoloSessionId,
  soloSessionUrl,
} from "../src/solo-session-persistence.js";

class FakeWorker {
  readonly messages: unknown[] = [];
  terminateCalls = 0;
  private readonly messageListeners: Array<(event: MessageEvent<MonitorRecorderEvent>) => void> = [];
  private readonly errorListeners: Array<(event: ErrorEvent) => void> = [];

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function"
      ? listener
      : (event: Event) => listener.handleEvent(event);
    if (type === "message") {
      this.messageListeners.push(callback as (event: MessageEvent<MonitorRecorderEvent>) => void);
    }
    if (type === "error") this.errorListeners.push(callback as (event: ErrorEvent) => void);
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
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
}

test("reports authoritative Solo storage headroom against the shared threshold", async () => {
  const availableBytes = SOLO_MINIMUM_STORAGE_HEADROOM_BYTES + 256 * 1024 * 1024;
  const ready = await checkSoloStorageHeadroom({
    estimate: async () => ({
      quota: availableBytes + 128 * 1024 * 1024,
      usage: 128 * 1024 * 1024,
    }),
  }, () => 12_345);

  assert.deepEqual(ready, {
    state: "ready",
    availableBytes,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs: 12_345,
    detail: "768 MiB is available for Solo capture",
  });

  const blocked = await checkSoloStorageHeadroom({
    estimate: async () => ({
      quota: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
      usage: 1,
    }),
  }, () => 12_346);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.availableBytes, SOLO_MINIMUM_STORAGE_HEADROOM_BYTES - 1);
  assert.match(blocked.detail, /requires at least 512 MiB/);
});

test("fails closed when the browser storage estimate is unavailable or invalid", async () => {
  const unavailable = await checkSoloStorageHeadroom(null, () => 20_000);
  assert.deepEqual(unavailable, {
    state: "blocked",
    availableBytes: null,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs: 20_000,
    detail: "Storage estimate is unavailable",
  });

  const invalid = await checkSoloStorageHeadroom({
    estimate: async () => ({ quota: undefined, usage: 0 }),
  }, () => 20_001);
  assert.equal(invalid.state, "blocked");
  assert.match(invalid.detail, /valid quota and usage/);

  const failed = await checkSoloStorageHeadroom({
    estimate: async () => {
      throw new Error("estimate denied");
    },
  }, () => 20_002);
  assert.equal(failed.state, "blocked");
  assert.match(failed.detail, /estimate denied/);
});

test("uses a distinct Solo storage key and keeps the active session in the URL", () => {
  const storage = memoryStorage();
  assert.equal(
    resolveSoloSessionId("?session=solo_url_session", storage),
    "solo_url_session",
  );
  assert.equal(
    storage.getItem(SOLO_ACTIVE_SESSION_STORAGE_KEY),
    "solo_url_session",
  );
  assert.equal(resolveSoloSessionId("", storage), "solo_url_session");
  assert.equal(
    soloSessionUrl(
      "solo_url_session",
      "https://ceres.test/launch/capture/?mode=solo&account=return",
    ).href,
    "https://ceres.test/launch/capture/?mode=solo&account=return&session=solo_url_session",
  );
});

test("uses the capture recorder identity rules for Solo session URLs", () => {
  const storage = memoryStorage();
  assert.equal(resolveSoloSessionId(
    "?session=-invalid_solo_session",
    storage,
    () => "solo_generated_session",
  ), "solo_generated_session");
  assert.throws(
    () => soloSessionUrl(
      "_invalid_solo_session",
      "https://ceres.test/launch/capture/?mode=solo",
    ),
    /identifier is invalid/,
  );
});

test("opens the distinct Solo OPFS root and returns durable ready state explicitly", async () => {
  const worker = new FakeWorker();
  const controls: unknown[] = [];
  const persistence = new SoloSessionPersistence({
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  persistence.setRecorderControlSink((message) => controls.push(message));

  const opening = persistence.open("solo_storage_session");
  await Promise.resolve();
  assert.deepEqual(worker.messages[0], {
    type: "open",
    sessionId: "solo_storage_session",
    storageRootName: "ceres-solo-recordings",
  });
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_storage_session",
    nextSequence: 4,
  });
  assert.deepEqual(await opening, { snapshot: null, nextSequence: 4 });
  assert.deepEqual(controls, []);
  assert.throws(
    () => persistence.sendRecorderReady(5),
    /exceeds the durable journal/,
  );

  persistence.sendRecorderReady(4);
  assert.deepEqual(controls, [{
    type: "recorder-ready",
    sessionId: "solo_storage_session",
    nextSequence: 4,
  }]);

  const closing = persistence.close();
  worker.emitMessage({ type: "closed", sessionId: "solo_storage_session" });
  await closing;
});

test("rejects a stalled finalisation summary instead of leaving Solo pending", async () => {
  const worker = new FakeWorker();
  const persistence = new SoloSessionPersistence({
    summaryTimeoutMs: 5,
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  const opening = persistence.open("solo_summary_timeout");
  await Promise.resolve();
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_summary_timeout",
    nextSequence: 0,
  });
  await opening;

  await assert.rejects(
    persistence.summarise("solo_episode_timeout"),
    /finalisation timed out/,
  );
  assert.deepEqual(worker.messages.at(-1), {
    type: "summarise",
    episodeId: "solo_episode_timeout",
  });
});

test("holds one exclusive Solo session lease until durable persistence closes", async () => {
  const activeSessions = new Set<string>();
  const acquireSessionLease = async (sessionId: string) => {
    if (activeSessions.has(sessionId)) {
      throw new Error("This Solo session is already active in another tab");
    }
    activeSessions.add(sessionId);
    return async () => {
      activeSessions.delete(sessionId);
    };
  };
  const firstWorker = new FakeWorker();
  const first = new SoloSessionPersistence({
    acquireSessionLease,
    monitorRecorderOptions: { worker: firstWorker as unknown as Worker },
  });
  const firstOpening = first.open("solo_exclusive_session");
  await Promise.resolve();
  firstWorker.emitMessage({
    type: "ready",
    sessionId: "solo_exclusive_session",
    nextSequence: 0,
  });
  await firstOpening;
  assert.deepEqual([...activeSessions], ["solo_exclusive_session"]);

  const secondWorker = new FakeWorker();
  const second = new SoloSessionPersistence({
    acquireSessionLease,
    monitorRecorderOptions: { worker: secondWorker as unknown as Worker },
  });
  await assert.rejects(
    second.open("solo_exclusive_session"),
    /already active in another tab/,
  );
  assert.deepEqual(secondWorker.messages, []);

  const closing = first.close();
  firstWorker.emitMessage({ type: "closed", sessionId: "solo_exclusive_session" });
  await closing;
  assert.deepEqual([...activeSessions], []);
});

test("returns a recorder acknowledgement only after the monitor worker durable commit", async () => {
  const worker = new FakeWorker();
  const controls: unknown[] = [];
  const persistence = new SoloSessionPersistence({
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  persistence.setRecorderControlSink((message) => controls.push(message));
  const opening = persistence.open("solo_loopback_session");
  await Promise.resolve();
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_loopback_session",
    nextSequence: 0,
  });
  await opening;
  persistence.sendRecorderReady(0);
  controls.length = 0;

  const encoded = encodeRecorderBlock({
    sessionId: "solo_loopback_session",
    episodeId: "solo_episode_0001",
    sequence: 0,
    recorderFrameIndex: 12,
    sourceTimestampUs: 3_000_000,
    flags: RecorderBlockFlags.SensorFrameJson,
    payload: new Uint8Array([1, 2, 3]),
  });
  assert.equal(
    persistence.appendRecorderBlock(0, encoded.buffer as ArrayBuffer),
    true,
  );
  assert.equal(controls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, SOLO_RECORDER_BATCH_DELAY_MS + 25));
  assert.equal(
    (worker.messages.at(-1) as { type?: string }).type,
    "blocks",
  );
  assert.equal(
    (worker.messages.at(-1) as { blocks?: ArrayBuffer[] }).blocks?.length,
    1,
  );

  worker.emitMessage({
    type: "ack",
    sessionId: "solo_loopback_session",
    sequence: 0,
    status: "stored",
  });
  assert.deepEqual(controls, [{
    type: "recorder-ack",
    sessionId: "solo_loopback_session",
    episodeId: "solo_episode_0001",
    sequence: 0,
    recorderFrameIndex: 12,
    status: "durable",
  }]);
  controls.length = 0;
  persistence.sendRecorderReady(0);
  assert.deepEqual(controls, [{
    type: "recorder-ready",
    sessionId: "solo_loopback_session",
    nextSequence: 1,
  }]);

  const closing = persistence.close();
  worker.emitMessage({ type: "closed", sessionId: "solo_loopback_session" });
  await closing;
});

test("coalesces an identical retransmission while its durable acknowledgement is pending", async () => {
  const worker = new FakeWorker();
  const controls: unknown[] = [];
  const persistence = new SoloSessionPersistence({
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  persistence.setRecorderControlSink((message) => controls.push(message));
  const opening = persistence.open("solo_retry_session");
  await Promise.resolve();
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_retry_session",
    nextSequence: 0,
  });
  await opening;

  const encoded = encodeRecorderBlock({
    sessionId: "solo_retry_session",
    episodeId: "solo_episode_retry",
    sequence: 0,
    recorderFrameIndex: 3,
    sourceTimestampUs: 900_000,
    flags: RecorderBlockFlags.Gap,
    payload: new Uint8Array(),
  });
  const first = encoded.buffer.slice(0) as ArrayBuffer;
  const retransmission = encoded.buffer.slice(0) as ArrayBuffer;
  assert.equal(persistence.appendRecorderBlock(0, first), true);
  assert.equal(persistence.appendRecorderBlock(0, retransmission), true);
  await new Promise((resolve) => setTimeout(resolve, SOLO_RECORDER_BATCH_DELAY_MS + 25));
  assert.equal(
    worker.messages.filter((message) => (message as { type?: string }).type === "blocks").length,
    1,
  );

  worker.emitMessage({
    type: "ack",
    sessionId: "solo_retry_session",
    sequence: 0,
    status: "stored",
  });
  assert.deepEqual(controls, [{
    type: "recorder-ack",
    sessionId: "solo_retry_session",
    episodeId: "solo_episode_retry",
    sequence: 0,
    recorderFrameIndex: 3,
    status: "durable",
  }]);

  const closing = persistence.close();
  worker.emitMessage({ type: "closed", sessionId: "solo_retry_session" });
  await closing;
});

test("drains an in-flight block acknowledgement during graceful close", async () => {
  const worker = new FakeWorker();
  const controls: unknown[] = [];
  const persistence = new SoloSessionPersistence({
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  persistence.setRecorderControlSink((message) => controls.push(message));
  const opening = persistence.open("solo_close_session");
  await Promise.resolve();
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_close_session",
    nextSequence: 0,
  });
  await opening;
  const encoded = encodeRecorderBlock({
    sessionId: "solo_close_session",
    episodeId: "solo_episode_close",
    sequence: 0,
    recorderFrameIndex: 6,
    sourceTimestampUs: 1_100_000,
    flags: RecorderBlockFlags.Gap,
    payload: new Uint8Array(),
  });
  assert.equal(persistence.appendRecorderBlock(0, encoded.buffer as ArrayBuffer), true);

  const closing = persistence.close();
  worker.emitMessage({
    type: "ack",
    sessionId: "solo_close_session",
    sequence: 0,
    status: "stored",
  });
  worker.emitMessage({ type: "closed", sessionId: "solo_close_session" });
  await closing;

  assert.deepEqual(controls, [{
    type: "recorder-ack",
    sessionId: "solo_close_session",
    episodeId: "solo_episode_close",
    sequence: 0,
    recorderFrameIndex: 6,
    status: "durable",
  }]);
});

test("fails closed on a conflicting in-flight recorder retransmission", async () => {
  const worker = new FakeWorker();
  const controls: unknown[] = [];
  const persistence = new SoloSessionPersistence({
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  persistence.setRecorderControlSink((message) => controls.push(message));
  const opening = persistence.open("solo_conflict_session");
  await Promise.resolve();
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_conflict_session",
    nextSequence: 0,
  });
  await opening;

  const block = (payload: number) => encodeRecorderBlock({
    sessionId: "solo_conflict_session",
    episodeId: "solo_episode_conflict",
    sequence: 0,
    recorderFrameIndex: 4,
    sourceTimestampUs: 1_000_000,
    flags: RecorderBlockFlags.SensorFrameJson,
    payload: new Uint8Array([payload]),
  }).buffer as ArrayBuffer;
  assert.equal(persistence.appendRecorderBlock(0, block(1)), true);
  assert.equal(persistence.appendRecorderBlock(0, block(2)), false);
  assert.deepEqual(controls, [{
    type: "recorder-error",
    fatal: true,
    code: "write-failed",
    message: "Solo recorder received a conflicting retransmission for sequence 0",
  }]);

  const closing = persistence.close();
  worker.emitMessage({ type: "closed", sessionId: "solo_conflict_session" });
  await closing;
});

test("fails closed when the worker reports an OPFS commit error", async () => {
  const worker = new FakeWorker();
  const controls: unknown[] = [];
  const persistence = new SoloSessionPersistence({
    monitorRecorderOptions: { worker: worker as unknown as Worker },
  });
  persistence.setRecorderControlSink((message) => controls.push(message));
  const opening = persistence.open("solo_failure_session");
  await Promise.resolve();
  worker.emitMessage({
    type: "ready",
    sessionId: "solo_failure_session",
    nextSequence: 0,
  });
  await opening;
  persistence.sendRecorderReady(0);
  controls.length = 0;

  worker.emitMessage({
    type: "error",
    sessionId: "solo_failure_session",
    message: "OPFS commit read-back failed",
  });

  assert.deepEqual(controls, [{
    type: "recorder-error",
    fatal: true,
    code: "write-failed",
    message: "OPFS commit read-back failed",
  }]);
  assert.equal(
    persistence.appendRecorderBlock(0, new ArrayBuffer(8)),
    false,
  );

  const closing = persistence.close();
  worker.emitMessage({ type: "closed", sessionId: "solo_failure_session" });
  await closing;
});
