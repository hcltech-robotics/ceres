import assert from "node:assert/strict";
import test from "node:test";
import {
  SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
  type SessionSnapshot,
} from "../shared/protocol.js";
import {
  currentRunStage,
  nextRunStage,
  recordingElapsedMs,
  runControls,
  runStatePresentation,
  sessionElapsedMs,
  soloRunStartPresentation,
  takeElapsedMs,
  taskRemainingMs,
} from "../src/run-presentation.js";

const snapshot = (overrides: Partial<SessionSnapshot["run"]> = {}) => ({
  configuration: {
    runTitle: "Reach study",
    totalCycles: 2,
    tasks: [
      {
        id: "timed",
        label: "Timed reach",
        instructions: "Reach",
        type: "timed",
        durationS: 10,
        repeatCount: 2,
        resetTimeS: 5,
      },
      { id: "pause", label: "Reset objects", instructions: "Reset", type: "pause", durationS: 8 },
    ],
  },
  sequenceReadiness: { ready: true, blockers: [] },
  recordingReadiness: { ready: true, blockers: [] },
  captureConnected: true,
  run: {
    status: "running",
    phase: "active-task",
    recordingState: "idle",
    startedAtMs: 1_000,
    endedAtMs: null,
    cycle: 1,
    activeTaskIndex: 0,
    repetition: 1,
    take: 1,
    takeStartedAtMs: 1_000,
    takeElapsedMs: 0,
    recordingStartedAtMs: null,
    recordingElapsedMs: 0,
    reviewEpisodeId: null,
    resetDeadlineMs: null,
    error: null,
    ...overrides,
  },
}) as SessionSnapshot;

test("run stages contain only cycle, task and rep position", () => {
  const current = currentRunStage(snapshot());
  assert.deepEqual(current, {
    complete: false,
    title: "Timed reach",
    detail: "Cycle 1/2, task 1/2, rep 1/2.",
    cycle: 1,
    taskIndex: 0,
    repetition: 1,
  });
  assert.doesNotMatch(JSON.stringify(current), /\bset\b/i);

  const next = nextRunStage(snapshot());
  assert.equal(next?.cycle, 1);
  assert.equal(next?.taskIndex, 0);
  assert.equal(next?.repetition, 2);
});

test("stage progression moves through reps, tasks and cycles", () => {
  const nextTask = nextRunStage(snapshot({ repetition: 2 }));
  assert.deepEqual(nextTask, {
    complete: false,
    title: "Reset objects",
    detail: "Cycle 1/2, task 2/2. Pause for 8 seconds.",
    cycle: 1,
    taskIndex: 1,
    repetition: 1,
  });

  const nextCycle = nextRunStage(snapshot({ activeTaskIndex: 1 }));
  assert.equal(nextCycle?.cycle, 2);
  assert.equal(nextCycle?.taskIndex, 0);
  assert.equal(nextCycle?.repetition, 1);

  const complete = nextRunStage(snapshot({ cycle: 2, activeTaskIndex: 1 }));
  assert.deepEqual(complete, {
    complete: true,
    title: "Run complete",
    detail: "2 cycles completed.",
    cycle: 2,
    taskIndex: 2,
    repetition: 1,
  });
});

test("run control presents Stop run to the director and Finish to the demonstrator", () => {
  const stopped = runControls(snapshot({ status: "stopped", phase: null, startedAtMs: null, takeStartedAtMs: null }));
  assert.deepEqual(stopped[0], {
    slot: "run",
    action: "start-sequence",
    label: "PRESS TO READY",
    tone: "success",
    enabled: true,
    pressed: false,
    state: "ready",
  });

  const running = runControls(snapshot());
  assert.deepEqual(running[0], {
    slot: "run",
    action: "stop",
    label: "Stop run",
    tone: "primary",
    enabled: true,
    pressed: true,
    state: "active",
  });

  for (const actor of ["demonstrator", "solo"] as const) {
    assert.deepEqual(runControls(snapshot(), true, actor)[0], {
      slot: "run",
      action: "finish",
      label: "Finish",
      tone: "primary",
      enabled: true,
      pressed: true,
      state: "active",
    });
    assert.equal(runControls(snapshot({ recordingState: "arming" }), true, actor)[0]?.enabled, false);
    assert.equal(runControls(snapshot({ recordingState: "stopping" }), true, actor)[0]?.enabled, false);
  }
});

