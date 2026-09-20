import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultCaptureStatus,
  normaliseSoloSessionPreferences,
  type SessionSnapshot,
} from "../shared/protocol.js";
import { DirectSessionReducer } from "../src/direct-session-reducer.js";
import { localVoiceCommandContext } from "../src/local-voice-command-context.js";

function runningSnapshot() {
  const reducer = new DirectSessionReducer("voice-session", () => 1_000, () => "voice-episode");
  reducer.setCaptureConnected(true);
  reducer.setCaptureStatus({ ...defaultCaptureStatus, recorder: "armed" });
  reducer.control("start-sequence");
  reducer.recordingAccepted("voice-episode");
  const snapshot = reducer.snapshot;
  assert.equal(snapshot.run.status, "running");
  assert.ok(snapshot.currentEpisode?.segments?.length);
  return snapshot;
}

test("elapsed time and incoming telemetry preserve the spoken command target", () => {
  const before = runningSnapshot();
  const after = structuredClone(before);
  after.run.takeElapsedMs += 600;
  after.run.recordingElapsedMs += 600;
  after.captureStatus.xrFrameCount = 45;
  after.captureStatus.recorderFrameIndex += 18;
  after.captureStatus.recorderDurableAckSequence += 20;
  after.captureStatus.lastFrameAt = 1_600;
  after.lastFrame = {
    timestampMs: 1_600,
    frameIndex: 45,
    head: { position: { x: 0.1, y: 1.7, z: -0.2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    leftHand: { tracked: true, joints: {}, pinch: 0 },
    rightHand: { tracked: true, joints: {}, pinch: 0.2 },
    sceneStatus: { planes: true, meshes: false, anchors: false },
  };
  after.lastTranscript = { text: "next", timestampMs: 1_600 };
  after.currentEpisode!.frameCount += 18;
  after.currentEpisode!.mediaChunkCount += 2;
  after.monitorCount += 1;
  assert.equal(localVoiceCommandContext("capture-tab", before), localVoiceCommandContext("capture-tab", after));
});

test("a changed capture session key invalidates an utterance", () => {
  const snapshot = runningSnapshot();
  assert.notEqual(localVoiceCommandContext("first-tab", snapshot), localVoiceCommandContext("second-tab", snapshot));
});

const targetChanges: Array<[string, (snapshot: SessionSnapshot) => void]> = [
  ["session identity", (snapshot) => { snapshot.sessionId = "replacement-session"; }],
  ["session restart", (snapshot) => { snapshot.startedAt = new Date(2_000).toISOString(); }],
  ["configuration revision", (snapshot) => { snapshot.configurationStatus.revision += 1; }],
  ["applied configuration revision", (snapshot) => { snapshot.configurationStatus.appliedRevision = 20; }],
  ["run restart", (snapshot) => { snapshot.run.startedAtMs = 2_000; }],
  ["stopped run", (snapshot) => { snapshot.run.status = "stopped"; }],
  ["paused recording", (snapshot) => { snapshot.run.recordingState = "paused"; }],
  ["task transition", (snapshot) => { snapshot.run.activeTaskIndex += 1; }],
  ["task phase transition", (snapshot) => { snapshot.run.phase = "post-task-pause"; }],
  ["repetition transition", (snapshot) => { snapshot.run.repetition += 1; }],
  ["take transition", (snapshot) => { snapshot.run.take += 1; }],
  ["cycle transition", (snapshot) => { snapshot.run.cycle += 1; }],
  ["review target", (snapshot) => { snapshot.run.reviewEpisodeId = "review-episode"; }],
  ["reset countdown", (snapshot) => { snapshot.run.resetDeadlineMs = 6_000; }],
  ["recording episode", (snapshot) => { snapshot.currentEpisode!.id = "replacement-episode"; }],
  ["recording segment", (snapshot) => { snapshot.currentEpisode!.segments!.at(-1)!.id = "replacement-segment"; }],
  ["segment outcome", (snapshot) => { snapshot.currentEpisode!.segments!.at(-1)!.outcome = "completed"; }],
  ["run finalisation", (snapshot) => { snapshot.currentEpisode!.runFinalisation = "finish-requested"; }],
  ["demonstrator readiness", (snapshot) => { snapshot.run.demonstratorReady = !snapshot.run.demonstratorReady; }],
  ["director readiness", (snapshot) => { snapshot.run.directorReady = !snapshot.run.directorReady; }],
];

for (const [change, mutate] of targetChanges) {
  test(`${change} invalidates an utterance from the preceding state`, () => {
    const before = runningSnapshot();
    const after = structuredClone(before);
    mutate(after);
    assert.notEqual(localVoiceCommandContext("capture-tab", before), localVoiceCommandContext("capture-tab", after));
  });
}

test("a new review annotation invalidates a pending pass or fail command", () => {
  const before = runningSnapshot();
  before.run.phase = "post-task-pause";
  before.run.recordingState = "paused";
  const after = structuredClone(before);
  after.currentEpisode!.segments!.at(-1)!.annotations.push({
    id: "annotation-pass",
    action: "pass",
    actor: "director",
    timestampMs: 2_000,
  });
  assert.notEqual(localVoiceCommandContext("capture-tab", before), localVoiceCommandContext("capture-tab", after));
  const changedAction = structuredClone(after);
  changedAction.currentEpisode!.segments!.at(-1)!.annotations.at(-1)!.action = "fail";
  assert.notEqual(localVoiceCommandContext("capture-tab", after), localVoiceCommandContext("capture-tab", changedAction));
});

test("a pending episode retains the same review target until its annotation changes", () => {
  const before = runningSnapshot();
  const pending = structuredClone(before);
  pending.pendingEpisode = pending.currentEpisode;
  pending.currentEpisode = null;
  assert.equal(localVoiceCommandContext("capture-tab", before), localVoiceCommandContext("capture-tab", pending));
  pending.pendingEpisode!.segments!.at(-1)!.annotations.push({
    id: "pending-annotation",
    action: "fail",
    actor: "demonstrator",
    timestampMs: 2_000,
  });
  assert.notEqual(localVoiceCommandContext("capture-tab", before), localVoiceCommandContext("capture-tab", pending));
});

test("Solo task selection and countdown changes invalidate a pending start command", () => {
  const reducer = new DirectSessionReducer("solo-voice", () => 1_000);
  reducer.enableSolo(normaliseSoloSessionPreferences({}));
  const initial = reducer.snapshot;
  const selected = structuredClone(initial);
  selected.solo!.selectedStartTaskId = selected.configuration.tasks[0].id;
  assert.notEqual(localVoiceCommandContext("capture-tab", initial), localVoiceCommandContext("capture-tab", selected));
  const counting = structuredClone(selected);
  counting.solo!.startCountdownDeadlineMs = 5_000;
  assert.notEqual(localVoiceCommandContext("capture-tab", selected), localVoiceCommandContext("capture-tab", counting));
  const delayed = structuredClone(counting);
  delayed.solo!.startCountdownDeadlineMs = 6_000;
  assert.notEqual(localVoiceCommandContext("capture-tab", counting), localVoiceCommandContext("capture-tab", delayed));
  const cancelled = structuredClone(counting);
  cancelled.solo!.startCountdownDeadlineMs = null;
  assert.notEqual(localVoiceCommandContext("capture-tab", counting), localVoiceCommandContext("capture-tab", cancelled));
});

test("Bridge pause and resume each invalidate commands spoken in the preceding state", () => {
  const active = localVoiceCommandContext("bridge-session", null, false);
  const paused = localVoiceCommandContext("bridge-session", null, true);
  assert.notEqual(active, paused);
  assert.notEqual(paused, localVoiceCommandContext("bridge-session", null, false));
  assert.notEqual(active, localVoiceCommandContext("replacement-bridge", null, false));
});

test("arriving or disappearing session state invalidates a pending command", () => {
  const snapshot = runningSnapshot();
  assert.equal(localVoiceCommandContext("capture-tab", null), localVoiceCommandContext("capture-tab", null));
  assert.notEqual(localVoiceCommandContext("capture-tab", null), localVoiceCommandContext("capture-tab", snapshot));
});
