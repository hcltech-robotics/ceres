import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultCaptureStatus,
  SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
  type Episode,
  type SessionSnapshot,
  type SoloStorageHeadroom,
  type VerifiedEpisodeHuggingFaceUpload,
} from "../shared/protocol.js";
import { taskSpecificationSha256Hex } from "../shared/task-specification.js";
import type { DirectCaptureCommand } from "../src/direct-session-reducer.js";
import type { MonitorRecordingSummary } from "../src/recorder/monitor-recording-summary.js";
import { runControls } from "../src/run-presentation.js";
import { SoloSessionController, type SoloSessionControllerOptions } from "../src/solo-session-controller.js";
import type {
  SoloRecorderControlMessage,
  SoloSessionOpenResult,
  SoloSessionPersistencePort,
} from "../src/solo-session-persistence.js";

class FakeSoloPersistence implements SoloSessionPersistencePort {
  readonly saved: SessionSnapshot[] = [];
  readonly controls: SoloRecorderControlMessage[] = [];
  opened: SoloSessionOpenResult = { snapshot: null, nextSequence: 0 };
  summary: MonitorRecordingSummary = {
    frameCount: 1,
    gapCount: 0,
    mediaChunkCount: 0,
    recorderSlotCount: 1,
    firstRecorderSequence: 0,
    lastRecorderSequence: 0,
  };
  readonly summarisedEpisodeIds: string[] = [];
  summaryPromise: Promise<MonitorRecordingSummary> | null = null;
  storageHeadroom: SoloStorageHeadroom = {
    state: "ready",
    availableBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES * 2,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs: 0,
    detail: "1024 MiB is available for Solo capture",
  };
  storageChecks = 0;
  failNextSave: Error | null = null;
  controlSink: ((message: SoloRecorderControlMessage) => void) | null = null;

  async open() {
    return structuredClone(this.opened);
  }

  async checkStorageHeadroom() {
    this.storageChecks += 1;
    return structuredClone(this.storageHeadroom);
  }

  async saveSnapshot(snapshot: SessionSnapshot) {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    this.saved.push(structuredClone(snapshot));
  }

  appendRecorderBlock() {
    return true;
  }

  async summarise(episodeId: string): Promise<MonitorRecordingSummary> {
    this.summarisedEpisodeIds.push(episodeId);
    if (this.summaryPromise) return this.summaryPromise;
    return structuredClone(this.summary);
  }

  sendRecorderReady(nextSequence: number) {
    const message = {
      type: "recorder-ready" as const,
      sessionId: this.saved.at(-1)!.sessionId,
      nextSequence,
    };
    this.controls.push(message);
    this.controlSink?.(message);
  }

  setRecorderControlSink(sink: ((message: SoloRecorderControlMessage) => void) | null) {
    this.controlSink = sink;
  }

  async close() {}
}

async function readySoloController(
  sessionId: string,
  nowRef: { value: number },
  persistence = new FakeSoloPersistence(),
  options: Pick<
    SoloSessionControllerOptions,
    "finalisationSummaryTimeoutMs" | "recoveredRecorderTimeoutMs"
  > = {},
) {
  const commandCommits: Array<{ commands: readonly DirectCaptureCommand[]; saveCount: number }> = [];
  const controller = new SoloSessionController(sessionId, {
    persistence,
    now: () => nowRef.value,
    allocateId: () => "solo-episode-0001",
    ...options,
    applyCaptureCommands: (commands) => {
      commandCommits.push({ commands: structuredClone(commands), saveCount: persistence.saved.length });
    },
  });
  await controller.mount(true);
  await controller.setCaptureStatus({
    ...defaultCaptureStatus,
    camera: "ready",
    xr: "active",
    recorder: "armed",
    handTracking: "active",
    leftHandTracked: true,
    rightHandTracked: true,
  });
  commandCommits.length = 0;
  return { controller, persistence, commandCommits };
}

test("bounds an unavailable recorder summary so Solo finalisation can settle", async () => {
  const now = { value: 10_000 };
  const persistence = new FakeSoloPersistence();
  persistence.summaryPromise = new Promise<MonitorRecordingSummary>(() => undefined);
  const { controller } = await readySoloController(
    "solo_finalisation_timeout",
    now,
    persistence,
    { finalisationSummaryTimeoutMs: 5 },
  );

  await controller.selectStartTask("task-001");
  now.value = 13_000;
  await controller.advanceTime();
  await controller.recordingAccepted("solo-episode-0001");
  await controller.control("stop");
  await controller.handleRecorderResult({
    type: "recording-finalised",
    episodeId: "solo-episode-0001",
  });

  assert.deepEqual(persistence.summarisedEpisodeIds, ["solo-episode-0001"]);
  assert.equal(controller.snapshot.run.status, "stopped");
  assert.equal(controller.snapshot.run.recordingState, "idle");
  assert.equal(controller.snapshot.currentEpisode, null);
  assert.match(
    controller.snapshot.attempts[0]?.integrityReason ?? "",
    /finalisation timed out/,
  );
});

function blockedStorageHeadroom(checkedAtMs: number): SoloStorageHeadroom {
  return {
    state: "blocked",
    availableBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES - 1,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs,
    detail: "Solo capture requires at least 512 MiB of available storage",
  };
}