test("a ready Solo run can start directly from the capture HUD", () => {
  const ready = snapshot({
    status: "stopped",
    phase: null,
    startedAtMs: null,
    takeStartedAtMs: null,
  });
  ready.operatingMode = "solo";

  assert.equal(
    runControls(ready, true, "solo").find(({ slot }) => slot === "run")?.enabled,
    true,
  );
  ready.sequenceReadiness = {
    ready: false,
    blockers: [{ code: "recorder-not-armed", message: "Recorder is not armed" }],
  };
  assert.equal(
    runControls(ready, true, "solo").find(({ slot }) => slot === "run")?.enabled,
    false,
  );
});

test("an offline control link overrides ready and running presentation", () => {
  for (const value of [
    snapshot({ status: "stopped", phase: null, startedAtMs: null, takeStartedAtMs: null }),
    snapshot(),
    snapshot({ recordingState: "recording" }),
    snapshot({ phase: "post-task-pause", reviewEpisodeId: "episode-1", takeStartedAtMs: null }),
  ]) assert.equal(runControls(value, false).every(({ enabled }) => !enabled), true);

  assert.deepEqual(runStatePresentation(snapshot({ status: "stopped", phase: null, startedAtMs: null, takeStartedAtMs: null }), false), {
    stateLabel: "OFFLINE",
    title: "Capture director offline",
    detail: "Connect to the capture director to receive the active run and instructions.",
  });
  assert.deepEqual(runStatePresentation(snapshot({ recordingState: "recording" }), false), {
    stateLabel: "OFFLINE",
    title: "Capture director offline",
    detail: "Recording is continuing locally. Reconnect the capture director to restore run controls.",
  });
  assert.deepEqual(runStatePresentation(snapshot({ recordingState: "paused", takeStartedAtMs: null }), false), {
    stateLabel: "OFFLINE",
    title: "Capture director offline",
    detail: "Recording remains paused locally. Reconnect the capture director to restore run controls.",
  });
});

test("socket readiness cannot enable Start while the demonstrator snapshot is disconnected", () => {
  const value = snapshot({ status: "stopped", phase: null, startedAtMs: null, takeStartedAtMs: null });
  value.captureConnected = false;

  assert.equal(runControls(value, true).find(({ slot }) => slot === "run")?.enabled, false);
  assert.equal(runControls(value, true).every(({ enabled }) => !enabled), true);
});

test("record control toggles from record to pause to resume", () => {
  const idle = runControls(snapshot()).find(({ slot }) => slot === "record");
  assert.deepEqual(idle, {
    slot: "record",
    action: "start",
    label: "Recording starts automatically",
    tone: "record",
    enabled: false,
    pressed: false,
    state: "idle",
  });

  const recording = runControls(snapshot({ recordingState: "recording" })).find(({ slot }) => slot === "record");
  assert.deepEqual(recording, {
    slot: "record",
    action: "pause",
    label: "Pause recording",
    tone: "record",
    enabled: true,
    pressed: true,
    state: "active",
  });

  const paused = runControls(snapshot({ recordingState: "paused", takeStartedAtMs: null })).find(({ slot }) => slot === "record");
  assert.deepEqual(paused, {
    slot: "record",
    action: "resume",
    label: "Resume recording",
    tone: "record",
    enabled: true,
    pressed: false,
    state: "idle",
  });
});

test("presents reversible readiness and sync lock by actor without a recording latch", () => {
  const ready = snapshot({
    status: "stopped",
    phase: null,
    startedAtMs: null,
    takeStartedAtMs: null,
    directorReady: true,
    demonstratorReady: false,
    recordingLatched: true,
  });
  assert.equal(runControls(ready, true, "director").find(({ slot }) => slot === "run")?.label, "READY");
  assert.equal(runControls(ready, true, "demonstrator").find(({ slot }) => slot === "run")?.label, "PRESS TO READY");
  assert.equal(runControls(ready).find(({ slot }) => slot === "record")?.state, "idle");
  ready.run.demonstratorReady = true;
  ready.run.syncLockStartedAtMs = Date.now();
  assert.equal(runControls(ready, true, "demonstrator").find(({ slot }) => slot === "run")?.state, "sync-lock");
});

