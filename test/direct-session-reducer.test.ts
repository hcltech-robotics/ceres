import assert from "node:assert/strict";
import test from "node:test";
import { CAMERA_REGISTRATION_SCHEMA, type CameraRegistration } from "../shared/camera-registration.js";
import {
  defaultCaptureStatus,
  nextRunControlCursor,
  normaliseSoloSessionPreferences,
  type CaptureConfiguration,
  type VerifiedEpisodeHuggingFaceUpload,
} from "../shared/protocol.js";
import { DirectSessionReducer } from "../src/direct-session-reducer.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";

const validSummary = {
  frameCount: 2,
  gapCount: 0,
  mediaChunkCount: 1,
  recorderSlotCount: 2,
  firstRecorderSequence: 0,
  lastRecorderSequence: 2,
};

function validSummaryFor(reducer: DirectSessionReducer) {
  const segments = reducer.snapshot.currentEpisode?.segments ?? [];
  const frameCount = Math.max(1, segments.length);
  return {
    ...validSummary,
    frameCount,
    recorderSlotCount: frameCount,
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
}

function next(reducer: DirectSessionReducer, actor: "director" | "demonstrator" = "director") {
  return reducer.control("next", actor, nextRunControlCursor(reducer.snapshot));
}

function resetControl(
  reducer: DirectSessionReducer,
  action: "success" | "fail" | "retry",
  actor: "director" | "demonstrator" = "director",
) {
  return reducer.control(action, actor, nextRunControlCursor(reducer.snapshot, action));
}

function readyReducer(
  sessionId: string,
  configuration?: (value: CaptureConfiguration) => void,
  ids: string[] = ["cycle-episode-1", "cycle-episode-2"],
) {
  let now = 1_000;
  let idIndex = 0;
  const reducer = new DirectSessionReducer(sessionId, () => now, () => ids[idIndex++]!);
  if (configuration) {
    const value = reducer.snapshot.configuration;
    configuration(value);
    const [command] = reducer.configure(value);
    if (command.type !== "configuration") throw new Error("Expected configuration command");
    reducer.configurationApplied(command.revision, command.checksum);
  }
  reducer.setCaptureConnected(true);
  reducer.setCaptureStatus({ ...defaultCaptureStatus, recorder: "armed" });
  return {
    reducer,
    now: () => now,
    setNow: (value: number) => { now = value; },
  };
}

test("a direct session accepts the browser test recorder rate", () => {
  const reducer = new DirectSessionReducer("direct-rate", undefined, undefined, 1);
  assert.equal(reducer.snapshot.configuration.recorderRateHz, 1);
  assert.equal(reducer.snapshot.captureStatus.recorderRateHz, 1);
});

test("keeps restored direct-session telemetry closed until a valid peer message arrives", () => {
  const reducer = new DirectSessionReducer("direct-privacy");
  assert.equal(reducer.snapshot.telemetryMode, "standard");
  assert.equal(reducer.snapshot.telemetryModeAuthoritative, false);

  reducer.setTelemetryMode("disabled");
  assert.equal(reducer.snapshot.telemetryMode, "disabled");
  assert.equal(reducer.snapshot.telemetryModeAuthoritative, true);

  const restored = new DirectSessionReducer("direct-privacy");
  restored.restore(reducer.snapshot, true);
  assert.equal(restored.snapshot.telemetryMode, "disabled");
  assert.equal(restored.snapshot.telemetryModeAuthoritative, false);

  restored.setTelemetryMode("invalid");
  assert.equal(restored.snapshot.telemetryMode, "disabled");
  assert.equal(restored.snapshot.telemetryModeAuthoritative, false);
  restored.setTelemetryMode("standard");
  assert.equal(restored.snapshot.telemetryMode, "standard");
  assert.equal(restored.snapshot.telemetryModeAuthoritative, true);

  restored.resetTelemetryModeAuthority();
  assert.equal(restored.snapshot.telemetryMode, "disabled");
  assert.equal(restored.snapshot.telemetryModeAuthoritative, false);

  const legacy = restored.snapshot as Partial<typeof restored.snapshot>;
  delete legacy.telemetryMode;
  delete legacy.telemetryModeAuthoritative;
  restored.restore(legacy as typeof restored.snapshot, true);
  assert.equal(restored.snapshot.telemetryMode, "disabled");
  assert.equal(restored.snapshot.telemetryModeAuthoritative, false);
});

test("a completed Solo run must be reset before configuration changes", () => {
  const reducer = new DirectSessionReducer("solo-complete-configuration-lock");
  reducer.enableSolo(normaliseSoloSessionPreferences({}));
  const completed = reducer.snapshot;
  completed.run.status = "complete";
  completed.run.endedAtMs = 2_000;
  completed.solo!.selectedStartTaskId = "task-001";
  reducer.restore(completed, true);

  const before = reducer.snapshot;
  const configuration = {
    ...before.configuration,
    recordAudio: !before.configuration.recordAudio,
  };
  assert.throws(
    () => reducer.configure(configuration),
    /locked until the current run is ready for configuration/,
  );
  assert.equal(reducer.snapshot.run.status, "complete");
  assert.equal(reducer.snapshot.configurationStatus.revision, before.configurationStatus.revision);
  assert.equal(reducer.snapshot.configuration.recordAudio, before.configuration.recordAudio);
  assert.equal(reducer.snapshot.solo?.selectedStartTaskId, "task-001");

  reducer.resetCompletedSoloRun();
  reducer.configure(configuration);
  assert.equal(reducer.snapshot.run.status, "stopped");
  assert.equal(reducer.snapshot.configuration.recordAudio, configuration.recordAudio);
});

test("required prompt audio remains capture-authoritative in Direct mode", () => {
  const { reducer } = readyReducer("direct-required-prompt", (configuration) => {
    configuration.promptAudio.enabled = true;
    configuration.promptAudio.required = true;
    configuration.promptAudio.taskStartAssetUrl = "/audio/task-start.mp3";
  });

  assert.equal(reducer.snapshot.operatingMode, "direct");
  assert.equal(reducer.snapshot.promptAudioStatus.state, "unavailable");
  assert.equal(reducer.snapshot.sequenceReadiness.ready, true);
  assert.equal(
    reducer.snapshot.sequenceReadiness.blockers.some((blocker) => blocker.code === "audio-not-ready"),
    false,
  );
});

test("a direct session retains and synchronises the camera registration", () => {
  const reducer = new DirectSessionReducer("direct-camera-registration");
  const registration: CameraRegistration = {
    schema: CAMERA_REGISTRATION_SCHEMA,
    cameraDeviceId: "quest-camera-device-0",
    cameraLabel: "camera2 0",
    side: "right",
    width: 1280,
    height: 960,
    fx: 760,
    fy: 762,
    cx: 638,
    cy: 481,
    distortion: [0, 0, 0, 0, 0],
    rms: .31,
    sampleCount: 18,
    reprojection: {
      centre: { near: .31, middle: .31, far: .31 },
      edges: { near: .31, middle: .31, far: .31 },
      maximumRms: .31,
    },
    calibratedAtMs: 4_000,
  };

  assert.deepEqual(reducer.setCameraRegistration(registration), [{
    type: "camera-registration",
    registration,
  }]);
  assert.deepEqual(reducer.snapshot.cameraRegistration, registration);
  assert.deepEqual(
    reducer.synchronise().find((command) => command.type === "camera-registration"),
    { type: "camera-registration", registration },
  );

  const restored = new DirectSessionReducer("direct-camera-registration");
  restored.restore(reducer.snapshot, true);
  assert.deepEqual(restored.snapshot.cameraRegistration, registration);
});

test("a direct episode freezes the selected camera, calibration and study metadata", () => {
  const { reducer } = readyReducer("direct-capture-metadata", (configuration) => {
    configuration.recordAudio = false;
    configuration.studyMetadata = {
      headsetId: "quest-rig-9e",
      demonstratorId: "",
      projectId: "project-canterbury",
      consentDate: "2026-08-02",
      consentDocumentId: "consent-v4-042",
    };
  });
  const registration: CameraRegistration = {
    schema: CAMERA_REGISTRATION_SCHEMA,
    cameraDeviceId: "quest-camera-device-0",
    cameraLabel: "camera2 0",
    side: "right",
    width: 1280,
    height: 960,
    fx: 760,
    fy: 762,
    cx: 638,
    cy: 481,
    distortion: [0, 0, 0, 0, 0],
    rms: .31,
    sampleCount: 18,
    reprojection: {
      centre: { near: .31, middle: .31, far: .31 },
      edges: { near: .31, middle: .31, far: .31 },
      maximumRms: .31,
    },
    calibratedAtMs: 4_000,
  };
  reducer.setCaptureStatus({
    ...defaultCaptureStatus,
    headsetModel: "Quest 3",
    sensorSource: "native-webxr",
    questBrowser: true,
    camera: "ready",
    recorder: "armed",
    selectedCameraDeviceId: registration.cameraDeviceId,
    selectedCameraLabel: registration.cameraLabel,
    selectedCameraWidth: registration.width,
    selectedCameraHeight: registration.height,
    selectedCameraFrameRate: 30,
    selectedCameraSide: registration.side,
    handTracking: "active",
  });
  reducer.setCameraRegistration(registration);

  reducer.control("start-sequence");
  const metadata = reducer.snapshot.pendingEpisode?.captureMetadata;

  assert.deepEqual(metadata?.camera.selection, {
    availability: "known",
    value: { label: "camera2 0", side: "right" },
  });
  assert.equal(metadata?.camera.calibration.availability, "known");
  assert.deepEqual(metadata?.study, {
    headsetId: "quest-rig-9e",
    demonstratorId: metadata?.study.demonstratorId,
    demonstratorIdOrigin: "generated",
    projectId: "project-canterbury",
    consentDate: "2026-08-02",
    consentDocumentId: "consent-v4-042",
  });
  assert.match(metadata?.study.demonstratorId ?? "", /^aardvark-onlooker,,[a-z]+,[a-z]+$/);
  assert.deepEqual(metadata?.audio, { rawMicrophoneAudioRetained: false });
  assert.equal(JSON.stringify(metadata).includes(registration.cameraDeviceId), false);
});

test("both readiness annotations start capture and recording together after sync lock", () => {
  const { reducer, setNow } = readyReducer("direct-ready");

  reducer.control("start-sequence", "director");
  reducer.control("start-sequence", "demonstrator");
  assert.equal(reducer.snapshot.run.syncLockStartedAtMs, 1_000);
  setNow(3_499);
  assert.deepEqual(reducer.advanceTime(), []);
  setNow(3_500);
  const commands = reducer.advanceTime();

  assert.equal(reducer.snapshot.run.status, "running");
  assert.equal(reducer.snapshot.run.phase, null);
  assert.equal(reducer.snapshot.run.recordingState, "arming");
  assert.equal(reducer.snapshot.run.takeStartedAtMs, null);
  assert.equal(reducer.snapshot.pendingEpisode?.id, "cycle-episode-1");
  assert.equal(reducer.snapshot.pendingEpisode?.segments?.length, 1);
  assert.deepEqual(
    commands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-arming", "recording-event"],
  );
  assert.equal(commands.some((command) => command.type === "run-state"), false);

  setNow(4_000);
  const accepted = reducer.recordingAccepted("cycle-episode-1");
  assert.deepEqual(accepted.map((command) => command.type === "control" ? command.action : command.type), [
    "recording-started",
    "run-state",
  ]);
  assert.equal(reducer.snapshot.run.phase, "active-task");
  assert.equal(reducer.snapshot.run.takeStartedAtMs, 4_000);
  assert.equal(reducer.control("start").some((command) => command.type === "control" && command.action === "recording-arming"), false);
});

test("persists only receipt-backed upload metadata in local session authority", () => {
  const sessionId = "direct-verified-upload";
  const { reducer } = readyReducer(sessionId);
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);
  next(reducer);
  reducer.recordingFinalised("cycle-episode-1", validSummaryFor(reducer));
  const episodeId = reducer.snapshot.episodes[0]!.id;
  const upload: VerifiedEpisodeHuggingFaceUpload = {
    state: "completed",
    requestId: `hf_upload_${"a".repeat(24)}`,
    jobId: `hf_upload_${"a".repeat(24)}`,
    captureSessionId: sessionId,
    episodeIds: [episodeId],
    completionReceipt: `ceres-hf-upload-receipt.v1.${"d".repeat(96)}`,
    manifestHash: "b".repeat(64),
    repository: "research/ceres-session",
    branch: "main",
    visibility: "private",
    outcome: "uploaded",
    uploadedAt: "2026-07-25T12:00:01.000Z",
    commitOid: "c".repeat(40),
    commitUrl: `https://huggingface.co/datasets/research/ceres-session/commit/${"c".repeat(40)}`,
    verifiedAt: "2026-07-25T12:00:00.000Z",
  };

  reducer.recordEpisodeUpload([episodeId], upload);
  assert.deepEqual(reducer.snapshot.episodes[0]?.huggingFaceUpload, upload);
  assert.throws(
    () => (reducer.recordEpisodeUpload as unknown as (
      episodeIds: string[],
      value: Record<string, unknown>,
    ) => void)([episodeId], {
      state: "completed",
      repository: "research/forged",
      branch: "main",
      outcome: "uploaded",
      uploadedAt: "2026-07-25T12:00:01.000Z",
    }),
    /verified backend receipt/,
  );
});