test("persists the immersive Solo workspace across a headset reload", async () => {
  const sessionId = "solo_workspace_restore";
  const now = { value: 100 };
  const persistence = new FakeSoloPersistence();
  const source = await readySoloController(sessionId, now, persistence);
  const workspace = {
    page: "export" as const,
    focusedTaskId: "task-001",
    selectedEpisodeIds: ["episode-001"],
    repositorySettings: {
      organisation: "hcltech-robotics",
      repository: "solo-dataset",
      branch: "main",
      visibility: "private" as const,
      missingRepositoryBehaviour: "private" as const,
    },
    exportSettings: {
      destination: "hugging-face" as const,
      huggingFaceCadence: "cycle" as const,
    },
    runEditorReviewed: true,
  };

  await source.controller.setWorkspace(workspace);

  assert.deepEqual(source.controller.snapshot.solo?.workspace, workspace);
  assert.deepEqual(persistence.saved.at(-1)?.solo?.workspace, workspace);
  persistence.opened = {
    snapshot: source.controller.snapshot,
    nextSequence: 0,
  };
  await source.controller.dispose();
  const restored = new SoloSessionController(sessionId, { persistence });
  await restored.mount(false);
  assert.deepEqual(restored.snapshot.solo?.workspace, workspace);
  await restored.dispose();
});

test("persists hand display changes and forwards them to the headset capture sink", async () => {
  const sessionId = "solo_hand_display";
  const now = { value: 100 };
  const source = await readySoloController(sessionId, now);
  const settings = {
    handMode: "keypoints" as const,
    handShading: "motion" as const,
    handTrail: "cog" as const,
  };

  await source.controller.setHandDisplay(settings);

  assert.deepEqual(source.controller.snapshot.handDisplay, settings);
  assert.deepEqual(source.persistence.saved.at(-1)?.handDisplay, settings);
  assert.deepEqual(source.commandCommits.at(-1)?.commands, [{
    type: "hand-display",
    settings,
  }]);
  await source.controller.dispose();
});

test("stores backend upload proof durably in the headset-local Solo catalogue", async () => {
  const sessionId = "solo_verified_upload";
  const now = { value: 100 };
  const source = await readySoloController(sessionId, now);
  const snapshot = source.controller.snapshot;
  const episode: Episode = {
    id: "solo-episode-upload-1",
    runTitle: "Solo upload",
    runDescription: "Persist verified proof",
    taskId: "task-001",
    taskLabel: "Open task",
    taskDescription: "Persist verified proof",
    cycle: 1,
    repetition: 1,
    take: 1,
    startedAt: "2026-07-25T12:00:00.000Z",
    endedAt: "2026-07-25T12:00:01.000Z",
    outcome: "completed",
    annotation: null,
    accepted: true,
    integrity: "valid",
    frameCount: 1,
    mediaChunkCount: 0,
    recorderSlotCount: 1,
    gapCount: 0,
    qualitySummary: {
      decision: "go",
      reasons: [],
      frameCount: 1,
      gapCount: 0,
      maxLeftHandSpeedMps: 0,
      maxRightHandSpeedMps: 0,
      slowHandEvents: 0,
      trackingLossEvents: 0,
    },
    qualityEvents: [],
    operatingMode: "solo",
    selectedStartTaskId: "task-001",
    startCountdownMs: 3_000,
  };
  snapshot.episodes = [episode];
  const persistence = new FakeSoloPersistence();
  persistence.opened = { snapshot, nextSequence: 0 };
  const controller = new SoloSessionController(sessionId, {
    persistence,
    now: () => now.value,
  });
  await controller.mount(true);
  const upload: VerifiedEpisodeHuggingFaceUpload = {
    state: "completed",
    requestId: `hf_upload_${"a".repeat(24)}`,
    jobId: `hf_upload_${"a".repeat(24)}`,
    captureSessionId: sessionId,
    episodeIds: [episode.id],
    completionReceipt: `ceres-hf-upload-receipt.v1.${"d".repeat(96)}`,
    manifestHash: "b".repeat(64),
    repository: "research/ceres-session",
    branch: "main",
    visibility: "private",
    outcome: "uploaded",
    uploadedAt: "2026-07-25T12:00:02.000Z",
    commitOid: "c".repeat(40),
    commitUrl: `https://huggingface.co/datasets/research/ceres-session/commit/${"c".repeat(40)}`,
    verifiedAt: "2026-07-25T12:00:01.000Z",
  };

  await controller.recordEpisodeUpload([episode.id], upload);
  assert.deepEqual(
    persistence.saved.at(-1)?.episodes[0]?.huggingFaceUpload,
    upload,
  );
  await assert.rejects(
    (controller.recordEpisodeUpload as unknown as (
      episodeIds: string[],
      value: Record<string, unknown>,
    ) => Promise<unknown>)([episode.id], {
      state: "completed",
      repository: "research/forged",
      branch: "main",
      outcome: "uploaded",
      uploadedAt: "2026-07-25T12:00:02.000Z",
    }),
    /verified backend receipt/,
  );
});

test("persists authoritative storage headroom and blocks Solo sequence readiness", async () => {
  const now = { value: 250 };
  const persistence = new FakeSoloPersistence();
  persistence.storageHeadroom = blockedStorageHeadroom(now.value);
  const controller = new SoloSessionController("solo_storage_blocked", {
    persistence,
    now: () => now.value,
  });

  await controller.mount(true);

  assert.equal(persistence.storageChecks, 1);
  assert.deepEqual(
    controller.snapshot.solo?.storageHeadroom,
    persistence.storageHeadroom,
  );
  assert.deepEqual(
    persistence.saved.at(-1)?.solo?.storageHeadroom,
    persistence.storageHeadroom,
  );
  assert.equal(
    controller.snapshot.sequenceReadiness.blockers.some(({ code }) => code === "storage-not-ready"),
    true,
  );
});

