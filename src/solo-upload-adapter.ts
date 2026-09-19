import {
  ACCOUNT_EXPORT_API_VERSION,
  ACCOUNT_EXPORT_MAX_ARTEFACT_BYTES,
  ACCOUNT_EXPORT_MAX_EPISODES,
  isHuggingFaceAppendAllocation,
  type AccountUploadJob,
  type AccountUploadManifestArtefact,
  type HuggingFaceAppendAllocation,
  type HuggingFaceMissingRepositoryBehaviour,
} from "../shared/export-destination.js";

import type { AccountUploadProgress } from "./export-service.js";
import type { SoloHuggingFaceCredential } from "./solo-hf-oauth.js";
import type {
  SoloHuggingFaceUploadResult,
  SoloHuggingFaceUploadStage,
} from "./solo-hf-upload.js";
import { withErrorContext, isWorkerErrorDetail, workerErrorFromDetail, type WorkerErrorDetail } from "./worker-errors.js";

export type SoloUploadProgressStage =
  | AccountUploadProgress["stage"]
  | SoloHuggingFaceUploadStage;

export type SoloUploadPresentationStage = AccountUploadProgress["stage"];

interface BaseSoloUploadOptions {
  sessionId: string;
  repository: string;
  branch: string;
  visibility: "public" | "private";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  appendAllocation?: HuggingFaceAppendAllocation;
  episodeIds: string[];
  artefacts: AccountUploadManifestArtefact[];
  signal: AbortSignal;
  onProgress: (
    completed: number,
    total: number,
    detail: string,
    stage: SoloUploadProgressStage,
  ) => void;
}

export interface AccountSoloUploadOptions extends BaseSoloUploadOptions {
  mode: "account";
  appendAllocation: HuggingFaceAppendAllocation;
  expectedAccountSubject: string;
  expectedHuggingFaceSubject: string;
}

export interface HeadsetSoloUploadOptions extends BaseSoloUploadOptions {
  mode: "headset";
  credential: SoloHuggingFaceCredential;
}

export type SoloUploadOptions = AccountSoloUploadOptions | HeadsetSoloUploadOptions;
export type SoloUploadResult =
  | Readonly<{ mode: "account"; job: AccountUploadJob }>
  | Readonly<{ mode: "headset"; result: SoloHuggingFaceUploadResult }>;

/** Returns the stable LeRobot episode number carried by the immutable export path. */
export function soloUploadEpisodeReference(
  artefacts: readonly Pick<AccountUploadManifestArtefact, "path">[],
) {
  const episodeNumbers = [...new Set(artefacts.flatMap(({ path }) => {
    const match = /^shards\/episode-(\d{6,})\//.exec(path);
    return match ? [match[1]!] : [];
  }))].sort();
  if (episodeNumbers.length === 0) return null;
  if (episodeNumbers.length === 1) return `capture ${episodeNumbers[0]}`;
  return `captures ${episodeNumbers.join(", ")}`;
}

export type SoloUploadWorkerOptions =
  | (Omit<AccountSoloUploadOptions, "signal" | "onProgress"> & {
      telemetryMode: "disabled";
    })
  | Omit<HeadsetSoloUploadOptions, "signal" | "onProgress">;

type SoloUploadWorkerMessage =
  | Readonly<{
      type: "progress";
      completed: number;
      total: number;
      detail: string;
      stage: SoloUploadProgressStage;
    }>
  | Readonly<{ type: "complete"; result: SoloUploadResult }>
  | Readonly<{
      type: "error";
      error: string;
      telemetry?: WorkerErrorDetail;
      stage?: string;
      cancelled: boolean;
      cancellationUnconfirmed: boolean;
      outcomeUnconfirmed: boolean;
      accountUploadJobId?: string | null;
    }>;

export class SoloUploadCancellationUnconfirmedError extends Error {
  readonly recoverable = true;

  constructor(
    message: string,
    readonly jobId: string | null = null,
  ) {
    super(message);
    this.name = "SoloUploadCancellationUnconfirmedError";
  }
}

