import assert from "node:assert/strict";
import test from "node:test";

import { defaultCaptureStatus, nextRunControlCursor, type SessionSnapshot } from "../shared/protocol.js";
import { DirectSessionReducer, type DirectCaptureCommand } from "../src/direct-session-reducer.js";
import { MonitorApp } from "../src/monitor-app.js";
import { MonitorRecorder, MonitorRecorderFailureLatch, type MonitorRecorderEvent } from "../src/recorder/monitor-recorder.js";

class FakeWorker {
  readonly messages: unknown[] = [];
  private readonly messageListeners: Array<(event: MessageEvent<MonitorRecorderEvent>) => void> = [];

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== "message") return;
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.messageListeners.push(callback as (event: MessageEvent<MonitorRecorderEvent>) => void);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  terminate() {}

  emitMessage(message: MonitorRecorderEvent) {
    const event = { data: message } as MessageEvent<MonitorRecorderEvent>;
    for (const listener of this.messageListeners) listener(event);
  }
}

interface CommitHarness {
  commitDirectCommands(root: HTMLElement, commands: DirectCaptureCommand[]): Promise<void>;
  commitDirectFinalisation(
    root: HTMLElement,
    episodeId: string,
    summary: {
      frameCount: number;
      gapCount: number;
      mediaChunkCount: number;
      recorderSlotCount: number;
      firstRecorderSequence: number | null;
      lastRecorderSequence: number | null;
      segmentSummaries: Record<string, { frameCount: number; gapCount: number; recorderSlotCount: number }>;
    },
    error?: string,
  ): Promise<void>;
}

test("does not send a direct command before the matching snapshot acknowledgement", async () => {
  const harness = directCommitHarness("direct_commit_ack");
  const committing = harness.app.commitDirectCommands({} as HTMLElement, harness.commands);
  let settled = false;
  void committing.then(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(harness.sent, []);
  assert.equal(settled, false);

  const request = snapshotRequest(harness.worker);
  harness.worker.emitMessage({
    type: "snapshot-saved",
    sessionId: harness.snapshot.sessionId,
    snapshotRequestId: request.snapshotRequestId,
    snapshotGeneration: 1,
  });
  await committing;

  assert.equal(settled, true);
  assert.deepEqual(harness.sent, harness.commands.map((command) => JSON.stringify(command)));
});

test("does not send a direct command when snapshot persistence fails", async () => {
  const harness = directCommitHarness("direct_commit_error");
  const committing = harness.app.commitDirectCommands({} as HTMLElement, harness.commands);
  const request = snapshotRequest(harness.worker);
  harness.worker.emitMessage({
    type: "error",
    sessionId: harness.snapshot.sessionId,
    snapshotRequestId: request.snapshotRequestId,
    message: "Monitor snapshot durability check failed",
  });

  await assert.rejects(committing, /Monitor snapshot durability check failed/);
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.failure.current, "Monitor snapshot durability check failed");
});

test("publishes a finalised episode only after its exact snapshot is durable", async () => {
  const harness = directFinalisationHarness("direct_finalisation_ack");
  const committing = harness.app.commitDirectFinalisation(
    {} as HTMLElement,
    harness.episodeId,
    harness.summary,
  );
  await Promise.resolve();

  const request = snapshotRequest(harness.worker);
  assert.equal(request.snapshot.episodes[0]?.id, harness.episodeId);
  assert.deepEqual(harness.rendered, []);
  assert.deepEqual(harness.sent, []);

  harness.worker.emitMessage({
    type: "snapshot-saved",
    sessionId: harness.snapshot.sessionId,
    snapshotRequestId: request.snapshotRequestId,
    snapshotGeneration: 1,
  });
  await committing;

  assert.equal(harness.rendered.at(-1)?.episodes[0]?.id, harness.episodeId);
  assert.deepEqual(
    harness.sent.map((message) => (JSON.parse(message) as { action?: string }).action),
    ["recording-stopped", undefined],
  );
});

test("restores the stopping snapshot when finalisation persistence fails", async () => {
  const harness = directFinalisationHarness("direct_finalisation_error");
  const committing = harness.app.commitDirectFinalisation(
    {} as HTMLElement,
    harness.episodeId,
    harness.summary,
  );
  const request = snapshotRequest(harness.worker);
  harness.worker.emitMessage({
    type: "error",
    sessionId: harness.snapshot.sessionId,
    snapshotRequestId: request.snapshotRequestId,
    message: "Final catalogue durability check failed",
  });

  await assert.rejects(committing, /Final catalogue durability check failed/);
  assert.equal(harness.reducer.snapshot.run.recordingState, "stopping");
  assert.equal(harness.reducer.snapshot.currentEpisode?.id, harness.episodeId);
  assert.equal(harness.reducer.snapshot.episodes.length, 0);
  assert.equal(harness.rendered.some((snapshot) => snapshot.episodes.some((episode) => episode.id === harness.episodeId)), false);
  assert.deepEqual(harness.sent, []);
});