test("revalidates persisted storage headroom when a Solo snapshot is restored", async () => {
  const now = { value: 375 };
  const source = await readySoloController("solo_storage_restore", now);
  assert.equal(source.controller.snapshot.solo?.storageHeadroom.state, "ready");

  const persistence = new FakeSoloPersistence();
  persistence.opened = {
    snapshot: source.controller.snapshot,
    nextSequence: 0,
  };
  persistence.storageHeadroom = blockedStorageHeadroom(now.value);
  const restored = new SoloSessionController("solo_storage_restore", {
    persistence,
    now: () => now.value,
  });

  await restored.mount(true);

  assert.equal(persistence.storageChecks, 1);
  assert.equal(restored.snapshot.solo?.storageHeadroom.state, "blocked");
  assert.equal(
    persistence.saved.at(-1)?.sequenceReadiness.blockers.some(
      ({ code }) => code === "storage-not-ready",
    ),
    true,
  );
});

test("revalidates storage before accepting a Solo start task", async () => {
  const now = { value: 500 };
  const { controller, persistence } = await readySoloController(
    "solo_storage_start_guard",
    now,
  );
  persistence.storageHeadroom = blockedStorageHeadroom(now.value);

  await assert.rejects(
    controller.selectStartTask("task-001"),
    /requires at least 512 MiB/,
  );

  assert.equal(persistence.storageChecks, 2);
  assert.equal(controller.snapshot.solo?.storageHeadroom.state, "blocked");
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(
    persistence.saved.at(-1)?.sequenceReadiness.blockers.some(
      ({ code }) => code === "storage-not-ready",
    ),
    true,
  );
});

test("revalidates storage during the countdown and cancels when readiness is lost", async () => {
  const now = { value: 1_000 };
  const { controller, persistence } = await readySoloController(
    "solo_storage_countdown",
    now,
  );
  await controller.selectStartTask("task-001");
  assert.equal(persistence.storageChecks, 2);
  persistence.storageHeadroom = blockedStorageHeadroom(2_000);

  now.value = 1_999;
  assert.deepEqual(await controller.advanceTime(), []);
  assert.equal(persistence.storageChecks, 2);
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, "task-001");

  now.value = 2_000;
  const cancelled = await controller.advanceTime();
  assert.equal(persistence.storageChecks, 3);
  assert.equal(cancelled.some((command) => command.type === "control"), false);
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(controller.snapshot.pendingEpisode, null);
  assert.equal(
    controller.snapshot.sequenceReadiness.blockers.some(({ code }) => code === "storage-not-ready"),
    true,
  );
});

test("forces a fresh storage check at the countdown deadline before recorder arming", async () => {
  const now = { value: 3_000 };
  const { controller, persistence } = await readySoloController(
    "solo_storage_deadline",
    now,
  );
  await controller.setPreferences({ startCountdownMs: 500 });
  await controller.selectStartTask("task-001");
  persistence.storageHeadroom = blockedStorageHeadroom(3_500);

  now.value = 3_500;
  const commands = await controller.advanceTime();

  assert.equal(persistence.storageChecks, 3);
  assert.equal(commands.some((command) => command.type === "control"), false);
  assert.equal(controller.snapshot.pendingEpisode, null);
  assert.equal(controller.snapshot.run.status, "stopped");
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(controller.snapshot.solo?.storageHeadroom.state, "blocked");
});

test("replays durable recorder readiness when the local recorder begins arming", async () => {
  const now = { value: 500 };
  const persistence = new FakeSoloPersistence();
  persistence.opened.nextSequence = 7;
  const controller = new SoloSessionController("solo_ready_replay", {
    persistence,
    now: () => now.value,
  });

  await controller.mount(true);
  assert.equal(persistence.controls.length, 1);
  await controller.setCaptureStatus({
    ...defaultCaptureStatus,
    recorder: "arming",
  });

  assert.deepEqual(persistence.controls.at(-1), {
    type: "recorder-ready",
    sessionId: "solo_ready_replay",
    nextSequence: 7,
  });
  assert.equal(persistence.controls.length, 2);
});

test("keeps high-rate recorder accounting volatile so block commits are not queued behind snapshots", async () => {
  const now = { value: 750 };
  const { controller, persistence, commandCommits } = await readySoloController(
    "solo_volatile_status",
    now,
  );
  const saveCount = persistence.saved.length;
  const commandCount = commandCommits.length;
  let publications = 0;
  const unsubscribe = controller.subscribe(() => {
    publications += 1;
  });

  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    handTracking: "active",
    recorderFrameIndex: 18,
    recorderPendingBlocks: 2,
    recorderDurableAckSequence: 15,
    sensorRateHz: 30,
    lastFrameAt: 730,
  });

  assert.equal(persistence.saved.length, saveCount);
  assert.equal(commandCommits.length, commandCount);
  assert.equal(publications, 1);
  assert.equal(controller.snapshot.captureStatus.recorderPendingBlocks, 2);
  assert.equal(controller.snapshot.captureStatus.recorderDurableAckSequence, 15);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(publications, 2);
  unsubscribe();
});

