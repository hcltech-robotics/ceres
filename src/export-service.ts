import type { AccountExportSession, AccountExportRepositoryCatalogue, AccountExportDestinationValidation, AccountExportDestinationValidationRequest, AccountUploadJob, AccountUploadManifestArtefact, AccountUploadCreateRequest, AccountUploadCreateResponse, AccountUploadCancelResponse, HuggingFaceAppendAllocation, HuggingFaceMissingRepositoryBehaviour } from "../shared/export-destination.js";
import type { VerifiedEpisodeHuggingFaceUpload } from "../shared/protocol.js";


export interface AccountUploadProgress {
  stage: "creating" | "preparing" | "uploading" | "finalising" | "completed" | "cancelled";
  detail: string;
  completed: number;
  total: number;
  job: AccountUploadJob | null;
}


export interface AccountUploadSyncOptions {
  expectedAccountSubject?: string;
  expectedHuggingFaceSubject?: string;
  sessionId: string;
  repository: string;
  branch: string;
  appendAllocation: HuggingFaceAppendAllocation;
  visibility: "private" | "public";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  episodeIds: string[];
  artefacts: AccountUploadManifestArtefact[];
  waitForFinalisation?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: AccountUploadProgress) => void;
}


export class AccountUploadInvalidResponseError extends Error {
  constructor() {
    super("The export destination service returned an invalid upload response");
    this.name = "AccountUploadInvalidResponseError";
  }
}


export class AccountExportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountExportRequestError";
  }
}


export class AccountUploadCancellationUnconfirmedError extends Error {
  readonly recoverable = true;

  constructor(
    readonly jobId: string | null,
    readonly confirmationError?: unknown,
  ) {
    super(
      "Hugging Face cancellation was not confirmed. The existing upload remains recoverable; retry to reconcile its backend state.",
    );
    this.name = "AccountUploadCancellationUnconfirmedError";
  }
}


export function verifiedEpisodeUploadFromAccountJob(
  job: AccountUploadJob,
  captureSessionId: string,
  episodeIds: readonly string[],
): VerifiedEpisodeHuggingFaceUpload {
  const expectedEpisodeIds = canonicalEpisodeIds(episodeIds);
  if (job.status !== "completed"
    || !job.finalCommit
    || !job.completionReceipt
    || !job.completedAt
    || job.captureSessionId !== captureSessionId
    || !sameStringArray(canonicalEpisodeIds(job.episodeIds), expectedEpisodeIds)
    || !/^[a-f0-9]{64}$/.test(job.manifestHash)) {
    throw new Error("Only a matching verified Hugging Face job may update episode metadata");
  }
  return {
    state: "completed",
    requestId: job.id,
    jobId: job.id,
    captureSessionId: job.captureSessionId,
    episodeIds: expectedEpisodeIds,
    completionReceipt: job.completionReceipt,
    manifestHash: job.manifestHash,
    repository: job.repository,
    branch: job.branch,
    visibility: job.visibility,
    outcome: "uploaded",
    uploadedAt: job.completedAt,
    commitOid: job.finalCommit.oid,
    commitUrl: job.finalCommit.url,
    verifiedAt: job.finalCommit.verifiedAt,
  };
}


export function sameAccountUploadEpisodeIds(
  left: readonly string[],
  right: readonly string[],
) {
  try {
    return sameStringArray(canonicalEpisodeIds(left), canonicalEpisodeIds(right));
  } catch {
    return false;
  }
}


export function canonicalEpisodeIds(episodeIds: readonly string[]) {
  if (episodeIds.length === 0 || new Set(episodeIds).size !== episodeIds.length) {
    throw new Error("Hugging Face upload episode selection is invalid");
  }
  return [...episodeIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}


export function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
export interface ExportDestinationService {
  session(signal?: AbortSignal): Promise<AccountExportSession>;
  repositoryCatalogue(organisation?: string, prefix?: string, signal?: AbortSignal): Promise<AccountExportRepositoryCatalogue>;
  validateDestination(request: AccountExportDestinationValidationRequest, signal?: AbortSignal): Promise<AccountExportDestinationValidation>;
  disconnectHuggingFace(signal?: AbortSignal): Promise<{ disconnected: true }>;
  huggingFaceConnectUrl(returnPath: string): string;
  reacquireUpload(request: AccountUploadCreateRequest, signal?: AbortSignal): Promise<AccountUploadCreateResponse>;
  uploadStatus(jobId: string, signal?: AbortSignal): Promise<AccountUploadJob>;
  cancelUpload(jobId: string, signal?: AbortSignal): Promise<AccountUploadCancelResponse>;
  reconcileUpload(job: AccountUploadJob, signal?: AbortSignal): Promise<AccountUploadJob>;
  syncBrowserExport(options: AccountUploadSyncOptions): Promise<AccountUploadJob>;
}
let service: ExportDestinationService | null = null;
export function configureExportDestinationService(value: ExportDestinationService) { service = value; }
export function exportDestinationService() { return service; }
export function requireExportDestinationService() {
  if (!service) throw new Error("An export destination service is not configured");
  return service;
}
