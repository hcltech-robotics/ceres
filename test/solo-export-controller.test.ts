import assert from "node:assert/strict";
import test from "node:test";

import type { AccountExportSession } from "../shared/export-destination.js";
import type {
  CaptureJob,
  Episode,
  RecordingState,
  SessionSnapshot,
} from "../shared/protocol.js";
import { DirectSessionReducer } from "../src/direct-session-reducer.js";
import {
  SoloExportController,
  type SoloExportControllerPorts,
  type SoloExportRequest,
} from "../src/solo-export-controller.js";

const sessionId = "solo_export_controller_session";

class ExportPorts implements SoloExportControllerPorts {
  readonly starts: SoloExportRequest[] = [];
  readonly retries: SoloExportRequest[] = [];
  readonly deletions: string[] = [];
  cancelCount = 0;
  startError: Error | null = null;
  deleteError: Error | null = null;

  async start(request: SoloExportRequest) {
    this.starts.push(request);
    if (this.startError) throw this.startError;
  }

  async cancel() {
    this.cancelCount += 1;
  }

  async retry(request: SoloExportRequest) {
    this.retries.push(request);
  }

  async deleteEpisode(episodeId: string) {
    this.deletions.push(episodeId);
    if (this.deleteError) throw this.deleteError;
  }
}

function snapshot(
  recordingState: RecordingState = "idle",
  episodes: Episode[] = [],
  attempts: Episode[] = [],
  jobs: CaptureJob[] = [],
): SessionSnapshot {
  const reducer = new DirectSessionReducer(sessionId, () => 1_700_000_000_000);
  reducer.enableSolo({ startCountdownMs: 3_000 });
  const value = structuredClone(reducer.snapshot);
  value.run.recordingState = recordingState;
  value.episodes = episodes;
  value.attempts = attempts;
  value.jobs = jobs;
  return value;
}

function episode(
  id: string,
  options: Partial<Episode> = {},
): Episode {
  return {
    id,
    runTitle: "Solo run",
    runDescription: "",
    taskId: "task-1",
    taskLabel: "Place sample",
    taskDescription: "Place the sample in the target",
    cycle: 0,
    repetition: 0,
    take: 1,
    startedAt: "2026-07-25T20:00:00.000Z",
    endedAt: "2026-07-25T20:00:01.000Z",
    outcome: "completed",
    annotation: "pass",
    accepted: true,
    integrity: "valid",
    frameCount: 30,
    mediaChunkCount: 1,
    qualitySummary: {
      decision: "go",
      reasons: [],
      frameCount: 30,
      gapCount: 0,
      maxLeftHandSpeedMps: 0,
      maxRightHandSpeedMps: 0,
      slowHandEvents: 0,
      trackingLossEvents: 0,
    },
    qualityEvents: [],
    ...options,
  };
}

function account(
  state: AccountExportSession["huggingFace"]["state"] = "ready",
  signedIn = true,
): AccountExportSession {
  return {
    version: 1,
    signedIn,
    huggingFace: {
      state,
      username: "solo-researcher",
    },
    defaults: {
      organisation: "hcltech-robotics",
      repositoryPrefix: "solo-",
      visibility: "private",
    },
  };
}

function job(
  id: string,
  state: CaptureJob["state"],
  recovery?: CaptureJob["browserRecovery"],
): CaptureJob {
  return {
    id,
    type: recovery?.destination === "hugging-face" ? "upload" : "export",
    state,
    detail: `${state} job`,
    createdAt: "2026-07-25T20:00:00.000Z",
    updatedAt: "2026-07-25T20:00:01.000Z",
    ...(recovery ? { browserRecovery: recovery } : {}),
  };
}