test("a pause-only direct configuration cannot start", () => {
  const { reducer } = readyReducer("direct-pause-only", (configuration) => {
    configuration.tasks = [{
      id: "pause-only",
      label: "Pause only",
      instructions: "Reset",
      type: "pause",
      durationS: 1,
    }];
  });

  assert.equal(reducer.snapshot.sequenceReadiness.ready, false);
  assert.deepEqual(reducer.snapshot.sequenceReadiness.blockers.map(({ code }) => code), ["no-task"]);
  assert.throws(() => reducer.control("start-sequence"), /recordable task/i);
});

test("manual pause and resume keep the active task segment open", () => {
  const { reducer, setNow } = readyReducer("direct-manual-pause");
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  const segmentId = reducer.snapshot.currentEpisode?.segments?.[0]?.id;

  setNow(2_000);
  const paused = reducer.control("pause");
  assert.equal(paused[0]?.type === "control" ? paused[0].action : null, "recording-paused");
  assert.equal(reducer.snapshot.run.phase, "active-task");
  assert.equal(reducer.snapshot.run.recordingState, "paused");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[0]?.outcome, "recording");

  setNow(3_000);
  reducer.control("resume");
  assert.equal(reducer.snapshot.run.recordingState, "recording");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.length, 1);
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[0]?.id, segmentId);
});