test("holds the Solo countdown until both hands are tracked when a controller made the selection", async () => {
  const now = { value: 1_000 };
  const { controller } = await readySoloController("solo_awaiting_hands", now);

  // The demonstrator is holding a controller, so neither hand is tracked.
  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    handTracking: "waiting",
    leftHandTracked: false,
    rightHandTracked: false,
  });

  await controller.selectStartTask("task-001");
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, "task-001");
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);

  // Time alone must not start the countdown while the hands are away.
  now.value = 9_000;
  await controller.advanceTime();
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(controller.snapshot.pendingEpisode, null);

  // One hand back is not enough for a hand demonstration.
  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    handTracking: "active",
    leftHandTracked: true,
    rightHandTracked: false,
  });
  await controller.advanceTime();
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);

  // Both hands free arms the countdown from that moment, not from the press.
  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    leftHandTracked: true,
    rightHandTracked: true,
  });
  await controller.advanceTime();
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, 12_000);
  assert.equal(controller.snapshot.pendingEpisode, null);

  now.value = 12_000;
  const started = await controller.advanceTime();
  assert.ok(controller.snapshot.pendingEpisode);
  assert.deepEqual(
    started.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-arming", "recording-event"],
  );
});

test("cancels a Solo countdown when either hand is lost before recorder arming", async () => {
  const now = { value: 1_000 };
  const { controller } = await readySoloController("solo_countdown_hand_loss", now);

  await controller.selectStartTask("task-001");
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, 4_000);

  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    handTracking: "active",
    leftHandTracked: false,
    rightHandTracked: true,
  });

  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  now.value = 4_000;
  assert.deepEqual(await controller.advanceTime(), []);
  assert.equal(controller.snapshot.pendingEpisode, null);
});

test("continues advancing a Solo run after its start selection is consumed", async () => {
  const now = { value: 1_000 };
  const { controller } = await readySoloController("solo_running_advance", now);
  const configuration = controller.snapshot.configuration;
  configuration.tasks[0] = {
    ...configuration.tasks[0]!,
    type: "timed",
    durationS: 1,
  };
  await controller.configure(configuration);
  const pending = controller.snapshot.configurationStatus;
  await controller.configurationApplied(pending.revision, pending.checksum);
  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    camera: "ready",
    xr: "active",
    recorder: "armed",
    leftHandTracked: true,
    rightHandTracked: true,
  });

  await controller.selectStartTask("task-001");
  now.value = 4_000;
  await controller.advanceTime();
  await controller.recordingAccepted("solo-episode-0001");
  now.value = 5_000;
  await controller.advanceTime();

  assert.notEqual(controller.snapshot.run.phase, "active-task");
});

test("normalises the default Solo countdown and starts only at its absolute deadline", async () => {
  const now = { value: 1_000 };
  const { controller, persistence, commandCommits } = await readySoloController(
    "solo_countdown_session",
    now,
  );

  const selected = await controller.selectStartTask("task-001");
  assert.equal(controller.snapshot.solo?.preferences.startCountdownMs, 3_000);
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, "task-001");
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, 4_000);
  assert.equal(controller.snapshot.pendingEpisode, null);
  assert.equal(selected.some((command) => command.type === "control"), false);

  now.value = 3_999;
  assert.equal(
    (await controller.advanceTime()).some((command) => command.type === "control"),
    false,
  );
  assert.equal(controller.snapshot.pendingEpisode, null);

  now.value = 4_000;
  const started = await controller.advanceTime();
  const episode = controller.snapshot.pendingEpisode;
  assert.ok(episode);
  assert.deepEqual(
    started.filter((command) => command.type === "control").map((command) => command.action),
    ["recording-arming", "recording-event"],
  );
  assert.equal(episode.operatingMode, "solo");
  assert.equal(episode.selectedStartTaskId, "task-001");
  assert.equal(episode.startCountdownMs, 3_000);
  assert.equal(episode.taskSpecVersion, 1);
  assert.equal(
    episode.taskSpecHash,
    await taskSpecificationSha256Hex(episode.taskSpecification),
  );
  assert.equal(episode.taskSpecification?.tasks[0]?.id, "task-001");
  assert.equal(commandCommits.at(-1)?.saveCount, persistence.saved.length);
  assert.equal(
    persistence.saved.at(-1)?.pendingEpisode?.id,
    "solo-episode-0001",
  );
});

test("starts from the deliberately selected task without changing duet readiness latches", async () => {
  const now = { value: 10_000 };
  const { controller } = await readySoloController("solo_selected_task", now);
  const configuration = controller.snapshot.configuration;
  configuration.tasks.push({
    id: "task-002",
    label: "Second task",
    instructions: "Place the object",
    type: "open",
    repeatCount: 1,
    resetTimeS: 5,
  });
  await controller.configure(configuration);
  const sent = controller.snapshot.configurationStatus;
  await controller.configurationApplied(sent.revision, sent.checksum);
  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    camera: "ready",
    xr: "active",
    recorder: "armed",
  });

  await controller.selectStartTask("task-002");
  now.value = 13_000;
  await controller.advanceTime();

  assert.equal(controller.snapshot.run.activeTaskIndex, 1);
  assert.equal(controller.snapshot.pendingEpisode?.taskId, "task-002");
  assert.equal(controller.snapshot.run.directorReady, false);
  assert.equal(controller.snapshot.run.demonstratorReady, false);
  assert.equal(controller.snapshot.run.syncLockStartedAtMs, null);
});