test("projects accepted episodes and retained attempts into immutable state", () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  const accepted = episode("accepted", { startedAt: "2026-07-25T20:00:01.000Z" });
  const retained = episode("retained", {
    accepted: false,
    annotation: "fail",
    frameCount: 12,
    startedAt: "2026-07-25T20:00:02.000Z",
  });
  const emptyAttempt = episode("empty", {
    accepted: false,
    frameCount: 0,
    startedAt: "2026-07-25T20:00:03.000Z",
  });
  const source = snapshot("idle", [accepted], [retained, emptyAttempt, accepted]);

  controller.updateSession(source);

  assert.deepEqual(
    controller.snapshot.episodes.map(({ id, kind, exportable }) => ({ id, kind, exportable })),
    [
      { id: "empty", kind: "attempt", exportable: false },
      { id: "retained", kind: "attempt", exportable: true },
      { id: "accepted", kind: "accepted", exportable: true },
    ],
  );
  assert.deepEqual(controller.snapshot.exportEpisodeIds, ["retained", "accepted"]);
  assert.equal(Object.isFrozen(controller.snapshot), true);
  assert.equal(Object.isFrozen(controller.snapshot.episodes), true);
  assert.equal(Object.isFrozen(controller.snapshot.episodes[0]?.episode), true);
  assert.throws(() => {
    (controller.snapshot.episodes[0]!.episode.qualitySummary.reasons as string[]).push("mutated");
  }, TypeError);
  assert.deepEqual(source.attempts[1]!.qualitySummary.reasons, []);
});

test("owns selection, falls back to every exportable episode and prunes removed ids", () => {
  const controller = new SoloExportController(new ExportPorts());
  const one = episode("one");
  const two = episode("two", { accepted: false, frameCount: 15 });
  const empty = episode("empty", { accepted: false, frameCount: 0 });
  controller.updateSession(snapshot("idle", [one], [two, empty]));

  assert.deepEqual(controller.snapshot.selectedEpisodeIds, []);
  assert.deepEqual(controller.snapshot.exportEpisodeIds, ["one", "two"]);

  controller.toggleEpisodeSelection("two");
  assert.deepEqual(controller.snapshot.selectedEpisodeIds, ["two"]);
  assert.deepEqual(controller.snapshot.exportEpisodeIds, ["two"]);

  controller.toggleEpisodeSelection("empty");
  assert.deepEqual(controller.snapshot.selectedEpisodeIds, ["empty", "two"]);
  assert.deepEqual(controller.snapshot.exportEpisodeIds, ["two"]);

  controller.updateSession(snapshot("idle", [one], [empty]));
  assert.deepEqual(controller.snapshot.selectedEpisodeIds, ["empty"]);
  assert.deepEqual(controller.snapshot.exportEpisodeIds, []);

  controller.clearEpisodeSelection();
  assert.deepEqual(controller.snapshot.exportEpisodeIds, ["one"]);
  assert.throws(() => controller.toggleEpisodeSelection("missing"), /not in the Solo catalogue/);
});

test("blocks selection and delete confirmation while episode review is unavailable", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  controller.updateSession(snapshot("recording", [episode("one")]));

  assert.equal(controller.snapshot.selectionAvailable, false);
  assert.throws(() => controller.toggleEpisodeSelection("one"), /unavailable while recording/);
  assert.throws(() => controller.requestDelete("one"), /unavailable while recording/);
  await assert.rejects(controller.confirmDelete(), /No Solo capture is awaiting deletion/);
  assert.deepEqual(ports.deletions, []);
});

test("derives episode operation authority from countdown and episode boundaries", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  const idle = snapshot("idle", [episode("one")], [], [
    job("retryable", "failed", {
      destination: "opfs",
      episodeIds: ["one"],
    }),
  ]);
  controller.updateSession(idle);
  controller.requestDelete("one");

  const countdown = snapshot("idle", [episode("one")], [], idle.jobs);
  countdown.solo!.startCountdownDeadlineMs = 1_700_000_003_000;
  controller.updateSession(countdown);

  assert.equal(controller.snapshot.selectionAvailable, false);
  assert.equal(controller.snapshot.deleteConfirmation, null);
  assert.equal(controller.snapshot.retry.available, false);
  assert.throws(() => controller.toggleEpisodeSelection("one"), /countdown/);
  await assert.rejects(controller.start("opfs"), /countdown/);
  await assert.rejects(controller.retry(), /countdown/);
  await assert.rejects(controller.confirmDelete(), /No Solo capture is awaiting deletion/);
  assert.deepEqual(ports.starts, []);
  assert.deepEqual(ports.retries, []);
  assert.deepEqual(ports.deletions, []);

  const current = snapshot("idle", [episode("one")]);
  current.currentEpisode = episode("active", {
    outcome: "recording",
    accepted: false,
    integrity: "pending",
  });
  controller.updateSession(current);
  assert.equal(controller.snapshot.selectionAvailable, false);
  await assert.rejects(controller.start("opfs"), /capture boundary/);

  const pending = snapshot("idle", [episode("one")]);
  pending.pendingEpisode = episode("pending", {
    outcome: "recording",
    accepted: false,
    integrity: "pending",
  });
  controller.updateSession(pending);
  assert.equal(controller.snapshot.selectionAvailable, false);
  assert.throws(() => controller.requestDelete("one"), /capture boundary/);

  controller.updateSession(snapshot("stopping", [episode("one")]));
  assert.equal(controller.snapshot.selectionAvailable, false);
  await assert.rejects(controller.start("opfs"), /finalising/);
});