export class SoloUploadOutcomeUnconfirmedError extends Error {
  readonly recoverable = true;

  constructor(
    message: string,
    readonly jobId: string | null = null,
  ) {
    super(message);
    this.name = "SoloUploadOutcomeUnconfirmedError";
  }
}

const SOLO_ACCOUNT_UPLOAD_JOB_STATUSES = new Set<AccountUploadJob["status"]>([
  "pending",
  "preparing",
  "uploading",
  "finalising",
  "completed",
  "failed",
  "cancelled",
]);
const SOLO_ACCOUNT_UPLOAD_ARTEFACT_STATUSES = new Set<AccountUploadJob["artefacts"][number]["status"]>([
  "pending",
  "action_issued",
  "uploaded",
  "verified",
  "failed",
]);
const SOLO_MISSING_REPOSITORY_BEHAVIOURS = new Set<HuggingFaceMissingRepositoryBehaviour>([
  "do-not-create",
  "private",
  "public",
]);

function validSoloUploadTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validSoloUploadNullableTimestamp(value: unknown): value is string | null {
  return value === null || validSoloUploadTimestamp(value);
}

function validSoloUploadFinalCommit(value: unknown): value is NonNullable<AccountUploadJob["finalCommit"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<NonNullable<AccountUploadJob["finalCommit"]>>;
  if (
    typeof candidate.oid !== "string"
    || !/^[A-Za-z0-9]{7,128}$/.test(candidate.oid)
    || typeof candidate.url !== "string"
    || candidate.url.length > 2_048
    || !validSoloUploadTimestamp(candidate.verifiedAt)
  ) return false;
  try {
    const url = new URL(candidate.url);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validSoloUploadArtefact(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AccountUploadJob["artefacts"][number]>;
  return typeof candidate.path === "string"
    && candidate.path.length > 0
    && candidate.path.length <= 240
    && typeof candidate.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(candidate.sha256)
    && Number.isSafeInteger(candidate.byteLength)
    && (candidate.byteLength as number) >= 0
    && (candidate.byteLength as number) <= ACCOUNT_EXPORT_MAX_ARTEFACT_BYTES
    && typeof candidate.mediaType === "string"
    && candidate.mediaType.length > 0
    && candidate.mediaType.length <= 128
    && typeof candidate.status === "string"
    && SOLO_ACCOUNT_UPLOAD_ARTEFACT_STATUSES.has(candidate.status as AccountUploadJob["artefacts"][number]["status"])
    && Number.isSafeInteger(candidate.retryCount)
    && (candidate.retryCount as number) >= 0
    && validSoloUploadNullableTimestamp(candidate.uploadedAt)
    && validSoloUploadNullableTimestamp(candidate.verifiedAt);
}

function validSoloAccountUploadJob(value: unknown): value is AccountUploadJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AccountUploadJob>;
  return candidate.version === ACCOUNT_EXPORT_API_VERSION
    && typeof candidate.id === "string"
    && /^hf_upload_[A-Za-z0-9_-]{24}$/.test(candidate.id)
    && typeof candidate.captureSessionId === "string"
    && candidate.captureSessionId.length > 0
    && candidate.captureSessionId.length <= 128
    && typeof candidate.repository === "string"
    && /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/.test(candidate.repository)
    && typeof candidate.branch === "string"
    && candidate.branch.length > 0
    && candidate.branch.length <= 128
    && isHuggingFaceAppendAllocation(candidate.appendAllocation)
    && (candidate.visibility === "private" || candidate.visibility === "public")
    && (candidate.missingRepositoryBehaviour === undefined
      || SOLO_MISSING_REPOSITORY_BEHAVIOURS.has(candidate.missingRepositoryBehaviour))
    && typeof candidate.status === "string"
    && SOLO_ACCOUNT_UPLOAD_JOB_STATUSES.has(candidate.status as AccountUploadJob["status"])
    && Array.isArray(candidate.episodeIds)
    && candidate.episodeIds.length > 0
    && candidate.episodeIds.length <= ACCOUNT_EXPORT_MAX_EPISODES
    && candidate.episodeIds.every((episodeId) => (
      typeof episodeId === "string" && episodeId.length > 0 && episodeId.length <= 128
    ))
    && new Set(candidate.episodeIds).size === candidate.episodeIds.length
    && typeof candidate.manifestHash === "string"
    && /^[a-f0-9]{64}$/.test(candidate.manifestHash)
    && Array.isArray(candidate.artefacts)
    && candidate.artefacts.length > 0
    && candidate.artefacts.length <= 1_000
    && candidate.artefacts.every(validSoloUploadArtefact)
    && (candidate.accountSubject === undefined || typeof candidate.accountSubject === "string")
    && (candidate.huggingFaceSubject === undefined || typeof candidate.huggingFaceSubject === "string")
    && (candidate.error === null || typeof candidate.error === "string")
    && (candidate.finalCommit === null || validSoloUploadFinalCommit(candidate.finalCommit))
    && (candidate.completionReceipt === null || typeof candidate.completionReceipt === "string")
    && validSoloUploadNullableTimestamp(candidate.finalisationLeaseExpiresAt)
    && (candidate.finalisationReclaimable === undefined
      || typeof candidate.finalisationReclaimable === "boolean")
    && validSoloUploadTimestamp(candidate.createdAt)
    && validSoloUploadTimestamp(candidate.updatedAt)
    && validSoloUploadNullableTimestamp(candidate.completedAt)
    && (candidate.status !== "completed" || (
      validSoloUploadFinalCommit(candidate.finalCommit)
      && typeof candidate.completionReceipt === "string"
      && candidate.completionReceipt.length > 0
      && validSoloUploadTimestamp(candidate.completedAt)
    ));
}

import { applicationServices } from "./application-services.js";

export async function runSoloUploadInWorker(options: SoloUploadOptions): Promise<SoloUploadResult> {
  options.signal.throwIfAborted();
  const worker = applicationServices().uploadWorker?.() ?? new Worker(new URL("./solo-upload.worker.ts", import.meta.url), {
    type: "module",
    name: "ceres-solo-upload",
  });
  let abort: () => void = () => undefined;
  try {
    return await new Promise<SoloUploadResult>((resolve, reject) => {
      let settled = false;
      let cancellationError: Error | null = null;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const unconfirmedCancellation = (
        message: string,
        cause: unknown,
        stage: string,
      ) => {
        const error = withErrorContext(
          new SoloUploadCancellationUnconfirmedError(message),
          {
            episodeCount: options.episodeIds.length,
            stage,
            worker: "hugging_face_upload",
          },
        );
        if (cause !== undefined) {
          Object.defineProperty(error, "cause", {
            configurable: true,
            value: cause,
          });
        }
        return error;
      };
      const unconfirmedOutcome = (
        message: string,
        cause: unknown,
        stage: string,
        jobId: string | null = null,
      ) => {
        const error = withErrorContext(
          new SoloUploadOutcomeUnconfirmedError(message, jobId),
          {
            episodeCount: options.episodeIds.length,
            stage,
            worker: "hugging_face_upload",
          },
        );
        if (cause !== undefined) {
          Object.defineProperty(error, "cause", {
            configurable: true,
            value: cause,
          });
        }
        return error;
      };
      const requestCancellation = (error: unknown) => {
        if (settled || cancellationError) return;
        cancellationError = withErrorContext(error instanceof Error
          ? error
          : new Error("The background upload worker stopped"), {
          episodeCount: options.episodeIds.length,
          stage: "progress_callback",
          worker: "hugging_face_upload",
        });
        try {
          worker.postMessage({ type: "cancel" });
        } catch (postError) {
          settle(() => reject(unconfirmedCancellation(
            "The background upload worker could not receive the cancellation request, so cancellation could not be confirmed",
            postError,
            "cancelling",
          )));
          return;
        }
        // The account worker may still be completing the durable backend cancellation.
        // Its terminal message is the acknowledgement that makes termination safe.
      };

      abort = () => requestCancellation(options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Hugging Face sync cancelled", "AbortError"));
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) {
        abort();
        settle(() => reject(cancellationError!));
        return;
      }
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const malformedAccountJobId = options.mode === "account"
          ? soloMalformedAccountCompletionJobId(event.data)
          : null;
        const message = soloUploadWorkerMessage(event.data);
        if (!message) {
          const protocolError = withErrorContext(
            new Error("The background upload worker returned an invalid response"),
            {
              episodeCount: options.episodeIds.length,
              stage: "protocol",
              worker: "hugging_face_upload",
            },
          );
          settle(() => reject(cancellationError
            ? unconfirmedCancellation(
                "The background upload response was invalid, so cancellation could not be confirmed",
                protocolError,
                "protocol",
              )
            : options.mode === "account"
              ? unconfirmedOutcome(
                  "The background upload response was invalid. CERES will reconcile the existing backend upload before reporting an outcome.",
                  protocolError,
                  "protocol",
                  malformedAccountJobId,
                )
              : protocolError));
          return;
        }
        if (message.type === "progress") {
          if (cancellationError) return;
          try {
            options.onProgress(
              message.completed,
              message.total,
              message.detail,
              message.stage,
            );
          } catch (error) {
            requestCancellation(error);
          }
          return;
        }
        if (message.type === "complete") {
          // A completed worker result is durable truth even when cancellation raced it.
          settle(() => resolve(message.result));
          return;
        }
        const workerError = message.telemetry
          ? workerErrorFromDetail(message.telemetry, {
              episodeCount: options.episodeIds.length,
              stage: message.stage ?? "uploading",
              worker: "hugging_face_upload",
            })
          : withErrorContext(new Error(message.error), {
              episodeCount: options.episodeIds.length,
              stage: message.stage ?? "uploading",
              worker: "hugging_face_upload",
            });
        const cancellationUnconfirmedError = withErrorContext(
          new SoloUploadCancellationUnconfirmedError(
            message.error,
            message.accountUploadJobId ?? null,
          ),
          {
            episodeCount: options.episodeIds.length,
            stage: message.stage ?? "uploading",
            worker: "hugging_face_upload",
          },
        );
        if (message.telemetry) {
          Object.defineProperty(cancellationUnconfirmedError, "cause", {
            configurable: true,
            value: workerError,
          });
        }
        const outcomeUnconfirmedError = unconfirmedOutcome(
          message.error,
          workerError,
          message.stage ?? "uploading",
          message.accountUploadJobId ?? null,
        );
        settle(() => reject(message.cancellationUnconfirmed
          ? cancellationUnconfirmedError
          : message.cancelled
            ? cancellationError ?? new DOMException("Hugging Face sync cancelled", "AbortError")
            : cancellationError
              ? unconfirmedCancellation(
                  "The background upload worker stopped without acknowledging cancellation",
                  workerError,
                  message.stage ?? "uploading",
                )
              : message.outcomeUnconfirmed !== false && options.mode === "account"
                ? outcomeUnconfirmedError
                : workerError));
      });
      worker.addEventListener("error", (event) => {
        const workerError = new Error(event.message || "The background upload worker stopped");
        if (event.filename && event.lineno > 0 && event.colno > 0) {
          workerError.stack = `${workerError.name}: ${workerError.message}\n    at <anonymous> (${event.filename}:${event.lineno}:${event.colno})`;
        }
        const contextualWorkerError = withErrorContext(workerError, {
            episodeCount: options.episodeIds.length,
            stage: "worker_crash",
            worker: "hugging_face_upload",
          });
        settle(() => reject(cancellationError
          ? unconfirmedCancellation(
              "The background upload worker stopped, so cancellation could not be confirmed",
              contextualWorkerError,
              "worker_crash",
            )
          : options.mode === "account"
            ? unconfirmedOutcome(
                "The background upload worker stopped. CERES will reconcile the existing backend upload before reporting an outcome.",
                contextualWorkerError,
                "worker_crash",
              )
            : contextualWorkerError));
      }, { once: true });
      worker.addEventListener("messageerror", () => {
        const context = {
          episodeCount: options.episodeIds.length,
          stage: "protocol",
          worker: "hugging_face_upload",
        } as const;
        const protocolError = withErrorContext(
          new Error("The background upload worker returned an unreadable response"),
          context,
        );
        if (!cancellationError) {
          settle(() => reject(options.mode === "account"
            ? unconfirmedOutcome(
                "The background upload response was unreadable. CERES will reconcile the existing backend upload before reporting an outcome.",
                protocolError,
                context.stage,
              )
            : protocolError));
          return;
        }
        settle(() => reject(unconfirmedCancellation(
          "The background upload response was unreadable, so cancellation could not be confirmed",
          protocolError,
          context.stage,
        )));
      }, { once: true });
      const resolvedWorkerOptions: SoloUploadWorkerOptions = options.mode === "account"
        ? (() => {
            const {
              signal: _signal,
              onProgress: _onProgress,
              ...workerOptions
            } = options;
            return { ...workerOptions, telemetryMode: "disabled" as const };
          })()
        : (() => {
            const {
              signal: _signal,
              onProgress: _onProgress,
              ...workerOptions
            } = options;
            return workerOptions;
          })();
      try {
        worker.postMessage({ type: "start", options: resolvedWorkerOptions });
      } catch (error) {
        const startError = withErrorContext(error instanceof Error
          ? error
          : new Error("The background upload worker could not start"), {
          episodeCount: options.episodeIds.length,
          stage: "starting",
          worker: "hugging_face_upload",
        });
        settle(() => reject(cancellationError
          ? unconfirmedCancellation(
              "The background upload worker could not start after cancellation was requested, so cancellation could not be confirmed",
              startError,
              "starting",
            )
          : startError));
      }
    });
  } finally {
    options.signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}