test("all control slots keep one stable order", () => {
  for (const value of [
    snapshot(),
    snapshot({ recordingState: "recording" }),
    snapshot({ recordingState: "paused", takeStartedAtMs: null }),
    snapshot({ phase: "post-task-pause", reviewEpisodeId: "episode-1", takeStartedAtMs: null }),
  ]) {
    assert.deepEqual(runControls(value).map(({ slot }) => slot), ["run", "record", "retry", "next", "pass", "fail"]);
  }
});

test("director and demonstrator can choose Next or Retry during an open active task", () => {
  const active = snapshot({ recordingState: "recording" });
  assert.equal(runControls(active, true, "director").find(({ slot }) => slot === "next")?.enabled, true);
  assert.equal(runControls(active, true, "demonstrator").find(({ slot }) => slot === "next")?.enabled, true);
  assert.equal(runControls(active, true, "demonstrator").find(({ slot }) => slot === "retry")?.enabled, true);
  assert.equal(runControls(snapshot({ recordingState: "arming" }), true, "director").find(({ slot }) => slot === "next")?.enabled, false);

  const reset = snapshot({ phase: "post-task-pause", recordingState: "paused", reviewEpisodeId: "episode-1" });
  reset.currentEpisode = {
    id: "episode-1",
    segments: [{ id: "segment-1", outcome: "completed", annotations: [] }],
  } as SessionSnapshot["currentEpisode"];
  assert.equal(runControls(reset, true, "demonstrator").find(({ slot }) => slot === "next")?.enabled, true);
  assert.equal(runControls(reset, true, "demonstrator").find(({ slot }) => slot === "next")?.label, "Advance");
});

test("annotations are enabled by reset phase and do not gate navigation", () => {
  const annotations = (value: SessionSnapshot) => runControls(value)
    .filter(({ slot }) => slot === "retry" || slot === "pass" || slot === "fail")
    .map(({ enabled }) => enabled);
  const writing = snapshot({ phase: "post-task-pause", recordingState: "stopping", reviewEpisodeId: null, takeStartedAtMs: null });
  writing.currentEpisode = { id: "episode-writing" } as SessionSnapshot["currentEpisode"];
  const reviewed = snapshot({ phase: "post-task-pause", recordingState: "paused", reviewEpisodeId: "episode-1", takeStartedAtMs: null });
  reviewed.currentEpisode = {
    id: "episode-1",
    segments: [{ id: "segment-1", outcome: "completed", annotations: [] }],
  } as SessionSnapshot["currentEpisode"];

  assert.deepEqual(annotations(snapshot({ reviewEpisodeId: "episode-1" })), [false, false, false]);
  assert.deepEqual(annotations(snapshot({ phase: "post-task-pause", reviewEpisodeId: null, takeStartedAtMs: null })), [true, true, true]);
  assert.deepEqual(annotations(writing), [false, false, false]);
  assert.equal(runControls(writing).find(({ slot }) => slot === "next")?.enabled, false);
  assert.deepEqual(annotations(reviewed), [true, true, true]);
  assert.deepEqual(annotations(snapshot({ phase: "task-pause", reviewEpisodeId: "episode-1", takeStartedAtMs: null })), [false, false, false]);
});

test("cycle completion presents the fifteen second break and keeps Next available", () => {
  const value = snapshot({
    phase: "cycle-pause",
    activeTaskIndex: 2,
    takeStartedAtMs: null,
    resetDeadlineMs: 16_000,
  });
  assert.deepEqual(runStatePresentation(value), {
    stateLabel: "CYCLE COMPLETE",
    title: "Cycle 1/2 complete",
    detail: "Cycle 2/2 begins after the 15 second pause. Next advances immediately.",
  });
  const controls = runControls(value);
  assert.equal(controls.find(({ slot }) => slot === "next")?.enabled, true);
  assert.equal(runControls(snapshot({
    phase: "cycle-pause",
    recordingState: "stopping",
    takeStartedAtMs: null,
    resetDeadlineMs: 16_000,
  })).find(({ slot }) => slot === "next")?.enabled, false);
  assert.equal(controls.find(({ slot }) => slot === "record")?.enabled, false);
});