test("cancels a countdown when Solo runtime readiness is lost", async () => {
  const now = { value: 2_000 };
  const { controller } = await readySoloController("solo_cancel_readiness", now);
  await controller.selectStartTask("task-001");

  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    camera: "error",
    xr: "active",
    recorder: "armed",
  });

  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(
    controller.snapshot.sequenceReadiness.blockers.some(({ code }) => code === "camera-not-ready"),
    true,
  );
  now.value = 20_000;
  assert.deepEqual(await controller.advanceTime(), []);
  assert.equal(controller.snapshot.pendingEpisode, null);
});

test("cancels a countdown when Solo XR readiness is lost", async () => {
  const now = { value: 2_500 };
  const { controller } = await readySoloController("solo_cancel_xr", now);
  await controller.selectStartTask("task-001");

  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    camera: "ready",
    xr: "ended",
    recorder: "armed",
  });

  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(
    controller.snapshot.sequenceReadiness.blockers.some(({ code }) => code === "xr-not-active"),
    true,
  );
});

test("cancels a countdown when the Solo run configuration changes", async () => {
  const now = { value: 2_750 };
  const { controller } = await readySoloController("solo_cancel_configuration", now);
  await controller.selectStartTask("task-001");

  const configuration = controller.snapshot.configuration;
  configuration.runTitle = "Changed while waiting";
  await controller.configure(configuration);

  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  now.value = 20_000;
  assert.deepEqual(await controller.advanceTime(), []);
  assert.equal(controller.snapshot.pendingEpisode, null);
});

test("cancels a countdown when required Solo prompt audio is lost", async () => {
  const now = { value: 3_000 };
  const { controller } = await readySoloController("solo_cancel_prompt_audio", now);
  const configuration = controller.snapshot.configuration;
  configuration.promptAudio.enabled = true;
  configuration.promptAudio.required = true;
  configuration.promptAudio.taskStartAssetUrl = "/audio/task-start.mp3";
  await controller.configure(configuration);
  const pending = controller.snapshot.configurationStatus;
  await controller.configurationApplied(pending.revision, pending.checksum);
  await controller.setPromptAudioStatus({ state: "ready", detail: "Prompt audio ready" });
  await controller.setCaptureStatus({
    ...controller.snapshot.captureStatus,
    camera: "ready",
    xr: "active",
    recorder: "armed",
  });
  await controller.selectStartTask("task-001");

  await controller.setPromptAudioStatus({ state: "error", detail: "Prompt audio was lost" });

  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(
    controller.snapshot.sequenceReadiness.blockers.some(({ code }) => code === "audio-not-ready"),
    true,
  );
});

test("Stop cancels a Solo countdown without creating an episode", async () => {
  const now = { value: 3_250 };
  const { controller } = await readySoloController("solo_cancel_stop", now);
  await controller.selectStartTask("task-001");

  const commands = await controller.control("stop");

  assert.equal(commands.some((command) => command.type === "control"), false);
  assert.equal(commands.some((command) => command.type === "run-state"), true);
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(controller.snapshot.pendingEpisode, null);
});

test("disposing Solo authority durably cancels an active countdown", async () => {
  const now = { value: 3_500 };
  const { controller, persistence } = await readySoloController("solo_cancel_dispose", now);
  await controller.selectStartTask("task-001");

  await controller.dispose();

  const persisted = persistence.saved.at(-1);
  assert.equal(persisted?.solo?.selectedStartTaskId, null);
  assert.equal(persisted?.solo?.startCountdownDeadlineMs, null);
  assert.equal(persisted?.pendingEpisode, null);
});

test("restores a countdown as a cancelled launch state", async () => {
  const now = { value: 1_000 };
  const first = await readySoloController("solo_restore_countdown", now);
  await first.controller.selectStartTask("task-001");
  const interrupted = first.controller.snapshot;

  const persistence = new FakeSoloPersistence();
  persistence.opened = { snapshot: interrupted, nextSequence: 7 };
  const restored = new SoloSessionController("solo_restore_countdown", {
    persistence,
    now: () => now.value,
  });
  await restored.mount(true);

  assert.equal(restored.snapshot.solo?.selectedStartTaskId, null);
  assert.equal(restored.snapshot.solo?.startCountdownDeadlineMs, null);
  assert.equal(restored.snapshot.run.status, "stopped");
  assert.equal(restored.snapshot.pendingEpisode, null);
  assert.equal(persistence.controls.at(-1)?.type, "recorder-ready");
  assert.equal(
    persistence.controls.at(-1)?.type === "recorder-ready"
      ? persistence.controls.at(-1)?.nextSequence
      : null,
    7,
  );
});

async function stoppingSoloSnapshot(sessionId: string, now: { value: number }) {
  const source = await readySoloController(sessionId, now);
  await source.controller.selectStartTask("task-001");
  now.value += 3_000;
  await source.controller.advanceTime();
  await source.controller.recordingAccepted("solo-episode-0001");
  await source.controller.control("stop");
  return source.controller.snapshot;
}