function directCommitHarness(sessionId: string) {
  const worker = new FakeWorker();
  const failure = new MonitorRecorderFailureLatch();
  const recorder = new MonitorRecorder((event) => {
    if (event.type === "error") failure.remember(event.message);
  }, { worker: worker as unknown as Worker });
  const reducer = new DirectSessionReducer(sessionId);
  const configuration = reducer.snapshot.configuration;
  configuration.runTitle = "Durably committed task";
  const commands = reducer.configure(configuration);
  const snapshot = reducer.snapshot;
  recorder.open(sessionId);
  const sent: string[] = [];
  const app = Object.create(MonitorApp.prototype) as CommitHarness;
  Object.assign(app, {
    connectionProfile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    monitorRecorder: recorder,
    monitorRecorderFailure: failure,
    peerControlChannel: {
      readyState: "open",
      send: (message: string) => sent.push(message),
    },
    snapshot,
    showActivity: () => undefined,
  });
  return { app, commands, failure, recorder, sent, snapshot, worker };
}

function directFinalisationHarness(sessionId: string) {
  const worker = new FakeWorker();
  const failure = new MonitorRecorderFailureLatch();
  const recorder = new MonitorRecorder((event) => {
    if (event.type === "error") failure.remember(event.message);
  }, { worker: worker as unknown as Worker });
  const reducer = new DirectSessionReducer(sessionId);
  reducer.setCaptureConnected(true);
  reducer.setCaptureStatus({ ...defaultCaptureStatus, recorder: "armed" });
  reducer.control("start-sequence");
  const episodeId = reducer.snapshot.pendingEpisode!.id;
  reducer.recordingAccepted(episodeId);
  reducer.control("next", "director", nextRunControlCursor(reducer.snapshot));
  reducer.control("next", "director", nextRunControlCursor(reducer.snapshot));
  const snapshot = reducer.snapshot;
  const segments = snapshot.currentEpisode?.segments ?? [];
  const summary = {
    frameCount: Math.max(1, segments.length),
    gapCount: 0,
    mediaChunkCount: 1,
    recorderSlotCount: Math.max(1, segments.length),
    firstRecorderSequence: 0,
    lastRecorderSequence: Math.max(1, segments.length),
    segmentSummaries: Object.fromEntries(segments.map((segment) => [segment.id, {
      frameCount: 1,
      gapCount: 0,
      recorderSlotCount: 1,
    }])),
    runEvents: segments.flatMap((segment, index) => [
      {
        sequence: index * 2,
        sourceTimestampUs: 1_000_000 + index * 1_000_000,
        event: {
          type: "segment-start" as const,
          segmentId: segment.id,
          taskId: segment.taskId,
          taskLabel: segment.taskLabel,
        },
      },
      {
        sequence: index * 2 + 1,
        sourceTimestampUs: 1_500_000 + index * 1_000_000,
        event: {
          type: "segment-end" as const,
          segmentId: segment.id,
          taskId: segment.taskId,
          taskLabel: segment.taskLabel,
        },
      },
    ]),
  };
  recorder.open(sessionId);
  const sent: string[] = [];
  const rendered: SessionSnapshot[] = [];
  const app = Object.create(MonitorApp.prototype) as CommitHarness;
  Object.assign(app, {
    connectionProfile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    directSession: reducer,
    directFinalisationPublication: episodeId,
    pendingDirectFinalisation: { episodeId, captureFinalised: true },
    monitorRecorder: recorder,
    monitorRecorderFailure: failure,
    peerControlChannel: {
      readyState: "open",
      send: (message: string) => sent.push(message),
    },
    snapshot,
    renderSnapshot: (_root: HTMLElement, value: SessionSnapshot) => rendered.push(structuredClone(value)),
    showActivity: () => undefined,
  });
  return { app, episodeId, failure, recorder, reducer, rendered, sent, snapshot, summary, worker };
}

function snapshotRequest(worker: FakeWorker) {
  const request = worker.messages.at(-1) as {
    type: string;
    snapshotRequestId: number;
    snapshot: SessionSnapshot;
  };
  assert.equal(request.type, "save-snapshot");
  return request;
}