function soloMalformedAccountCompletionJobId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as {
    type?: unknown;
    result?: { mode?: unknown; job?: { id?: unknown } };
  };
  const id = message.type === "complete" && message.result?.mode === "account"
    ? message.result.job?.id
    : null;
  return typeof id === "string" && /^hf_upload_[A-Za-z0-9_-]{24}$/.test(id) ? id : null;
}

function soloUploadWorkerMessage(value: unknown): SoloUploadWorkerMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Partial<SoloUploadWorkerMessage>;
  if (message.type === "progress") {
    return typeof message.detail === "string"
      && typeof message.stage === "string"
      && Number.isFinite(message.completed)
      && Number.isFinite(message.total)
      ? message as Extract<SoloUploadWorkerMessage, { type: "progress" }>
      : null;
  }
  if (message.type === "complete") {
    const result = message.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    if (result.mode === "account") {
      return validSoloAccountUploadJob(result.job)
        ? message as Extract<SoloUploadWorkerMessage, { type: "complete" }>
        : null;
    }
    return result.mode === "headset" && result.result && typeof result.result === "object"
      ? message as Extract<SoloUploadWorkerMessage, { type: "complete" }>
      : null;
  }
  return message.type === "error"
    && typeof message.error === "string"
    && (message.telemetry === undefined || isWorkerErrorDetail(message.telemetry))
    && (message.stage === undefined || (
      typeof message.stage === "string"
      && /^[a-z][a-z0-9_-]{0,63}$/.test(message.stage)
    ))
    && typeof message.cancelled === "boolean"
    && typeof message.cancellationUnconfirmed === "boolean"
    && (message.outcomeUnconfirmed === undefined || typeof message.outcomeUnconfirmed === "boolean")
    && (
      message.accountUploadJobId === undefined
      || message.accountUploadJobId === null
      || (
        typeof message.accountUploadJobId === "string"
        && /^hf_upload_[A-Za-z0-9_-]{24}$/.test(message.accountUploadJobId)
      )
    )
    ? message as Extract<SoloUploadWorkerMessage, { type: "error" }>
    : null;
}

export function soloUploadPresentationStage(
  stage: SoloUploadProgressStage,
): SoloUploadPresentationStage {
  if (stage === "committing") return "finalising";
  if (stage === "repository" || stage === "reading" || stage === "hashing") return "preparing";
  return stage;
}