test("defers interrupted recorder accounting until the recovered journal tail is durable", async () => {
  const now = { value: 20_000 };
  const { controller } = await readySoloController("solo_reload_source", now);
  await controller.selectStartTask("task-001");
  now.value = 23_000;
  await controller.advanceTime();
  const armingSnapshot = controller.snapshot;
  await controller.recordingAccepted("solo-episode-0001");
  const recordingSnapshot = controller.snapshot;

  for (const state of ["arming", "recording", "paused", "stopping"] as const) {
    const persistence = new FakeSoloPersistence();
    const recovered = structuredClone(state === "arming" ? armingSnapshot : recordingSnapshot);
    recovered.sessionId = `solo_reload_${state}`;
    recovered.run.recordingState = state;
    recovered.captureStatus.recorder = state === "stopping" ? "recording" : state;
    persistence.opened = { snapshot: recovered, nextSequence: 3 };
    persistence.summary = {
      frameCount: 2,
      gapCount: 0,
      mediaChunkCount: 0,
      recorderSlotCount: 2,
      firstRecorderSequence: 0,
      lastRecorderSequence: 1,
    };
    const commands: DirectCaptureCommand[] = [];
    const restored = new SoloSessionController(recovered.sessionId, {
      persistence,
      now: () => now.value,
      applyCaptureCommands: (next) => commands.push(...structuredClone(next)),
    });

    await restored.mount(false);
    await restored.synchronise();

    assert.equal(restored.snapshot.captureConnected, false);
    assert.equal(restored.snapshot.attempts.length, 0);
    assert.equal(persistence.summarisedEpisodeIds.length, 0);
    assert.equal(restored.snapshot.sequenceReadiness.ready, false);
    await restored.setCaptureConnected(true);
    await restored.setCaptureStatus({
      ...recovered.captureStatus,
      camera: "ready",
      xr: "active",
      recorder: "armed",
      recorderPendingBlocks: 1,
    });

    assert.equal(restored.snapshot.captureConnected, false);
    assert.equal(restored.snapshot.attempts.length, 0);
    assert.equal(persistence.summarisedEpisodeIds.length, 0);
    await restored.setCaptureStatus({
      ...restored.snapshot.captureStatus,
      recorder: "armed",
      recorderPendingBlocks: 0,
    });

    assert.equal(restored.snapshot.run.status, "stopped");
    assert.equal(restored.snapshot.run.recordingState, "idle");
    assert.equal(restored.snapshot.currentEpisode, null);
    assert.equal(restored.snapshot.pendingEpisode, null);
    assert.equal(restored.snapshot.attempts[0]?.integrity, "interrupted");
    assert.equal(restored.snapshot.attempts[0]?.frameCount, 2);
    assert.deepEqual(persistence.summarisedEpisodeIds, ["solo-episode-0001"]);
    assert.equal(restored.snapshot.captureConnected, true);
    assert.equal(restored.snapshot.sequenceReadiness.ready, true);
    assert.equal(
      restored.snapshot.attempts[0]?.integrityReason,
      "Solo recording was interrupted by a page reload before durable finalisation completed",
    );
    assert.equal(
      commands.some((command) => command.type === "control"
        && (command.action === "recording-recover-arming"
          || command.action === "recording-recover-stopping")),
      false,
    );
  }
});