test("uses request, cancel and confirm as an explicit two-step delete flow", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  controller.updateSession(snapshot("idle", [episode("one"), episode("two")]));
  controller.toggleEpisodeSelection("one");

  controller.requestDelete("one");
  assert.deepEqual(controller.snapshot.deleteConfirmation, {
    episodeId: "one",
    taskLabel: "Place sample",
  });
  assert.deepEqual(ports.deletions, []);

  controller.cancelDelete();
  assert.equal(controller.snapshot.deleteConfirmation, null);
  assert.deepEqual(ports.deletions, []);

  controller.requestDelete("one");
  await controller.confirmDelete();
  assert.deepEqual(ports.deletions, ["one"]);
  assert.equal(controller.snapshot.deleteConfirmation, null);
  assert.deepEqual(controller.snapshot.selectedEpisodeIds, []);

  ports.deleteError = new Error("durable delete failed");
  controller.requestDelete("two");
  await assert.rejects(controller.confirmDelete(), /durable delete failed/);
  assert.equal(controller.snapshot.deleteConfirmation?.episodeId, "two");
  assert.equal(controller.snapshot.deletingEpisodeId, null);
  assert.equal(controller.snapshot.lastError, "durable delete failed");
});

test("derives headset-local account presentation and repository settings", () => {
  const controller = new SoloExportController(new ExportPorts());

  assert.equal(controller.snapshot.account.state, "checking");
  controller.updateAccount(null, "unavailable");
  assert.deepEqual(controller.snapshot.account, {
    state: "sign-in",
    label: "Hugging Face is not authorised on this headset",
    action: "connect",
    actionLabel: "Sign in to Hugging Face",
    username: null,
    canUpload: false,
  });

  controller.updateHeadsetHuggingFaceAccount("headset-researcher");
  assert.deepEqual(controller.snapshot.account, {
    state: "connected",
    label: "Hugging Face connected/headset-researcher",
    action: "manage",
    actionLabel: "Reauthorise",
    username: "headset-researcher",
    canUpload: true,
  });
  assert.equal(controller.snapshot.repositorySettings.organisation, "headset-researcher");
  controller.updateHeadsetHuggingFaceAccount(null);

  controller.updateAccount(account("disconnected", false));
  assert.equal(controller.snapshot.account.state, "sign-in");
  assert.equal(controller.snapshot.account.action, "connect");

  controller.updateAccount(account("reauthentication_required"));
  assert.equal(controller.snapshot.account.state, "reauthenticate");
  assert.equal(controller.snapshot.account.actionLabel, "Reauthenticate");

  controller.updateAccount(account());
  assert.deepEqual(controller.snapshot.repositorySettings, {
    organisation: "hcltech-robotics",
    repository: "solo-capture",
    branch: "main",
    visibility: "private",
    missingRepositoryBehaviour: "private",
  });
  assert.equal(controller.snapshot.account.state, "connected");
  assert.equal(controller.snapshot.account.username, "solo-researcher");
  assert.equal("token" in controller.snapshot.account, false);

  controller.updateRepositorySettings({
    repository: "custom-dataset",
    branch: "experiments/solo",
    visibility: "public",
    missingRepositoryBehaviour: "public",
  });
  controller.updateAccount({
    ...account(),
    defaults: {
      organisation: "another-org",
      repositoryPrefix: "new-",
      visibility: "private",
    },
  });
  assert.deepEqual(controller.snapshot.repositorySettings, {
    organisation: "another-org",
    repository: "custom-dataset",
    branch: "experiments/solo",
    visibility: "public",
    missingRepositoryBehaviour: "public",
  });
});