test("paused recording freezes recording, take and left clocks only", () => {
  const now = 7_000;
  const active = snapshot({
    takeStartedAtMs: 5_000,
    takeElapsedMs: 2_000,
    recordingStartedAtMs: 6_500,
    recordingElapsedMs: 500,
  });
  assert.equal(sessionElapsedMs(active.run, now), 6_000);
  assert.equal(takeElapsedMs(active.run, now), 4_000);
  assert.equal(recordingElapsedMs(active.run, now), 1_000);
  assert.equal(taskRemainingMs(active, now), 6_000);

  const paused = snapshot({
    recordingState: "paused",
    takeStartedAtMs: null,
    takeElapsedMs: 4_000,
    recordingStartedAtMs: null,
    recordingElapsedMs: 1_000,
  });
  assert.equal(sessionElapsedMs(paused.run, now), 6_000);
  assert.equal(takeElapsedMs(paused.run, now), 4_000);
  assert.equal(recordingElapsedMs(paused.run, now), 1_000);
  assert.equal(taskRemainingMs(paused, now), 6_000);
  assert.match(runStatePresentation(paused).detail, /Session time continues/);
});

test("presents a controller-made start selection as waiting for both hands", () => {
  const value = snapshot({
    status: "stopped",
    phase: null,
    startedAtMs: null,
    takeStartedAtMs: null,
  });
  value.operatingMode = "solo";
  value.solo = {
    preferences: { startCountdownMs: 3_000 },
    selectedStartTaskId: "timed",
    startCountdownDeadlineMs: null,
    storageHeadroom: {
      state: "ready",
      availableBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
      requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
      checkedAtMs: 1_000,
      detail: "512 MiB is available for Solo capture",
    },
  };

  assert.deepEqual(soloRunStartPresentation(value, 1_000), {
    state: "awaiting-hands",
    selectedStartTaskId: "timed",
    startCountdownDeadlineMs: null,
    remainingMs: null,
    countdownValue: null,
  });
  assert.equal(
    runControls(value, true, "solo").find(({ slot }) => slot === "run")?.label,
    "Show both hands",
  );

  // Arming the countdown replaces the waiting state with the normal countdown.
  value.solo.startCountdownDeadlineMs = 4_000;
  assert.equal(soloRunStartPresentation(value, 1_000)?.state, "countdown");
});

test("presents the Solo countdown from its absolute deadline without claiming recording", () => {
  const value = snapshot({
    status: "stopped",
    phase: null,
    startedAtMs: null,
    takeStartedAtMs: null,
  });
  value.operatingMode = "solo";
  value.solo = {
    preferences: { startCountdownMs: 3_000 },
    selectedStartTaskId: "timed",
    startCountdownDeadlineMs: 4_000,
    storageHeadroom: {
      state: "ready",
      availableBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
      requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
      checkedAtMs: 1_000,
      detail: "512 MiB is available for Solo capture",
    },
  };

  assert.deepEqual(soloRunStartPresentation(value, 1_000), {
    state: "countdown",
    selectedStartTaskId: "timed",
    startCountdownDeadlineMs: 4_000,
    remainingMs: 3_000,
    countdownValue: 3,
  });
  assert.equal(soloRunStartPresentation(value, 2_001)?.countdownValue, 2);
  assert.equal(soloRunStartPresentation(value, 3_001)?.countdownValue, 1);
  assert.deepEqual(runStatePresentation(value, true, 1_000), {
    stateLabel: "3",
    title: "Timed reach",
    detail: "Hold position. Recording has not started.",
    selectedStartTaskId: "timed",
    startCountdownDeadlineMs: 4_000,
  });
  assert.deepEqual(
    runControls(value, true, "solo").find(({ slot }) => slot === "run"),
    {
      slot: "run",
      action: "stop",
      label: "Cancel countdown",
      tone: "success",
      enabled: true,
      pressed: true,
      state: "countdown",
    },
  );

  value.run.status = "running";
  value.run.recordingState = "arming";
  value.solo.startCountdownDeadlineMs = null;
  assert.equal(runStatePresentation(value).stateLabel, "ARMING");
  assert.equal(runStatePresentation(value).detail, "Hold position.");
  value.run.recordingState = "recording";
  assert.equal(runStatePresentation(value).stateLabel, "REC");
});