test("fails closed when restored recorder recovery exceeds its deadline", async () => {
  const sessionId = "solo_reload_watchdog";
  const now = { value: 30_000 };
  const recovered = await stoppingSoloSnapshot(sessionId, now);
  const persistence = new FakeSoloPersistence();
  persistence.opened = { snapshot: recovered, nextSequence: 4 };
  const restored = new SoloSessionController(sessionId, {
    persistence,
    now: () => now.value,
    recoveredRecorderTimeoutMs: 5,
  });

  await restored.mount(true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await restored.synchronise();

  assert.equal(restored.snapshot.run.status, "stopped");
  assert.equal(restored.snapshot.run.recordingState, "idle");
  assert.equal(restored.snapshot.currentEpisode, null);
  assert.equal(restored.snapshot.pendingEpisode, null);
  assert.equal(restored.snapshot.captureStatus.recorder, "failed");
  assert.equal(restored.snapshot.captureConnected, false);
  assert.equal(restored.snapshot.attempts[0]?.integrity, "interrupted");
  assert.equal(
    restored.snapshot.attempts[0]?.integrityReason,
    "Solo recorder finalisation recovery timed out before the interrupted journal tail became durable",
  );
  assert.deepEqual(persistence.summarisedEpisodeIds, ["solo-episode-0001"]);
  assert.equal(persistence.saved.at(-1)?.run.recordingState, "idle");
  await restored.dispose();
});

test("recovers immediately from a restored recorder failure and preserves rollback", async () => {
  const sessionId = "solo_reload_failed_recorder";
  const now = { value: 40_000 };
  const recovered = await stoppingSoloSnapshot(sessionId, now);
  const persistence = new FakeSoloPersistence();
  persistence.opened = { snapshot: recovered, nextSequence: 5 };
  const restored = new SoloSessionController(sessionId, {
    persistence,
    now: () => now.value,
    recoveredRecorderTimeoutMs: 10_000,
  });
  const failedStatus = {
    ...recovered.captureStatus,
    recorder: "failed" as const,
    recorderPendingBlocks: 2,
    lastError: "Recovered durable recorder worker failed",
  };

  await restored.mount(true);
  persistence.failNextSave = new Error("Recovered snapshot save failed");
  await assert.rejects(
    restored.setCaptureStatus(failedStatus),
    /Recovered snapshot save failed/,
  );
  assert.equal(restored.snapshot.run.recordingState, "stopping");
  assert.equal(restored.snapshot.currentEpisode?.id, "solo-episode-0001");

  await restored.setCaptureStatus(failedStatus);

  assert.equal(restored.snapshot.run.status, "stopped");
  assert.equal(restored.snapshot.run.recordingState, "idle");
  assert.equal(restored.snapshot.captureStatus.recorder, "failed");
  assert.equal(restored.snapshot.attempts[0]?.integrity, "interrupted");
  assert.equal(
    restored.snapshot.attempts[0]?.integrityReason,
    "Recovered durable recorder worker failed",
  );
  assert.deepEqual(
    persistence.summarisedEpisodeIds,
    ["solo-episode-0001", "solo-episode-0001"],
  );
  await restored.dispose();
});

test("settles a persisted failed recorder during restored mount", async () => {
  const sessionId = "solo_reload_persisted_failure";
  const now = { value: 50_000 };
  const recovered = await stoppingSoloSnapshot(sessionId, now);
  recovered.captureStatus.recorder = "failed";
  recovered.captureStatus.lastError = "Persisted recorder failure";
  const persistence = new FakeSoloPersistence();
  persistence.opened = { snapshot: recovered, nextSequence: 6 };
  const restored = new SoloSessionController(sessionId, {
    persistence,
    now: () => now.value,
    recoveredRecorderTimeoutMs: 10_000,
  });

  await restored.mount(true);

  assert.equal(restored.snapshot.run.status, "stopped");
  assert.equal(restored.snapshot.run.recordingState, "idle");
  assert.equal(restored.snapshot.captureStatus.recorder, "failed");
  assert.equal(restored.snapshot.attempts[0]?.integrityReason, "Persisted recorder failure");
  assert.deepEqual(persistence.summarisedEpisodeIds, ["solo-episode-0001"]);
  await restored.dispose();
});

test("disposal cancels restored recorder recovery", async () => {
  const sessionId = "solo_reload_dispose_watchdog";
  const now = { value: 60_000 };
  const recovered = await stoppingSoloSnapshot(sessionId, now);
  const persistence = new FakeSoloPersistence();
  persistence.opened = { snapshot: recovered, nextSequence: 7 };
  const restored = new SoloSessionController(sessionId, {
    persistence,
    now: () => now.value,
    recoveredRecorderTimeoutMs: 5,
  });

  await restored.mount(true);
  await restored.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(restored.snapshot.run.recordingState, "stopping");
  assert.deepEqual(persistence.summarisedEpisodeIds, []);
});

test("starts an actionable active task after recovered recorder finalisation", async () => {
  const now = { value: 40_000 };
  const first = await readySoloController("solo_restart_recovered", now);
  await first.controller.selectStartTask("task-001");
  now.value = 43_000;
  await first.controller.advanceTime();
  await first.controller.recordingAccepted("solo-episode-0001");

  const persistence = new FakeSoloPersistence();
  persistence.opened = {
    snapshot: first.controller.snapshot,
    nextSequence: 2,
  };
  persistence.summary = {
    frameCount: 2,
    gapCount: 0,
    mediaChunkCount: 0,
    recorderSlotCount: 2,
    firstRecorderSequence: 0,
    lastRecorderSequence: 1,
  };
  const restored = new SoloSessionController("solo_restart_recovered", {
    persistence,
    now: () => now.value,
  });
  await restored.mount(false);
  await restored.setCaptureConnected(true);
  await restored.setCaptureStatus({
    ...restored.snapshot.captureStatus,
    camera: "ready",
    xr: "active",
    recorder: "armed",
    recorderPendingBlocks: 0,
  });

  await restored.selectStartTask("task-001");
  now.value = 46_000;
  await restored.advanceTime();
  const restartedEpisodeId = restored.snapshot.pendingEpisode?.id;
  assert.ok(restartedEpisodeId);
  await restored.recordingAccepted(restartedEpisodeId);

  assert.equal(restored.snapshot.run.status, "running");
  assert.equal(restored.snapshot.run.phase, "active-task");
  assert.equal(restored.snapshot.run.recordingState, "recording");
  assert.equal(
    runControls(restored.snapshot, true, "solo").find(({ action }) => action === "next")?.enabled,
    true,
  );
});

test("a completed Solo run returns to deliberate task selection without reconfiguration", async () => {
  const now = { value: 30_000 };
  const { controller } = await readySoloController("solo_restart_complete", now);
  const completed = controller.snapshot;
  completed.run.status = "complete";
  completed.run.phase = null;
  completed.run.recordingState = "idle";
  completed.run.endedAtMs = now.value;
  completed.currentEpisode = null;
  completed.pendingEpisode = null;
  completed.solo!.selectedStartTaskId = null;
  completed.solo!.startCountdownDeadlineMs = null;
  await controller.restore(completed, true);

  await controller.selectStartTask("task-001");

  assert.equal(controller.snapshot.run.status, "stopped");
  assert.equal(controller.snapshot.solo?.selectedStartTaskId, "task-001");
  assert.equal(controller.snapshot.solo?.startCountdownDeadlineMs, 33_000);
});

test("resets a completed Solo run without deleting retained captures or setup", async () => {
  const now = { value: 30_000 };
  const { controller, persistence } = await readySoloController("solo_reset_complete", now);
  const completed = controller.snapshot;
  const retainedEpisode: Episode = {
    id: "solo-episode-retained-1",
    runTitle: "Completed Solo run",
    runDescription: "Retain this capture after reset",
    taskId: "task-001",
    taskLabel: "Open task",
    taskDescription: "Retain this capture after reset",
    cycle: 1,
    repetition: 1,
    take: 1,
    startedAt: "2026-07-29T12:00:00.000Z",
    endedAt: "2026-07-29T12:00:01.000Z",
    outcome: "completed",
    annotation: null,
    accepted: true,
    integrity: "valid",
    frameCount: 1,
    mediaChunkCount: 0,
    recorderSlotCount: 1,
    gapCount: 0,
    qualitySummary: {
      decision: "go",
      reasons: [],
      frameCount: 1,
      gapCount: 0,
      maxLeftHandSpeedMps: 0,
      maxRightHandSpeedMps: 0,
      slowHandEvents: 0,
      trackingLossEvents: 0,
    },
    qualityEvents: [],
    operatingMode: "solo",
    selectedStartTaskId: "task-001",
    startCountdownMs: 3_000,
  };
  const workspace = {
    page: "run" as const,
    focusedTaskId: "task-001",
    selectedEpisodeIds: [retainedEpisode.id],
    repositorySettings: null,
    exportSettings: {
      destination: "local" as const,
      huggingFaceCadence: "run" as const,
    },
    runEditorReviewed: true,
  };
  completed.episodes = [retainedEpisode];
  completed.run.status = "complete";
  completed.run.phase = null;
  completed.run.recordingState = "idle";
  completed.run.endedAtMs = now.value;
  completed.currentEpisode = null;
  completed.pendingEpisode = null;
  completed.solo!.workspace = workspace;
  completed.solo!.selectedStartTaskId = null;
  completed.solo!.startCountdownDeadlineMs = null;
  await controller.restore(completed, true);
  const configurationBefore = structuredClone(controller.snapshot.configuration);

  const commands = await controller.resetCompletedRun();

  assert.deepEqual(commands.map(({ type }) => type), ["run-state"]);
  assert.equal(controller.snapshot.run.status, "stopped");
  assert.equal(controller.snapshot.run.recordingState, "idle");
  assert.equal(controller.snapshot.run.startedAtMs, null);
  assert.equal(controller.snapshot.run.endedAtMs, null);
  assert.equal(controller.snapshot.episodes.length, 1);
  assert.equal(controller.snapshot.episodes[0]?.id, retainedEpisode.id);
  assert.equal(controller.snapshot.episodes[0]?.outcome, "completed");
  assert.equal(controller.snapshot.episodes[0]?.integrity, "valid");
  assert.deepEqual(controller.snapshot.configuration, configurationBefore);
  assert.deepEqual(controller.snapshot.solo?.workspace, workspace);
  assert.equal(persistence.saved.at(-1)?.run.status, "stopped");
  assert.deepEqual(await controller.resetCompletedRun(), []);
});

test("rolls back a reducer mutation and emits no command when persistence fails", async () => {
  const now = { value: 1_000 };
  const { controller, persistence, commandCommits } = await readySoloController(
    "solo_commit_failure",
    now,
  );
  const before = controller.snapshot;
  const changed = controller.snapshot.configuration;
  changed.runTitle = "Must not escape";
  persistence.failNextSave = new Error("OPFS snapshot flush failed");

  await assert.rejects(controller.configure(changed), /OPFS snapshot flush failed/);

  assert.equal(controller.snapshot.configuration.runTitle, before.configuration.runTitle);
  assert.deepEqual(commandCommits, []);
});

test("retains a durable semantic status when downstream command delivery fails", async () => {
  const now = { value: 1_500 };
  const persistence = new FakeSoloPersistence();
  const controller = new SoloSessionController("solo_delivery_failure", {
    persistence,
    now: () => now.value,
  });
  await controller.mount(true);
  controller.setCaptureCommandSink(() => {
    throw new Error("Local capture command sink failed");
  });

  await assert.rejects(
    controller.setCaptureStatus({
      ...defaultCaptureStatus,
      camera: "ready",
    }),
    /Local capture command sink failed/,
  );

  assert.equal(controller.snapshot.captureStatus.camera, "ready");
  assert.equal(persistence.saved.at(-1)?.captureStatus.camera, "ready");
});

test("locks configuration once the Solo run has entered recorder arming", async () => {
  const now = { value: 1_000 };
  const { controller } = await readySoloController("solo_configuration_lock", now);
  await controller.selectStartTask("task-001");
  now.value = 4_000;
  await controller.advanceTime();

  const changed = controller.snapshot.configuration;
  changed.runTitle = "Blocked";
  await assert.rejects(controller.configure(changed), /configuration is locked/i);
});

test("persists export job updates in the recoverable Solo snapshot", async () => {
  const now = { value: 1_000 };
  const { controller, persistence } = await readySoloController("solo_export_jobs", now);
  await controller.upsertJob({
    id: "export-job-0001",
    type: "export",
    state: "running",
    detail: "Writing immutable artefacts",
    createdAt: "2026-07-25T07:00:00.000Z",
    updatedAt: "2026-07-25T07:00:01.000Z",
    browserRecovery: {
      destination: "hugging-face",
      episodeIds: ["episode-0001"],
      repository: "research/ceres-session",
      branch: "main",
      visibility: "private",
      artefacts: [{
        path: "shards/episode-000000/data/chunk-000/file-000.parquet",
        sha256: "a".repeat(64),
        byteLength: 1_024,
        mediaType: "application/vnd.apache.parquet",
      }],
    },
  });

  assert.equal(controller.snapshot.jobs[0]?.state, "running");
  assert.equal(persistence.saved.at(-1)?.jobs[0]?.id, "export-job-0001");
  assert.deepEqual(
    persistence.saved.at(-1)?.jobs[0]?.browserRecovery,
    controller.snapshot.jobs[0]?.browserRecovery,
  );
  await controller.removeJob("export-job-0001");
  assert.deepEqual(controller.snapshot.jobs, []);
  assert.deepEqual(persistence.saved.at(-1)?.jobs, []);
});
