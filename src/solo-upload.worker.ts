/// <reference lib="webworker" />

import {
  requireExportDestinationService,
  AccountExportRequestError,
  AccountUploadCancellationUnconfirmedError,
} from "./export-service.js";
import {
  soloHuggingFaceUploadErrorMessage,
  uploadSoloHuggingFaceExport,
} from "./solo-hf-upload.js";
import { serialiseWorkerError } from "./worker-errors.js";
import type {
  SoloUploadProgressStage,
  SoloUploadResult,
  SoloUploadWorkerOptions,
} from "./solo-upload-adapter.js";

type SoloUploadWorkerRequest =
  | Readonly<{ type: "start"; options: SoloUploadWorkerOptions }>
  | Readonly<{ type: "cancel" }>;

const scope = self as DedicatedWorkerGlobalScope;
const PROGRESS_INTERVAL_MS = 750;
let active: AbortController | null = null;
let pendingProgress: {
  completed: number;
  total: number;
  detail: string;
  stage: SoloUploadProgressStage;
} | null = null;
let progressTimer: number | null = null;
let lastProgressAt = Number.NEGATIVE_INFINITY;
let uploadStage = "starting";
let activeAccountUploadJobId: string | null = null;

scope.onmessage = (event: MessageEvent<SoloUploadWorkerRequest>) => {

  if (event.data.type === "cancel") {
    active?.abort(new DOMException("Hugging Face sync cancelled", "AbortError"));
    return;
  }
  if (active) {
    const error = new Error("A background upload is already running");
    post({
      type: "error",
      error: error.message,
      telemetry: serialiseWorkerError(error, scope.location.origin),
      stage: "starting",
      cancelled: false,
      cancellationUnconfirmed: false,
      outcomeUnconfirmed: false,
    });
    return;
  }
  const controller = new AbortController();
  active = controller;

  uploadStage = "starting";
  activeAccountUploadJobId = null;
  void run(event.data.options, controller.signal).finally(() => {
    flushProgress();
    if (active === controller) active = null;
  });
};

async function run(options: SoloUploadWorkerOptions, signal: AbortSignal) {
  try {
    const result = options.mode === "account"
      ? await uploadWithAccount(options, signal)
      : await uploadWithHeadset(options, signal);
    flushProgress();
    post({ type: "complete", result });
  } catch (error) {
    const cancellationUnconfirmed = error instanceof AccountUploadCancellationUnconfirmedError;
    const cancelled = !cancellationUnconfirmed
      && (signal.aborted || (error instanceof DOMException && error.name === "AbortError"));
    const failedStage = uploadStage;
    const outcomeUnconfirmed = options.mode === "account"
      && !cancelled
      && !cancellationUnconfirmed
      && !(
        failedStage === "creating"
        && error instanceof AccountExportRequestError
        && error.status >= 400
        && error.status < 500
      );
    flushProgress();
    post({
      type: "error",
      error: cancelled ? "Hugging Face sync cancelled" : soloHuggingFaceUploadErrorMessage(error),
      telemetry: serialiseWorkerError(error, scope.location.origin),
      stage: failedStage,
      cancelled,
      cancellationUnconfirmed,
      outcomeUnconfirmed,
      accountUploadJobId: cancellationUnconfirmed ? error.jobId : activeAccountUploadJobId,
    });
  }
}

async function uploadWithAccount(
  options: Extract<SoloUploadWorkerOptions, { mode: "account" }>,
  signal: AbortSignal,
): Promise<SoloUploadResult> {
  const client = requireExportDestinationService();
  const job = await client.syncBrowserExport({
    expectedAccountSubject: options.expectedAccountSubject,
    expectedHuggingFaceSubject: options.expectedHuggingFaceSubject,
    sessionId: options.sessionId,
    repository: options.repository,
    branch: options.branch,
    appendAllocation: options.appendAllocation,
    visibility: options.visibility,
    missingRepositoryBehaviour: options.missingRepositoryBehaviour,
    episodeIds: options.episodeIds,
    artefacts: options.artefacts,
    waitForFinalisation: false,
    signal,
    onProgress: (progress) => {
      if (progress.job) activeAccountUploadJobId = progress.job.id;
      progressUpdate(
        progress.stage,
        progress.completed,
        progress.total,
        progress.detail,
      );
    },
  });
  return { mode: "account", job };
}

async function uploadWithHeadset(
  options: Extract<SoloUploadWorkerOptions, { mode: "headset" }>,
  signal: AbortSignal,
): Promise<SoloUploadResult> {
  const result = await uploadSoloHuggingFaceExport({
    credential: options.credential,
    sessionId: options.sessionId,
    repository: options.repository,
    branch: options.branch,
    visibility: options.visibility,
    missingRepositoryBehaviour: options.missingRepositoryBehaviour,
    appendAllocation: options.appendAllocation,
    artefacts: options.artefacts,
    signal,
    onProgress: (completed, total, detail, stage) => progressUpdate(
      stage,
      completed,
      total,
      detail,
    ),
  });
  return { mode: "headset", result };
}

function progressUpdate(
  stage: SoloUploadProgressStage,
  completed: number,
  total: number,
  detail: string,
) {
  if (transitionStage(stage)) flushProgress();
  pendingProgress = { completed, total, detail, stage };
  const now = performance.now();
  if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
    flushProgress();
    return;
  }
  if (progressTimer === null) {
    progressTimer = scope.setTimeout(
      flushProgress,
      Math.max(0, PROGRESS_INTERVAL_MS - (now - lastProgressAt)),
    );
  }
}

function flushProgress() {
  if (progressTimer !== null) {
    scope.clearTimeout(progressTimer);
    progressTimer = null;
  }
  if (!pendingProgress) return;
  lastProgressAt = performance.now();
  post({ type: "progress", ...pendingProgress });
  pendingProgress = null;
}

function transitionStage(stage: string): boolean {
  if (stage === uploadStage) return false;
  uploadStage = stage;
  return true;
}

function post(message: unknown) {
  scope.postMessage(message);
}