test("a stale resume cannot leave the task reset", () => {
  const { reducer } = readyReducer("direct-stale-resume");
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  reducer.control("pause");
  next(reducer);

  assert.equal(reducer.snapshot.run.phase, "post-task-pause");
  assert.equal(reducer.snapshot.run.recordingState, "paused");
  assert.throws(() => reducer.control("resume"), /Only a paused direct recording can be resumed/);
  assert.equal(reducer.snapshot.run.phase, "post-task-pause");
  assert.equal(reducer.snapshot.run.recordingState, "paused");
});

test("pass and fail are append-only annotations and never gate a reset", () => {
  const { reducer, setNow } = readyReducer("direct-annotations", (configuration) => {
    configuration.tasks = [{
      id: "task-a",
      label: "Task A",
      instructions: "Reach",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    }];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  setNow(2_000);
  next(reducer);
  const before = reducer.snapshot.run;

  setNow(2_100);
  resetControl(reducer, "success", "director");
  setNow(2_200);
  resetControl(reducer, "fail", "demonstrator");
  const after = reducer.snapshot;

  assert.equal(after.run.phase, "post-task-pause");
  assert.equal(after.run.activeTaskIndex, before.activeTaskIndex);
  assert.equal(after.run.resetDeadlineMs, before.resetDeadlineMs);
  assert.equal(after.run.recordingState, "paused");
  assert.deepEqual(
    after.currentEpisode?.segments?.[0]?.annotations.map(({ action, actor }) => ({ action, actor })),
    [
      { action: "next", actor: "director" },
      { action: "pass", actor: "director" },
      { action: "fail", actor: "demonstrator" },
    ],
  );
});

test("retry retains the completed segment and opens another segment after reset expiry", () => {
  const { reducer, setNow } = readyReducer("direct-retry", (configuration) => {
    configuration.tasks = [{
      id: "task-a",
      label: "Task A",
      instructions: "Reach",
      type: "open",
      repeatCount: 1,
      resetTimeS: 2,
    }];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  setNow(2_000);
  reducer.control("retry", "demonstrator", nextRunControlCursor(reducer.snapshot, "retry"));
  const deadline = reducer.snapshot.run.resetDeadlineMs;
  assert.ok(deadline !== null);
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[0]?.outcome, "retry");

  setNow(deadline!);
  const commands = reducer.advanceTime();
  assert.equal(reducer.snapshot.run.phase, "active-task");
  assert.equal(reducer.snapshot.run.recordingState, "recording");
  assert.equal(reducer.snapshot.currentEpisode?.id, "cycle-episode-1");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.length, 2);
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[1]?.outcome, "recording");
  assert.deepEqual(
    commands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-event", "recording-resumed"],
  );
});

test("a timed direct task does not start before recorder acceptance", () => {
  const { reducer, setNow } = readyReducer("direct-pending-transition", (configuration) => {
    configuration.tasks = [
      {
        id: "pending-task-a",
        label: "Pending task A",
        instructions: "Complete task A",
        type: "timed",
        durationS: 1,
        repeatCount: 1,
        resetTimeS: 5,
      },
      {
        id: "pending-task-b",
        label: "Pending task B",
        instructions: "Complete task B",
        type: "open",
        repeatCount: 1,
        resetTimeS: 5,
      },
    ];
  });
  const starting = reducer.control("start-sequence");
  assert.equal(reducer.snapshot.pendingEpisode?.segments?.length, 1);
  assert.equal(reducer.snapshot.run.phase, null);
  assert.equal(reducer.snapshot.run.takeStartedAtMs, null);
  assert.equal(starting.some((command) => command.type === "run-state"), false);

  setNow(2_000);
  assert.deepEqual(reducer.advanceTime(), []);
  assert.equal(reducer.snapshot.run.phase, null);
  assert.equal(reducer.snapshot.pendingEpisode?.segments?.[0]?.outcome, "recording");

  const accepted = reducer.recordingAccepted("cycle-episode-1");
  assert.equal(reducer.snapshot.run.phase, "active-task");
  assert.equal(reducer.snapshot.run.recordingState, "recording");
  assert.equal(reducer.snapshot.run.takeStartedAtMs, 2_000);
  assert.deepEqual(accepted.map((command) => command.type === "control" ? command.action : command.type), [
    "recording-started",
    "run-state",
  ]);

  setNow(2_999);
  assert.deepEqual(reducer.advanceTime(), []);
  setNow(3_000);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.phase, "post-task-pause");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[0]?.outcome, "completed");
});