test("keeps a ready account preferred while retaining a headset recovery authority", () => {
  const controller = new SoloExportController(new ExportPorts());
  const accountSession: AccountExportSession = {
    ...account(),
    huggingFace: {
      state: "ready",
      username: "account-user",
    },
    defaults: {
      organisation: "account-owner",
      repositoryPrefix: "account-",
      visibility: "private",
    },
  };

  controller.updateAccount(accountSession);
  controller.updateHeadsetHuggingFaceAccount("headset-owner");

  assert.equal(controller.snapshot.repositorySettings.organisation, "account-owner");
  assert.equal(controller.snapshot.account.username, "account-user");
  assert.equal(controller.snapshot.account.actionLabel, "Manage connection");

  controller.updateAccount({
    ...accountSession,
    huggingFace: {
      state: "disconnected",
      username: "account-user",
    },
  });
  assert.equal(controller.snapshot.repositorySettings.organisation, "headset-owner");
  assert.equal(controller.snapshot.account.username, "headset-owner");

  controller.updateAccount(accountSession);
  assert.equal(controller.snapshot.repositorySettings.organisation, "account-owner");
  assert.equal(controller.snapshot.account.username, "account-user");
});

test("validates and routes OPFS, folder and Hugging Face destination requests", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  controller.updateSession(snapshot("idle", [
    episode("one"),
    episode("empty", { frameCount: 0 }),
  ], [episode("two", { accepted: false })]));

  await controller.start("opfs");
  await controller.start("folder");
  await controller.startEpisodes("opfs", ["one"]);
  assert.deepEqual(ports.starts, [
    {
      destination: "opfs",
      sessionId,
      episodeIds: ["one", "two"],
    },
    {
      destination: "folder",
      sessionId,
      episodeIds: ["one", "two"],
    },
    {
      destination: "opfs",
      sessionId,
      episodeIds: ["one"],
    },
  ]);
  assert.equal(Object.isFrozen(ports.starts[0]), true);
  assert.equal(Object.isFrozen(ports.starts[0]?.episodeIds), true);

  await assert.rejects(controller.start("hugging-face"), /Connect Hugging Face/);
  controller.updateAccount(account());
  controller.updateRepositorySettings({ repository: "invalid repository" });
  await assert.rejects(controller.start("hugging-face"), /valid Hugging Face repository name/);
  controller.updateRepositorySettings({
    repository: "solo-dataset",
    branch: "feature/solo",
    visibility: "private",
  });
  controller.updateVerifiedRepositoryDestination({
    version: 1,
    repository: "hcltech-robotics/solo-dataset",
    branch: "feature/solo",
    availability: "existing",
    visibility: "private",
    append: {
      nextEpisodeIndex: 7,
      nextGlobalFrameIndex: 700,
      repositoryRevision: "a".repeat(40),
    },
  });
  await controller.start("hugging-face");
  assert.deepEqual(ports.starts.at(-1), {
    destination: "hugging-face",
    sessionId,
    episodeIds: ["one", "two"],
    repository: "hcltech-robotics/solo-dataset",
    branch: "feature/solo",
    visibility: "private",
    missingRepositoryBehaviour: "private",
  });
});

