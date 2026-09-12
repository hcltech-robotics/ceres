import assert from "node:assert/strict";
import test from "node:test";
import type { CaptureJob, SessionSnapshot } from "../shared/protocol.js";
import {
  recoverSoloSystemTransitionCompletion,
  type SoloSystemTransitionRecoveryPorts,
} from "../src/solo-app.js";
import type { PendingSoloSystemTransition } from "../src/solo-system-transition.js";

const queuedFolderJob: CaptureJob = {
  id: "job-folder-recovery",
  type: "export",
  state: "queued",
  detail: "Waiting for a Solo folder destination",
  createdAt: "2026-07-26T12:00:00.000Z",
  updatedAt: "2026-07-26T12:00:00.000Z",
  browserRecovery: {
    destination: "folder",
    episodeIds: ["episode-001"],
  },
};

const folderTransition: PendingSoloSystemTransition = {
  version: 1,
  id: "transition-folder-recovery",
  kind: "folder-export",
  sessionId: "solo-session-recovery",
  returnPage: "export",
  continuationId: queuedFolderJob.id,
  requestedAtMs: 1,
  phase: "awaiting-xr-reentry",
  requiresXrReentry: true,
};

const snapshot = {
  sessionId: folderTransition.sessionId,
  jobs: [queuedFolderJob],
} as unknown as SessionSnapshot;

test("failed folder completion becomes retryable and clears the native transition", async () => {
  const calls: string[] = [];
  let failedJob: CaptureJob | null = null;
  let visibleError: unknown;
  const originalError = new Error("The selected directory handle expired");
  const ports: SoloSystemTransitionRecoveryPorts = {
    restoreRuntime(page) {
      calls.push(`restore:${page}`);
    },
    async failFolderJob(job) {
      failedJob = job;
      calls.push(`job:${job.state}`);
    },
    async clearResult(transitionId) {
      calls.push(`result:${transitionId}`);
    },
    clearPersistedTransition(sessionId) {
      calls.push(`storage:${sessionId}`);
    },
    async persistWorkspace(page) {
      calls.push(`persist:${page}`);
    },
    render() {
      calls.push("render");
    },
    showOriginalError(error) {
      visibleError = error;
      calls.push("error");
    },
  };

  await recoverSoloSystemTransitionCompletion(
    folderTransition,
    snapshot,
    originalError,
    ports,
    () => "2026-07-26T12:01:00.000Z",
  );

  assert.deepEqual(calls, [
    "restore:export",
    "job:failed",
    `result:${folderTransition.id}`,
    `storage:${folderTransition.sessionId}`,
    "persist:export",
    "render",
    "error",
  ]);
  assert.equal(failedJob?.state, "failed");
  assert.equal(failedJob?.updatedAt, "2026-07-26T12:01:00.000Z");
  assert.match(failedJob?.detail ?? "", /selected directory handle expired/);
  assert.match(failedJob?.detail ?? "", /Retry the folder export/);
  assert.deepEqual(failedJob?.browserRecovery, queuedFolderJob.browserRecovery);
  assert.equal(visibleError, originalError);
});

test("cleanup failures cannot strand the XR return page or replace the original error", async () => {
  const calls: string[] = [];
  let visibleError: unknown;
  const originalError = new Error("Task import preview failed");
  const fileTransition: PendingSoloSystemTransition = {
    ...folderTransition,
    id: "transition-file-recovery",
    kind: "file-import",
    returnPage: "import",
    continuationId: undefined,
  };
  const ports: SoloSystemTransitionRecoveryPorts = {
    restoreRuntime(page) {
      calls.push(`restore:${page}`);
    },
    async failFolderJob() {
      assert.fail("A file transition must not settle a folder export job");
    },
    async clearResult() {
      calls.push("result");
      throw new Error("IndexedDB cleanup failed");
    },
    clearPersistedTransition() {
      calls.push("storage");
      throw new Error("Local storage cleanup failed");
    },
    async persistWorkspace(page) {
      calls.push(`persist:${page}`);
      throw new Error("Workspace persistence failed");
    },
    render() {
      calls.push("render");
    },
    showOriginalError(error) {
      visibleError = error;
      calls.push("error");
    },
  };

  await recoverSoloSystemTransitionCompletion(
    fileTransition,
    {
      ...snapshot,
      jobs: [],
    },
    originalError,
    ports,
  );

  assert.deepEqual(calls, [
    "restore:import",
    "result",
    "storage",
    "persist:import",
    "render",
    "error",
  ]);
  assert.equal(visibleError, originalError);
});