test("delayed reset annotations and Retry cannot target a later task segment", () => {
  const { reducer, setNow } = readyReducer("direct-stale-reset-control", (configuration) => {
    configuration.tasks = [
      {
        id: "stale-task-a",
        label: "Stale task A",
        instructions: "Complete task A",
        type: "open",
        repeatCount: 1,
        resetTimeS: 5,
      },
      {
        id: "stale-task-b",
        label: "Stale task B",
        instructions: "Complete task B",
        type: "open",
        repeatCount: 1,
        resetTimeS: 5,
      },
    ];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  setNow(2_000);
  next(reducer);
  const stalePassCursor = nextRunControlCursor(reducer.snapshot, "success");
  const staleRetryCursor = nextRunControlCursor(reducer.snapshot, "retry");
  next(reducer);
  setNow(3_000);
  next(reducer);

  reducer.control("success", "director", stalePassCursor);
  reducer.control("retry", "director", staleRetryCursor);
  const segment = reducer.snapshot.currentEpisode?.segments?.[1];
  assert.equal(reducer.snapshot.run.phase, "post-task-pause");
  assert.equal(segment?.outcome, "completed");
  assert.equal(segment?.annotations.some(({ action }) => action === "pass" || action === "retry"), false);
});

test("two tasks share one episode and each cycle accepts exactly one episode", () => {
  const { reducer, setNow } = readyReducer("direct-cycles", (configuration) => {
    configuration.totalCycles = 2;
    configuration.tasks = [
      { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
      { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
    ];
  });

  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer, "demonstrator");
  next(reducer);
  assert.equal(reducer.snapshot.run.activeTaskIndex, 1);
  assert.equal(reducer.snapshot.currentEpisode?.id, "cycle-episode-1");
  assert.deepEqual(reducer.snapshot.currentEpisode?.segments?.map(({ taskId }) => taskId), ["task-a", "task-b"]);

  next(reducer);
  next(reducer);
  assert.equal(reducer.snapshot.run.phase, "cycle-pause");
  assert.equal(reducer.snapshot.run.recordingState, "stopping");
  reducer.recordingFinalised("cycle-episode-1", validSummaryFor(reducer));
  assert.equal(reducer.snapshot.episodes.length, 1);
  assert.equal(reducer.snapshot.episodes[0]?.segments?.length, 2);
  assert.deepEqual(reducer.snapshot.episodes[0]?.segments?.map(({ frameCount, gapCount, recorderSlotCount, accepted }) => ({
    frameCount,
    gapCount,
    recorderSlotCount,
    accepted,
  })), [
    { frameCount: 1, gapCount: 0, recorderSlotCount: 1, accepted: true },
    { frameCount: 1, gapCount: 0, recorderSlotCount: 1, accepted: true },
  ]);

  next(reducer);
  assert.equal(reducer.snapshot.run.cycle, 2);
  assert.equal(reducer.snapshot.pendingEpisode?.id, "cycle-episode-2");
  reducer.recordingAccepted("cycle-episode-2");
  next(reducer);
  next(reducer);
  next(reducer);
  next(reducer);
  reducer.recordingFinalised("cycle-episode-2", validSummaryFor(reducer));
  assert.equal(reducer.snapshot.episodes.length, 2);
  assert.deepEqual(reducer.snapshot.episodes.map(({ cycle }) => cycle), [2, 1]);

  setNow(reducer.snapshot.run.resetDeadlineMs!);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.status, "complete");
});

test("Solo post-acquisition review is exclusive, idempotent and preserves retained capture proof", () => {
  const { reducer } = readyReducer("solo-post-acquisition-review");
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);
  next(reducer);
  reducer.recordingFinalised("cycle-episode-1", validSummaryFor(reducer));
  reducer.enableSolo(normaliseSoloSessionPreferences({}));

  const upload: VerifiedEpisodeHuggingFaceUpload = {
    state: "completed",
    requestId: `hf_upload_${"a".repeat(24)}`,
    jobId: `hf_upload_${"a".repeat(24)}`,
    captureSessionId: "solo-post-acquisition-review",
    episodeIds: ["cycle-episode-1"],
    completionReceipt: `ceres-hf-upload-receipt.v1.${"c".repeat(96)}`,
    manifestHash: "d".repeat(64),
    repository: "research/solo-quality",
    branch: "main",
    visibility: "private",
    outcome: "uploaded",
    uploadedAt: "2026-07-31T12:00:00.000Z",
    commitOid: "e".repeat(40),
    commitUrl: `https://huggingface.co/datasets/research/solo-quality/commit/${"e".repeat(40)}`,
    verifiedAt: "2026-07-31T11:59:59.000Z",
  };
  reducer.recordEpisodeUpload(["cycle-episode-1"], upload);
  const retainedFrameCount = reducer.snapshot.episodes[0]!.frameCount;
  const retainedMediaChunkCount = reducer.snapshot.episodes[0]!.mediaChunkCount;

  assert.equal(reducer.reviewFinalisedSoloEpisode("cycle-episode-1", "fail").length, 1);
  assert.equal(reducer.snapshot.episodes.length, 0);
  assert.equal(reducer.snapshot.attempts[0]!.annotation, "fail");
  assert.equal(reducer.snapshot.attempts[0]!.accepted, false);
  assert.deepEqual(reducer.snapshot.attempts[0]!.huggingFaceUpload, upload);
  assert.equal(reducer.snapshot.attempts[0]!.frameCount, retainedFrameCount);
  assert.equal(reducer.snapshot.attempts[0]!.mediaChunkCount, retainedMediaChunkCount);
  assert.deepEqual(reducer.reviewFinalisedSoloEpisode("cycle-episode-1", "fail"), []);

  assert.equal(reducer.reviewFinalisedSoloEpisode("cycle-episode-1", "pass").length, 1);
  assert.equal(reducer.snapshot.attempts.length, 0);
  assert.equal(reducer.snapshot.episodes[0]!.annotation, "pass");
  assert.equal(reducer.snapshot.episodes[0]!.accepted, true);
  assert.deepEqual(reducer.snapshot.episodes[0]!.huggingFaceUpload, upload);
  assert.deepEqual(reducer.reviewFinalisedSoloEpisode("cycle-episode-1", "pass"), []);

  const restored = new DirectSessionReducer("solo-post-acquisition-review");
  restored.restore(structuredClone(reducer.snapshot), true);
  assert.equal(restored.snapshot.episodes[0]!.annotation, "pass");
  assert.deepEqual(restored.snapshot.episodes[0]!.huggingFaceUpload, upload);
});

test("a reset-phase Next cursor advances once and cannot complete the next task when replayed", () => {
  const { reducer } = readyReducer("direct-stale-reset-next", (configuration) => {
    configuration.tasks = [
      { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
      { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
    ];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);

  const resetCursor = nextRunControlCursor(reducer.snapshot);
  reducer.control("next", "director", resetCursor);
  assert.equal(reducer.snapshot.run.phase, "active-task");
  assert.equal(reducer.snapshot.run.activeTaskIndex, 1);
  assert.equal(reducer.snapshot.currentEpisode?.segments?.length, 2);

  reducer.control("next", "director", resetCursor);
  assert.equal(reducer.snapshot.run.phase, "active-task");
  assert.equal(reducer.snapshot.run.activeTaskIndex, 1);
  assert.equal(reducer.snapshot.currentEpisode?.segments?.length, 2);
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[1]?.outcome, "recording");

  next(reducer);
  assert.equal(reducer.snapshot.run.phase, "post-task-pause");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[1]?.outcome, "completed");
});

test("cycle finalisation requires durable recorder slots for every task segment", () => {
  const { reducer } = readyReducer("direct-segment-coverage", (configuration) => {
    configuration.tasks = [
      { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
      { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
    ];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);
  next(reducer);
  next(reducer);
  next(reducer);

  const summary = validSummaryFor(reducer);
  summary.segmentSummaries["cycle-episode-1-segment-2"] = {
    frameCount: 0,
    gapCount: 0,
    recorderSlotCount: 0,
  };
  reducer.recordingFinalised("cycle-episode-1", summary);

  assert.equal(reducer.snapshot.episodes.length, 0);
  assert.equal(reducer.snapshot.attempts[0]?.integrityReason, "Task segment Task B has no durable recorder slots");
  assert.deepEqual(reducer.snapshot.attempts[0]?.segments?.map(({ accepted }) => accepted), [false, false]);
});

test("cycle finalisation rejects recorder rows outside durable task segments", () => {
  const reducer = readyReducer("direct-segment-leakage").reducer;
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);
  next(reducer);
  const summary = validSummaryFor(reducer);
  summary.frameCount = 2;
  summary.recorderSlotCount = 2;
  reducer.recordingFinalised("cycle-episode-1", summary);

  assert.equal(reducer.snapshot.episodes.length, 0);
  assert.match(reducer.snapshot.attempts[0]?.integrityReason ?? "", /frames are not fully attributed/);
});

test("configured pauses keep the cycle episode paused before the next task segment", () => {
  const { reducer, setNow } = readyReducer("direct-configured-pause", (configuration) => {
    configuration.tasks = [
      { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 0 },
      { id: "pause-a", label: "Reset", instructions: "Reset", type: "pause", durationS: 2 },
      { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 0 },
    ];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);
  next(reducer);
  assert.equal(reducer.snapshot.run.phase, "task-pause");
  assert.equal(reducer.snapshot.run.recordingState, "paused");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.length, 1);

  setNow(reducer.snapshot.run.resetDeadlineMs!);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.activeTaskIndex, 2);
  assert.equal(reducer.snapshot.run.recordingState, "recording");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.length, 2);
});

test("timed completion pauses the cycle episode and reset expiry reaches finalisation", () => {
  const { reducer, setNow } = readyReducer("direct-timed", (configuration) => {
    configuration.tasks = [{
      id: "timed-a",
      label: "Timed A",
      instructions: "Reach",
      type: "timed",
      durationS: 1,
      repeatCount: 1,
      resetTimeS: 1,
    }];
  });
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  setNow(2_000);
  const completion = reducer.advanceTime();
  assert.equal(reducer.snapshot.run.phase, "post-task-pause");
  assert.equal(reducer.snapshot.run.recordingState, "paused");
  assert.deepEqual(
    completion.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-paused", "recording-event"],
  );

  setNow(7_000);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.phase, "cycle-pause");
  assert.equal(reducer.snapshot.run.recordingState, "stopping");
});

test("source timestamp run events are applied to cycle segments at finalisation", () => {
  const { reducer } = readyReducer("direct-source-events");
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  next(reducer);
  resetControl(reducer, "success", "director");
  next(reducer);
  const segmentId = "cycle-episode-1-segment-1";
  reducer.recordingFinalised("cycle-episode-1", {
    ...validSummaryFor(reducer),
    runEvents: [
      { sequence: 0, sourceTimestampUs: 1_000_000, event: { type: "segment-start", segmentId, taskId: "task-001", taskLabel: "Open task" } },
      { sequence: 1, sourceTimestampUs: 2_000_000, event: { type: "segment-end", segmentId, taskId: "task-001", taskLabel: "Open task" } },
      {
        sequence: 2,
        sourceTimestampUs: 2_100_000,
        event: {
          type: "annotation",
          segmentId,
          annotationId: `${segmentId}-annotation-2`,
          action: "pass",
          actor: "director",
        },
      },
    ],
  });
  const segment = reducer.snapshot.episodes[0]?.segments?.[0];
  assert.equal(segment?.startSourceTimestampUs, 1_000_000);
  assert.equal(segment?.endSourceTimestampUs, 2_000_000);
  assert.equal(segment?.annotations.find(({ action }) => action === "pass")?.sourceTimestampUs, 2_100_000);
});

test("invalid direct finalisation summaries fail closed without stranding the run", () => {
  const readyToFinalise = (sessionId: string) => {
    const reducer = readyReducer(sessionId).reducer;
    reducer.control("start-sequence");
    reducer.recordingAccepted("cycle-episode-1");
    next(reducer);
    next(reducer);
    return reducer;
  };

  const unknown = readyToFinalise("direct-unknown-event");
  unknown.recordingFinalised("cycle-episode-1", {
    ...validSummaryFor(unknown),
    runEvents: [{
      sequence: 0,
      sourceTimestampUs: 1_000_000,
      event: {
        type: "segment-start",
        segmentId: "forged-segment",
        taskId: "task-001",
        taskLabel: "Open task",
      },
    }],
  });
  assert.equal(unknown.snapshot.run.status, "error");
  assert.equal(unknown.snapshot.run.recordingState, "idle");
  assert.equal(unknown.snapshot.currentEpisode, null);
  assert.match(unknown.snapshot.attempts[0]?.integrityReason ?? "", /unknown task segment/);

  const conflicting = readyToFinalise("direct-conflicting-event");
  const segmentId = "cycle-episode-1-segment-1";
  conflicting.recordingFinalised("cycle-episode-1", {
    ...validSummaryFor(conflicting),
    runEvents: [
      {
        sequence: 0,
        sourceTimestampUs: 1_000_000,
        event: { type: "segment-start", segmentId, taskId: "task-001", taskLabel: "Open task" },
      },
      {
        sequence: 1,
        sourceTimestampUs: 1_100_000,
        event: { type: "segment-start", segmentId, taskId: "task-001", taskLabel: "Open task" },
      },
    ],
  });
  assert.equal(conflicting.snapshot.run.status, "error");
  assert.equal(conflicting.snapshot.run.recordingState, "idle");
  assert.equal(conflicting.snapshot.currentEpisode, null);
  assert.equal(conflicting.snapshot.attempts[0]?.segments?.[0]?.startSourceTimestampUs, undefined);
  assert.match(conflicting.snapshot.attempts[0]?.integrityReason ?? "", /source timestamp conflicts/);

  const missingEnd = readyToFinalise("direct-missing-segment-end");
  const missingEndSummary = validSummaryFor(missingEnd);
  missingEndSummary.runEvents = [missingEndSummary.runEvents[0]!];
  missingEnd.recordingFinalised("cycle-episode-1", missingEndSummary);
  assert.equal(missingEnd.snapshot.run.status, "error");
  assert.match(missingEnd.snapshot.attempts[0]?.integrityReason ?? "", /no durable segment-end event/);

  const reversed = readyToFinalise("direct-reversed-segment-bounds");
  const reversedSummary = validSummaryFor(reversed);
  reversedSummary.runEvents = [
    { ...reversedSummary.runEvents[0]!, sourceTimestampUs: 2_000_000 },
    { ...reversedSummary.runEvents[1]!, sourceTimestampUs: 1_000_000 },
  ];
  reversed.recordingFinalised("cycle-episode-1", reversedSummary);
  assert.equal(reversed.snapshot.run.status, "error");
  assert.match(reversed.snapshot.attempts[0]?.integrityReason ?? "", /precedes its durable segment-start event/);
});

test("stop and recorder rejection fail closed without accepting a cycle", () => {
  const stoppedFixture = readyReducer("direct-stop");
  const stopped = stoppedFixture.reducer;
  stopped.control("start-sequence");
  stopped.recordingAccepted("cycle-episode-1");
  const stopCommands = stopped.control("stop");
  assert.deepEqual(
    stopCommands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-paused", "recording-event", "recording-stopping"],
  );
  assert.equal(stopped.snapshot.run.status, "running");
  assert.equal(stopped.snapshot.run.recordingState, "stopping");
  const stoppedSummary = validSummaryFor(stopped);
  stoppedSummary.frameCount = 0;
  stoppedSummary.recorderSlotCount = 0;
  for (const segment of Object.values(stoppedSummary.segmentSummaries)) {
    segment.frameCount = 0;
    segment.recorderSlotCount = 0;
  }
  stoppedFixture.setNow(2_000);
  stopped.recordingFinalised("cycle-episode-1", stoppedSummary);
  assert.equal(stopped.snapshot.run.status, "stopped");
  assert.equal(stopped.snapshot.run.startedAtMs, 1_000);
  assert.equal(stopped.snapshot.run.endedAtMs, 2_000);
  assert.equal(stopped.snapshot.captureStatus.recorder, "armed");
  assert.equal(stopped.snapshot.captureStatus.lastError, null);
  assert.equal(stopped.snapshot.episodes.length, 0);
  assert.equal(stopped.snapshot.attempts[0]?.outcome, "stopped");

  const rejected = readyReducer("direct-rejected").reducer;
  rejected.control("start-sequence");
  rejected.recordingRejected("cycle-episode-1", "Recorder unavailable");
  assert.equal(rejected.snapshot.run.status, "error");
  assert.equal(rejected.snapshot.captureStatus.recorder, "failed");
  assert.equal(rejected.snapshot.attempts[0]?.segments?.[0]?.outcome, "stopped");
});

for (const actor of ["director", "demonstrator"] as const) test(`${actor} finish preserves a partial cycle only after recorder finalisation`, () => {
  const fixture = readyReducer(`direct-finish-${actor}`, (configuration) => {
    configuration.totalCycles = 3;
    configuration.tasks = [
      { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 2, resetTimeS: 5 },
      { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
    ];
  });
  const { reducer } = fixture;
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");

  const finishCursor = nextRunControlCursor(reducer.snapshot, "finish");
  const cursorless = reducer.control("finish", actor);
  assert.equal(cursorless.some((command) => command.type === "control"), false);
  assert.equal(reducer.snapshot.run.recordingState, "recording");
  const stale = reducer.control("finish", actor, "stale-finish-cursor");
  assert.equal(stale.some((command) => command.type === "control"), false);
  assert.equal(reducer.snapshot.run.recordingState, "recording");
  const finishCommands = reducer.control("finish", actor, finishCursor);
  assert.deepEqual(
    finishCommands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-paused", "recording-event", "recording-stopping"],
  );
  assert.equal(reducer.snapshot.run.status, "running");
  assert.equal(reducer.snapshot.run.recordingState, "stopping");
  assert.equal(reducer.snapshot.episodes.length, 0);
  assert.equal(reducer.snapshot.currentEpisode?.runFinalisation, "finish-requested");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[0]?.outcome, "completed");
  assert.equal(reducer.snapshot.currentEpisode?.segments?.[0]?.accepted, false);
  assert.equal(reducer.snapshot.run.phase, null);
  assert.equal(reducer.snapshot.run.resetDeadlineMs, null);
  assert.equal(
    reducer.control("finish", actor, finishCursor).some((command) => command.type === "control"),
    false,
  );
  assert.throws(() => reducer.control("finish", actor, nextRunControlCursor(reducer.snapshot, "finish")), /already finalising/);
  fixture.setNow(60_000);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.recordingState, "stopping");
  assert.equal(reducer.snapshot.run.activeTaskIndex, 0);
  assert.equal(reducer.snapshot.run.cycle, 1);

  fixture.setNow(61_000);
  reducer.recordingFinalised("cycle-episode-1", validSummaryFor(reducer));

  assert.equal(reducer.snapshot.run.status, "complete");
  assert.equal(reducer.snapshot.run.phase, null);
  assert.equal(reducer.snapshot.run.recordingState, "idle");
  assert.equal(reducer.snapshot.run.endedAtMs, 61_000);
  assert.equal(reducer.snapshot.currentEpisode, null);
  assert.equal(reducer.snapshot.attempts.length, 0);
  assert.equal(reducer.snapshot.episodes[0]?.outcome, "completed");
  assert.equal(reducer.snapshot.episodes[0]?.accepted, true);
  assert.equal(reducer.snapshot.episodes[0]?.runFinalisation, "finish-completed");
  assert.equal(reducer.snapshot.episodes[0]?.segments?.[0]?.outcome, "completed");
  assert.equal(reducer.snapshot.episodes[0]?.segments?.[0]?.accepted, true);
  assert.equal(reducer.snapshot.episodes[0]?.frameCount, 1);
  assert.equal(reducer.snapshot.episodes[0]?.mediaChunkCount, 1);
  assert.equal(isExportableEpisode(reducer.snapshot.episodes[0]), true);
  assert.deepEqual(reducer.snapshot.episodes[0]?.segments?.map(({ taskId }) => taskId), ["task-a"]);
  assert.equal(reducer.control("finish", actor, finishCursor).some((command) => command.type === "control"), false);
  fixture.setNow(120_000);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.status, "complete");
  assert.equal(reducer.snapshot.run.cycle, 1);
  assert.equal(reducer.snapshot.pendingEpisode, null);
});