test("binds every Hugging Face start to the current verified destination", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  controller.updateSession(snapshot("idle", [episode("one")]));
  controller.updateAccount(account());

  await assert.rejects(
    controller.start("hugging-face"),
    /Verify the current Hugging Face destination/,
  );
  await assert.rejects(
    controller.startEpisodes("hugging-face", ["one"]),
    /Verify the current Hugging Face destination/,
  );
  assert.deepEqual(ports.starts, []);

  const destinationA = {
    version: 1 as const,
    repository: "hcltech-robotics/solo-capture",
    branch: "main",
    availability: "existing" as const,
    visibility: "private" as const,
    append: {
      nextEpisodeIndex: 3,
      nextGlobalFrameIndex: 300,
      repositoryRevision: "b".repeat(40),
    },
  };
  controller.updateVerifiedRepositoryDestination(destinationA);
  await controller.startEpisodes("hugging-face", ["one"]);
  assert.equal(ports.starts.at(-1)?.repository, destinationA.repository);
  assert.equal(ports.starts.at(-1)?.visibility, destinationA.visibility);

  controller.updateRepositorySettings({ branch: "captures/next" });
  await assert.rejects(
    controller.start("hugging-face"),
    /Verify the current Hugging Face destination/,
  );
  controller.updateRepositorySettings({ branch: "main" });
  controller.updateVerifiedRepositoryDestination(destinationA);

  controller.updateRepositorySettings({ repository: "destination-b" });
  await assert.rejects(
    controller.start("hugging-face"),
    /Verify the current Hugging Face destination/,
  );
  assert.throws(
    () => controller.updateVerifiedRepositoryDestination(destinationA),
    /does not match the current settings/,
  );

  controller.updateVerifiedRepositoryDestination({
    ...destinationA,
    repository: "hcltech-robotics/destination-b",
  });
  controller.updateRepositorySettings({ visibility: "public" });
  await assert.rejects(
    controller.start("hugging-face"),
    /Verify the current Hugging Face destination/,
  );
});

test("rejects starts without an idle exportable selection or while a job is active", async () => {
  const controller = new SoloExportController(new ExportPorts());
  await assert.rejects(controller.start("opfs"), /Solo session is not available/);

  controller.updateSession(snapshot("idle", [episode("empty", { frameCount: 0 })]));
  await assert.rejects(controller.start("opfs"), /No exportable Solo captures/);

  controller.updateSession(snapshot("recording", [episode("one")]));
  await assert.rejects(controller.start("opfs"), /unavailable while recording/);

  controller.updateSession(snapshot("idle", [episode("one")], [], [job("active", "running", {
    destination: "opfs",
    episodeIds: ["one"],
  })]));
  await assert.rejects(controller.start("folder"), /already active/);
});

test("allows an explicit immutable episode start during an active run", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  const activeRun = snapshot("idle", [episode("completed-cycle")]);
  activeRun.run.status = "running";
  controller.updateSession(activeRun);

  await assert.rejects(controller.start("opfs"), /active run/);
  await controller.startEpisodes("opfs", ["completed-cycle"]);

  assert.deepEqual(ports.starts, [{
    destination: "opfs",
    sessionId,
    episodeIds: ["completed-cycle"],
  }]);
});

test("rejects a mixed selection containing a non-exportable episode", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  controller.updateSession(snapshot("idle", [
    episode("exportable"),
    episode("empty", { frameCount: 0 }),
  ]));
  controller.toggleEpisodeSelection("exportable");
  controller.toggleEpisodeSelection("empty");

  assert.deepEqual(controller.snapshot.exportEpisodeIds, ["exportable"]);
  await assert.rejects(controller.start("opfs"), /empty is not exportable/);
  assert.deepEqual(ports.starts, []);
});

test("exposes active progress, cancellation and retry from durable job state", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  const failed = job("failed", "failed", {
    destination: "folder",
    episodeIds: ["one"],
  });
  const running = job("running", "running", {
    destination: "opfs",
    episodeIds: ["one"],
  });
  controller.updateSession(snapshot("idle", [episode("one")], [], [failed, running]));
  controller.updateProgress({
    jobId: "running",
    completed: 2,
    total: 5,
    detail: "Writing shards",
  });

  assert.equal(controller.snapshot.active.busy, true);
  assert.equal(controller.snapshot.active.job?.id, "running");
  assert.deepEqual(controller.snapshot.active.progress, {
    jobId: "running",
    completed: 2,
    total: 5,
    fraction: 0.4,
    detail: "Writing shards",
  });
  assert.equal(controller.snapshot.active.canCancel, true);
  await controller.cancel();
  assert.equal(ports.cancelCount, 1);
  assert.equal(controller.snapshot.active.progress, null);

  controller.updateSession(snapshot("idle", [episode("one")], [], [failed]));
  assert.equal(controller.snapshot.retry.available, true);
  assert.equal(controller.snapshot.retry.job?.id, "failed");
  await controller.retry();
  assert.deepEqual(ports.retries, [{
    destination: "folder",
    sessionId,
    episodeIds: ["one"],
  }]);
});