for (const actor of ["director", "demonstrator"] as const) test(`${actor} finish waits for direct recorder acceptance before closing a segment`, () => {
  const { reducer } = readyReducer("direct-finish-during-arming");
  reducer.control("start-sequence");
  const armingCursor = nextRunControlCursor(reducer.snapshot, "finish");

  assert.throws(
    () => reducer.control("finish", actor, armingCursor),
    /accept the recording before finishing/,
  );
  assert.equal(reducer.snapshot.run.recordingState, "arming");
  assert.equal(reducer.snapshot.pendingEpisode?.segments?.[0]?.outcome, "recording");
  assert.equal(reducer.snapshot.pendingEpisode?.runFinalisation, undefined);

  reducer.recordingAccepted("cycle-episode-1");
  const commands = reducer.control(
    "finish",
    actor,
    nextRunControlCursor(reducer.snapshot, "finish"),
  );
  assert.deepEqual(
    commands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-paused", "recording-event", "recording-stopping"],
  );
});

for (const phase of ["paused", "reset", "cycle-pause"] as const) test(`director finish completes from ${phase} without advancing another task or cycle`, () => {
  const fixture = readyReducer(`direct-finish-${phase}`, (configuration) => {
    configuration.totalCycles = 3;
    configuration.tasks = [{ id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 }];
  });
  const { reducer } = fixture;
  reducer.control("start-sequence");
  reducer.recordingAccepted("cycle-episode-1");
  if (phase === "paused") reducer.control("pause");
  else {
    next(reducer);
    if (phase === "cycle-pause") {
      next(reducer);
      reducer.recordingFinalised("cycle-episode-1", validSummaryFor(reducer));
    }
  }
  reducer.control("finish", "director", nextRunControlCursor(reducer.snapshot, "finish"));
  fixture.setNow(60_000);
  reducer.advanceTime();
  assert.equal(reducer.snapshot.run.cycle, 1);
  assert.equal(reducer.snapshot.pendingEpisode, null);
  if (phase !== "cycle-pause") {
    assert.equal(reducer.snapshot.run.recordingState, "stopping");
    assert.equal(reducer.snapshot.episodes.length, 0);
    reducer.recordingFinalised("cycle-episode-1", validSummaryFor(reducer));
  }
  assert.equal(reducer.snapshot.run.status, "complete");
  assert.equal(reducer.snapshot.episodes.length, 1);
  assert.equal(isExportableEpisode(reducer.snapshot.episodes[0]), true);
});

test("post-task-pause Finish survives a direct authority restart as terminal finalisation", () => {
  const source = readyReducer("direct-finish-post-task-restart").reducer;
  source.control("start-sequence");
  source.recordingAccepted("cycle-episode-1");
  next(source, "demonstrator");
  assert.equal(source.snapshot.run.phase, "post-task-pause");
  assert.equal(source.snapshot.run.recordingState, "paused");

  const commands = source.control(
    "finish",
    "demonstrator",
    nextRunControlCursor(source.snapshot, "finish"),
  );
  assert.equal(source.snapshot.currentEpisode?.runFinalisation, "finish-requested");
  assert.equal(source.snapshot.run.recordingState, "stopping");
  assert.deepEqual(
    commands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-stopping"],
  );

  const restored = new DirectSessionReducer("direct-finish-post-task-restart");
  restored.restore(source.snapshot, true);
  const recovery = restored.synchronise().at(-1);
  assert.equal(recovery?.type === "control" ? recovery.action : null, "recording-recover-stopping");
  restored.recordingFinalised("cycle-episode-1", validSummaryFor(restored));
  assert.equal(restored.snapshot.run.status, "complete");
  assert.equal(restored.snapshot.episodes[0]?.runFinalisation, "finish-completed");
});

test("stop during recorder arming settles late acceptance and rejection", () => {
  const accepted = readyReducer("direct-stop-during-arming-accepted").reducer;
  accepted.control("start-sequence");
  accepted.control("stop");
  assert.equal(accepted.snapshot.run.status, "running");
  assert.equal(accepted.snapshot.run.recordingState, "stopping");
  assert.equal(accepted.snapshot.pendingEpisode?.id, "cycle-episode-1");
  const acceptedCommands = accepted.recordingAccepted("cycle-episode-1");
  assert.deepEqual(
    acceptedCommands.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-started", "recording-stopping"],
  );
  assert.equal(accepted.snapshot.pendingEpisode, null);
  assert.equal(accepted.snapshot.currentEpisode?.id, "cycle-episode-1");
  accepted.recordingFinalised("cycle-episode-1", validSummaryFor(accepted));
  assert.equal(accepted.snapshot.run.status, "stopped");
  assert.equal(accepted.snapshot.run.recordingState, "idle");
  assert.equal(accepted.snapshot.attempts.filter(({ id }) => id === "cycle-episode-1").length, 1);
  assert.deepEqual(accepted.recordingAccepted("cycle-episode-1"), []);
  assert.deepEqual(accepted.recordingRejected("cycle-episode-1", "stale rejection"), []);
  assert.deepEqual(accepted.recordingFinalised("cycle-episode-1", validSummary), []);

  const rejected = readyReducer("direct-stop-during-arming-rejected").reducer;
  rejected.control("start-sequence");
  rejected.control("stop");
  rejected.recordingRejected("cycle-episode-1", "Recorder unavailable");
  assert.equal(rejected.snapshot.run.status, "stopped");
  assert.equal(rejected.snapshot.run.recordingState, "idle");
  assert.equal(rejected.snapshot.pendingEpisode, null);
  assert.equal(rejected.snapshot.attempts[0]?.id, "cycle-episode-1");
  assert.equal(rejected.snapshot.attempts[0]?.integrity, "interrupted");
});