test("does not offer cancellation once an account upload is finalising", async () => {
  const ports = new ExportPorts();
  const controller = new SoloExportController(ports);
  const running = job("finalising", "running", {
    destination: "hugging-face",
    episodeIds: ["one"],
    repository: "hcltech-robotics/solo-capture",
    branch: "main",
    visibility: "private",
  });
  controller.updateSession(snapshot("idle", [episode("one")], [], [running]));
  controller.updateProgress({
    jobId: "finalising",
    completed: 5,
    total: 5,
    detail: "Verifying artefacts and creating the Hub commit",
    stage: "finalising",
  });

  assert.equal(controller.snapshot.active.canCancel, false);
  await assert.rejects(
    controller.cancel(),
    /finalising and can no longer be aborted/,
  );
  assert.equal(ports.cancelCount, 0);
});

test("keeps a retryable immutable request after a start port failure", async () => {
  const ports = new ExportPorts();
  ports.startError = new Error("export worker stopped");
  const controller = new SoloExportController(ports);
  const observed: string[] = [];
  const unsubscribe = controller.subscribe((state) => {
    observed.push(state.lastError ?? state.active.operation ?? "idle");
  });
  controller.updateSession(snapshot("idle", [episode("one")]));

  await assert.rejects(controller.start("opfs"), /export worker stopped/);
  assert.equal(controller.snapshot.lastError, "export worker stopped");
  assert.equal(controller.snapshot.retry.available, true);
  assert.deepEqual(controller.snapshot.retry.request, {
    destination: "opfs",
    sessionId,
    episodeIds: ["one"],
  });
  assert.equal(Object.isFrozen(controller.snapshot.retry.request), true);

  ports.startError = null;
  const retryRequest = controller.snapshot.retry.request;
  await controller.retry();
  assert.deepEqual(ports.retries, [retryRequest]);
  assert.ok(observed.includes("start"));
  assert.ok(observed.includes("export worker stopped"));
  unsubscribe();
});

test("does not offer a stale failed job after a newer equivalent export completed", () => {
  const controller = new SoloExportController(new ExportPorts());
  const recovery = {
    destination: "folder" as const,
    episodeIds: ["one"],
  };
  const failed = {
    ...job("failed", "failed", recovery),
    updatedAt: "2026-07-25T20:00:01.000Z",
  };
  const completed = {
    ...job("completed", "completed", recovery),
    updatedAt: "2026-07-25T20:00:02.000Z",
  };

  controller.updateSession(snapshot("idle", [episode("one")], [], [failed, completed]));

  assert.equal(controller.snapshot.retry.available, false);
  assert.equal(controller.snapshot.retry.job, null);
});

test("retires an authority-rebound upload failure after its retry completes", () => {
  const controller = new SoloExportController(new ExportPorts());
  const recovery = {
    destination: "hugging-face" as const,
    episodeIds: ["one"],
    repository: "research-org/solo-capture",
    branch: "main",
    visibility: "private" as const,
    missingRepositoryBehaviour: "private" as const,
  };
  const failed = {
    ...job("failed", "failed", recovery),
    updatedAt: "2026-07-25T20:00:01.000Z",
  };
  const completed = {
    ...job("completed", "completed", {
      ...recovery,
      uploadMode: "account" as const,
      uploadPrincipal: "account:ceres-user:hf-user",
    }),
    updatedAt: "2026-07-25T20:00:02.000Z",
  };

  controller.updateSession(snapshot("idle", [episode("one")], [], [failed, completed]));

  assert.equal(controller.snapshot.retry.available, false);
  assert.equal(controller.snapshot.retry.job, null);
});