test("restoring a stop-pending arm transition recovers arming before stopping", () => {
  const source = readyReducer("direct-stop-during-arming-reconnect").reducer;
  source.control("start-sequence");
  source.control("stop");

  const restored = new DirectSessionReducer("direct-stop-during-arming-reconnect");
  restored.restore(source.snapshot, true);
  const recovery = restored.synchronise().at(-1);
  assert.equal(recovery?.type === "control" ? recovery.action : null, "recording-recover-arming");
  assert.equal(recovery?.type === "control" ? recovery.episode?.id : null, "cycle-episode-1");
  const commands = restored.recordingAccepted("cycle-episode-1");
  assert.equal(commands.some((command) => command.type === "control" && command.action === "recording-stopping"), true);
});

test("restoring a current stopping episode recovers and settles finalisation once", () => {
  const source = readyReducer("direct-stopping-reconnect").reducer;
  source.control("start-sequence");
  source.recordingAccepted("cycle-episode-1");
  source.control("stop");

  const restored = new DirectSessionReducer("direct-stopping-reconnect");
  restored.restore(source.snapshot, true);
  const recovery = restored.synchronise().at(-1);
  assert.equal(recovery?.type === "control" ? recovery.action : null, "recording-recover-stopping");
  restored.recordingFinalised("cycle-episode-1", validSummaryFor(restored));
  assert.equal(restored.snapshot.run.status, "stopped");
  assert.equal(restored.snapshot.attempts.filter(({ id }) => id === "cycle-episode-1").length, 1);
  assert.deepEqual(restored.recordingFinalised("cycle-episode-1", validSummary), []);
});

test("missing summaries and explicit finalisation errors settle as interrupted attempts", () => {
  const missing = readyReducer("direct-missing-summary").reducer;
  missing.control("start-sequence");
  missing.recordingAccepted("cycle-episode-1");
  next(missing);
  next(missing);
  missing.recordingFinalised("cycle-episode-1", undefined);
  assert.equal(missing.snapshot.run.status, "error");
  assert.match(missing.snapshot.attempts[0]?.integrityReason ?? "", /no sensor frames/);

  const explicit = readyReducer("direct-explicit-finalisation-error").reducer;
  explicit.control("start-sequence");
  explicit.recordingAccepted("cycle-episode-1");
  next(explicit);
  next(explicit);
  explicit.recordingFinalised("cycle-episode-1", validSummaryFor(explicit), "Terminal audio journalling failed");
  assert.equal(explicit.snapshot.run.status, "error");
  assert.equal(explicit.snapshot.attempts[0]?.integrityReason, "Terminal audio journalling failed");
});

test("restoring an arming cycle preserves recorder recovery and live transport authority", () => {
  const source = readyReducer("direct-restore").reducer;
  source.control("start-sequence");
  const restored = new DirectSessionReducer("direct-restore");
  restored.restore(source.snapshot, true);
  assert.equal(restored.snapshot.captureConnected, true);
  const recovery = restored.synchronise().at(-1);
  assert.equal(recovery?.type === "control" ? recovery.action : null, "recording-recover-arming");
  assert.equal(recovery?.type === "control" ? recovery.episode?.id : null, "cycle-episode-1");
});

test("restoring a legacy snapshot supplies recorder finalisation progress defaults", () => {
  const source = readyReducer("direct-legacy-progress").reducer.snapshot;
  const legacyCaptureStatus = source.captureStatus as unknown as Record<string, unknown>;
  delete legacyCaptureStatus.recorderQueuedBlocks;
  delete legacyCaptureStatus.recorderFinaliseStartAckSequence;
  delete legacyCaptureStatus.recorderFinaliseTargetSequence;

  const restored = new DirectSessionReducer("direct-legacy-progress");
  restored.restore(source);

  assert.equal(restored.snapshot.captureStatus.recorderQueuedBlocks, 0);
  assert.equal(restored.snapshot.captureStatus.recorderFinaliseStartAckSequence, null);
  assert.equal(restored.snapshot.captureStatus.recorderFinaliseTargetSequence, null);
});
