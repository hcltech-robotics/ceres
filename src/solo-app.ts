import { captureSafetyMarkup } from "./capture-setup.js";
import {
  isStateBoundRunControlAction,
  nextRunControlCursor,
  type CaptureConfiguration,
  type CaptureJob,
  type Episode,
  type SessionSnapshot,
  type SoloExportDestinationPreference,
  type SoloHuggingFaceSaveCadence,
  type SoloWorkspaceState,
} from "../shared/protocol.js";
import {
  isHuggingFaceAppendAllocation,
  matchesRetainedHuggingFaceAppendAllocation,
  sameHuggingFaceAppendAllocation,
  type AccountExportDestinationValidation,
  type AccountExportRepositoryCatalogue,
  type AccountExportSession,
  type AccountUploadJob,
  type AccountUploadManifestArtefact,
  type HuggingFaceAppendAllocation,
  type HuggingFaceMissingRepositoryBehaviour,
} from "../shared/export-destination.js";
import {
  requireExportDestinationService,
  AccountExportRequestError,
  AccountUploadCancellationUnconfirmedError,
  AccountUploadInvalidResponseError,
  sameAccountUploadEpisodeIds,
  verifiedEpisodeUploadFromAccountJob,
} from "./export-service.js";
import {
  CaptureApp,
  type CaptureLaunchPresentationState,
  type SoloUploadHudStatus,
} from "./capture-app.js";




import type { DirectRunControlAction } from "./direct-session-reducer.js";
import { workerErrorFromDetail } from "./worker-errors.js";
import { BrowserExportAdapter } from "./lerobot-export/browser-export-adapter.js";
import type {
  MonitorExportErrorEvent,
  MonitorExportWorkerEvent,
} from "./lerobot-export/types.js";
import { RunDraftController } from "./run-draft-controller.js";
import { RunEditor } from "./run-editor.js";
import { SoloSessionController } from "./solo-session-controller.js";
import { SoloCaptureAuthority } from "./solo-capture-authority.js";
import {
  SoloExportController,
  type SoloExportControllerState,
  type SoloExportRequest,
} from "./solo-export-controller.js";
import {
  SoloTaskImportController,
  type SoloTaskImportSnapshot,
} from "./solo-task-import-controller.js";
import { TASK_IMPORT_MAX_BYTES } from "./task-import.js";
import { TaskImportWorkspace } from "./task-import-browser.js";
import {
  clearSoloSystemTransition,
  completeSoloSystemTransition,
  isSoloSystemTransitionContinuation,
  isSoloSystemTransitionOauthReturn,
  markSoloSystemTransitionOutsideXr,
  persistSoloSystemTransition,
  requestSoloSystemTransition,
  requireSoloSystemTransitionXrReentry,
  resumeSoloSystemTransitionAfterReload,
  restoreSoloSystemTransition,
  type PendingSoloSystemTransition,
  type SoloSystemTransitionKind,
} from "./solo-system-transition.js";
import {
  ensureSoloDirectoryReadWritePermission,
  SoloSystemResultStore,
  type SoloDirectoryHandle,
} from "./solo-system-result-store.js";
import {
  applySoloXrDraftIntent,
  type SoloXrConsoleAccountPresentation,
  type SoloXrConsoleExportState,
  type SoloXrConsoleImportState,
  type SoloXrConsoleIntent,
  type SoloXrConsolePage,
} from "./solo-xr-console-presentation.js";
import {
  checkSoloStorageHeadroom,
  rememberSoloSession,
  SOLO_ACTIVE_SESSION_STORAGE_KEY,
  SOLO_SESSION_ID_PATTERN,
} from "./solo-session-persistence.js";
import { waitForSoloStartReadiness } from "./solo-start-readiness.js";
import { verifySoloHuggingFaceCredential } from "./solo-hf-credential.js";
import {
  beginSoloHuggingFaceOauth,
  completeSoloHuggingFaceOauth,
  deleteSoloHuggingFaceCredential,
  loadSoloHuggingFaceCredential,
  type SoloHuggingFaceCredential,
} from "./solo-hf-oauth.js";
import {
  loadSoloHuggingFaceOwners,
  loadSoloHuggingFaceRepositories,
} from "./solo-hf-repository-catalogue.js";
import {
  normaliseSoloHuggingFaceDestination,
  soloHuggingFaceRepositoryName,
  SoloHuggingFaceDestinationError,
  soloHuggingFaceDestinationError,
  validateSoloHuggingFaceDestination,
  type SoloHuggingFaceDestinationErrorCode,
} from "./solo-hf-destination.js";
import { soloHuggingFaceUploadErrorMessage } from "./solo-hf-upload.js";
import {
  runSoloUploadInWorker,
  SoloUploadCancellationUnconfirmedError,
  SoloUploadOutcomeUnconfirmedError,
  soloUploadEpisodeReference,
  soloUploadPresentationStage,
} from "./solo-upload-adapter.js";
import {
  soloPostAcquisitionQualityWindow,
} from "./solo-post-acquisition-quality.js";
import {
  soloAutomaticUploadEpisodeIds,
  soloAutomaticUploadKey,
} from "./solo-automatic-upload.js";
import {
  soloAutomaticLocalExportEpisodeIds,
  soloAutomaticLocalExportKey,
} from "./solo-automatic-local-export.js";
import {
  DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION,
  requestSoloLocalExportPermission,
  soloLocalExportFolderIdentityMatches,
  soloLocalExportPermission,
  SoloLocalExportDestinationStore,
  type SoloLocalExportDestination,
  type SoloLocalExportPermission,
} from "./solo-local-export-destination.js";
import {
  SoloRunQualityService,
  SOLO_RUN_QUALITY_STORAGE_ROOT,
  type SoloRunQualityLoadOptions,
  type SoloRunQualityResult,
} from "./solo-run-quality.js";
import {
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  Globe,
  LockKeyhole,
  RotateCw,
  createIcons,
} from "lucide";

const SAFE_SOLO_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SOLO_ACCOUNT_SESSION_TIMEOUT_MS = 8_000;
const SOLO_HEADSET_CREDENTIAL_LOAD_TIMEOUT_MS = 4_000;
const SOLO_HEADSET_CREDENTIAL_VERIFY_TIMEOUT_MS = 4_000;
const SOLO_REPOSITORY_CATALOGUE_DELAY_MS = 180;
const SOLO_REPOSITORY_REQUEST_TIMEOUT_MS = 10_000;
const SOLO_PREPARED_UPLOAD_START_FAILURE = "The Hugging Face destination or authorisation changed before upload. Verify both, then retry the upload.";
const SOLO_UPLOAD_RECOVERY_RETRY_MS = 30_000;
const SOLO_MISSING_REPOSITORY_LABELS: Record<HuggingFaceMissingRepositoryBehaviour, string> = {
  "do-not-create": "Existing only",
  private: "Create private",
  public: "Create public",
};

interface SoloRepositoryDestinationValidation {
  key: string | null;
  state: "idle" | "checking" | "ready" | "error";
  detail: string;
  code: SoloHuggingFaceDestinationErrorCode | null;
  result: AccountExportDestinationValidation | null;
}

const escapeHtml = (value: string) => value.replace(
  /[&<>"]/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!,
);

interface SoloExportIntent {
  type: "export" | "folder" | "upload";
  episodeIds: string[];
  repository?: string;
  branch?: string;
  visibility?: "private" | "public";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  uploadMode?: "account" | "headset";
  uploadPrincipal?: string;
  appendAllocation?: HuggingFaceAppendAllocation;
}

interface SoloAccountUploadReconciliationInput {
  requestId: string;
  accountJob: AccountUploadJob | string | null;
  accountSubject: string;
  huggingFaceSubject: string;
  sessionId: string;
  episodeIds: readonly string[];
  cancellationPending: boolean;
}

type SoloExportJourneyOutcome = "queued" | "completed" | "failed" | "cancelled";

function soloUploadProgressDetail(
  artefacts: readonly AccountUploadManifestArtefact[],
  detail: string,
) {
  const episodeReference = soloUploadEpisodeReference(artefacts);
  return episodeReference ? `Uploading as ${episodeReference}... ${detail}` : detail;
}

function assertSoloUploadArtefactAllocation(
  artefacts: readonly AccountUploadManifestArtefact[],
  allocation: HuggingFaceAppendAllocation,
) {
  const episodeIndices = [...new Set(artefacts.flatMap(({ path }) => {
    const match = /^shards\/episode-(\d{6,})\//.exec(path);
    if (!match) return [];
    const episodeIndex = Number(match[1]);
    return Number.isSafeInteger(episodeIndex) ? [episodeIndex] : [];
  }))].sort((left, right) => left - right);
  if (episodeIndices.length === 0) {
    throw new Error("The prepared export does not contain an immutable episode shard");
  }
  for (const [offset, episodeIndex] of episodeIndices.entries()) {
    if (episodeIndex !== allocation.nextEpisodeIndex + offset) {
      throw new Error("The prepared export no longer matches the Hugging Face append position");
    }
  }
}

function soloUploadCompletionDetail(
  artefacts: readonly AccountUploadManifestArtefact[],
  commitOid: string,
) {
  const episodeReference = soloUploadEpisodeReference(artefacts);
  return episodeReference
    ? `Uploaded as ${episodeReference}. Hugging Face commit ${commitOid}`
    : `Hugging Face commit ${commitOid}`;
}

export function soloExportWorkerFailurePresentation(
  event: Pick<MonitorExportErrorEvent, "cancelled" | "errorType">,
) {
  if (event.cancelled) {
    return {
      detail: "Export cancelled",
      errorType: "AbortError",
    };
  }
  return {
    detail: "Browser export failed before the artefacts were ready. Retry the export.",
    errorType: typeof event.errorType === "string"
      && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(event.errorType)
      ? event.errorType
      : "WorkerExportError",
  };
}

export function soloUploadHudStatus(value: {
  active: Pick<SoloExportControllerState["active"], "job" | "progress">;
  jobs: readonly CaptureJob[];
  episodes?: SoloExportControllerState["episodes"];
}): SoloUploadHudStatus | null {
  const activeJob = value.active.job?.type === "upload"
    ? value.active.job
    : value.jobs.find((job) => (
        job.type === "upload" && (job.state === "queued" || job.state === "running")
      )) ?? null;
  if (!activeJob) return null;
  const progress = value.active.progress?.jobId === null
    || value.active.progress?.jobId === activeJob.id
    ? value.active.progress
    : null;
  if (progress?.stage === "completed" || progress?.stage === "cancelled") return null;
  const persistedAccountFinalisation = activeJob.state === "running"
    && activeJob.browserRecovery?.uploadMode === "account"
    && activeJob.browserRecovery.cancellationPending !== true
    && Boolean(activeJob.browserRecovery.accountUploadJobId);
  const stage: SoloUploadHudStatus["stage"] = progress?.stage === "finalising"
    || persistedAccountFinalisation
    ? "finalising"
    : progress?.stage === "uploading"
      ? "uploading"
      : "preparing";
  const episodeReference = soloUploadEpisodeReference(activeJob.browserRecovery?.artefacts ?? [])
    ?? soloPreparingUploadEpisodeReference(
      activeJob.browserRecovery?.episodeIds ?? [],
      value.episodes ?? [],
    );
  const label = episodeReference
    ? stage === "uploading"
      ? `Uploading as ${episodeReference}...`
      : stage === "finalising"
        ? `Finalising ${episodeReference}...`
        : `Preparing ${episodeReference}...`
    : stage === "uploading"
      ? "Uploading..."
      : stage === "finalising"
        ? "Finalising upload..."
        : "Preparing upload...";
  return {
    stage,
    label,
    detail: progress?.detail ?? activeJob.detail,
    progress: progress ? Math.min(1, Math.max(0, progress.fraction)) : null,
  };
}

function soloPreparingUploadEpisodeReference(
  episodeIds: readonly string[],
  episodes: SoloExportControllerState["episodes"],
) {
  const selected = new Set(episodeIds);
  const indices = [...episodes]
    .filter(({ exportable }) => exportable)
    .sort((left, right) => (
      left.episode.startedAt.localeCompare(right.episode.startedAt)
      || left.id.localeCompare(right.id)
    ))
    .flatMap(({ id }, index) => selected.has(id) ? [String(index).padStart(6, "0")] : []);
  if (indices.length === 0) return null;
  return indices.length === 1 ? `episode ${indices[0]}` : `episodes ${indices.join(", ")}`;
}



interface SoloCapability {
  id: "secure" | "opfs" | "storage" | "camera" | "microphone" | "xr";
  label: string;
  state: "checking" | "ready" | "blocked";
  detail: string;
}

export type SoloProvisioningStage = "destination" | "camera" | "run" | "xr";

const isSoloProvisioningStage = (value: string | undefined): value is SoloProvisioningStage =>
  value === "destination" || value === "camera" || value === "run" || value === "xr";

export interface SoloProvisioningInput {
  destinationReady: boolean;
  cameraReady: boolean;
  runReviewed: boolean;
  hasRecordableTask: boolean;
  xrLaunchReady: boolean;
}

export interface SoloProvisioningState extends SoloProvisioningInput {
  stage: SoloProvisioningStage;
  runReady: boolean;
  xrReady: boolean;
}

export function soloProvisioningStepPresentation(
  state: SoloProvisioningState,
  step: SoloProvisioningStage,
  requestedExpanded: boolean | undefined,
) {
  const complete = step === "destination"
    ? state.destinationReady
    : step === "camera"
      ? state.cameraReady
      : step === "run"
        ? state.runReady
        : false;
  const active = state.stage === step;
  const available = !complete && !active && step === "run";
  const locked = !complete && !active && !available;
  return {
    complete,
    expanded: locked ? false : requestedExpanded ?? !complete,
  };
}

export function soloUploadCompletionRepository(
  job: CaptureJob | null | undefined,
  fallback: string | null,
) {
  return job?.browserRecovery?.destination === "hugging-face"
    ? job.browserRecovery.repository ?? null
    : fallback;
}

export function soloHuggingFaceUploadActivityLabel(
  runComplete: boolean,
  recovered: boolean,
  repository: string | null,
) {
  const repositoryLabel = repository ? ` to ${repository}` : "";
  if (recovered) return `Syncing previous run${repositoryLabel}...`;
  return runComplete
    ? `Run complete, uploading${repositoryLabel}...`
    : `Uploading current capture${repositoryLabel}...`;
}

export function soloRunCanResume(
  snapshot: Pick<SessionSnapshot, "run" | "currentEpisode" | "pendingEpisode">,
) {
  const quiescentRun = snapshot.run.recordingState === "idle"
    && snapshot.currentEpisode === null
    && snapshot.pendingEpisode === null;
  const pausedCapture = snapshot.run.recordingState === "paused"
    && snapshot.currentEpisode !== null
    && snapshot.pendingEpisode === null;
  return snapshot.run.status === "running" && (quiescentRun || pausedCapture);
}

export function soloRunHasPausedCapture(
  snapshot: Pick<SessionSnapshot, "run" | "currentEpisode" | "pendingEpisode">,
) {
  return snapshot.run.status === "running"
    && snapshot.run.recordingState === "paused"
    && snapshot.currentEpisode !== null
    && snapshot.pendingEpisode === null;
}

export function soloRunCanStop(
  snapshot: Pick<SessionSnapshot, "run" | "currentEpisode" | "pendingEpisode">,
) {
  if (snapshot.run.status !== "running" || snapshot.pendingEpisode !== null) return false;
  if (snapshot.currentEpisode === null) {
    return snapshot.run.recordingState === "idle";
  }
  return snapshot.run.recordingState === "recording"
    || snapshot.run.recordingState === "paused";
}

export type SoloHuggingFaceUploadAuthority = Readonly<{
  mode: "account" | "headset";
  principal: string;
}>;

export function soloHuggingFaceUploadAuthorityForMode(
  mode: "account" | "headset",
  authorities: readonly SoloHuggingFaceUploadAuthority[],
) {
  return authorities.find((authority) => authority.mode === mode) ?? null;
}

export function soloProvisioningState(
  input: SoloProvisioningInput,
): SoloProvisioningState {
  const runReady = input.runReviewed && input.hasRecordableTask;
  const xrReady = input.cameraReady
    && runReady
    && input.xrLaunchReady;
  const stage: SoloProvisioningStage = !input.cameraReady
    ? "camera"
    : !runReady
      ? "run"
      : "xr";
  return {
    ...input,
    stage,
    runReady,
    xrReady,
  };
}

export interface SoloSystemTransitionRecoveryPorts {
  restoreRuntime(page: SoloXrConsolePage): void;
  failFolderJob(job: CaptureJob): Promise<void>;
  clearResult(transitionId: string): Promise<void>;
  clearPersistedTransition(sessionId: string): void;
  persistWorkspace(page: SoloXrConsolePage): Promise<void>;
  render(): void;
  showOriginalError(error: unknown): void;
}

export async function recoverSoloSystemTransitionCompletion(
  pending: PendingSoloSystemTransition,
  snapshot: SessionSnapshot,
  error: unknown,
  ports: SoloSystemTransitionRecoveryPorts,
  now: () => string = () => new Date().toISOString(),
) {
  const originalMessage = errorMessage(
    error,
    "The Solo system hand-off could not be completed",
  );
  const folderJob = pending.kind === "folder-export"
    ? snapshot.jobs.find(({ id }) => id === pending.continuationId)
    : undefined;

  ports.restoreRuntime(pending.returnPage);

  if (folderJob?.state === "queued" || folderJob?.state === "running") {
    await bestEffortRecoveryStep(async () => {
      await ports.failFolderJob({
        ...folderJob,
        state: "failed",
        detail: `Folder export could not resume. ${originalMessage} Retry the folder export.`,
        updatedAt: now(),
      });    });
  }
  await bestEffortRecoveryStep(() => ports.clearResult(pending.id));
  await bestEffortRecoveryStep(async () => {
    ports.clearPersistedTransition(snapshot.sessionId);
  });
  await bestEffortRecoveryStep(() => ports.persistWorkspace(pending.returnPage));

  ports.render();
  ports.showOriginalError(error);
}

async function bestEffortRecoveryStep(step: () => void | Promise<void>) {
  try {
    await step();
  } catch {
    // Recovery must not leave the headset waiting on a stale system transition.
  }
}

export class SoloApp {
  private root: HTMLElement | null = null;
  private controller: SoloSessionController | null = null;
  private captureApp: CaptureApp | null = null;
  private captureAuthority: SoloCaptureAuthority | null = null;
  private runDraft: RunDraftController | null = null;
  private importController: SoloTaskImportController | null = null;
  private exportController: SoloExportController | null = null;
  private launchRunEditor: RunEditor | null = null;
  private launchTaskWorkspace: TaskImportWorkspace | null = null;
  private exporter: BrowserExportAdapter | null = null;
  private get accountClient() { return requireExportDestinationService(); }
  private accountSession: AccountExportSession | null = null;
  private soloHuggingFaceCredential: SoloHuggingFaceCredential | null = null;
  private soloHuggingFaceSubject: string | null = null;
  private accountUnavailable = false;
  private readonly exportIntents = new Map<string, SoloExportIntent>();
  private readonly cancelledLerobotExportRequestIds = new Set<string>();
  private readonly lerobotExportStartedAt = new Map<string, number>();
  private readonly resumedExportJobIds = new Set<string>();
  private readonly restoredExportJobIds = new Set<string>();
  private uploadController: AbortController | null = null;
  private uploadCompletion: Promise<void> | null = null;
  private uploadMode: "account" | "headset" | null = null;
  private readonly accountUploadReconciliations = new Map<string, AbortController>();
  private pendingUploadResumeCompletion: Promise<void> | null = null;
  private accountDisconnecting = false;
  private accountSessionChecked = false;
  private oauthReturnState: "connected" | "failed" | null = null;
  private oauthCallbackInFlight = false;
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeImport: (() => void) | null = null;
  private unsubscribeExport: (() => void) | null = null;
  private importSnapshot: SoloTaskImportSnapshot | null = null;
  private exportSnapshot: SoloExportControllerState | null = null;
  private sessionRecovery: "new" | "restored" | "active" = "active";
  private xrPage: SoloXrConsolePage = "run";
  private xrNotice: string | null = null;
  private workspaceRepositorySettingsExplicit = false;
  private exportDestination: SoloExportDestinationPreference = "hugging-face";
  private huggingFaceSaveCadence: SoloHuggingFaceSaveCadence = "run";
  private automaticUploadKey: string | null = null;
  private automaticLocalExportKey: string | null = null;
  private readonly localExportDestinationStore = new SoloLocalExportDestinationStore();
  private localExportDestination: SoloLocalExportDestination = DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  private localExportPermission: SoloLocalExportPermission = "granted";
  private localExportDestinationLoaded = false;
  private localExportDestinationBusy = false;
  private localExportDestinationLoad: Promise<void> | null = null;
  private runEditorReviewed = false;
  private resumedRunAwaitingXr = false;
  private stoppingOngoingRun = false;
  private resettingCompletedRun = false;
  private readonly soloStepExpanded = new Map<SoloProvisioningStage, boolean>();
  private xrLaunchGateAllowed = false;
  private launchPresentation: CaptureLaunchPresentationState | null = null;
  private postAcquisitionQualityService: SoloRunQualityService | null = null;
  private postAcquisitionLoadAbort: AbortController | null = null;
  private postAcquisitionLoadKey = "";
  private postAcquisitionResult: SoloRunQualityResult | null = null;
  private postAcquisitionPresentationKey = "";
  private readonly recordedQualityEpisodeIds = new Set<string>();
  private readonly pendingRecordingQualityEpisodes = new Map<string, Episode["qualitySummary"]>();
  private recordingQualityDelivery: Promise<void> | null = null;
  private importGist = "";
  private selectedImportSampleId: string | null = null;
  private selectedImportCandidateId: string | null = null;
  private pendingSystemTransition: PendingSoloSystemTransition | null = null;
  private pendingFolderRequest: SoloExportRequest | null = null;
  private readonly systemResultStore = new SoloSystemResultStore();
  private completingSystemTransition = false;
  private systemTransitionCompletionBlocked = false;
  private timingTimer: number | null = null;
  private configurationTimer: number | null = null;
  private configurationFlushPromise: Promise<void> | null = null;
  private pendingConfiguration: CaptureConfiguration | null = null;
  private pendingAudioRecordingValue: boolean | null = null;
  private soloOauthCompletion = Promise.resolve();
  private authenticationEpoch = 0;
  private startupAuthenticationEpoch = 0;
  private authenticationSignOutInProgress = false;
  private huggingFaceActionBusy = false;
  private huggingFaceActionBusyText = "Opening Hugging Face";
  private repositoryCatalogueAbort: AbortController | null = null;
  private repositoryCatalogueTimer: number | null = null;
  private repositoryCatalogueState: "idle" | "loading" | "ready" | "error" = "idle";
  private readonly repositoryCatalogueOrganisations = new Set<string>();
  private repositoryPolicyOutsidePointerListener: ((event: PointerEvent) => void) | null = null;
  private repositoryDestinationValidation: SoloRepositoryDestinationValidation = {
    key: null,
    state: "idle",
    detail: "Choose a namespace and repository",
    code: null,
    result: null,
  };
  private startReadinessAbort: AbortController | null = null;
  private startingSession = false;
  private resumeCandidateSessionId: string | null = null;
  private xrReadyForTransitionCompletion = false;
  private returningToSoloXr = false;
  private disposed = false;

  mount(root: HTMLElement) {
    if (this.disposed) throw new Error("A disposed Solo application cannot be mounted");
    this.root = root;
    const launchUrl = new URL(location.href);
    this.oauthCallbackInFlight = launchUrl.searchParams.has("code")
      || launchUrl.searchParams.has("state");
    this.huggingFaceActionBusy = this.oauthCallbackInFlight;
    this.huggingFaceActionBusyText = "Completing Hugging Face";
    root.innerHTML = soloCoordinatorMarkup();
    this.localExportDestinationLoad = this.loadLocalExportDestination(root);
    void this.localExportDestinationLoad;
    this.startupAuthenticationEpoch = this.invalidateSoloAuthentication();
    this.soloOauthCompletion = this.completeSoloHuggingFaceOauth(
      root,
      this.startupAuthenticationEpoch,
    );
    this.wireLaunchControls(root);
    this.wireWorkspaceControls(root);
    this.renderResumeOffer(root);
    const exportResult = launchUrl.searchParams.get("export");
    if (exportResult === "connected" || exportResult === "failed") {
      this.oauthReturnState = exportResult;
      this.showActivity(
        exportResult === "connected"
          ? "Hugging Face connection updated"
          : "Hugging Face connection was not completed",
        exportResult === "connected" ? "system" : "error",
      );
      launchUrl.searchParams.delete("export");
      history.replaceState(null, "", launchUrl);
    }
    void this.checkCapabilities(root);
    const requestedSessionId = launchUrl.searchParams.get("session");
    const restoredSessionId = requestedSessionId ? null : this.rememberedSoloSession();
    this.resumeCandidateSessionId = restoredSessionId;
    const sessionId = requestedSessionId && SOLO_SESSION_ID_PATTERN.test(requestedSessionId)
      ? requestedSessionId
      : `solo-${crypto.randomUUID()}`;
    void this.startSession(root, sessionId, requestedSessionId === sessionId);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.authenticationEpoch += 1;
    if (this.timingTimer !== null) window.clearInterval(this.timingTimer);
    this.timingTimer = null;
    if (this.configurationTimer !== null) window.clearTimeout(this.configurationTimer);
    this.configurationTimer = null;
    this.startReadinessAbort?.abort();
    this.startReadinessAbort = null;
    this.uploadController?.abort();
    this.uploadController = null;
    for (const reconciliation of this.accountUploadReconciliations.values()) {
      reconciliation.abort();
    }
    this.accountUploadReconciliations.clear();
    this.repositoryCatalogueAbort?.abort();
    this.repositoryCatalogueAbort = null;
    if (this.repositoryPolicyOutsidePointerListener) {
      document.removeEventListener("pointerdown", this.repositoryPolicyOutsidePointerListener);
      this.repositoryPolicyOutsidePointerListener = null;
    }
    this.abortPostAcquisitionLoads();
    this.postAcquisitionQualityService?.close();
    this.postAcquisitionQualityService = null;
    if (this.repositoryCatalogueTimer !== null) {
      window.clearTimeout(this.repositoryCatalogueTimer);
    }
    this.repositoryCatalogueTimer = null;
    this.uploadCompletion = null;
    this.uploadMode = null;
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.unsubscribeImport?.();
    this.unsubscribeImport = null;
    this.unsubscribeExport?.();
    this.unsubscribeExport = null;
    this.importController?.dispose();
    this.importController = null;
    this.launchTaskWorkspace?.dispose();
    this.launchTaskWorkspace = null;
    this.launchRunEditor?.dispose();
    this.launchRunEditor = null;
    this.exportController = null;
    this.runDraft = null;
    this.exporter?.close();
    this.exporter = null;
    const capture = this.captureApp;
    const authority = this.captureAuthority;
    const controller = this.controller;
    capture?.dispose();
    this.captureApp = null;
    void authority?.dispose();
    this.captureAuthority = null;
    if (!authority) void controller?.dispose();
    this.controller = null;
    this.root?.replaceChildren();
    this.root = null;
  }

  private wireLaunchControls(root: HTMLElement) {
    root.querySelector<HTMLButtonElement>("#solo-new-session")!.addEventListener("click", () => {
      void this.startSession(root, `solo-${crypto.randomUUID()}`, false);
    });
    root.querySelector<HTMLButtonElement>("#solo-resume-session")!.addEventListener("click", () => {
      const sessionId = root.querySelector<HTMLButtonElement>("#solo-resume-session")!.dataset.sessionId;
      if (sessionId) void this.startSession(root, sessionId, true);
    });
    root.querySelector<HTMLButtonElement>("#solo-recheck")!.addEventListener("click", () => {
      void this.checkCapabilities(root);
      void this.refreshAccountSession(root);
    });
  }

  private wireAccountAction(root: HTMLElement) {
    const action = root.querySelector<HTMLElement>("#solo-hf-action");
    if (!action || action.dataset.soloWired === "true") return;
    action.dataset.soloWired = "true";
    action.addEventListener("click", (event) => {
      event.preventDefault();
      void this.beginSoloHuggingFaceOauth(root);
    });
    const logout = root.querySelector<HTMLButtonElement>("#solo-hf-logout");
    logout?.addEventListener("click", (event) => {
      event.preventDefault();
      void this.signOutSoloHuggingFace(root);
    });
  }

  private wirePreloadTaskAction(root: HTMLElement) {
    const action = root.querySelector<HTMLButtonElement>("#solo-preload-task");
    if (action && action.dataset.soloWired !== "true") {
      action.dataset.soloWired = "true";
      action.addEventListener("click", () => {
        if (this.controller && soloRunCanResume(this.controller.snapshot)) {
          void this.resumeLaunchRun(root);
          return;
        }
        void this.openLaunchTaskWorkspace(root);
      });
    }
    const stop = root.querySelector<HTMLButtonElement>("#solo-stop-run");
    if (stop && stop.dataset.soloWired !== "true") {
      stop.dataset.soloWired = "true";
      stop.addEventListener("click", () => {
        void this.finishOngoingSoloRun(root);
      });
    }
  }

  private wireSoloProvisioningToggles(controls: HTMLElement, root: HTMLElement) {
    for (const button of controls.querySelectorAll<HTMLButtonElement>("[data-solo-step-toggle]")) {
      if (button.dataset.soloWired === "true") continue;
      button.dataset.soloWired = "true";
      button.addEventListener("click", () => {
        if (button.disabled) return;
        const step = button.dataset.soloStepToggle;
        if (!isSoloProvisioningStage(step)) return;
        this.soloStepExpanded.set(step, button.getAttribute("aria-expanded") !== "true");
        this.renderSoloProvisioning(root);
      });
    }
  }

  private wireSoloExportSettings(root: HTMLElement) {
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[name="solo-export-destination"]',
    )) {
      if (input.dataset.soloWired === "true") continue;
      input.dataset.soloWired = "true";
      input.addEventListener("change", () => {
        if (!input.checked) return;
        this.automaticUploadKey = null;
        this.automaticLocalExportKey = null;
        this.exportDestination = input.value === "hugging-face"
          ? "hugging-face"
          : "local";
        this.renderSoloExportSettings(root);
        void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
      });
    }
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[name="solo-local-export-destination"]',
    )) {
      if (input.dataset.soloWired === "true") continue;
      input.dataset.soloWired = "true";
      input.addEventListener("change", () => {
        if (!input.checked || this.localExportDestinationBusy) return;
        if (input.value === "browser") {
          void this.selectBrowserLocalExportDestination(root);
        } else if (this.localExportDestination.type !== "folder") {
          void this.chooseLocalExportFolder(root);
        }
      });
    }
    const folderAction = root.querySelector<HTMLButtonElement>("#solo-local-folder-action");
    if (folderAction && folderAction.dataset.soloWired !== "true") {
      folderAction.dataset.soloWired = "true";
      folderAction.addEventListener("click", () => {
        if (this.localExportDestinationBusy) return;
        if (this.localExportDestination.type === "folder" && this.localExportPermission !== "granted") {
          void this.reconnectLocalExportFolder(root);
        } else {
          void this.chooseLocalExportFolder(root);
        }
      });
    }
    const cadence = root.querySelector<HTMLSelectElement>("#solo-hf-cadence");
    if (cadence && cadence.dataset.soloWired !== "true") {
      cadence.dataset.soloWired = "true";
      cadence.addEventListener("change", () => {
        this.automaticUploadKey = null;
        this.huggingFaceSaveCadence = cadence.value === "cycle" ? "cycle" : "run";
        this.renderSoloExportSettings(root);
        void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
      });
    }
    const organisation = root.querySelector<HTMLInputElement>("#solo-hf-organisation");
    if (organisation && organisation.dataset.soloWired !== "true") {
      organisation.dataset.soloWired = "true";
      organisation.addEventListener("input", () => {
        this.repositoryCatalogueAbort?.abort();
        this.updateSoloRepositorySettings({ organisation: organisation.value });
        this.scheduleSoloRepositoryCatalogue(root);
      });
      organisation.addEventListener("blur", () => {
        this.renderSoloExportSettings(root);
      });
    }
    const repository = root.querySelector<HTMLInputElement>("#solo-hf-repository");
    if (repository && repository.dataset.soloWired !== "true") {
      repository.dataset.soloWired = "true";
      repository.addEventListener("input", () => {
        this.repositoryCatalogueAbort?.abort();
        this.updateSoloRepositorySettings({ repository: repository.value });
        this.scheduleSoloRepositoryCatalogue(root);
      });
    }
    this.wireMissingRepositoryBehaviour(root);
    this.renderSoloExportSettings(root);
  }

  private async loadLocalExportDestination(root: HTMLElement) {
    try {
      const destination = await this.localExportDestinationStore.load();
      const permission = await soloLocalExportPermission(destination);
      if (this.disposed || this.root !== root) return;
      this.localExportDestination = destination;
      this.localExportPermission = permission;
    } catch (error) {
      if (this.disposed || this.root !== root) return;
      this.localExportDestination = DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
      this.localExportPermission = "granted";
      this.showActivity(errorMessage(error, "The local export destination could not be restored"), "error");
    } finally {
      if (this.disposed || this.root !== root) return;
      this.localExportDestinationLoaded = true;
      this.renderSoloExportSettings(root);
      this.scheduleAutomaticLocalExport(this.controller?.snapshot ?? null);
    }
  }

  private async selectBrowserLocalExportDestination(root: HTMLElement) {
    this.localExportDestinationBusy = true;
    this.renderSoloExportSettings(root);
    try {
      this.localExportDestination = await this.localExportDestinationStore.useBrowserStorage();
      this.localExportPermission = "granted";
      this.automaticLocalExportKey = null;
      this.showActivity("Completed runs will be written to private browser storage", "system");
    } catch (error) {
      this.showActivity(error, "error");
    } finally {
      this.localExportDestinationBusy = false;
      this.renderSoloExportSettings(root);
      this.scheduleAutomaticLocalExport(this.controller?.snapshot ?? null);
    }
  }

  private async chooseLocalExportFolder(root: HTMLElement) {
    const picker = (window as typeof window & {
      showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) {
      this.showActivity("Folder export is unavailable in this browser", "error");
      this.renderSoloExportSettings(root);
      return;
    }
    this.localExportDestinationBusy = true;
    this.renderSoloExportSettings(root);
    try {
      const directoryHandle = await picker.call(window, { mode: "readwrite" }) as SoloDirectoryHandle;
      this.localExportDestination = await this.localExportDestinationStore.useFolder(directoryHandle);
      // A successful readwrite picker return is the browser's permission grant.
      this.localExportPermission = "granted";
      this.automaticLocalExportKey = null;
      this.showActivity(`Completed runs will be written to ${this.localExportDestination.name}`, "system");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.showActivity(error, "error");
      }
    } finally {
      this.localExportDestinationBusy = false;
      this.renderSoloExportSettings(root);
      this.scheduleAutomaticLocalExport(this.controller?.snapshot ?? null);
    }
  }

  private async reconnectLocalExportFolder(root: HTMLElement) {
    this.localExportDestinationBusy = true;
    this.renderSoloExportSettings(root);
    try {
      this.localExportPermission = await requestSoloLocalExportPermission(this.localExportDestination);
      if (this.localExportPermission !== "granted") {
        throw new Error("Read and write permission is required for the selected Solo export folder");
      }
      this.automaticLocalExportKey = null;
      this.showActivity("Local export folder reconnected", "system");
      if (this.controller) await this.restoreExportJobs(this.controller.snapshot);
    } catch (error) {
      this.showActivity(error, "error");
    } finally {
      this.localExportDestinationBusy = false;
      this.renderSoloExportSettings(root);
      this.scheduleAutomaticLocalExport(this.controller?.snapshot ?? null);
    }
  }

  private wireMissingRepositoryBehaviour(root: HTMLElement) {
    const trigger = root.querySelector<HTMLButtonElement>("#solo-hf-missing-repository");
    const menu = root.querySelector<HTMLElement>("#solo-hf-missing-repository-menu");
    if (!trigger || !menu || trigger.dataset.soloWired === "true") return;
    trigger.dataset.soloWired = "true";
    trigger.addEventListener("click", () => {
      if (trigger.getAttribute("aria-expanded") === "true") {
        this.closeMissingRepositoryMenu(root);
      } else {
        this.openMissingRepositoryMenu(root, "selected");
      }
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.openMissingRepositoryMenu(root, event.key === "ArrowDown" ? "first" : "last");
      } else if (event.key === "Escape") {
        this.closeMissingRepositoryMenu(root, true);
      }
    });
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[data-solo-hf-missing-value]")];
    for (const item of items) {
      item.addEventListener("click", () => {
        const value = item.dataset.soloHfMissingValue;
        if (value !== "do-not-create" && value !== "private" && value !== "public") return;
        this.repositoryCatalogueAbort?.abort();
        this.updateSoloRepositorySettings({ missingRepositoryBehaviour: value });
        this.closeMissingRepositoryMenu(root, true);
        void this.refreshSoloRepositoryCatalogue(root);
      });
    }
    menu.addEventListener("keydown", (event) => {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") nextIndex = index < 0 ? 0 : (index + 1) % items.length;
      else if (event.key === "ArrowUp") nextIndex = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = items.length - 1;
      else if (event.key === "Escape") {
        event.preventDefault();
        this.closeMissingRepositoryMenu(root, true);
        return;
      } else if (event.key === "Tab") {
        this.closeMissingRepositoryMenu(root);
        return;
      }
      if (nextIndex !== null) {
        event.preventDefault();
        items[nextIndex]?.focus();
      }
    });
    if (this.repositoryPolicyOutsidePointerListener) {
      document.removeEventListener("pointerdown", this.repositoryPolicyOutsidePointerListener);
    }
    this.repositoryPolicyOutsidePointerListener = (event) => {
      const policy = root.querySelector<HTMLElement>(".solo-hf-repository-policy");
      if (policy && event.target instanceof Node && !policy.contains(event.target)) {
        this.closeMissingRepositoryMenu(root);
      }
    };
    document.addEventListener("pointerdown", this.repositoryPolicyOutsidePointerListener);
  }

  private openMissingRepositoryMenu(
    root: HTMLElement,
    focus: "selected" | "first" | "last",
  ) {
    const trigger = root.querySelector<HTMLButtonElement>("#solo-hf-missing-repository");
    const menu = root.querySelector<HTMLElement>("#solo-hf-missing-repository-menu");
    if (!trigger || !menu) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[data-solo-hf-missing-value]")];
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const target = focus === "first"
      ? items[0]
      : focus === "last"
        ? items.at(-1)
        : items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0];
    target?.focus();
  }

  private closeMissingRepositoryMenu(root: HTMLElement, restoreFocus = false) {
    const trigger = root.querySelector<HTMLButtonElement>("#solo-hf-missing-repository");
    const menu = root.querySelector<HTMLElement>("#solo-hf-missing-repository-menu");
    if (!trigger || !menu) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }

  private renderSoloExportSettings(root: HTMLElement) {
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[name="solo-export-destination"]',
    )) {
      input.checked = input.value === this.exportDestination;
    }
    const huggingFace = this.exportDestination === "hugging-face";
    const localSetup = root.querySelector<HTMLElement>("#solo-local-setup");
    if (localSetup) localSetup.hidden = huggingFace;
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[name="solo-local-export-destination"]',
    )) {
      input.checked = input.value === this.localExportDestination.type;
      input.disabled = this.localExportDestinationBusy || !this.localExportDestinationLoaded;
    }
    const localStatus = root.querySelector<HTMLElement>("#solo-local-destination-status");
    const folderAction = root.querySelector<HTMLButtonElement>("#solo-local-folder-action");
    if (localStatus) {
      localStatus.textContent = !this.localExportDestinationLoaded
        ? "Restoring local destination"
        : this.localExportDestination.type === "browser"
          ? "Private browser storage is ready"
          : this.localExportPermission === "granted"
            ? `${this.localExportDestination.name} is ready`
            : `${this.localExportDestination.name} needs permission`;
      localStatus.dataset.state = !this.localExportDestinationLoaded || this.localExportDestinationBusy
        ? "busy"
        : this.localExportDestination.type === "folder" && this.localExportPermission !== "granted"
          ? "warning"
          : "ready";
    }
    if (folderAction) {
      folderAction.disabled = this.localExportDestinationBusy || !this.localExportDestinationLoaded;
      folderAction.textContent = this.localExportDestination.type === "folder"
        && this.localExportPermission !== "granted"
        ? "Reconnect"
        : this.localExportDestination.type === "folder"
          ? "Change folder"
          : "Choose folder";
    }
    const setup = root.querySelector<HTMLElement>("#solo-hf-setup");
    if (setup) setup.hidden = !huggingFace;
    const cadence = root.querySelector<HTMLSelectElement>("#solo-hf-cadence");
    if (cadence) cadence.value = this.huggingFaceSaveCadence;
    const accountConfiguration = this.accountSession?.signedIn === true
      && this.accountSession.huggingFace.state === "ready";
    const repositoryConfiguration = huggingFace && (
      accountConfiguration
      || this.soloHuggingFaceCredential !== null
    );
    const repositoryConfigurationGroup = root.querySelector<HTMLElement>("#solo-hf-repository-settings");
    if (repositoryConfigurationGroup) repositoryConfigurationGroup.hidden = !repositoryConfiguration;
    const settings = this.exportController?.snapshot.repositorySettings;
    const organisation = root.querySelector<HTMLInputElement>("#solo-hf-organisation");
    if (
      organisation
      && settings
      && document.activeElement !== organisation
      && organisation.value !== settings.organisation
    ) {
      organisation.value = settings.organisation;
    }
    const repository = root.querySelector<HTMLInputElement>("#solo-hf-repository");
    if (repository && settings && document.activeElement !== repository) {
      repository.value = soloHuggingFaceRepositoryName(settings.repository);
    }
    this.renderSoloRepositoryDestination(root, settings ?? null);
    this.renderMissingRepositoryBehaviour(
      root,
      settings?.missingRepositoryBehaviour ?? "private",
    );
    if (repositoryConfiguration && repositoryConfigurationGroup) {
      const accountKey = [
        this.accountSession?.subject ?? "",
        this.accountSession?.huggingFace.subject ?? "",
        this.soloHuggingFaceSubject ?? "",
      ].join(":");
      if (
        repositoryConfigurationGroup.dataset.accountKey !== accountKey
        || this.repositoryCatalogueState === "idle"
      ) {
        repositoryConfigurationGroup.dataset.accountKey = accountKey;
        this.repositoryCatalogueState = "loading";
        this.repositoryCatalogueOrganisations.clear();
        root.querySelector<HTMLDataListElement>("#solo-hf-organisation-options")?.replaceChildren();
        void this.refreshSoloRepositoryCatalogue(
          root,
          settings?.organisation || this.accountSession?.defaults.organisation,
          true,
        );
      }
    } else {
      this.repositoryCatalogueAbort?.abort();
      this.repositoryCatalogueAbort = null;
      this.repositoryCatalogueState = "idle";
      this.repositoryCatalogueOrganisations.clear();
      if (this.repositoryCatalogueTimer !== null) {
        window.clearTimeout(this.repositoryCatalogueTimer);
        this.repositoryCatalogueTimer = null;
      }
      if (repositoryConfigurationGroup) delete repositoryConfigurationGroup.dataset.accountKey;
    }
    root.dataset.exportDestination = this.exportDestination;
    root.dataset.localExportDestination = this.localExportDestination.type;
    root.dataset.localExportPermission = this.localExportPermission;
    root.dataset.huggingFaceSaveCadence = this.huggingFaceSaveCadence;
    this.renderSoloProvisioning(root);
    this.scheduleAutomaticHuggingFaceUpload(this.controller?.snapshot ?? null);
    this.scheduleAutomaticLocalExport(this.controller?.snapshot ?? null);
  }

  private updateSoloRepositorySettings(
    settings: Parameters<SoloExportController["updateRepositorySettings"]>[0],
  ) {
    this.exportController?.updateRepositorySettings(settings);
    this.workspaceRepositorySettingsExplicit = true;
    this.invalidateSoloRepositoryDestination();
    if (this.root) this.renderSoloExportSettings(this.root);
    void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
  }

  private invalidateSoloRepositoryDestination() {
    this.automaticUploadKey = null;
    this.exportController?.updateVerifiedRepositoryDestination(null);
    this.repositoryDestinationValidation = {
      key: null,
      state: "idle",
      detail: "Verify the Hugging Face destination",
      code: null,
      result: null,
    };
  }

  private scheduleSoloRepositoryCatalogue(root: HTMLElement) {
    if (this.repositoryCatalogueTimer !== null) {
      window.clearTimeout(this.repositoryCatalogueTimer);
    }
    this.repositoryCatalogueTimer = window.setTimeout(() => {
      this.repositoryCatalogueTimer = null;
      void this.refreshSoloRepositoryCatalogue(root);
    }, SOLO_REPOSITORY_CATALOGUE_DELAY_MS);
  }

  private async refreshSoloRepositoryCatalogue(
    root: HTMLElement,
    preferredOrganisation?: string,
    refreshOrganisations = false,
  ) {
    if (
      this.disposed
      || this.root !== root
      || (
        !this.soloHuggingFaceCredential
        && (
          this.accountSession?.signedIn !== true
          || this.accountSession.huggingFace.state !== "ready"
        )
      )
    ) return;
    this.repositoryCatalogueAbort?.abort();
    const abort = new AbortController();
    this.repositoryCatalogueAbort = abort;
    const organisation = root.querySelector<HTMLInputElement>("#solo-hf-organisation");
    const organisationOptions = root.querySelector<HTMLDataListElement>(
      "#solo-hf-organisation-options",
    );
    const repository = root.querySelector<HTMLInputElement>("#solo-hf-repository");
    const options = root.querySelector<HTMLDataListElement>("#solo-hf-repository-options");
    if (!organisation || !organisationOptions || !repository || !options) return;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      abort.abort(new DOMException("Hugging Face destination verification timed out", "TimeoutError"));
    }, SOLO_REPOSITORY_REQUEST_TIMEOUT_MS);
    if (refreshOrganisations || this.repositoryCatalogueOrganisations.size === 0) {
      this.repositoryCatalogueState = "loading";
      this.renderSoloProvisioning(root);
    }
    try {
      let initial: AccountExportRepositoryCatalogue | null = null;
      let selected = organisation.value.trim()
        || this.exportController?.snapshot.repositorySettings.organisation
        || "";
      const selectedAuthority = this.availableHuggingFaceUploadAuthority();
      const headsetCredential = selectedAuthority?.mode === "headset"
        ? this.soloHuggingFaceCredential
        : null;
      if (headsetCredential) {
        if (refreshOrganisations || this.repositoryCatalogueOrganisations.size === 0) {
          const owners = await loadSoloHuggingFaceOwners(headsetCredential, abort.signal);
          if (
            abort.signal.aborted
            || this.disposed
            || this.root !== root
            || this.repositoryCatalogueAbort !== abort
          ) return;
          this.repositoryCatalogueOrganisations.clear();
          for (const name of owners) this.repositoryCatalogueOrganisations.add(name);
          if (!selected) {
            selected = this.canonicalSoloRepositoryOrganisation(preferredOrganisation ?? "")
              ?? owners[0]
              ?? "";
          }
          this.repositoryCatalogueState = "ready";
          organisationOptions.replaceChildren(
            ...owners.map((name) => new Option(name, name)),
          );
          if (document.activeElement !== organisation) organisation.value = selected;
        }
        const canonicalOwner = this.canonicalSoloRepositoryOrganisation(selected);
        if (!canonicalOwner) {
          throw new Error("The selected Hugging Face organisation is unavailable");
        }
        selected = canonicalOwner;
        if (
          this.exportController?.snapshot.repositorySettings.organisation !== selected
        ) {
          this.exportController?.updateRepositorySettings({ organisation: selected });
          this.workspaceRepositorySettingsExplicit = true;
          if (document.activeElement !== organisation) organisation.value = selected;
          void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
        }
        const repositories = await loadSoloHuggingFaceRepositories(
          headsetCredential,
          selected,
          repository.value.trim(),
          abort.signal,
        );
        if (
          abort.signal.aborted
          || this.disposed
          || this.root !== root
          || this.repositoryCatalogueAbort !== abort
        ) return;
        options.replaceChildren(
          ...repositories.map((name) => new Option(name, name)),
        );
        await this.validateSoloRepositoryDestination(root, abort);
        this.renderSoloProvisioning(root);
        return;
      }
      if (refreshOrganisations || this.repositoryCatalogueOrganisations.size === 0) {
        initial = await this.accountClient.repositoryCatalogue(
          undefined,
          repository.value.trim(),
          abort.signal,
        );
        if (
          abort.signal.aborted
          || this.disposed
          || this.root !== root
          || this.repositoryCatalogueAbort !== abort
        ) return;
        this.repositoryCatalogueOrganisations.clear();
        for (const name of initial.organisations) {
          this.repositoryCatalogueOrganisations.add(name);
        }
        if (!selected) {
          selected = this.canonicalSoloRepositoryOrganisation(preferredOrganisation ?? "")
            ?? initial.organisations[0]
            ?? "";
        }
        this.repositoryCatalogueState = "ready";
        organisationOptions.replaceChildren(
          ...initial.organisations.map((name) => new Option(name, name)),
        );
        if (document.activeElement !== organisation) organisation.value = selected;
      }
      const canonicalOwner = this.canonicalSoloRepositoryOrganisation(selected);
      if (!canonicalOwner) {
        throw new Error("The selected Hugging Face organisation is unavailable");
      }
      selected = canonicalOwner;
      if (
        this.exportController?.snapshot.repositorySettings.organisation !== selected
      ) {
        this.exportController?.updateRepositorySettings({ organisation: selected });
        this.workspaceRepositorySettingsExplicit = true;
        if (document.activeElement !== organisation) organisation.value = selected;
        void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
      }
      const catalogue = initial
        && selected === initial.organisations[0]
        ? initial
        : await this.accountClient.repositoryCatalogue(
            selected,
            repository.value.trim(),
            abort.signal,
          );
      if (
        abort.signal.aborted
        || this.disposed
        || this.root !== root
        || this.repositoryCatalogueAbort !== abort
      ) return;
      options.replaceChildren(
        ...catalogue.repositories.map((value) => {
          const name = soloHuggingFaceRepositoryName(value);
          return new Option(name, name);
        }),
      );
      await this.validateSoloRepositoryDestination(root, abort);
      this.renderSoloProvisioning(root);
    } catch (error) {
      if (
        (!abort.signal.aborted || timedOut)
        && !this.disposed
        && this.root === root
        && this.repositoryCatalogueAbort === abort
      ) {
        options.replaceChildren();
        const failure = timedOut
          ? new SoloHuggingFaceDestinationError(
              "request",
              "Hugging Face took too long to respond. Edit the destination to retry.",
            )
          : soloHuggingFaceDestinationError(error);
        this.repositoryDestinationValidation = {
          key: this.soloRepositoryDestinationKey(),
          state: "error",
          detail: failure.message,
          code: failure.code,
          result: null,
        };
        this.exportController?.updateVerifiedRepositoryDestination(null);
        if (this.repositoryCatalogueOrganisations.size === 0) {
          this.repositoryCatalogueState = "error";
          organisationOptions.replaceChildren();
        }
        this.renderSoloRepositoryDestination(
          root,
          this.exportController?.snapshot.repositorySettings ?? null,
        );
        this.renderSoloProvisioning(root);
      }
    } finally {
      window.clearTimeout(timeout);
      if (this.repositoryCatalogueAbort === abort) {
        this.repositoryCatalogueAbort = null;
      }
    }
  }

  private async validateSoloRepositoryDestination(
    root: HTMLElement,
    abort: AbortController,
  ) {
    const settings = this.exportController?.snapshot.repositorySettings;
    if (!settings) return;
    let destination;
    try {
      destination = normaliseSoloHuggingFaceDestination({
        organisation: settings.organisation,
        repository: settings.repository,
        branch: settings.branch,
        visibility: settings.visibility,
        missingRepositoryBehaviour: settings.missingRepositoryBehaviour,
      });
    } catch (error) {
      const failure = soloHuggingFaceDestinationError(error);
      this.repositoryDestinationValidation = {
        key: this.soloRepositoryDestinationKey(),
        state: "error",
        detail: failure.message,
        code: failure.code,
        result: null,
      };
      this.exportController?.updateVerifiedRepositoryDestination(null);
      this.renderSoloRepositoryDestination(root, settings);
      return;
    }
    const key = this.soloRepositoryDestinationKey();
    if (!key) return;
    this.repositoryDestinationValidation = {
      key,
      state: "checking",
      detail: "Verifying repository",
      code: null,
      result: null,
    };
    this.exportController?.updateVerifiedRepositoryDestination(null);
    this.renderSoloRepositoryDestination(root, settings);
    this.renderSoloProvisioning(root);
    try {
      const authority = this.availableHuggingFaceUploadAuthority();
      const result = authority?.mode === "headset" && this.soloHuggingFaceCredential
        ? await validateSoloHuggingFaceDestination(
            this.soloHuggingFaceCredential,
            this.repositoryCatalogueOrganisations,
            destination,
            abort.signal,
          )
        : await this.accountClient.validateDestination({
            organisation: destination.organisation,
            repository: destination.repository,
            branch: destination.branch,
            visibility: destination.visibility,
            missingRepositoryBehaviour: destination.missingRepositoryBehaviour,
          }, abort.signal);
      if (
        abort.signal.aborted
        || this.disposed
        || this.root !== root
        || this.repositoryCatalogueAbort !== abort
        || this.soloRepositoryDestinationKey() !== key
      ) return;
      if (
        result.version !== 1
        || result.repository !== destination.resolved
        || result.branch !== destination.branch
        || (result.availability !== "existing" && result.availability !== "creatable")
        || (result.visibility !== "private" && result.visibility !== "public")
        || result.visibility !== destination.visibility
        || !isHuggingFaceAppendAllocation(result.append)
      ) {
        throw new Error("The account service returned an invalid Hugging Face destination");
      }
      this.repositoryDestinationValidation = {
        key,
        state: "ready",
        detail: result.availability === "existing"
          ? `Existing ${result.visibility} dataset is ready`
          : `New ${result.visibility} dataset can be created`,
        code: null,
        result,
      };
      this.exportController?.updateVerifiedRepositoryDestination(result);
    } catch (error) {
      const timedOut = abort.signal.aborted
        && abort.signal.reason instanceof DOMException
        && abort.signal.reason.name === "TimeoutError";
      if (abort.signal.aborted && !timedOut) return;
      if (
        this.disposed
        || this.root !== root
        || this.repositoryCatalogueAbort !== abort
        || this.soloRepositoryDestinationKey() !== key
      ) return;
      const failure = timedOut
        ? new SoloHuggingFaceDestinationError(
            "request",
            "Hugging Face took too long to respond. Edit the destination to retry.",
          )
        : soloHuggingFaceDestinationError(error);
      this.repositoryDestinationValidation = {
        key,
        state: "error",
        detail: failure.message,
        code: failure.code,
        result: null,
      };
      this.exportController?.updateVerifiedRepositoryDestination(null);
    }
    this.renderSoloRepositoryDestination(root, settings);
    if (this.repositoryDestinationValidation.state === "ready") {
      void this.tryResumePendingUpload();
    }
    this.scheduleAutomaticHuggingFaceUpload(this.controller?.snapshot ?? null);
  }

  private soloRepositoryDestinationKey() {
    const settings = this.exportController?.snapshot.repositorySettings;
    const authority = this.availableHuggingFaceUploadAuthority();
    if (!settings || !authority) return null;
    try {
      const destination = normaliseSoloHuggingFaceDestination({
        organisation: settings.organisation,
        repository: settings.repository,
        branch: settings.branch,
        visibility: settings.visibility,
        missingRepositoryBehaviour: settings.missingRepositoryBehaviour,
      });
      return this.soloRepositoryDestinationKeyFor(
        authority.principal,
        destination,
      );
    } catch {
      return null;
    }
  }

  private soloRepositoryDestinationKeyFor(
    principal: string,
    destination: ReturnType<typeof normaliseSoloHuggingFaceDestination>,
  ) {
    return [
      principal,
      destination.resolved,
      destination.branch,
      destination.visibility,
      destination.missingRepositoryBehaviour,
    ].join(":");
  }

  private requireCurrentVerifiedUploadIntent(intent: SoloExportIntent) {
    if (!intent.repository || !intent.visibility) {
      throw new Error("Set the Hugging Face repository and visibility in Solo XR");
    }
    const [organisation = "", repository = "", ...remainder] = intent.repository.split("/");
    if (remainder.length > 0) {
      throw new Error("Set a valid Hugging Face repository in Solo XR");
    }
    const destination = normaliseSoloHuggingFaceDestination({
      organisation,
      repository,
      branch: intent.branch ?? "",
      visibility: intent.visibility,
      missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
    });
    const authority = this.availableHuggingFaceUploadAuthority();
    const validation = this.repositoryDestinationValidation;
    const key = authority
      ? this.soloRepositoryDestinationKeyFor(authority.principal, destination)
      : null;
    if (
      !authority
      || validation.state !== "ready"
      || validation.key !== key
      || validation.result === null
      || validation.result.repository !== destination.resolved
      || validation.result.branch !== destination.branch
      || validation.result.visibility !== destination.visibility
      || !isHuggingFaceAppendAllocation(validation.result.append)
    ) {
      throw new Error("Verify the current Hugging Face destination before starting a Solo sync");
    }
    return {
      ...intent,
      repository: validation.result.repository,
      visibility: validation.result.visibility,
    };
  }

  private renderSoloRepositoryDestination(
    root: HTMLElement,
    settings: SoloExportControllerState["repositorySettings"] | null,
  ) {
    const status = root.querySelector<HTMLElement>("#solo-hf-destination-status");
    if (!status) return;
    let localError: string | null = null;
    if (settings) {
      try {
        normaliseSoloHuggingFaceDestination({
          organisation: settings.organisation,
          repository: settings.repository,
          branch: settings.branch,
          visibility: settings.visibility,
          missingRepositoryBehaviour: settings.missingRepositoryBehaviour,
        }).resolved;
      } catch (error) {
        localError = soloHuggingFaceDestinationError(error).message;
      }
    }
    const validation = this.repositoryDestinationValidation;
    const matches = validation.key !== null
      && validation.key === this.soloRepositoryDestinationKey();
    status.textContent = localError
      ?? (matches ? validation.detail : "Verify the Hugging Face destination");
    status.className = `solo-hf-destination-status is-${localError
      ? "error"
      : matches ? validation.state : "idle"}`;
  }

  private renderMissingRepositoryBehaviour(
    root: HTMLElement,
    behaviour: HuggingFaceMissingRepositoryBehaviour,
  ) {
    const trigger = root.querySelector<HTMLButtonElement>("#solo-hf-missing-repository");
    const label = SOLO_MISSING_REPOSITORY_LABELS[behaviour];
    if (trigger) {
      trigger.dataset.behaviour = behaviour;
      trigger.setAttribute("aria-label", `If the repository is missing: ${label}`);
      trigger.title = `If the repository is missing: ${label}`;
    }
    for (const item of root.querySelectorAll<HTMLButtonElement>(
      "[data-solo-hf-missing-value]",
    )) {
      item.setAttribute("aria-checked", String(item.dataset.soloHfMissingValue === behaviour));
    }
  }

  private installSoloLaunchControls(
    root: HTMLElement,
    captureRoot: HTMLElement,
    sessionId: string,
  ) {
    const joinColumn = captureRoot.querySelector<HTMLElement>(".join-column");
    if (!joinColumn) throw new Error("The demonstrator launch controls are unavailable");
    if (!root.querySelector("#solo-session-id")) {
      const controls = document.createElement("section");
      controls.id = "solo-launch-controls";
      controls.className = "solo-launch-controls";
      controls.setAttribute("aria-label", "Solo capture setup");
      const sessionSuffix = sessionId.replace(/-/g, "").slice(-4).toUpperCase();
      controls.innerHTML = `
        <div class="solo-launch-session">
          <span>Local session</span>
          <div class="solo-launch-session-status">
            <strong id="solo-session-id" class="status-pill is-ready" title="${escapeHtml(sessionId)}">OK / ${sessionSuffix}</strong>
            <button id="solo-resume-previous-session" class="solo-session-refresh" type="button" aria-label="Resume previous local session" title="Resume previous local session" hidden><i data-lucide="arrow-right" aria-hidden="true"></i></button>
            <button id="solo-start-new-session" class="solo-session-refresh" type="button" aria-label="Start a new local session" title="Start a new local session"><i data-lucide="rotate-cw" aria-hidden="true"></i></button>
          </div>
        </div>
        ${captureSafetyMarkup("solo-safety-note")}
        <p id="solo-provisioning-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
        <section id="solo-run-completion" class="solo-run-completion" hidden>
          <div class="solo-run-upload-copy">
            <span id="solo-run-completion-label" role="status" aria-live="polite" aria-atomic="true">Run complete</span>
            <small id="solo-run-upload-detail" hidden></small>
          </div>
          <progress id="solo-run-upload-progress" max="1" value="0" aria-label="Hugging Face upload progress" hidden></progress>
          <div class="solo-run-upload-actions">
            <button id="solo-run-upload-cancel" class="toolbar-button" type="button" aria-label="Abort Hugging Face upload" hidden>ABORT</button>
            <button id="solo-run-upload-retry" class="toolbar-button" type="button" hidden>RETRY</button>
          </div>
        </section>
        <ol class="capture-setup-steps" aria-label="Solo capture setup steps">
          <li class="capture-setup-step" data-solo-step="destination" data-state="active" data-collapsed="false">
            <button class="capture-step-summary" type="button" data-solo-step-toggle="destination" aria-expanded="true" aria-controls="solo-step-destination-content">
              <span class="capture-step-number" aria-hidden="true"><span class="capture-step-number-value">1</span><i data-lucide="check"></i></span>
              <span class="capture-step-content"><strong id="solo-export-destination-label">Storage and upload</strong><span>Hugging Face is selected by default. Capture remains on this headset until you upload.</span></span>
              <span class="capture-step-state">Current</span>
              <i class="capture-step-toggle-icon" data-lucide="chevron-down" aria-hidden="true"></i>
            </button>
            <div id="solo-step-destination-content" class="capture-step-action">
              <section id="solo-launch-destination" class="solo-launch-destination" aria-labelledby="solo-export-destination-label">
                <div class="solo-segmented-control" role="radiogroup" aria-label="Solo capture destination">
                  <label>
                    <input type="radio" name="solo-export-destination" value="local">
                    <span>Locally</span>
                  </label>
                  <label data-solo-hf-destination data-processing="true" aria-busy="true">
                    <input type="radio" name="solo-export-destination" value="hugging-face" checked>
                    <span>Hugging Face</span>
                  </label>
                </div>
                <section id="solo-local-setup" class="solo-local-setup" aria-labelledby="solo-local-label">
                  <div>
                    <span id="solo-local-label">Local destination</span>
                    <small>Choose where completed runs are written after finalisation.</small>
                  </div>
                  <div class="solo-segmented-control solo-local-destination-control" role="radiogroup" aria-label="Local export destination">
                    <label>
                      <input type="radio" name="solo-local-export-destination" value="browser" checked>
                      <span>Browser storage</span>
                    </label>
                    <label>
                      <input type="radio" name="solo-local-export-destination" value="folder">
                      <span>Selected folder</span>
                    </label>
                  </div>
                  <div class="solo-local-folder-row">
                    <small id="solo-local-destination-status" role="status" aria-live="polite" aria-atomic="true">Private browser storage is ready</small>
                    <button id="solo-local-folder-action" class="prompt-audio-button" type="button">Choose folder</button>
                  </div>
                </section>
                <section id="solo-hf-setup" class="solo-hf-setup" hidden>
                  <section class="solo-launch-option" aria-labelledby="solo-hf-label">
                    <div>
                      <span id="solo-hf-label">Hugging Face account</span>
                      <span class="solo-account-identity">
                        <small id="solo-hf-state" class="solo-account-state">This authorises Hugging Face only on this headset.</small>
                        <button id="solo-hf-logout" class="solo-account-logout" type="button" hidden>(log out)</button>
                      </span>
                    </div>
                    <button id="solo-hf-action" class="prompt-audio-button" type="button" data-account-action="sign-in" aria-busy="false">Sign in to Hugging Face</button>
                  </section>
                  <section id="solo-hf-repository-settings" class="solo-hf-repository-settings" aria-labelledby="solo-hf-repository-label" hidden>
                    <span id="solo-hf-repository-label">Repository</span>
                    <div id="solo-hf-config-row" class="solo-hf-config-row">
                      <input id="solo-hf-organisation" list="solo-hf-organisation-options" aria-label="Hugging Face owner" aria-describedby="solo-hf-destination-status" placeholder="Owner" autocomplete="off" spellcheck="false">
                      <datalist id="solo-hf-organisation-options"></datalist>
                      <span class="solo-hf-repository-separator" aria-hidden="true">/</span>
                      <input id="solo-hf-repository" list="solo-hf-repository-options" aria-label="Hugging Face repository name" aria-describedby="solo-hf-destination-status" placeholder="Repository" autocomplete="off" spellcheck="false">
                      <datalist id="solo-hf-repository-options"></datalist>
                      <div class="solo-hf-repository-policy">
                        <button id="solo-hf-missing-repository" class="solo-hf-missing-repository" type="button" data-behaviour="private" aria-haspopup="menu" aria-expanded="false" aria-controls="solo-hf-missing-repository-menu" aria-label="If the repository is missing: Create private" title="If the repository is missing: Create private">
                          <i class="solo-hf-policy-icon" data-solo-hf-policy-icon="do-not-create" data-lucide="ban" aria-hidden="true"></i>
                          <i class="solo-hf-policy-icon" data-solo-hf-policy-icon="private" data-lucide="lock-keyhole" aria-hidden="true"></i>
                          <i class="solo-hf-policy-icon" data-solo-hf-policy-icon="public" data-lucide="globe" aria-hidden="true"></i>
                        </button>
                        <div id="solo-hf-missing-repository-menu" class="solo-hf-repository-policy-menu" role="menu" aria-label="If the repository is missing" hidden>
                          <button type="button" role="menuitemradio" aria-checked="false" data-solo-hf-missing-value="do-not-create"><i data-lucide="ban" aria-hidden="true"></i><span>Existing only</span></button>
                          <button type="button" role="menuitemradio" aria-checked="true" data-solo-hf-missing-value="private"><i data-lucide="lock-keyhole" aria-hidden="true"></i><span>Create private</span></button>
                          <button type="button" role="menuitemradio" aria-checked="false" data-solo-hf-missing-value="public"><i data-lucide="globe" aria-hidden="true"></i><span>Create public</span></button>
                        </div>
                      </div>
                    </div>
                    <small id="solo-hf-destination-status" class="solo-hf-destination-status is-idle" role="status" aria-live="polite" aria-atomic="true">Verify the Hugging Face destination</small>
                  </section>
                  <section id="solo-hf-cadence-row" class="solo-launch-option" aria-labelledby="solo-hf-cadence-label">
                    <div>
                      <span id="solo-hf-cadence-label">Upload to Hugging Face</span>
                      <small>Choose when completed capture data is synchronised.</small>
                    </div>
                    <select id="solo-hf-cadence" aria-label="Hugging Face upload schedule">
                      <option value="cycle">Every cycle</option>
                      <option value="run" selected>At the very end</option>
                    </select>
                  </section>
                </section>
              </section>
            </div>
          </li>
          <li class="capture-setup-step" data-solo-step="camera" data-state="locked" data-collapsed="true">
            <button class="capture-step-summary" type="button" data-solo-step-toggle="camera" aria-expanded="false" aria-controls="solo-step-camera-content" aria-disabled="true" disabled>
              <span class="capture-step-number" aria-hidden="true"><span class="capture-step-number-value">2</span><i data-lucide="check"></i></span>
              <span class="capture-step-content"><strong>Camera and audio</strong><span>Grant access, confirm the outward camera preview and choose audio settings.</span></span>
              <span class="capture-step-state">Locked</span>
              <i class="capture-step-toggle-icon" data-lucide="chevron-down" aria-hidden="true"></i>
            </button>
            <div id="solo-step-camera-content" class="capture-step-action"><div id="solo-camera-action"></div></div>
          </li>
          <li class="capture-setup-step" data-solo-step="run" data-state="locked" data-collapsed="true">
            <button class="capture-step-summary" type="button" data-solo-step-toggle="run" aria-expanded="false" aria-controls="solo-step-run-content" aria-disabled="true" disabled>
              <span class="capture-step-number" aria-hidden="true"><span class="capture-step-number-value">3</span><i data-lucide="check"></i></span>
              <span class="capture-step-content"><strong>Specify tasks</strong><span id="solo-run-summary">Review, edit or import the run.</span></span>
              <span class="capture-step-state">Locked</span>
              <i class="capture-step-toggle-icon" data-lucide="chevron-down" aria-hidden="true"></i>
            </button>
            <div id="solo-step-run-content" class="capture-step-action">
              <div class="solo-run-controls">
                <button id="solo-preload-task" class="prompt-audio-button" type="button">Open run editor</button>
                <button id="solo-stop-run" class="prompt-audio-button solo-stop-run" type="button" hidden>Stop run</button>
              </div>
            </div>
          </li>
          <li class="capture-setup-step" data-solo-step="xr" data-state="locked" data-collapsed="true">
            <button class="capture-step-summary" type="button" data-solo-step-toggle="xr" aria-expanded="false" aria-controls="solo-step-xr-content" aria-disabled="true" disabled>
              <span class="capture-step-number" aria-hidden="true"><span class="capture-step-number-value">4</span><i data-lucide="check"></i></span>
              <span class="capture-step-content"><strong>Open XR</strong><span>Enter the immersive Solo capture after setup is complete.</span></span>
              <span class="capture-step-state">Locked</span>
              <i class="capture-step-toggle-icon" data-lucide="chevron-down" aria-hidden="true"></i>
            </button>
            <div id="solo-step-xr-content" class="capture-step-action"><div id="solo-xr-action"></div></div>
          </li>
        </ol>
        <div id="run-editor-home-slot" hidden><div id="run-editor-home"></div></div>
        <div id="task-editor-mount"></div>
      `;
      createIcons({
        icons: { ArrowRight, Ban, Check, ChevronDown, Globe, LockKeyhole, RotateCw },
        root: controls,
      });
      this.soloStepExpanded.set("destination", true);
      this.wireSoloProvisioningToggles(controls, root);
      controls.querySelector<HTMLButtonElement>("#solo-run-upload-retry")?.addEventListener("click", () => {
        void this.retryCompletedRunUpload();
      });
      controls.querySelector<HTMLButtonElement>("#solo-run-upload-cancel")?.addEventListener("click", () => {
        void this.abortActiveSoloUpload();
      });
      controls.querySelector<HTMLButtonElement>("#solo-start-new-session")!.addEventListener("click", () => {
        this.navigateToSoloSession(`solo-${crypto.randomUUID()}`);
      });
      const resumePrevious = controls.querySelector<HTMLButtonElement>("#solo-resume-previous-session")!;
      if (this.resumeCandidateSessionId && this.resumeCandidateSessionId !== sessionId) {
        resumePrevious.hidden = false;
        resumePrevious.addEventListener("click", () => this.navigateToSoloSession(this.resumeCandidateSessionId!));
      }
      const enterXr = joinColumn.querySelector<HTMLButtonElement>("#enter-xr");
      joinColumn.insertBefore(controls, enterXr);
      const prepareCamera = captureRoot.querySelector<HTMLButtonElement>("#prepare-camera");
      const audioPreferences = captureRoot.querySelector<HTMLElement>(".launch-audio-preferences");
      const cameraAction = controls.querySelector<HTMLElement>("#solo-camera-action");
      if (prepareCamera && cameraAction) cameraAction.append(prepareCamera);
      if (audioPreferences && cameraAction) cameraAction.append(audioPreferences);
      const xrAction = controls.querySelector<HTMLElement>("#solo-xr-action");
      if (enterXr && xrAction) xrAction.append(enterXr);
      joinColumn.querySelector<HTMLElement>(".join-checklist")?.setAttribute("hidden", "");
      const workspaceMount = controls.querySelector<HTMLElement>("#task-editor-mount");
      if (workspaceMount) root.append(workspaceMount);
    }
    const transition = root.querySelector<HTMLElement>("#solo-system-transition");
    if (transition && transition.parentElement !== joinColumn) {
      transition.classList.add("task-row");
      const promptButton = joinColumn.querySelector("#prepare-prompts");
      joinColumn.insertBefore(transition, promptButton);
    }
    this.renderSoloProvisioning(root);
  }

  private renderSoloProvisioning(root: HTMLElement) {
    const controls = root.querySelector<HTMLElement>("#solo-launch-controls");
    if (!controls) return;
    this.renderSoloHuggingFaceProcessing(root);
    const repositorySettings = this.exportController?.snapshot.repositorySettings;
    const repositoryDestinationKey = this.soloRepositoryDestinationKey();
    const repositoryConfigurationReady = Boolean(
      this.repositoryCatalogueState === "ready"
      && repositorySettings
      && this.repositoryCatalogueOrganisations.has(repositorySettings.organisation)
      && repositoryDestinationKey
      && this.repositoryDestinationValidation.state === "ready"
      && this.repositoryDestinationValidation.key === repositoryDestinationKey
      && this.repositoryDestinationValidation.result !== null,
    );
    // Delivery preferences are not capture preconditions. Preserve repository
    // warnings for an authorised Hugging Face destination without blocking the
    // durable local capture path.
    const destinationReady = this.exportDestination === "local"
      || this.availableHuggingFaceUploadAuthority() === null
      || repositoryConfigurationReady;
    const cameraReady = this.launchPresentation?.camera === "ready";
    const configuration = this.runDraft?.readConfiguration();
    const recordableTaskCount = configuration?.tasks.filter(({ type }) => type !== "pause").length ?? 0;
    const snapshot = this.controller?.snapshot ?? null;
    const resumableRun = snapshot ? soloRunCanResume(snapshot) : false;
    const pausedOngoingCapture = snapshot ? soloRunHasPausedCapture(snapshot) : false;
    const stoppableRun = snapshot ? soloRunCanStop(snapshot) : false;
    const resumeAcknowledged = !resumableRun || this.resumedRunAwaitingXr;
    const completedRunReadyForReset = this.controller?.snapshot.run.status === "complete"
      && this.controller.snapshot.run.recordingState === "idle"
      && this.controller.snapshot.currentEpisode === null
      && this.controller.snapshot.pendingEpisode === null;
    const state = soloProvisioningState({
      destinationReady,
      cameraReady,
      runReviewed: this.runEditorReviewed && resumeAcknowledged,
      hasRecordableTask: recordableTaskCount > 0,
      xrLaunchReady: this.launchPresentation?.xrLaunchReady ?? false,
    });

    controls.dataset.soloProvisioningStage = state.stage;
    const provisioningStatus = controls.querySelector<HTMLElement>("#solo-provisioning-status");
    const completionMessage = this.renderCompletedRunStatus(
      controls,
      completedRunReadyForReset,
    );
    const provisioningMessage = completedRunReadyForReset
      ? completionMessage
      : this.launchPresentation?.camera === "requesting"
        ? "Enabling the camera for Solo setup."
        : !state.cameraReady
          ? "Enable the camera to continue."
          : !state.runReady
            ? resumableRun
              ? pausedOngoingCapture
                ? "Capture paused. Resume it before reopening XR."
                : "Camera ready. Resume the ongoing Solo run to continue."
              : "Camera ready. Review the Solo run to continue."
            : !state.xrReady
              ? "Run ready. Waiting for XR launch readiness."
              : "Solo setup complete. Open XR when ready.";
    if (provisioningStatus && provisioningStatus.textContent !== provisioningMessage) {
      provisioningStatus.textContent = provisioningMessage;
    }
    const stepOrder: SoloProvisioningStage[] = ["destination", "camera", "run", "xr"];
    const destinationSummary = controls.querySelector<HTMLElement>(
      '[data-solo-step="destination"] .capture-step-content span',
    );
    if (destinationSummary) {
      destinationSummary.textContent = this.exportDestination === "local"
        ? "Capture stays on this headset until you export it."
        : repositoryConfigurationReady && this.repositoryDestinationValidation.result
          ? "Hugging Face destination ready."
          : "Hugging Face will be ready when you connect an account.";
    }
    for (const step of stepOrder) {
      const node = controls.querySelector<HTMLElement>(`[data-solo-step="${step}"]`);
      if (!node) continue;
      const stepPresentation = soloProvisioningStepPresentation(
        state,
        step,
        step === "run" && (completedRunReadyForReset || pausedOngoingCapture)
          ? true
          : this.soloStepExpanded.get(step),
      );
      const { complete } = stepPresentation;
      const destinationPending = !complete
        && step === "destination"
        && this.exportDestination === "hugging-face"
        && this.availableHuggingFaceUploadAuthority() !== null;
      const expanded = destinationPending
        ? this.soloStepExpanded.get(step) ?? true
        : stepPresentation.expanded;
      const active = state.stage === step;
      const current = active || destinationPending;
      const warning = !complete
        && (
          step === "destination"
            && this.exportDestination === "hugging-face"
            && (
              this.accountUnavailable
              || this.repositoryCatalogueState === "error"
              || this.repositoryDestinationValidation.state === "error"
            )
          || active && step === "camera" && this.launchPresentation?.camera === "error"
        );
      const incomplete = !complete && active && !warning && step === "xr";
      const available = !complete && !active && step === "run";
      const visualState = complete
        ? "complete"
        : warning
          ? "warning"
          : incomplete
            ? "incomplete"
            : available
              ? "available"
              : current
                ? "active"
                : "locked";
      node.dataset.state = visualState;
      if (active) node.setAttribute("aria-current", "step");
      else node.removeAttribute("aria-current");
      node.dataset.collapsed = String(!expanded);
      const toggle = node.querySelector<HTMLButtonElement>("[data-solo-step-toggle]");
      if (toggle) {
        toggle.disabled = visualState === "locked";
        toggle.setAttribute("aria-disabled", String(visualState === "locked"));
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.title = visualState === "locked"
          ? "Complete the preceding setup steps first"
          : expanded ? "Collapse setup step" : "Expand setup step";
      }
      const status = node.querySelector<HTMLElement>(".capture-step-state");
      if (status) {
        status.textContent = complete
          ? "Complete"
          : warning
            ? "Needs attention"
            : incomplete
              ? state.xrReady
                ? "Ready to open"
                : this.launchPresentation?.xr === "active"
                  ? "XR active"
                  : "Waiting"
              : current
                ? step === "camera" && this.launchPresentation?.camera === "requesting"
                  || step === "destination" && (
                    this.repositoryCatalogueState !== "ready"
                    || this.repositoryDestinationValidation.state === "checking"
                  )
                  ? "Working"
                  : "Current"
                : available
                  ? "Available"
                  : "Locked";
      }
    }

    const prepareCamera = controls.querySelector<HTMLButtonElement>("#prepare-camera");
    if (prepareCamera) {
      const capabilityBlocked = prepareCamera.textContent === "HTTPS required";
      if (!capabilityBlocked) {
        prepareCamera.textContent = this.launchPresentation?.camera === "ready"
          ? "Camera enabled"
          : this.launchPresentation?.camera === "requesting"
            ? "Enabling camera"
            : this.launchPresentation?.camera === "error"
              ? "Retry camera"
              : "Enable camera";
      }
      prepareCamera.disabled = capabilityBlocked
        || this.launchPresentation?.camera === "requesting"
        || state.cameraReady;
    }

    const runAction = controls.querySelector<HTMLButtonElement>("#solo-preload-task");
    if (runAction) {
      const run = snapshot?.run;
      runAction.disabled = this.resettingCompletedRun
        || this.stoppingOngoingRun
        || (run?.status === "running" && !resumableRun)
        || run?.recordingState !== "idle" && run?.recordingState !== "paused";
      runAction.textContent = resumableRun
        ? "Resume"
        : state.runReady ? "Edit run" : "Open run editor";
      runAction.title = resumableRun
        ? "Resume the ongoing Solo run"
        : state.runReady
          ? "Edit the configured Solo run"
          : "Open the Solo run editor";
    }
    const stopRun = controls.querySelector<HTMLButtonElement>("#solo-stop-run");
    if (stopRun) {
      stopRun.hidden = !stoppableRun;
      stopRun.disabled = this.stoppingOngoingRun;
      stopRun.textContent = "Finish";
      stopRun.title = pausedOngoingCapture || snapshot?.currentEpisode
        ? "Finish and safely finalise the current capture"
        : "Finish the ongoing run";
    }
    const runSummary = controls.querySelector<HTMLElement>("#solo-run-summary");
    if (runSummary) {
      runSummary.textContent = completedRunReadyForReset
        ? "Resumable task retained."
        : pausedOngoingCapture
          ? `${configuration?.runTitle ?? "Solo run"} / capture paused. Resume where you left off.`
        : resumableRun
          ? `${configuration?.runTitle ?? "Solo run"} / run in progress. Resume where you left off.`
        : configuration
        ? `${configuration.runTitle} / ${recordableTaskCount} ${recordableTaskCount === 1 ? "task" : "tasks"}`
        : "Review, edit or import the run.";
    }

    const enterXr = controls.querySelector<HTMLButtonElement>("#enter-xr");
    if (enterXr) {
      enterXr.textContent = "Open XR";
      enterXr.disabled = !state.xrReady || root.dataset.taskWorkspaceOpen === "true";
      enterXr.title = state.xrReady
        ? "Launch Solo XR"
        : "Complete the Solo setup steps before entering XR";
    }
    const xrLaunchGateAllowed = state.cameraReady
      && state.runReady
      && root.dataset.taskWorkspaceOpen !== "true";
    if (this.xrLaunchGateAllowed !== xrLaunchGateAllowed) {
      this.xrLaunchGateAllowed = xrLaunchGateAllowed;
      queueMicrotask(() => this.captureApp?.refreshLaunchState());
    }
  }

  private focusNextSoloAction(root: HTMLElement) {
    window.requestAnimationFrame(() => {
      if (!root.isConnected) return;
      const nextAction = ["#enter-xr", "#solo-preload-task", "#prepare-camera"]
        .map((selector) => root.querySelector<HTMLButtonElement>(selector))
        .find((action): action is HTMLButtonElement => action !== null && !action.disabled);
      nextAction?.focus();
    });
  }

  private canonicalSoloRepositoryOrganisation(value: string) {
    const candidate = value.trim();
    if (!candidate) return null;
    if (this.repositoryCatalogueOrganisations.has(candidate)) return candidate;
    const folded = candidate.toLocaleLowerCase();
    return [...this.repositoryCatalogueOrganisations].find(
      (organisation) => organisation.toLocaleLowerCase() === folded,
    ) ?? null;
  }

  private activeHuggingFaceUpload() {
    const active = this.exportSnapshot?.active.job;
    return active?.type === "upload"
      && active.browserRecovery?.destination === "hugging-face"
      ? active
      : null;
  }

  private renderSoloHuggingFaceProcessing(root: HTMLElement) {
    const destinationProcessing = this.exportDestination === "hugging-face"
      && (
        this.huggingFaceActionBusy
        || this.repositoryCatalogueState === "loading"
        || this.repositoryDestinationValidation.state === "checking"
      );
    const destination = root.querySelector<HTMLElement>("[data-solo-hf-destination]");
    if (destination) {
      destination.dataset.processing = String(destinationProcessing);
      destination.setAttribute("aria-busy", String(destinationProcessing));
    }
    const action = root.querySelector<HTMLButtonElement>("#solo-hf-action");
    if (action) {
      action.classList.toggle("is-processing", this.huggingFaceActionBusy);
      action.setAttribute("aria-busy", String(this.huggingFaceActionBusy));
      if (this.huggingFaceActionBusy) {
        action.disabled = true;
        action.hidden = false;
        action.textContent = this.huggingFaceActionBusyText;
      }
    }
  }

  private async resumeLaunchRun(root: HTMLElement) {
    const controller = this.controller;
    if (!controller || !soloRunCanResume(controller.snapshot)) {
      this.showActivity("The ongoing Solo run is not ready to resume", "error");
      this.renderSoloProvisioning(root);
      return;
    }
    this.runEditorReviewed = true;
    this.resumedRunAwaitingXr = true;
    this.soloStepExpanded.set("run", false);
    this.soloStepExpanded.set("xr", true);
    this.renderSoloProvisioning(root);
    try {
      await this.persistWorkspace();
      this.showActivity("Ongoing Solo run ready. Open XR to continue.", "system");
    } catch (error) {
      this.showActivity(error, "error");
    }
    this.focusNextSoloAction(root);
  }

  private async finishOngoingSoloRun(root: HTMLElement) {
    const controller = this.controller;
    if (!controller || !soloRunCanStop(controller.snapshot)) {
      this.showActivity("There is no ongoing Solo capture to finish", "error");
      this.renderSoloProvisioning(root);
      return;
    }
    const hasCapture = controller.snapshot.currentEpisode !== null
      || controller.snapshot.run.recordingState !== "idle";
    this.stoppingOngoingRun = true;
    this.renderSoloProvisioning(root);
    try {
      await controller.control(
        "finish",
        nextRunControlCursor(controller.snapshot, "finish"),
      );
      this.resumedRunAwaitingXr = false;
      this.showActivity(
        hasCapture
          ? "Finishing and finalising the current capture."
          : "Solo run finished.",
        "system",
      );
    } catch (error) {
      this.showActivity(error, "error");
    } finally {
      this.stoppingOngoingRun = false;
      this.renderSoloProvisioning(root);
    }
  }

  private async openLaunchTaskWorkspace(root: HTMLElement) {
    const controller = this.controller;
    const draft = this.runDraft;
    if (!controller || !draft) {
      this.showActivity("The Solo task workspace is not ready", "error");
      return;
    }
    if (!this.launchRunEditor) {
      const editorRoot = root.querySelector<HTMLElement>("#run-editor-home");
      if (!editorRoot) throw new Error("The Solo task editor mount is unavailable");
      this.launchRunEditor = new RunEditor({
        root: editorRoot,
        configuration: draft.readConfiguration(),
        selectedStartTaskId: controller.snapshot.solo?.selectedStartTaskId ?? null,
        onConfigurationChange: (configuration) => {
          this.runDraft?.applyConfiguration(configuration);
          if (this.controller?.snapshot.run.status !== "complete") {
            this.queueConfiguration(configuration);
          }
          this.runEditorReviewed = false;
          this.renderSoloProvisioning(root);
        },
        onStartTaskSelection: (taskId) => {
          this.runDraft?.selectStartTask(taskId);
          void this.persistWorkspace();
        },
        onActivity: (message) => this.showActivity(message, "system"),
      });
      this.launchRunEditor.mount();
      this.launchTaskWorkspace = new TaskImportWorkspace({
        root,
        readConfiguration: () => this.launchRunEditor?.readConfiguration() ?? draft.readConfiguration(),
        applyConfiguration: (configuration) => this.launchRunEditor?.applyConfiguration(configuration),
        hasUnsavedChanges: () => false,
        openOverlay: () => {
          const modal = root.querySelector<HTMLElement>("#task-editor-modal");
          if (modal) modal.hidden = false;
          root.dataset.taskWorkspaceOpen = "true";
          root.querySelector<HTMLElement>("#solo-capture-host")?.setAttribute("inert", "");
          this.renderSoloProvisioning(root);
        },
        closeOverlay: () => {
          const modal = root.querySelector<HTMLElement>("#task-editor-modal");
          if (modal) modal.hidden = true;
          delete root.dataset.taskWorkspaceOpen;
          root.querySelector<HTMLElement>("#solo-capture-host")?.removeAttribute("inert");
          this.renderSoloProvisioning(root);
        },
        headerActionLabel: "LOCK IN",
        headerActionDisabled: () => this.controller?.snapshot.run.status === "complete",
        onHeaderAction: () => {
          void this.lockInLaunchRun(root);
        },
        secondaryHeaderActionLabel: "RESET RUN",
        secondaryHeaderActionDisabled: () => (
          this.controller?.snapshot.run.status !== "complete"
          || this.resettingCompletedRun
        ),
        onSecondaryHeaderAction: () => {
          void this.resetCompletedRunFromEditor(root);
        },
        backHeaderActionLabel: "BACK",
        onBackHeaderAction: () => {
          this.launchTaskWorkspace?.close();
          void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
        },
      });
    }
    this.launchTaskWorkspace?.open();
    this.renderSoloProvisioning(root);
  }

  private async lockInLaunchRun(root: HTMLElement) {
    const editor = this.launchRunEditor;
    const controller = this.controller;
    if (!editor || !controller || controller.snapshot.run.status === "complete") return;
    try {
      const configuration = editor.readConfiguration();
      this.runDraft?.applyConfiguration(configuration);
      if (!soloCaptureConfigurationAlreadyApplied(configuration, controller.snapshot)) {
        this.queueConfiguration(configuration);
        await this.applyPendingConfiguration();
      }
      this.runEditorReviewed = true;
      this.soloStepExpanded.set("run", false);
      this.soloStepExpanded.set("xr", true);
      this.launchTaskWorkspace?.close();
      this.renderSoloProvisioning(root);
      await this.persistWorkspace();
      this.showActivity("Solo run locked in", "system");
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private renderCompletedRunStatus(
    controls: HTMLElement,
    runComplete: boolean,
  ) {
    const container = controls.querySelector<HTMLElement>("#solo-run-completion");
    const label = controls.querySelector<HTMLElement>("#solo-run-completion-label");
    const detail = controls.querySelector<HTMLElement>("#solo-run-upload-detail");
    const progress = controls.querySelector<HTMLProgressElement>("#solo-run-upload-progress");
    const cancel = controls.querySelector<HTMLButtonElement>("#solo-run-upload-cancel");
    const retry = controls.querySelector<HTMLButtonElement>("#solo-run-upload-retry");
    const actions = controls.querySelector<HTMLElement>(".solo-run-upload-actions");
    if (!container || !label || !detail || !progress || !cancel || !retry || !actions) {
      return "Run complete.";
    }
    const jobs = [...(this.exportSnapshot?.jobs ?? [])]
      .filter(({ type, browserRecovery }) => (
        type === "upload"
        && browserRecovery?.destination === "hugging-face"
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const active = jobs.find(({ state }) => state === "queued" || state === "running");
    const showUpload = Boolean(active || this.uploadCompletion);
    container.hidden = !runComplete && !showUpload;
    container.setAttribute("aria-busy", String(showUpload));
    detail.hidden = true;
    detail.textContent = "";
    progress.hidden = true;
    cancel.hidden = true;
    cancel.disabled = false;
    cancel.textContent = "ABORT";
    retry.hidden = true;
    actions.hidden = true;
    const finish = (message: string) => {
      if (label.textContent !== message) label.textContent = message;
      actions.hidden = cancel.hidden && retry.hidden;
      return message;
    };
    if (active) {
      const repository = soloUploadCompletionRepository(
        active,
        this.repositoryDestinationValidation.result?.repository ?? null,
      );
      const message = soloHuggingFaceUploadActivityLabel(
        runComplete,
        active ? this.restoredExportJobIds.has(active.id) : false,
        repository,
      );
      const episodeCount = active?.browserRecovery?.episodeIds.length ?? 0;
      const episodeLabel = episodeCount > 0
        ? `${episodeCount} ${episodeCount === 1 ? "episode" : "episodes"}`
        : null;
      const progressDetail = this.exportSnapshot?.active.progress?.detail
        ?? active?.detail
        ?? "Preparing immutable upload artefacts";
      detail.textContent = episodeLabel
        ? `${episodeLabel} / ${progressDetail}`
        : progressDetail;
      detail.hidden = false;
      progress.hidden = false;
      const fraction = this.exportSnapshot?.active.progress?.fraction;
      if (fraction === undefined || fraction === null) progress.removeAttribute("value");
      else progress.value = fraction;
      const finalising = this.exportSnapshot?.active.progress?.stage === "finalising";
      const accountRecoveryOnly = active?.browserRecovery?.uploadMode === "account"
        && !this.uploadController
        && !this.exporter?.isRunning();
      cancel.hidden = !active;
      cancel.disabled = this.exportSnapshot?.active.canCancel !== true;
      if (finalising) cancel.textContent = "FINALISING";
      else if (this.exportSnapshot?.active.operation === "cancel") {
        cancel.textContent = accountRecoveryOnly ? "STOPPING" : "ABORTING";
      } else {
        cancel.textContent = accountRecoveryOnly ? "STOP RESUME" : "ABORT";
      }
      cancel.setAttribute(
        "aria-label",
        accountRecoveryOnly
          ? "Stop automatic recovery of the account upload"
          : "Abort Hugging Face upload",
      );
      return finish(message);
    }
    if (!runComplete) return "";
    container.setAttribute("aria-busy", "false");
    if (this.exportDestination !== "hugging-face") {
      return finish("Run complete. Capture stored on this headset.");
    }
    const latestEpisodeId = [...(this.controller?.snapshot.episodes ?? [])]
      .filter(({ endedAt }) => endedAt)
      .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""))[0]?.id;
    const relevantJobs = latestEpisodeId
      ? jobs.filter(({ browserRecovery }) => browserRecovery?.episodeIds.includes(latestEpisodeId))
      : jobs;
    const terminal = relevantJobs.find(
      ({ state }) => state === "completed" || state === "failed" || state === "cancelled",
    );
    if (terminal?.state === "completed") {
      const repository = soloUploadCompletionRepository(terminal, null);
      const repositoryLabel = repository ? ` to ${repository}` : "";
      progress.hidden = false;
      progress.value = 1;
      detail.textContent = terminal.detail;
      detail.hidden = false;
      return finish(`Run complete, upload successful${repositoryLabel}`);
    }
    if (terminal?.state === "failed") {
      const repository = soloUploadCompletionRepository(terminal, null);
      const repositoryLabel = repository ? ` to ${repository}` : "";
      detail.textContent = terminal.detail;
      detail.hidden = false;
      retry.hidden = this.exportSnapshot?.retry.available !== true;
      return finish(`Run complete, upload failed${repositoryLabel}`);
    }
    if (terminal?.state === "cancelled") {
      const repository = soloUploadCompletionRepository(terminal, null);
      const repositoryLabel = repository ? ` to ${repository}` : "";
      detail.textContent = terminal.detail;
      detail.hidden = false;
      retry.hidden = this.exportSnapshot?.retry.available !== true;
      return finish(`Run complete, upload cancelled${repositoryLabel}`);
    }
    const repository = this.repositoryDestinationValidation.result?.repository ?? null;
    if (!this.availableHuggingFaceUploadAuthority()) {
      return finish("Run complete. Capture stored on this headset. Sign in to Hugging Face to send it.");
    }
    if (!repository) {
      return finish("Run complete. Capture stored on this headset. Verify the Hugging Face destination to send it.");
    }
    return finish(`Run complete. Starting Hugging Face upload to ${repository}.`);
  }

  private async abortActiveSoloUpload() {
    if (!this.activeHuggingFaceUpload()) return;
    try {
      await this.exportController?.cancel();
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private async retryCompletedRunUpload() {
    try {
      await this.exportController?.retry();
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private async resetCompletedRunFromEditor(root: HTMLElement) {
    const controller = this.controller;
    const editor = this.launchRunEditor;
    if (
      !controller
      || !editor
      || controller.snapshot.run.status !== "complete"
      || this.resettingCompletedRun
    ) return;
    this.resettingCompletedRun = true;
    try {
      const configuration = editor.readConfiguration();
      await controller.resetCompletedRun();
      this.runDraft?.applyConfiguration(configuration);
      this.queueConfiguration(configuration);
      await this.applyPendingConfiguration();
      this.runEditorReviewed = false;
      const lock = root.querySelector<HTMLButtonElement>("#task-editor-close");
      const reset = root.querySelector<HTMLButtonElement>("#task-editor-secondary-action");
      if (lock) lock.disabled = false;
      if (reset) reset.disabled = true;
      this.renderSoloProvisioning(root);
      await this.persistWorkspace();
      this.showActivity("Run reset. Lock in the run when it is ready.", "system");
    } catch (error) {
      this.showActivity(error, "error");
    } finally {
      this.resettingCompletedRun = false;
    }
  }

  private async startSoloRunFromXr() {
    const controller = this.controller;
    const draft = this.runDraft;
    if (!controller || !draft) return;
    try {
      const snapshot = controller.snapshot;
      const taskId = snapshot.solo?.selectedStartTaskId
        ?? draft.snapshot.selectedStartTaskId
        ?? snapshot.configuration.tasks.find((task) => task.type !== "pause")?.id
        ?? null;
      if (!taskId) throw new Error("Configure at least one recordable task before starting");
      draft.selectStartTask(taskId);
      await this.waitForStartReadiness();
      await controller.selectStartTask(taskId);
      this.showActivity("Solo countdown started", "system");
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private async retreadSoloRunFromXr() {
    const controller = this.controller;
    if (
      !controller
      || controller.snapshot.run.status !== "complete"
      || controller.snapshot.run.recordingState !== "idle"
    ) return;
    try {
      await controller.resetCompletedRun();
      this.runEditorReviewed = true;
      this.postAcquisitionPresentationKey = "";
      this.captureApp?.clearSoloPostAcquisitionQuality();
      await this.startSoloRunFromXr();
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private async reconfigureSoloRunFromXr(root: HTMLElement) {
    const snapshot = this.controller?.snapshot;
    if (!snapshot || !this.captureApp) return;
    if (snapshot.run.status === "running" || snapshot.run.recordingState !== "idle") {
      this.showActivity("Finish the active run before reconfiguring it", "error");
      return;
    }
    try {
      await this.captureApp.exitXrForSystemTransition();
      await this.openLaunchTaskWorkspace(root);
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private async beginHuggingFaceConnection() {
    if (this.controller && this.captureApp) {
      try {
        await this.beginSystemTransition("hf-oauth", "export");
      } catch (error) {
        this.showActivity(error, "error");
      }
      return;
    }
    const snapshot = this.controller?.snapshot;
    if (snapshot && (
      snapshot.run.status === "running"
      || snapshot.run.recordingState !== "idle"
      || snapshot.currentEpisode
      || snapshot.pendingEpisode
    )) {
      this.showActivity("Stop the active Solo run before connecting Hugging Face", "error");
      return;
    }
    try {
      await this.applyPendingConfiguration();
      if (this.pendingConfiguration) {
        throw new Error("Persist the Solo draft before leaving for Hugging Face sign-in");
      }
      await beginSoloHuggingFaceOauth(location.href);
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private wireWorkspaceControls(root: HTMLElement) {
    root.querySelector<HTMLButtonElement>("#solo-transition-action")!.addEventListener("click", () => {
      void this.continueSystemTransition();
    });
    const fileInput = root.querySelector<HTMLInputElement>("#solo-transition-file")!;
    fileInput.addEventListener("change", (event) => {
      void this.receiveSystemFile((event.currentTarget as HTMLInputElement).files?.[0] ?? null);
    });
    fileInput.addEventListener("cancel", () => {
      void this.receiveSystemFile(null);
    });
    root.querySelector<HTMLButtonElement>("#solo-return-xr")!.addEventListener("click", () => {
      void this.returnToSoloXr();
    });
  }

  private async startSession(root: HTMLElement, sessionId: string, restoring: boolean) {
    if (this.startingSession || this.controller) return;
    if (!SOLO_SESSION_ID_PATTERN.test(sessionId)) {
      this.showActivity("The Solo session identifier is invalid", "error");
      return;
    }
    this.startingSession = true;
    this.recordedQualityEpisodeIds.clear();    const newButton = root.querySelector<HTMLButtonElement>("#solo-new-session")!;
    const resumeButton = root.querySelector<HTMLButtonElement>("#solo-resume-session")!;
    newButton.disabled = true;
    resumeButton.disabled = true;
    this.setLaunchState(root, restoring ? "Restoring Solo session" : "Creating Solo session", "busy");
    const controller = new SoloSessionController(sessionId);
    this.controller = controller;
    const authority = new SoloCaptureAuthority(controller);
    this.captureAuthority = authority;
    this.xrLaunchGateAllowed = false;
    this.resumedRunAwaitingXr = false;
    const capture = new CaptureApp({
      authority,
      onSoloStartRun: () => this.startSoloRunFromXr(),
      onSoloReconfigure: () => this.reconfigureSoloRunFromXr(root),
      onSoloRetread: () => this.retreadSoloRunFromXr(),
      onAudioRecordingChange: (enabled) => this.setSoloAudioRecording(enabled),
      isXrLaunchAllowed: () => this.xrLaunchGateAllowed,
      onLaunchStateChange: (state) => {
        this.launchPresentation = state;
        if (state.xr === "active") this.resumedRunAwaitingXr = false;
        this.renderSoloProvisioning(root);
      },
    });
    this.captureApp = capture;
    try {
      const captureHost = root.querySelector<HTMLElement>("#solo-capture-host")!;
      capture.mount(captureHost);
      this.installSoloLaunchControls(root, captureHost, sessionId);
      this.wireAccountAction(root);
      this.wirePreloadTaskAction(root);
      this.wireSoloExportSettings(root);
      await authority.connect();
      await authority.whenIdle();
      this.sessionRecovery = restoring ? "restored" : "new";
      this.setActiveSession(sessionId);
      root.dataset.sessionId = sessionId;
      root.querySelector<HTMLElement>("#solo-session-id")!.textContent = `OK / ${sessionId.replace(/-/g, "").slice(-4).toUpperCase()}`;
      root.querySelector<HTMLElement>("#solo-session-gate")!.classList.add("is-compact");
      this.mountHeadsetControllers(controller.snapshot);
      this.restoreSystemTransition(sessionId);
      this.renderSoloExportSettings(root);
      this.unsubscribeSnapshot = controller.subscribe((snapshot) => this.renderSnapshot(snapshot));
      this.mountExporter();
      this.startTiming();
      this.setLaunchState(root, restoring ? "Solo session restored" : "Solo session ready", "ready");      if (this.authenticationIsCurrent(this.startupAuthenticationEpoch, root)) {
        this.showActivity(restoring ? "Solo session restored" : "New Solo session ready", "system");
      }
      await this.restoreExportJobs(controller.snapshot);
      this.scheduleAutomaticHuggingFaceUpload(controller.snapshot);
      this.scheduleAutomaticLocalExport(controller.snapshot);
      const startupAuthenticationEpoch = this.startupAuthenticationEpoch;
      void this.finishSoloAuthenticationStartup(
        root,
        sessionId,
        startupAuthenticationEpoch,
      ).catch((error) => {
        if (this.authenticationIsCurrent(startupAuthenticationEpoch, root)) {
          this.showActivity(error, "error");
        }
      });
    } catch (error) {      this.captureApp?.dispose();
      this.captureApp = null;
      await authority.dispose().catch(() => undefined);
      this.captureAuthority = null;
      this.controller = null;
      this.unsubscribeSnapshot?.();
      this.unsubscribeSnapshot = null;
      root.querySelector<HTMLElement>("#solo-workspace")!.hidden = true;
      this.setLaunchState(root, errorMessage(error, "Solo session could not start"), "error");
    } finally {
      this.startingSession = false;
      newButton.disabled = false;
      resumeButton.disabled = false;
    }
  }

  private async finishSoloAuthenticationStartup(
    root: HTMLElement,
    sessionId: string,
    authenticationEpoch: number,
  ) {
    await this.soloOauthCompletion;
    if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
    if (this.oauthReturnState) this.restoreSystemTransition(sessionId);
    await this.refreshAccountSession(root, authenticationEpoch);
    this.scheduleAutomaticHuggingFaceUpload(this.controller?.snapshot ?? null);
  }

  private mountHeadsetControllers(snapshot: SessionSnapshot) {
    this.unsubscribeImport?.();
    this.unsubscribeExport?.();
    this.importController?.dispose();
    this.repositoryCatalogueAbort?.abort();
    this.repositoryCatalogueAbort = null;
    this.repositoryCatalogueState = "idle";
    this.repositoryCatalogueOrganisations.clear();
    this.invalidateSoloRepositoryDestination();
    this.restoredExportJobIds.clear();
    if (this.sessionRecovery === "restored") {
      for (const job of snapshot.jobs) {
        if (
          job.browserRecovery
          && (job.state === "queued" || job.state === "running")
        ) this.restoredExportJobIds.add(job.id);
      }
    }
    const workspace = snapshot.solo?.workspace;
    this.xrPage = workspace?.page ?? "run";
    this.workspaceRepositorySettingsExplicit = workspace?.repositorySettings != null;
    this.exportDestination = workspace?.exportSettings.destination ?? "hugging-face";
    this.huggingFaceSaveCadence = workspace?.exportSettings.huggingFaceCadence ?? "run";
    this.runEditorReviewed = snapshot.run.status === "complete";
    this.runDraft = new RunDraftController(
      snapshot.configuration,
      snapshot.solo?.selectedStartTaskId ?? null,
    );
    this.runDraft.focusTask(workspace?.focusedTaskId ?? null);
    this.importController = new SoloTaskImportController({
      readConfiguration: () => this.runDraft?.readConfiguration() ?? snapshot.configuration,
      applyConfiguration: async (configuration) => {
        const applied = this.runDraft?.applyConfiguration(configuration) ?? configuration;
        this.queueConfiguration(applied);
        await this.applyPendingConfiguration();
      },
    });
    this.exportController = new SoloExportController({
      start: (request) => this.startControllerExport(request),
      cancel: () => this.cancelSoloExportRuntime(),
      retry: (request) => this.startControllerExport(request, true),
      deleteEpisode: async (episodeId) => {
        await this.controller?.deleteEpisode(episodeId);
      },
    });
    this.exportController.updateSession(snapshot);
    this.setExportSelection(workspace?.selectedEpisodeIds ?? [], false);
    if (workspace?.repositorySettings) {
      this.exportController.updateRepositorySettings({
        ...workspace.repositorySettings,
        repository: soloHuggingFaceRepositoryName(workspace.repositorySettings.repository),
      });
    }
    this.exportController.updateAccount(
      this.accountSession,
      this.accountUnavailable ? "unavailable" : this.accountSession ? "available" : "checking",
    );
    this.exportController.updateHeadsetHuggingFaceAccount(
      this.soloHuggingFaceCredential?.username ?? null,
    );
    this.unsubscribeImport = this.importController.subscribe((value) => {
      this.importSnapshot = value;
    });
    this.unsubscribeExport = this.exportController.subscribe((value) => {
      this.exportSnapshot = value;
      this.updateSoloUploadHud(value);
      this.pushXrConsoleState();
      if (this.root) this.renderSoloExportSettings(this.root);
      void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
    });
  }

  private async cancelSoloExportRuntime() {
    const activeJob = this.exportController?.snapshot.active.job ?? null;
    if (activeJob) this.resumedExportJobIds.add(activeJob.id);

    if (this.exporter?.isRunning()) {
      if (!activeJob) throw new Error("The active browser export identity is unavailable");
      this.cancelledLerobotExportRequestIds.add(activeJob.id);
      let persistenceError: unknown;
      try {
        await this.upsertJob({
          ...activeJob,
          state: "running",
          detail: activeJob.type === "upload"
            ? "Hugging Face cancellation requested during artefact preparation; waiting for worker acknowledgement"
            : "Solo export cancellation requested; waiting for worker acknowledgement",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        persistenceError = error;
      }
      let cancellationError: unknown;
      try {
        this.exporter.cancel();
      } catch (error) {
        cancellationError = error;
        this.cancelledLerobotExportRequestIds.delete(activeJob.id);
      }
      if (persistenceError !== undefined && cancellationError !== undefined) {
        const combinedError = new Error(
          "The cancellation request and its recoverable state could not both be recorded",
        );
        Object.defineProperty(combinedError, "cause", {
          configurable: true,
          value: { persistenceError, cancellationError },
        });
        throw combinedError;
      }
      if (persistenceError !== undefined) throw persistenceError;
      if (cancellationError !== undefined) throw cancellationError;
      return;
    }

    const upload = this.uploadController;
    const completion = this.uploadCompletion;
    if (upload) {
      if (this.uploadMode === "account") {
        const persistedJob = this.controller?.snapshot.jobs.find((job) => job.id === activeJob?.id);
        if (!persistedJob?.browserRecovery) {
          throw new Error("The account upload cancellation identity is unavailable");
        }
        await this.upsertJob({
          ...persistedJob,
          state: "running",
          detail: "Hugging Face cancellation requested; waiting for backend confirmation",
          updatedAt: new Date().toISOString(),
          browserRecovery: {
            ...persistedJob.browserRecovery,
            cancellationPending: true,
          },
        });
      }
      upload.abort();
      if (completion) await completion.catch(() => undefined);
      return;
    }

    if (!activeJob) return;
    const accountRecoveryOnly = activeJob.type === "upload"
      && activeJob.browserRecovery?.uploadMode === "account";
    const ambiguousAccountOutcome = accountRecoveryOnly
      && activeJob.browserRecovery?.cancellationPending === false;
    if (ambiguousAccountOutcome) {
      const recovery = activeJob.browserRecovery!;
      const pendingCancellationJob: CaptureJob = {
        ...activeJob,
        state: "running",
        detail: "Hugging Face cancellation requested; waiting for authoritative backend confirmation",
        updatedAt: new Date().toISOString(),
        browserRecovery: {
          ...recovery,
          cancellationPending: true,
        },
      };
      await this.upsertJob(pendingCancellationJob);
      const activeReconciliation = this.accountUploadReconciliations.get(activeJob.id);
      activeReconciliation?.abort();
      if (activeReconciliation) this.accountUploadReconciliations.delete(activeJob.id);
      this.resumedExportJobIds.delete(activeJob.id);
      const account = this.accountSession;
      if (
        account?.signedIn
        && account.subject
        && account.huggingFace.state === "ready"
        && account.huggingFace.subject
        && this.controller
      ) {
        this.resumedExportJobIds.add(activeJob.id);
        this.startAccountUploadReconciliation({
          requestId: activeJob.id,
          accountJob: recovery.accountUploadJobId ?? null,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: this.controller.sessionId,
          episodeIds: recovery.episodeIds,
          cancellationPending: true,
        });
      } else {
        this.schedulePendingUploadResume();
      }
      this.showActivity(
        "Hugging Face cancellation is pending authoritative backend confirmation.",
        "system",
      );
      return;
    }
    const accountBackendOutcomePending = accountRecoveryOnly
      && (
        activeJob.browserRecovery.cancellationPending === true
        || Boolean(activeJob.browserRecovery.accountUploadJobId)
      );
    if (accountBackendOutcomePending) {
      this.showActivity(
        activeJob.browserRecovery?.cancellationPending === true
          ? "Hugging Face cancellation is already pending backend confirmation. CERES will keep reconciling it."
          : "Hugging Face finalisation is already running on the backend. CERES will keep reconciling its truthful outcome.",
        "system",
      );
      return;
    }
    this.accountUploadReconciliations.get(activeJob.id)?.abort();
    this.exportIntents.delete(activeJob.id);
    this.exportController?.updateProgress(null);
    const episodeIds = activeJob.browserRecovery?.episodeIds ?? [];
    const hasPreparedArtefacts = (activeJob.browserRecovery?.artefacts?.length ?? 0) > 0;
    await this.upsertJob({
      ...activeJob,
      state: "cancelled",
      detail: accountRecoveryOnly
        ? "Automatic account upload recovery stopped"
        : activeJob.type === "upload"
          ? "Hugging Face sync cancelled before recovery"
          : "Solo export cancelled before recovery",
      updatedAt: new Date().toISOString(),
    });    if (activeJob.type === "upload") {    }
    if (activeJob.type !== "upload" || !hasPreparedArtefacts) {    }
    if (accountRecoveryOnly) {
      this.showActivity(
        "Automatic upload recovery stopped. An account upload already finalising may still complete.",
        "system",
      );
    }
    this.schedulePendingUploadResume();
  }

  private async handleXrConsoleIntent(intent: SoloXrConsoleIntent) {
    this.xrNotice = null;
    try {
      if (intent.type === "quit-xr") {
        await this.captureApp?.exitXrForSystemTransition();
        return true;
      }
      if (intent.type === "open-console" || intent.type === "close-console") {
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "navigate") {
        this.xrPage = intent.page;
        await this.persistWorkspace();
        const importController = this.importController;
        const importSnapshot = importController?.snapshot;
        if (intent.page === "import"
          && importSnapshot
          && importSnapshot.catalogueEntries.length === 0
          && !importSnapshot.busy) {
          this.clearImportSelection();
          await importController.loadCatalogue();
        }
        this.pushXrConsoleState();
        return true;
      }
      if (isSoloDraftIntent(intent)) {
        const draft = this.runDraft;
        if (!draft) throw new Error("The Solo run draft is unavailable");
        const before = draft.readConfiguration();
        const configuration = applySoloXrDraftIntent(draft, intent);
        if (intent.type !== "draft-focus-task"
          && JSON.stringify(before) !== JSON.stringify(configuration)) {
          this.queueConfiguration(configuration);
        }
        await this.persistWorkspace();
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "select-start-task") {
        const draft = this.runDraft;
        if (!draft) throw new Error("The Solo run draft is unavailable");
        draft.selectStartTask(intent.taskId);
        await this.waitForStartReadiness();
        const controller = this.controller;
        if (!controller) throw new Error("The Solo session is unavailable");
        this.xrNotice = null;
        await controller.selectStartTask(intent.taskId);
        this.showActivity("Solo countdown started", "system");
        return true;
      }
      if (intent.type === "run-control") {
        await this.handleRunControl(intent.action);
        return true;
      }
      if (intent.type === "import-file") {
        this.clearImportSelection();
        this.importController?.selectSource("file");
        await this.beginSystemTransition("file-import", "import");
        return true;
      }
      if (intent.type === "import-select-sample") {
        this.clearImportSelection();
        this.importController?.selectSource("sample");
        this.selectedImportSampleId = intent.sampleId;
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "import-gist-change") {
        this.clearImportSelection();
        this.importGist = intent.value;
        this.importController?.selectSource("gist");
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "import-fetch-gist") {
        this.clearImportSelection();
        const result = await this.importController?.loadGist(this.importGist);
        if (result?.error) throw new Error(result.error);
        this.selectedImportCandidateId = result?.selectedGistCandidateIndex == null
          ? null
          : String(result.selectedGistCandidateIndex);
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "import-select-candidate") {
        const index = Number(intent.candidateId);
        if (!Number.isSafeInteger(index)) throw new Error("The selected Gist file is invalid");
        this.clearImportSelection();
        if (!this.importController?.selectGistCandidate(index)) {
          throw new Error("The selected GitHub Gist file is invalid");
        }
        this.selectedImportCandidateId = intent.candidateId;
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "import-preview") {
        if (this.importController?.snapshot.source === "sample" && this.selectedImportSampleId) {
          const result = await this.importController.previewSample(this.selectedImportSampleId);
          if (result.error) {
            this.clearImportSelection();
            throw new Error(result.error);
          }
        } else if (this.importController?.snapshot.source === "gist") {
          this.clearImportSelection();
          const result = await this.importController.loadGist(this.importGist);
          if (result.error) throw new Error(result.error);
          this.selectedImportCandidateId = result.selectedGistCandidateIndex == null
            ? null
            : String(result.selectedGistCandidateIndex);
        }
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "import-confirm") {
        const configuration = await this.importController?.confirm();
        if (!configuration) throw new Error("Preview a valid task source before importing it");
        this.clearImportSelection();
        this.importGist = "";
        this.xrPage = "tasks";
        await this.persistWorkspace();
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "import-cancel") {
        this.importController?.cancel();
        this.importGist = "";
        this.clearImportSelection();
        this.pushXrConsoleState();
        return true;
      }
      if (intent.type === "episode-select") {
        this.setExportSelection(intent.selected
          ? [...(this.exportController?.snapshot.selectedEpisodeIds ?? []), intent.episodeId]
          : (this.exportController?.snapshot.selectedEpisodeIds ?? [])
            .filter((episodeId) => episodeId !== intent.episodeId));
        return true;
      }
      if (intent.type === "episode-delete") {
        const exportController = this.exportController;
        if (!exportController) throw new Error("Solo episode review is unavailable");
        exportController.requestDelete(intent.episodeId);
        return true;
      }
      if (intent.type === "episode-delete-confirm") {
        const exportController = this.exportController;
        if (!exportController?.snapshot.deleteConfirmation
          || exportController.snapshot.deleteConfirmation.episodeId !== intent.episodeId) {
          throw new Error("The Solo episode delete confirmation has changed");
        }
        await exportController.confirmDelete();
        return true;
      }
      if (intent.type === "episode-delete-cancel") {
        this.exportController?.cancelDelete();
        return true;
      }
      if (intent.type === "export-repository-change") {
        const [organisation = "", repository = ""] = intent.value.split("/", 2);
        this.updateSoloRepositorySettings({ organisation, repository });
        if (this.root) await this.refreshSoloRepositoryCatalogue(this.root);
        return true;
      }
      if (intent.type === "export-branch-change") {
        this.exportController?.updateRepositorySettings({ branch: intent.value });
        this.workspaceRepositorySettingsExplicit = true;
        await this.persistWorkspace();
        return true;
      }
      if (intent.type === "export-visibility-change") {
        this.updateSoloRepositorySettings({ visibility: intent.visibility });
        if (this.root) await this.refreshSoloRepositoryCatalogue(this.root);
        return true;
      }
      if (intent.type === "export-local" || intent.type === "export-folder" || intent.type === "hf-upload") {
        this.setExportSelection(intent.episodeIds);
        await this.exportController?.start(
          intent.type === "export-local"
            ? "opfs"
            : intent.type === "export-folder"
              ? "folder"
              : "hugging-face",
        );
        return true;
      }
      if (intent.type === "export-cancel") {
        await this.exportController?.cancel();
        return true;
      }
      if (intent.type === "export-retry") {
        await this.exportController?.retry();
        return true;
      }
      if (intent.type === "hf-sign-in") {
        await this.beginSystemTransition("hf-oauth", "export");
        return true;
      }
      if (intent.type === "hf-sign-out") {
        if (this.root) await this.signOutSoloHuggingFace(this.root);
        return true;
      }
      return true;
    } catch (error) {
      this.showActivity(error, "error");
      return false;
    }
  }

  private setExportSelection(episodeIds: readonly string[], persist = true) {
    const controller = this.exportController;
    if (!controller) throw new Error("Solo export is unavailable");
    const requested = new Set(episodeIds);
    const current = new Set(controller.snapshot.selectedEpisodeIds);
    for (const episodeId of current) {
      if (!requested.has(episodeId)) controller.toggleEpisodeSelection(episodeId);
    }
    for (const episodeId of requested) {
      if (!current.has(episodeId)) controller.toggleEpisodeSelection(episodeId);
    }
    if (persist) {
      void this.persistWorkspace().catch((error) => this.showActivity(error, "error"));
    }
  }

  private async persistWorkspace(page: SoloXrConsolePage = this.xrPage) {
    const controller = this.controller;
    if (!controller) return;
    const exportController = this.exportController;
    const repositorySettings = this.workspaceRepositorySettingsExplicit && exportController
      ? { ...exportController.snapshot.repositorySettings }
      : null;
    const workspace: SoloWorkspaceState = {
      page,
      focusedTaskId: this.runDraft?.snapshot.focusedTaskId ?? null,
      selectedEpisodeIds: [...(exportController?.snapshot.selectedEpisodeIds ?? [])],
      repositorySettings,
      exportSettings: {
        destination: this.exportDestination,
        huggingFaceCadence: this.huggingFaceSaveCadence,
      },
      runEditorReviewed: this.runEditorReviewed,
    };
    if (JSON.stringify(controller.snapshot.solo?.workspace) === JSON.stringify(workspace)) return;
    await controller.setWorkspace(workspace);
  }

  private async startControllerExport(
    request: SoloExportRequest,
    explicitRetry = false,
  ) {
    if (request.destination === "folder") {
      await this.prepareFolderSystemTransition(request);
      return;
    }
    const type: SoloExportIntent["type"] = request.destination === "opfs"
      ? "export"
      : "upload";
    await this.startExport({
      type,
      episodeIds: [...request.episodeIds],
      ...(request.repository ? { repository: request.repository } : {}),
      ...(request.branch ? { branch: request.branch } : {}),
      ...(request.visibility ? { visibility: request.visibility } : {}),
      ...(request.missingRepositoryBehaviour
        ? { missingRepositoryBehaviour: request.missingRepositoryBehaviour }
        : {}),
      ...(!explicitRetry && request.uploadMode ? { uploadMode: request.uploadMode } : {}),
      ...(!explicitRetry && request.uploadPrincipal
        ? { uploadPrincipal: request.uploadPrincipal }
        : {}),
    });
  }

  private async prepareFolderSystemTransition(request: SoloExportRequest) {
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await this.upsertJob({
      id: jobId,
      type: "export",
      state: "queued",
      detail: "Waiting for a Solo folder destination",
      createdAt,
      updatedAt: createdAt,
      browserRecovery: {
        destination: "folder",
        episodeIds: [...request.episodeIds],
      },
    });    this.pendingFolderRequest = request;
    try {
      await this.beginSystemTransition("folder-export", "export", jobId);
    } catch (error) {      this.pendingFolderRequest = null;
      const job = this.controller?.snapshot.jobs.find(({ id }) => id === jobId);
      if (job?.state === "queued" || job?.state === "running") {
        await this.upsertJob({
          ...job,
          state: "failed",
          detail: errorMessage(error, "Folder selection could not start"),
          updatedAt: new Date().toISOString(),
        }).then(() => {        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async beginSystemTransition(
    kind: SoloSystemTransitionKind,
    returnPage: SoloXrConsolePage,
    continuationId?: string,
  ) {
    const controller = this.controller;
    const capture = this.captureApp;
    if (!controller || !capture) throw new Error("The Solo headset session is unavailable");
    if (this.pendingSystemTransition) {
      throw new Error("Complete the active Quest system hand-off before starting another");
    }
    if (kind !== "folder-export" && this.exportSnapshot?.active.busy) {
      throw new Error("Complete or cancel the active Solo export before leaving immersive mode");
    }
    await this.applyPendingConfiguration();
    if (this.pendingConfiguration) {
      throw new Error("Persist the Solo draft before leaving immersive mode");
    }
    const snapshot = controller.snapshot;
    this.xrPage = returnPage;
    await this.persistWorkspace(returnPage);
    if (kind === "hf-oauth") this.clearSoloOauthReturnMarker();
    const pending = requestSoloSystemTransition({
      kind,
      sessionId: snapshot.sessionId,
      returnPage,
      ...(continuationId ? { continuationId } : {}),
    }, snapshot, { finalising: snapshot.run.recordingState === "stopping" });
    persistSoloSystemTransition(localStorage, pending);
    this.pendingSystemTransition = pending;
    this.systemTransitionCompletionBlocked = false;
    this.xrReadyForTransitionCompletion = false;
    try {
      await capture.exitXrForSystemTransition();
    } catch (error) {
      if (kind === "folder-export") {
        await this.settlePendingFolderTransition(
          "failed",
          "Solo XR could not exit for folder selection",
        );
      }
      await this.systemResultStore.clear(pending.id).catch(() => undefined);
      clearSoloSystemTransition(localStorage, snapshot.sessionId);
      this.pendingSystemTransition = null;
      this.renderSystemTransition();
      throw error;
    }
    const outside = markSoloSystemTransitionOutsideXr(pending);
    persistSoloSystemTransition(localStorage, outside);
    this.pendingSystemTransition = outside;
    this.renderSystemTransition();
  }

  private restoreSystemTransition(sessionId: string) {
    const restored = restoreSoloSystemTransition(localStorage, sessionId);
    if (!restored) return;
    this.systemTransitionCompletionBlocked = false;
    const resumed = resumeSoloSystemTransitionAfterReload(restored);
    const returnedFromOauth = isSoloSystemTransitionOauthReturn(
      resumed,
      this.oauthReturnState,
    );
    this.pendingSystemTransition = returnedFromOauth
      ? requireSoloSystemTransitionXrReentry(resumed)
      : resumed;
    this.xrPage = this.pendingSystemTransition.returnPage;
    if (returnedFromOauth) {
      this.oauthReturnState = null;
      this.clearSoloOauthReturnMarker();
    }
    if (this.pendingSystemTransition.kind === "folder-export") {
      const job = this.controller?.snapshot.jobs.find(
        ({ id }) => id === this.pendingSystemTransition?.continuationId,
      );
      const episodeIds = job?.browserRecovery?.destination === "folder"
        ? job.browserRecovery.episodeIds
        : [];
      if (episodeIds.length > 0) {
        this.pendingFolderRequest = {
          destination: "folder",
          sessionId,
          episodeIds: [...episodeIds],
        };
      } else if (job) {
        void this.upsertJob({
          ...job,
          state: "failed",
          detail: "The restored folder export recovery record is incomplete",
          updatedAt: new Date().toISOString(),
        }).then(() => {        });
      } else if (this.pendingSystemTransition.continuationId) {
        const now = new Date().toISOString();
        void this.upsertJob({
          id: this.pendingSystemTransition.continuationId,
          type: "export",
          state: "failed",
          detail: "The restored folder export recovery job is missing",
          createdAt: now,
          updatedAt: now,
        }).then(() => {        });
      }
    }
    persistSoloSystemTransition(localStorage, this.pendingSystemTransition);
    this.captureApp?.restoreXrConsolePage(this.pendingSystemTransition.returnPage);
    this.renderSystemTransition();
  }

  private async continueSystemTransition() {
    const pending = this.pendingSystemTransition;
    if (!pending || pending.phase !== "outside-xr") return;
    if (pending.kind === "hf-oauth" && this.oauthCallbackInFlight) return;
    try {
      if (pending.kind === "file-import") {
        const fileInput = this.root?.querySelector<HTMLInputElement>("#solo-transition-file");
        if (!fileInput) throw new Error("The Solo file hand-off control is unavailable");
        fileInput.value = "";
        fileInput.click();
        return;
      }
      if (pending.kind === "hf-oauth") {
        this.invalidateSoloAuthentication();
        await beginSoloHuggingFaceOauth(new URL(this.soloOauthReturnPath(), location.origin).href);
        return;
      }
      const picker = (window as typeof window & {
        showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      if (!picker) throw new Error("Folder export is unavailable in this browser");
      const directoryHandle = await picker.call(window, { mode: "readwrite" }) as SoloDirectoryHandle;
      await this.systemResultStore.putDirectory(pending.id, directoryHandle);
      this.markSystemTransitionAwaitingReentry();
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      await this.settlePendingFolderTransition(
        cancelled ? "cancelled" : "failed",
        cancelled ? "Folder selection was cancelled" : errorMessage(error, "Folder selection failed"),
      );
      await this.systemResultStore.clear(pending.id).catch(() => undefined);
      if (!cancelled) this.showActivity(error, "error");
      this.markSystemTransitionAwaitingReentry();
    }
  }

  private async receiveSystemFile(file: File | null) {
    if (!file) {
      const transitionId = this.pendingSystemTransition?.id;
      if (transitionId) await this.systemResultStore.clear(transitionId).catch(() => undefined);
      this.markSystemTransitionAwaitingReentry();
      return;
    }
    try {
      if (file.size > TASK_IMPORT_MAX_BYTES) {
        throw new Error(`The task file exceeds the ${TASK_IMPORT_MAX_BYTES} byte limit`);
      }
      const text = await file.text();
      const pending = this.pendingSystemTransition;
      if (!pending || pending.kind !== "file-import") {
        throw new Error("The Solo file selection no longer matches an active transition");
      }
      await this.systemResultStore.putFile(pending.id, file.name, text);
    } catch (error) {
      const transitionId = this.pendingSystemTransition?.id;
      if (transitionId) await this.systemResultStore.clear(transitionId).catch(() => undefined);
      this.showActivity(error, "error");
    }
    this.markSystemTransitionAwaitingReentry();
  }

  private markSystemTransitionAwaitingReentry() {
    const pending = this.pendingSystemTransition;
    if (!pending || pending.phase !== "outside-xr") return;
    this.pendingSystemTransition = requireSoloSystemTransitionXrReentry(pending);
    persistSoloSystemTransition(localStorage, this.pendingSystemTransition);
    this.renderSystemTransition();
  }

  private async settlePendingFolderTransition(
    state: "cancelled" | "failed",
    detail: string,
  ) {
    const jobId = this.pendingSystemTransition?.continuationId;
    if (!jobId) return;
    const job = this.controller?.snapshot.jobs.find(({ id }) => id === jobId);
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    await this.upsertJob({
      ...job,
      state,
      detail,
      updatedAt: new Date().toISOString(),
    });  }

  private renderSystemTransition() {
    const root = this.root;
    if (!root) return;
    const pending = this.pendingSystemTransition;
    const bridge = root.querySelector<HTMLElement>("#solo-system-transition")!;
    const returnToXr = root.querySelector<HTMLButtonElement>("#solo-return-xr")!;
    bridge.hidden = !pending;
    returnToXr.hidden = !pending || pending.phase !== "awaiting-xr-reentry";
    returnToXr.disabled = this.returningToSoloXr;
    if (!pending) return;
    const label = pending.kind === "file-import"
      ? "Choose task file"
      : pending.kind === "folder-export"
        ? "Choose export folder"
        : "Continue to Hugging Face";
    const oauthCallbackInFlight = pending.kind === "hf-oauth"
      && pending.phase === "outside-xr"
      && this.oauthCallbackInFlight;
    root.querySelector<HTMLElement>("#solo-transition-detail")!.textContent = pending.phase === "awaiting-xr-reentry"
      ? "Return to Solo XR to continue on the headset"
      : oauthCallbackInFlight
        ? "Completing Hugging Face authorisation. Keep this page open."
        : `${label} in the Quest browser, then return to Solo XR`;
    const action = root.querySelector<HTMLButtonElement>("#solo-transition-action")!;
    action.textContent = oauthCallbackInFlight ? "Completing Hugging Face" : label;
    action.disabled = oauthCallbackInFlight;
    action.hidden = pending.phase !== "outside-xr";
  }

  private completeSystemTransitionIfReady(snapshot: SessionSnapshot) {
    const pending = this.pendingSystemTransition;
    if (!pending
      || pending.phase !== "awaiting-xr-reentry"
      || !this.xrReadyForTransitionCompletion
      || this.completingSystemTransition
      || this.systemTransitionCompletionBlocked) return;
    this.completingSystemTransition = true;
    void this.completeSystemTransition(snapshot, pending).finally(() => {
      this.completingSystemTransition = false;
    });
  }

  private async completeSystemTransition(
    snapshot: SessionSnapshot,
    pending: PendingSoloSystemTransition,
  ) {
    try {
      const page = completeSoloSystemTransition(pending, snapshot.sessionId, true);
      const result = await this.systemResultStore.get(pending.id);
      if (pending.kind === "file-import" && result?.kind === "file-import") {
        await this.importController?.previewLocalText({
          fileName: result.fileName,
          text: result.text,
        });
      } else if (pending.kind === "folder-export" && result?.kind === "folder-export") {
        const request = this.pendingFolderRequest;
        if (!request || !pending.continuationId) {
          throw new Error("The Solo folder export continuation is incomplete");
        }
        await this.startPreparedFolderExport(
          pending.continuationId,
          request,
          result.directoryHandle,
        );
        this.pendingFolderRequest = null;
      } else if (pending.kind === "folder-export") {
        const job = snapshot.jobs.find(({ id }) => id === pending.continuationId);
        if (job?.state === "queued" || job?.state === "running") {
          await this.settlePendingFolderTransition(
            "failed",
            "The selected folder could not be restored. Retry the folder export",
          );
        }
        this.pendingFolderRequest = null;
      }
      this.pendingSystemTransition = null;
      this.xrReadyForTransitionCompletion = true;
      this.xrPage = page;
      await bestEffortRecoveryStep(() => this.systemResultStore.clear(pending.id));
      await bestEffortRecoveryStep(async () => {
        clearSoloSystemTransition(localStorage, snapshot.sessionId);
      });
      await bestEffortRecoveryStep(() => this.persistWorkspace(page));
      this.renderSystemTransition();
      this.pushXrConsoleState();
    } catch (error) {
      await recoverSoloSystemTransitionCompletion(
        pending,
        this.controller?.snapshot ?? snapshot,
        error,
        {
          restoreRuntime: (page) => {
            this.pendingSystemTransition = null;
            this.pendingFolderRequest = null;
            this.systemTransitionCompletionBlocked = false;
            this.xrReadyForTransitionCompletion = true;
            this.xrPage = page;
          },
          failFolderJob: async (job) => {
            await this.upsertJob(job);
            await this.localExportDestinationStore.clearFolderJob(job.id).catch(() => undefined);
          },
          clearResult: (transitionId) => this.systemResultStore.clear(transitionId),
          clearPersistedTransition: (sessionId) => {
            clearSoloSystemTransition(localStorage, sessionId);
          },
          persistWorkspace: (page) => this.persistWorkspace(page),
          render: () => {
            this.renderSystemTransition();
            this.pushXrConsoleState();
          },
          showOriginalError: (originalError) => this.showActivity(originalError, "error"),
        },
      );
    }
  }

  private async returnToSoloXr() {
    const pending = this.pendingSystemTransition;
    const capture = this.captureApp;
    if (!pending || pending.phase !== "awaiting-xr-reentry" || !capture || this.returningToSoloXr) return;
    this.returningToSoloXr = true;
    this.renderSystemTransition();
    this.systemTransitionCompletionBlocked = false;
    try {
      try {
        const result = await this.systemResultStore.get(pending.id);
        if (result?.kind === "folder-export") {
          await ensureSoloDirectoryReadWritePermission(result.directoryHandle);
        }
      } catch (error) {
        if (pending.kind === "folder-export") {
          await this.settlePendingFolderTransition(
            "failed",
            errorMessage(error, "Folder permission was not granted"),
          );
        }
        await this.systemResultStore.clear(pending.id).catch(() => undefined);
        this.showActivity(error, "error");
      }
      try {
        await capture.requestXrReentryFromUserGesture();
      } catch (error) {
        this.showActivity(error, "error");
        return;
      }
      this.xrReadyForTransitionCompletion = true;
      if (this.controller) this.completeSystemTransitionIfReady(this.controller.snapshot);
    } finally {
      this.returningToSoloXr = false;
      this.renderSystemTransition();
    }
  }

  private async startPreparedFolderExport(
    requestId: string,
    request: SoloExportRequest,
    directoryHandle: SoloDirectoryHandle,
  ) {
    const controller = this.controller;
    const exporter = this.exporter;
    if (!controller || !exporter) throw new Error("Solo folder export is unavailable");
    const destination = await this.localExportDestinationStore.bindFolderJob(requestId, {
      version: 1,
      type: "folder",
      name: directoryHandle.name,
      directoryHandle,
    });
    const intent: SoloExportIntent = {
      type: "folder",
      episodeIds: [...request.episodeIds],
    };
    this.exportIntents.set(requestId, intent);
    this.lerobotExportStartedAt.set(requestId, performance.now());
    exporter.start({
      requestId,
      sessionId: controller.sessionId,
      episodes: [...controller.snapshot.episodes, ...controller.snapshot.attempts],
      episodeIds: [...request.episodeIds],
      source: "solo-opfs",
      recorderRateHz: controller.snapshot.configuration.recorderRateHz,
      directoryHandle: destination.directoryHandle,
    });
    const existing = controller.snapshot.jobs.find((job) => job.id === requestId);
    await this.upsertJob({
      ...existing,
      id: requestId,
      type: "export",
      state: "running",
      detail: "Writing LeRobot v3 artefacts to the selected folder",
      createdAt: this.jobCreatedAt(requestId),
      updatedAt: new Date().toISOString(),
    });
  }

  private pushXrConsoleState(snapshot = this.controller?.snapshot) {
    const capture = this.captureApp;
    if (!capture || !snapshot) return;
    if (this.root) this.root.dataset.xrConsolePage = this.xrPage;
    const presentationSnapshot = this.xrPresentationSnapshot(snapshot);
    capture.updateXrConsoleState({
      snapshot: presentationSnapshot,
      page: this.xrPage,
      focusedTaskId: this.runDraft?.snapshot.focusedTaskId ?? null,
      selectedEpisodeIds: this.exportSnapshot?.selectedEpisodeIds ?? [],
      pendingDelete: this.exportSnapshot?.deleteConfirmation
        ? {
            episodeId: this.exportSnapshot.deleteConfirmation.episodeId,
            label: this.exportSnapshot.deleteConfirmation.taskLabel,
          }
        : null,
      account: this.xrAccountPresentation(),
      importState: this.xrImportPresentation(),
      exportState: this.xrExportPresentation(),
      notice: this.xrNotice,
      finalising: snapshot.run.recordingState === "stopping",
      sessionRecovery: this.sessionRecovery,
    });
  }

  private xrPresentationSnapshot(snapshot: SessionSnapshot) {
    const draft = this.runDraft;
    if (!draft) return snapshot;
    const configuration = draft.readConfiguration();
    if (JSON.stringify(configuration) === JSON.stringify(snapshot.configuration)) return snapshot;
    return {
      ...structuredClone(snapshot),
      configuration,
    };
  }

  private xrAccountPresentation(): SoloXrConsoleAccountPresentation {
    const account = this.exportSnapshot?.account;
    if (account?.canUpload) {
      return {
        state: "signed-in",
        label: account.username ?? account.label,
        uploadEnabled: true,
        actionLabel: null,
      };
    }
    if (this.soloHuggingFaceCredential) {
      return {
        state: "signed-in",
        label: this.soloHuggingFaceCredential.username,
        uploadEnabled: true,
        actionLabel: null,
      };
    }
    return {
      state: "signed-out",
      label: "Hugging Face is not authorised on this headset",
      uploadEnabled: false,
      actionLabel: "Sign in to Hugging Face",
    };
  }

  private xrImportPresentation(): SoloXrConsoleImportState {
    const value = this.importSnapshot;
    if (!value) {
      return {
        stage: "choose",
        gist: this.importGist,
        samples: [],
        selectedSampleId: null,
        candidates: [],
        selectedCandidateId: null,
        previewLabel: null,
        preview: null,
        message: "Choose a sample, public Gist or local file",
      };
    }
    return {
      stage: value.error ? "error" : value.busy ? "loading" : value.preview ? "preview" : "choose",
      gist: this.importGist,
      samples: value.catalogueEntries.map((entry) => ({
        id: entry.id,
        label: entry.title,
        detail: `${entry.taskCount} tasks / ${entry.summary}`,
      })),
      selectedSampleId: this.selectedImportSampleId,
      candidates: value.gistCandidates.map((entry) => ({
        id: String(entry.index),
        label: entry.fileName,
        detail: `${entry.taskCount} tasks / ${entry.runTitle}`,
      })),
      selectedCandidateId: this.selectedImportCandidateId,
      previewLabel: value.preview?.runTitle ?? null,
      preview: value.preview
        ? {
            sourceLabel: value.preview.sourceLabel,
            fileName: value.preview.fileName,
            runTitle: value.preview.runTitle,
            runDescription: value.preview.runDescription,
            cycleCount: value.preview.cycleCount,
            taskSpecHash: value.preview.taskSpecHash,
            warnings: value.preview.warnings,
            tasks: value.preview.tasks,
          }
        : null,
      message: value.error ?? value.detail,
    };
  }

  private xrExportPresentation(): SoloXrConsoleExportState {
    const value = this.exportSnapshot;
    const active = value?.active;
    const terminal = value?.jobs.find(
      (job) => job.state === "completed" || job.state === "failed" || job.state === "cancelled",
    );
    return {
      repository: value
        ? `${value.repositorySettings.organisation}/${value.repositorySettings.repository}`
        : "",
      branch: value?.repositorySettings.branch ?? "main",
      visibility: value?.repositorySettings.visibility ?? "private",
      state: active?.busy || active?.job
        ? active.job?.type === "upload" ? "uploading" : "preparing"
        : terminal?.state === "completed" ? "completed"
          : terminal ? "failed"
            : "idle",
      progress: active?.progress?.fraction ?? null,
      message: value?.lastError
        ?? active?.progress?.detail
        ?? active?.job?.detail
        ?? terminal?.detail
        ?? "Choose accepted episodes to export",
      canCancel: active?.canCancel ?? false,
      canRetry: value?.retry.available ?? false,
      jobs: [...(value?.jobs ?? [])]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((job) => ({
          id: job.id,
          type: job.type,
          state: job.state,
          detail: job.detail,
          updatedAt: job.updatedAt,
        })),
    };
  }

  private updateSoloUploadHud(value: Readonly<SoloExportControllerState>) {
    this.captureApp?.setSoloUploadStatus(soloUploadHudStatus(value));
  }

  private mountExporter() {
    this.exporter?.close();
    this.exporter = new BrowserExportAdapter();
    this.exporter.onEvent((event) => this.handleExportEvent(event));
  }

  private async restoreExportJobs(snapshot: SessionSnapshot) {
    await this.localExportDestinationLoad;
    const recoverable = [...snapshot.jobs]
      .filter((job) => job.browserRecovery)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const active = recoverable.find((job) => job.state === "queued" || job.state === "running");
    if (!active) return;
    const intent = this.exportIntentFromJob(active);
    if (!intent) {
      if (active.browserRecovery?.cancellationPending === true) {
        await this.upsertJob({
          ...active,
          state: "running",
          detail: "The retained Hugging Face cancellation identity is incomplete; recovery remains pending",
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      await this.markInterruptedExportFailed(active, "The interrupted export recovery record is incomplete");
      return;
    }
    if (intent.type === "folder") {
      if (isSoloSystemTransitionContinuation(
        this.pendingSystemTransition,
        "folder-export",
        active.id,
      )) return;
      const jobDestination = await this.localExportDestinationStore.loadFolderJob(active.id);
      if (!jobDestination) {
        await this.markInterruptedExportFailed(
          active,
          "The interrupted folder export has no verified destination. Retry the folder export",
        );
        return;
      }
      if (!await soloLocalExportFolderIdentityMatches(
        jobDestination,
        this.localExportDestination,
      )) {
        await this.markInterruptedExportFailed(
          active,
          "The selected folder does not match this interrupted export. Retry the folder export",
        );
        return;
      }
      this.localExportPermission = await soloLocalExportPermission(jobDestination);
      if (this.root) this.renderSoloExportSettings(this.root);
      if (this.localExportPermission === "granted") {
        await this.resumePersistedFolderExport(active, intent, jobDestination);
        return;
      }
      await this.upsertJob({
        ...active,
        state: "queued",
        detail: `Reconnect ${jobDestination.name} to resume this export`,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (intent.type === "export") {
      await this.resumeBrowserExport(active, intent);
      return;
    }
    await this.tryResumePendingUpload();
  }

  private async resumePersistedFolderExport(
    job: CaptureJob,
    intent: SoloExportIntent,
    destination: Extract<SoloLocalExportDestination, { type: "folder" }>,
  ) {
    const controller = this.controller;
    const exporter = this.exporter;
    if (!controller || !exporter || exporter.isRunning() || this.resumedExportJobIds.has(job.id)) return;
    this.resumedExportJobIds.add(job.id);
    try {
      await this.startPreparedFolderExport(
        job.id,
        {
          destination: "folder",
          sessionId: controller.sessionId,
          episodeIds: [...intent.episodeIds],
        },
        destination.directoryHandle,
      );
      this.showActivity(`Resuming export to ${destination.name}`, "system");
    } catch (error) {
      this.resumedExportJobIds.delete(job.id);
      await this.upsertJob({
        ...job,
        state: "failed",
        detail: errorMessage(error, "The selected-folder export could not resume"),
        updatedAt: new Date().toISOString(),
      });      throw error;
    }
  }

  private exportIntentFromJob(job: CaptureJob): SoloExportIntent | null {
    const recovery = job.browserRecovery;
    if (!recovery
      || recovery.episodeIds.length === 0
      || recovery.episodeIds.some((episodeId) => !SAFE_SOLO_ENTITY_ID_PATTERN.test(episodeId))) return null;
    if (recovery.destination === "opfs") {
      return { type: "export", episodeIds: [...recovery.episodeIds] };
    }
    if (recovery.destination === "folder") {
      return { type: "folder", episodeIds: [...recovery.episodeIds] };
    }
    if (!recovery.repository || !recovery.branch || !recovery.visibility) return null;
    if (
      recovery.uploadPrincipal !== undefined
      && (
        recovery.uploadPrincipal.trim() !== recovery.uploadPrincipal
        || recovery.uploadPrincipal.length === 0
        || recovery.uploadPrincipal.length > 256
      )
    ) return null;
    if (
      recovery.appendAllocation !== undefined
      && !isHuggingFaceAppendAllocation(recovery.appendAllocation)
    ) return null;
    return {
      type: "upload",
      episodeIds: [...recovery.episodeIds],
      repository: recovery.repository,
      branch: recovery.branch,
      visibility: recovery.visibility,
      missingRepositoryBehaviour: recovery.missingRepositoryBehaviour ?? recovery.visibility,
      ...(recovery.uploadMode ? { uploadMode: recovery.uploadMode } : {}),
      ...(recovery.uploadPrincipal ? { uploadPrincipal: recovery.uploadPrincipal } : {}),
      ...(recovery.appendAllocation
        ? { appendAllocation: { ...recovery.appendAllocation } }
        : {}),
    };
  }

  private async resumeBrowserExport(job: CaptureJob, intent: SoloExportIntent): Promise<boolean> {
    const controller = this.controller;
    const exporter = this.exporter;
    if (!controller || !exporter || exporter.isRunning() || this.resumedExportJobIds.has(job.id)) return false;
    this.resumedExportJobIds.add(job.id);
    try {
      this.lerobotExportStartedAt.set(job.id, performance.now());
      exporter.start({
        requestId: job.id,
        sessionId: controller.sessionId,
        episodes: [...controller.snapshot.episodes, ...controller.snapshot.attempts],
        episodeIds: intent.episodeIds,
        source: "solo-opfs",
        recorderRateHz: controller.snapshot.configuration.recorderRateHz,
      });
      this.exportIntents.set(job.id, intent);
      await this.upsertJob({
        ...job,
        state: "running",
        detail: "Resuming immutable artefacts from the Solo journal",
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (error) {      await this.markInterruptedExportFailed(job, errorMessage(error, "The interrupted export could not resume"));
      return false;
    }
  }

  private tryResumePendingUpload(): Promise<void> {
    if (this.pendingUploadResumeCompletion) return this.pendingUploadResumeCompletion;
    const completion = this.resumePendingUpload().catch((error) => {      this.showActivity(error, "error");
    });
    this.pendingUploadResumeCompletion = completion;
    void completion.finally(() => {
      if (this.pendingUploadResumeCompletion === completion) {
        this.pendingUploadResumeCompletion = null;
      }
    });
    return completion;
  }

  private schedulePendingUploadResume() {
    queueMicrotask(() => {
      if (this.disposed) return;
      void this.tryResumePendingUpload().finally(() => {
        this.scheduleAutomaticHuggingFaceUpload(this.controller?.snapshot ?? null);
      });
    });
  }

  private async resumePendingUpload() {
    const controller = this.controller;
    const exporter = this.exporter;
    if (
      !controller
      || !exporter
      || exporter.isRunning()
      || this.uploadController
      || this.uploadCompletion
      || this.accountUploadReconciliations.size > 0
    ) return;
    const jobs = [...controller.snapshot.jobs]
      .filter((entry) => (
        entry.type === "upload"
        && (entry.state === "queued" || entry.state === "running")
        && entry.browserRecovery?.destination === "hugging-face"
      ))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const job of jobs) {
      if (this.resumedExportJobIds.has(job.id)) continue;
      const intent = this.exportIntentFromJob(job);
      if (!intent || intent.type !== "upload" || !intent.uploadMode || !intent.uploadPrincipal) {
        if (job.browserRecovery?.cancellationPending === true) {
          await this.upsertJob({
            ...job,
            state: "running",
            detail: "The retained Hugging Face cancellation identity is incomplete; recovery remains pending",
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        await this.markInterruptedExportFailed(job, "The interrupted upload recovery record is incomplete");
        continue;
      }
      const availableAuthority = this.huggingFaceUploadAuthorityFor(intent.uploadMode);
      if (!availableAuthority || intent.uploadPrincipal !== availableAuthority.principal) {
        const detail = intent.uploadMode === "account"
          ? "Waiting for the intended CERES account to resume this upload"
          : "Waiting for the intended headset Hugging Face authorisation to resume this upload";
        if (job.state !== "queued" || job.detail !== detail) {
          await this.upsertJob({
            ...job,
            state: "queued",
            detail,
            updatedAt: new Date().toISOString(),
          });
        }
        continue;
      }
      const resolvedIntent: SoloExportIntent = {
        ...intent,
        uploadMode: intent.uploadMode,
        uploadPrincipal: intent.uploadPrincipal,
      };
      const resolvedJob: CaptureJob = {
        ...job,
        browserRecovery: {
          ...job.browserRecovery!,
          uploadMode: resolvedIntent.uploadMode,
          uploadPrincipal: resolvedIntent.uploadPrincipal,
        },
      };
      await this.upsertJob(resolvedJob);
      if (this.resumedExportJobIds.has(job.id)) continue;
      const accountUploadJobId = resolvedJob.browserRecovery?.accountUploadJobId;
      const artefacts = resolvedJob.browserRecovery?.artefacts;
      if (
        resolvedIntent.uploadMode === "account"
        && resolvedJob.browserRecovery?.cancellationPending === true
      ) {
        const account = this.accountSession;
        if (
          !account?.signedIn
          || !account.subject
          || account.huggingFace.state !== "ready"
          || !account.huggingFace.subject
        ) continue;
        const appendAllocation = resolvedJob.browserRecovery.appendAllocation;
        if (!appendAllocation || !isHuggingFaceAppendAllocation(appendAllocation) || !artefacts?.length) {
          await this.upsertJob({
            ...resolvedJob,
            state: "running",
            detail: "The exact cancelled Hugging Face upload identity is unavailable; recovery remains pending",
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        this.resumedExportJobIds.add(job.id);
        this.startAccountUploadReconciliation({
          requestId: job.id,
          accountJob: accountUploadJobId ?? null,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: controller.sessionId,
          episodeIds: resolvedIntent.episodeIds,
          cancellationPending: true,
        });
        return;
      }
      if (
        resolvedIntent.uploadMode === "account"
        && (
          Boolean(accountUploadJobId)
          || resolvedJob.browserRecovery?.cancellationPending === false
        )
      ) {
        const account = this.accountSession;
        if (
          !account?.signedIn
          || !account.subject
          || account.huggingFace.state !== "ready"
          || !account.huggingFace.subject
        ) continue;
        const appendAllocation = resolvedJob.browserRecovery?.appendAllocation;
        if (!appendAllocation || !isHuggingFaceAppendAllocation(appendAllocation) || !artefacts?.length) {
          await this.upsertJob({
            ...resolvedJob,
            state: "running",
            detail: "The exact Hugging Face upload identity is unavailable; recovery remains pending",
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        this.resumedExportJobIds.add(job.id);
        this.startAccountUploadReconciliation({
          requestId: job.id,
          accountJob: accountUploadJobId ?? null,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: controller.sessionId,
          episodeIds: resolvedIntent.episodeIds,
          cancellationPending: false,
        });
        return;
      }
      if (artefacts?.length) {
        this.resumedExportJobIds.add(job.id);
        this.exportIntents.set(job.id, resolvedIntent);
        if (this.startHuggingFaceUpload(job.id, resolvedIntent, artefacts, true)) return;
        this.resumedExportJobIds.delete(job.id);
        await this.settlePreparedUploadStartFailure(job.id);
        continue;
      }
      if (await this.resumeBrowserExport(resolvedJob, resolvedIntent)) return;
    }
  }

  private async markInterruptedExportFailed(job: CaptureJob, detail: string) {
    const episodeIds = job.browserRecovery?.episodeIds ?? [];
    const hasPreparedArtefacts = (job.browserRecovery?.artefacts?.length ?? 0) > 0;
    await this.upsertJob({
      ...job,
      state: "failed",
      detail,
      updatedAt: new Date().toISOString(),
    });
    if (job.browserRecovery?.destination === "folder") {
      await this.localExportDestinationStore.clearFolderJob(job.id).catch(() => undefined);
    }    if (job.type === "upload") {    }
    if (job.type !== "upload" || !hasPreparedArtefacts) {    }
  }

  private async setSoloAudioRecording(enabled: boolean) {
    const controller = this.controller;
    if (!controller) throw new Error("The Solo session is unavailable");
    const snapshot = controller.snapshot;
    if (snapshot.run.status === "running"
      || snapshot.run.status === "complete"
      || snapshot.run.recordingState !== "idle"
      || snapshot.currentEpisode !== null
      || snapshot.pendingEpisode !== null) {
      throw new Error("Audio recording is locked until the current run is ready for configuration");
    }
    const current = this.runDraft?.readConfiguration() ?? snapshot.configuration;
    if (snapshot.configuration.recordAudio === enabled) return;
    const configuration = { ...current, recordAudio: enabled };
    this.pendingAudioRecordingValue = enabled;
    this.queueConfiguration(configuration);
    try {
      await this.applyPendingConfiguration();
    } finally {
      const applied = controller.snapshot.configuration;
      if (applied.recordAudio === enabled) {
        const draft = this.runDraft?.readConfiguration();
        if (draft) {
          this.runDraft?.applyConfiguration({ ...draft, recordAudio: enabled });
        }
        const editorDraft = this.launchRunEditor?.readConfiguration();
        if (editorDraft) {
          this.launchRunEditor?.applyConfiguration(
            { ...editorDraft, recordAudio: enabled },
            false,
          );
        }
      } else if (this.pendingConfiguration) {
        this.pendingConfiguration = {
          ...this.pendingConfiguration,
          recordAudio: applied.recordAudio,
        };
      }
      if (this.pendingAudioRecordingValue === enabled) this.pendingAudioRecordingValue = null;
    }
  }

  private queueConfiguration(configuration: CaptureConfiguration) {
    this.pendingConfiguration = soloConfigurationWithAudioRecordingOverride(
      configuration,
      this.pendingAudioRecordingValue,
    );
    if (this.configurationTimer !== null) window.clearTimeout(this.configurationTimer);
    this.configurationTimer = window.setTimeout(() => {
      this.configurationTimer = null;
      void this.applyPendingConfiguration().catch((error) => this.showActivity(error, "error"));
    }, 250);
  }

  private async waitForStartReadiness() {
    this.startReadinessAbort?.abort();
    const request = new AbortController();
    this.startReadinessAbort = request;
    this.xrNotice = "Applying run changes and preparing capture";
    this.pushXrConsoleState();
    try {
      await this.applyPendingConfiguration();
      const controller = this.controller;
      if (!controller) throw new Error("The Solo session is unavailable");
      const status = controller.snapshot.configurationStatus;
      await waitForSoloStartReadiness(
        controller,
        {
          revision: status.revision,
          checksum: status.checksum,
        },
        { signal: request.signal },
      );
    } finally {
      if (this.startReadinessAbort === request) this.startReadinessAbort = null;
    }
  }

  private applyPendingConfiguration(): Promise<void> {
    if (this.configurationFlushPromise) {
      return this.configurationFlushPromise.then(() => (
        this.pendingConfiguration ? this.applyPendingConfiguration() : undefined
      ));
    }
    const active = this.flushPendingConfiguration().finally(() => {
      if (this.configurationFlushPromise === active) this.configurationFlushPromise = null;
    });
    this.configurationFlushPromise = active;
    return active;
  }

  private async flushPendingConfiguration() {
    const controller = this.controller;
    if (!controller) {
      if (this.pendingConfiguration) throw new Error("The Solo session is unavailable");
      return;
    }
    if (this.configurationTimer !== null) window.clearTimeout(this.configurationTimer);
    this.configurationTimer = null;
    while (this.pendingConfiguration) {
      const configuration = this.pendingConfiguration;
      this.pendingConfiguration = null;
      if (soloCaptureConfigurationAlreadyApplied(configuration, controller.snapshot)) continue;
      try {
        await controller.configure(configuration);
        this.showActivity("Run draft applied and persisted", "system");
      } catch (error) {
        this.pendingConfiguration ??= configuration;
        this.showActivity(error, "error");
        throw error;
      }
    }
  }

  private clearImportSelection() {
    this.selectedImportSampleId = null;
    this.selectedImportCandidateId = null;
  }

  private async handleRunControl(action: string) {
    const controller = this.controller;
    if (!controller) return;
    try {
      if (action === "cancel-countdown") {
        await controller.cancelCountdown();
        return;
      }
      const cursorAction = action === "next" ? "next-task" : action;
      const cursor = isStateBoundRunControlAction(cursorAction)
        ? nextRunControlCursor(controller.snapshot, cursorAction)
        : undefined;
      await controller.control(action as DirectRunControlAction, cursor);
    } catch (error) {
      this.showActivity(error, "error");
    }
  }

  private renderSnapshot(snapshot: SessionSnapshot) {
    const root = this.root;
    if (!root) return;
    root.dataset.recordingState = snapshot.run.recordingState;
    root.dataset.runStatus = snapshot.run.status;
    root.dataset.countdownActive = String(snapshot.solo?.startCountdownDeadlineMs != null);
    root.dataset.countdownDeadlineMs = snapshot.solo?.startCountdownDeadlineMs == null
      ? ""
      : String(snapshot.solo.startCountdownDeadlineMs);
    root.dataset.episodeCount = String(snapshot.episodes.length);
    root.dataset.attemptCount = String(snapshot.attempts.length);
    root.dataset.configurationRevision = String(snapshot.configurationStatus.revision);    this.completeSystemTransitionIfReady(snapshot);

    const configurationLocked = snapshot.run.status === "running"
      || snapshot.run.recordingState !== "idle";
    this.runDraft?.setLocked(configurationLocked);
    this.runDraft?.setSelectedStartTask(snapshot.solo?.selectedStartTaskId ?? null);
    this.exportController?.updateSession(snapshot);
    this.scheduleAutomaticHuggingFaceUpload(snapshot);
    this.scheduleAutomaticLocalExport(snapshot);
    this.pushXrConsoleState(snapshot);
    this.renderSoloProvisioning(root);
    this.updatePostAcquisitionQuality(root, snapshot);
  }





  private updatePostAcquisitionQuality(root: HTMLElement, snapshot: SessionSnapshot) {
    const window = soloPostAcquisitionQualityWindowForSnapshot(snapshot);
    if (!window) {
      this.clearPostAcquisitionQuality(root);
      return;
    }
    const runEpisodes = soloPostAcquisitionRunEpisodes(snapshot)
      .filter((candidate) => candidate.integrity === "valid"
        && candidate.endedAt !== undefined
        && (candidate.recorderSlotCount ?? 0) > 0);
    if (runEpisodes.length === 0) {
      this.clearPostAcquisitionQuality(root);
      return;
    }
    const presentationKey = soloRunQualityPresentationKey(snapshot, runEpisodes);
    if (this.postAcquisitionPresentationKey === presentationKey && this.postAcquisitionResult) return;
    if (this.postAcquisitionLoadKey === presentationKey) return;
    this.abortPostAcquisitionLoads();
    this.postAcquisitionLoadKey = presentationKey;
    this.postAcquisitionPresentationKey = "";
    this.postAcquisitionResult = null;
    root.dataset.postAcquisitionQualityState = "loading";
    this.captureApp?.clearSoloPostAcquisitionQuality();
    const abort = new AbortController();
    this.postAcquisitionLoadAbort = abort;
    void this.loadPostAcquisitionQuality({
      sessionId: snapshot.sessionId,
      recorderRateHz: snapshot.configuration.recorderRateHz,
      storageRoot: SOLO_RUN_QUALITY_STORAGE_ROOT,
      episodes: runEpisodes,
    }, abort.signal).then((result) => {
      if (this.disposed
        || abort.signal.aborted
        || this.root !== root
        || this.postAcquisitionLoadKey !== presentationKey) return;
      this.postAcquisitionResult = result;
      this.postAcquisitionPresentationKey = presentationKey;
      root.dataset.postAcquisitionQualityState = "ready";
      this.captureApp?.presentSoloPostAcquisitionQuality({
        key: presentationKey,
        result,
      });
    }).catch((error) => {
      if (abort.signal.aborted || this.disposed || this.root !== root) return;
      root.dataset.postAcquisitionQualityState = "error";
      this.showActivity(errorMessage(error, "Post-acquisition quality could not be read"), "error");
    }).finally(() => {
      if (this.postAcquisitionLoadAbort === abort) this.postAcquisitionLoadAbort = null;
    });
  }

  private async loadPostAcquisitionQuality(
    options: SoloRunQualityLoadOptions,
    signal: AbortSignal,
  ) {
    let finalError: unknown = new Error("Post-acquisition quality could not be read");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) throw new DOMException("Solo run quality analysis was cancelled", "AbortError");
      try {
        this.postAcquisitionQualityService ??= new SoloRunQualityService();
        return await this.postAcquisitionQualityService.load(options, signal);
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        finalError = error;
        this.postAcquisitionQualityService?.close();
        this.postAcquisitionQualityService = null;
        if (attempt === 0) await postAcquisitionRetryDelay(signal);
      }
    }
    throw finalError;
  }

  private clearPostAcquisitionQuality(root: HTMLElement) {
    if (this.postAcquisitionLoadKey === ""
      && this.postAcquisitionPresentationKey === ""
      && this.postAcquisitionResult === null) return;
    this.abortPostAcquisitionLoads();
    this.postAcquisitionPresentationKey = "";
    this.postAcquisitionResult = null;
    root.dataset.postAcquisitionQualityState = "idle";
    this.captureApp?.clearSoloPostAcquisitionQuality();
  }

  private abortPostAcquisitionLoads() {
    this.postAcquisitionLoadAbort?.abort();
    this.postAcquisitionLoadAbort = null;
    this.postAcquisitionQualityService?.cancel();
    this.postAcquisitionLoadKey = "";
  }

  private async startExport(intent: SoloExportIntent) {
    const controller = this.controller;
    const exporter = this.exporter;
    if (!controller || !exporter) return;
    if (exporter.isRunning() || this.uploadController || this.uploadCompletion) {
      this.showActivity("An export or upload is already active", "error");
      return;
    }
    let requestId: string | null = null;
    let deliveryCreatedAt: string | null = null;
    let exportStarted = false;
    let resolvedIntent = intent;
    try {
      const episodes = [...controller.snapshot.episodes, ...controller.snapshot.attempts]
        .filter((episode) => intent.episodeIds.includes(episode.id));
      if (episodes.length === 0) throw new Error("Select at least one exportable episode");
      requestId = crypto.randomUUID();
      deliveryCreatedAt = new Date().toISOString();
      if (intent.type === "upload") {
        const authority = this.availableHuggingFaceUploadAuthority();
        if (!authority) throw new Error("Sign in to Hugging Face before starting a sync");
        if (
          (intent.uploadMode && intent.uploadMode !== authority.mode)
          || (intent.uploadPrincipal && intent.uploadPrincipal !== authority.principal)
        ) {
          throw new Error("The Hugging Face authority for this upload is no longer active");
        }
        resolvedIntent = {
          ...this.requireCurrentVerifiedUploadIntent(intent),
          uploadMode: intent.uploadMode ?? authority.mode,
          uploadPrincipal: intent.uploadPrincipal ?? authority.principal,
        };
        if (!resolvedIntent.repository || !resolvedIntent.branch || !resolvedIntent.visibility) {
          throw new Error("Set the Hugging Face repository, branch and visibility in Solo XR");
        }
        const allocationAbort = new AbortController();
        const allocationTimeout = window.setTimeout(() => allocationAbort.abort(
          new DOMException("Hugging Face destination inspection timed out", "TimeoutError"),
        ), SOLO_REPOSITORY_REQUEST_TIMEOUT_MS);
        try {
          const allocation = await this.revalidateUploadDestination(
            resolvedIntent,
            resolvedIntent.uploadMode!,
            allocationAbort.signal,
          );
          resolvedIntent = {
            ...resolvedIntent,
            appendAllocation: allocation.append,
          };
        } finally {
          window.clearTimeout(allocationTimeout);
        }
      }
      const createdAt = deliveryCreatedAt;
      await this.upsertJob({
        id: requestId,
        type: intent.type === "upload" ? "upload" : "export",
        state: "queued",
        detail: intent.type === "upload"
          ? "Preparing immutable artefacts for Hugging Face"
          : "Preparing LeRobot v3 artefacts",
        createdAt,
        updatedAt: createdAt,
        browserRecovery: {
          destination: intent.type === "upload" ? "hugging-face" : "opfs",
          episodeIds: [...intent.episodeIds],
          ...(resolvedIntent.repository ? { repository: resolvedIntent.repository } : {}),
          ...(resolvedIntent.branch ? { branch: resolvedIntent.branch } : {}),
          ...(resolvedIntent.visibility ? { visibility: resolvedIntent.visibility } : {}),
          ...(resolvedIntent.missingRepositoryBehaviour
            ? { missingRepositoryBehaviour: resolvedIntent.missingRepositoryBehaviour }
            : {}),
          ...(resolvedIntent.uploadMode ? { uploadMode: resolvedIntent.uploadMode } : {}),
          ...(resolvedIntent.uploadPrincipal
            ? { uploadPrincipal: resolvedIntent.uploadPrincipal }
            : {}),
          ...(resolvedIntent.appendAllocation
            ? { appendAllocation: { ...resolvedIntent.appendAllocation } }
            : {}),
        },
      });      if (intent.type === "upload") {      }
      this.lerobotExportStartedAt.set(requestId, performance.now());
      exporter.start({
        requestId,
        sessionId: controller.sessionId,
        episodes: [...controller.snapshot.episodes, ...controller.snapshot.attempts],
        episodeIds: resolvedIntent.episodeIds,
        source: "solo-opfs",
        recorderRateHz: controller.snapshot.configuration.recorderRateHz,
        ...(resolvedIntent.appendAllocation
          ? {
              episodeIndexBase: resolvedIntent.appendAllocation.nextEpisodeIndex,
              globalFrameIndexBase: resolvedIntent.appendAllocation.nextGlobalFrameIndex,
            }
          : {}),
      });
      exportStarted = true;
      this.exportIntents.set(requestId, resolvedIntent);
      if (intent.type === "upload") {      }
      this.showActivity(intent.type === "upload" ? "Hugging Face sync queued" : "Local export queued", "system");
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      if (!cancelled) {      }
      if (!requestId) {
        if (!cancelled) this.showActivity(error, "error");
        return;
      }
      const lerobotElapsedMs = this.finishLerobotExportTiming(requestId);
      const deliveryElapsedMs = deliveryCreatedAt
        ? Math.max(0, Date.now() - Date.parse(deliveryCreatedAt))
        : null;
      const timingOutcome = cancelled
        ? "cancelled"
        : error instanceof DOMException && error.name === "TimeoutError" ? "timed_out" : "failed";
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === requestId);
      await this.upsertJob({
        ...existing,
        id: requestId,
        type: intent.type === "upload" ? "upload" : "export",
        state: cancelled ? "cancelled" : "failed",
        detail: cancelled
          ? "Browser export cancelled before it started"
          : errorMessage(error, "Browser export could not start"),
        createdAt: deliveryCreatedAt ?? this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      });
      if (lerobotElapsedMs !== null) {      }
      if (intent.type === "upload") {      }
      if (!exportStarted) {      }
      if (!cancelled) this.showActivity(error, "error");
    }
  }

  private scheduleAutomaticHuggingFaceUpload(snapshot: SessionSnapshot | null) {
    if (!snapshot || this.exportDestination !== "hugging-face") {
      this.automaticUploadKey = null;
      return;
    }
    if (
      !this.exportController
      || !this.exporter
      || this.exportController.snapshot.active.busy
      || this.exporter.isRunning()
      || this.uploadController
      || this.uploadCompletion
      || !this.availableHuggingFaceUploadAuthority()
      || this.repositoryDestinationValidation.state !== "ready"
      || this.repositoryDestinationValidation.result === null
    ) return;
    const episodeIds = soloAutomaticUploadEpisodeIds(snapshot, this.huggingFaceSaveCadence);
    const key = soloAutomaticUploadKey(snapshot, this.huggingFaceSaveCadence, episodeIds);
    if (!key) {
      this.automaticUploadKey = null;
      return;
    }
    if (key === this.automaticUploadKey) return;
    this.automaticUploadKey = key;
    queueMicrotask(() => {
      if (this.disposed || this.automaticUploadKey !== key) return;
      if (
        !this.exporter
        || this.exportController?.snapshot.active.busy
        || this.exporter.isRunning()
        || this.uploadController
        || this.uploadCompletion
      ) {
        if (this.automaticUploadKey === key) this.automaticUploadKey = null;
        return;
      }
      void this.exportController?.startEpisodes("hugging-face", episodeIds).catch((error) => {
        if (this.automaticUploadKey === key) this.automaticUploadKey = null;        this.showActivity(error, "error");
      });
    });
  }

  private scheduleAutomaticLocalExport(snapshot: SessionSnapshot | null) {
    if (
      !snapshot
      || this.exportDestination !== "local"
      || !this.localExportDestinationLoaded
      || (
        this.localExportDestination.type === "folder"
        && this.localExportPermission !== "granted"
      )
    ) {
      this.automaticLocalExportKey = null;
      return;
    }
    if (
      !this.exportController
      || !this.exporter
      || this.exportController.snapshot.active.busy
      || this.exporter.isRunning()
      || this.uploadController
      || this.uploadCompletion
    ) return;
    const episodeIds = soloAutomaticLocalExportEpisodeIds(snapshot);
    const destination = this.localExportDestination;
    const key = soloAutomaticLocalExportKey(snapshot, destination, episodeIds);
    if (!key) {
      this.automaticLocalExportKey = null;
      return;
    }
    if (key === this.automaticLocalExportKey) return;
    this.automaticLocalExportKey = key;
    queueMicrotask(() => {
      if (
        this.disposed
        || this.automaticLocalExportKey !== key
        || this.exportDestination !== "local"
      ) return;
      if (
        !this.exporter
        || this.exportController?.snapshot.active.busy
        || this.exporter.isRunning()
        || this.uploadController
        || this.uploadCompletion
      ) {
        if (this.automaticLocalExportKey === key) this.automaticLocalExportKey = null;
        return;
      }
      const completion = destination.type === "folder"
        ? this.startAutomaticFolderExport(episodeIds, destination)
        : this.exportController?.startEpisodes("opfs", episodeIds);
      void completion?.catch((error) => {
        if (this.automaticLocalExportKey === key) this.automaticLocalExportKey = null;        this.showActivity(error, "error");
      });
    });
  }

  private async startAutomaticFolderExport(
    episodeIds: readonly string[],
    destination: Extract<SoloLocalExportDestination, { type: "folder" }>,
  ) {
    const controller = this.controller;
    if (!controller || !this.exporter) throw new Error("Solo folder export is unavailable");
    const permission = await soloLocalExportPermission(destination);
    this.localExportPermission = permission;
    if (permission !== "granted") {
      if (this.root) this.renderSoloExportSettings(this.root);
      throw new Error(`Reconnect ${destination.name} before finishing another run`);
    }
    const request: SoloExportRequest = {
      destination: "folder",
      sessionId: controller.sessionId,
      episodeIds: [...episodeIds],
    };
    const requestId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const recovery = {
      destination: "folder" as const,
      episodeIds: [...episodeIds],
    };
    try {
      await this.localExportDestinationStore.bindFolderJob(requestId, destination);
      await this.upsertJob({
        id: requestId,
        type: "export",
        state: "queued",
        detail: `Preparing LeRobot v3 artefacts for ${destination.name}`,
        createdAt,
        updatedAt: createdAt,
        browserRecovery: recovery,
      });      await this.startPreparedFolderExport(
        requestId,
        request,
        destination.directoryHandle,
      );
    } catch (error) {
      await this.localExportDestinationStore.clearFolderJob(requestId).catch(() => undefined);
      await this.upsertJob({
        id: requestId,
        type: "export",
        state: "failed",
        detail: errorMessage(error, "The selected-folder export could not start"),
        createdAt,
        updatedAt: new Date().toISOString(),
        browserRecovery: recovery,
      });      throw error;
    }
  }

  private async handleExportEvent(event: MonitorExportWorkerEvent) {
    const cancellationWasPosted = this.cancelledLerobotExportRequestIds.has(event.requestId);
    if (cancellationWasPosted && event.type !== "complete" && event.type !== "error") return;
    const intent = this.exportIntents.get(event.requestId);
    if (!intent) return;
    if (cancellationWasPosted && event.type === "complete" && intent.type === "upload") {
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === event.requestId);
      const lerobotElapsedMs = this.finishLerobotExportTiming(event.requestId);
      const deliveryElapsedMs = this.jobElapsedMs(event.requestId);
      await this.upsertJob({
        ...existing,
        id: event.requestId,
        type: "upload",
        state: "cancelled",
        detail: "Hugging Face sync cancelled after immutable artefacts were prepared",
        createdAt: this.jobCreatedAt(event.requestId),
        updatedAt: new Date().toISOString(),
        browserRecovery: {
          ...existing?.browserRecovery,
          destination: "hugging-face",
          episodeIds: [...intent.episodeIds],
          repository: intent.repository!,
          branch: intent.branch!,
          visibility: intent.visibility!,
          missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility!,
          ...(intent.uploadMode ? { uploadMode: intent.uploadMode } : {}),
          ...(intent.uploadPrincipal ? { uploadPrincipal: intent.uploadPrincipal } : {}),
          ...(intent.appendAllocation
            ? { appendAllocation: { ...intent.appendAllocation } }
            : {}),
          artefacts: [...event.artefacts],
        },
      });
      this.cancelledLerobotExportRequestIds.delete(event.requestId);
      this.exportIntents.delete(event.requestId);
      this.resumedExportJobIds.delete(event.requestId);
      this.exportController?.updateProgress(null);      this.schedulePendingUploadResume();
      return;
    }
    if (event.type === "media-profile") { return; }
    if (event.type === "progress") {
      if (intent.type === "upload") {      }
      const total = Math.max(1, event.total);
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === event.requestId);
      this.exportController?.updateProgress({
        jobId: event.requestId,
        completed: event.completed,
        total,
        detail: event.detail,
        stage: event.stage === "uploading" ? "uploading" : "preparing",
      });
      await this.upsertJob({
        ...existing,
        id: event.requestId,
        type: intent.type === "upload" ? "upload" : "export",
        state: "running",
        detail: event.detail,
        createdAt: this.jobCreatedAt(event.requestId),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (event.type === "error") {
      const failure = soloExportWorkerFailurePresentation(event);
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === event.requestId);
      const timingOutcome = event.cancelled
        ? "cancelled"
        : event.errorType === "ExportInactivityError" ? "timed_out" : "failed";
      const lerobotElapsedMs = this.finishLerobotExportTiming(event.requestId);
      const deliveryElapsedMs = this.jobElapsedMs(event.requestId);
      await this.upsertJob({
        ...existing,
        id: event.requestId,
        type: intent.type === "upload" ? "upload" : "export",
        state: event.cancelled ? "cancelled" : "failed",
        detail: failure.detail,
        createdAt: this.jobCreatedAt(event.requestId),
        updatedAt: new Date().toISOString(),
      });
      if (cancellationWasPosted) {
        this.cancelledLerobotExportRequestIds.delete(event.requestId);
      }
      this.exportIntents.delete(event.requestId);
      this.resumedExportJobIds.delete(event.requestId);
      this.exportController?.updateProgress(null);
      if (intent.type === "folder") {
        await this.localExportDestinationStore.clearFolderJob(event.requestId).catch(() => undefined);
      }      if (intent.type === "upload") {      }      if (intent.type === "upload") {      }
      if (!event.cancelled) {        const diagnosticError = event.errorTelemetry
          ? workerErrorFromDetail(event.errorTelemetry)
          : Object.assign(new Error(failure.detail), { name: failure.errorType });        this.showActivity(failure.detail, "error");
      }
      this.schedulePendingUploadResume();
      return;
    }
    const lerobotElapsedMs = this.finishLerobotExportTiming(event.requestId);
    if (intent.type !== "upload") {
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === event.requestId);
      await this.upsertJob({
        ...existing,
        id: event.requestId,
        type: "export",
        state: "completed",
        detail: `${event.episodeCount} episodes and ${event.artifactCount} artefacts written`,
        createdAt: this.jobCreatedAt(event.requestId),
        updatedAt: new Date().toISOString(),
      });
      if (cancellationWasPosted) {
        this.cancelledLerobotExportRequestIds.delete(event.requestId);
      }
      this.exportIntents.delete(event.requestId);
      this.exportController?.updateProgress(null);
      if (intent.type === "folder") {
        await this.localExportDestinationStore.clearFolderJob(event.requestId).catch(() => undefined);
      }      this.showActivity("LeRobot v3 export complete", "system");
      return;
    }
    const availableAuthority = intent.uploadMode
      ? this.huggingFaceUploadAuthorityFor(intent.uploadMode)
      : null;
    const authorityMatches = Boolean(
      intent.uploadMode
      && intent.uploadPrincipal
      && availableAuthority?.mode === intent.uploadMode
      && availableAuthority.principal === intent.uploadPrincipal,
    );
    const uploadMode = authorityMatches ? intent.uploadMode! : null;
    const uploadIntent: SoloExportIntent = {
      ...intent,
      ...(uploadMode ? { uploadMode } : {}),
    };
    const existing = this.controller?.snapshot.jobs.find((job) => job.id === event.requestId);
    const initialDetail = uploadMode === "account"
      ? "Immutable artefacts are ready for account-authorised upload"
      : uploadMode === "headset"
        ? "Immutable artefacts are ready for headset-authorised upload"
        : "Immutable artefacts are waiting for Hugging Face authorisation";
    await this.upsertJob({
      id: event.requestId,
      type: "upload",
      state: "running",
      detail: soloUploadProgressDetail(event.artefacts, initialDetail),
      createdAt: this.jobCreatedAt(event.requestId),
      updatedAt: new Date().toISOString(),
      browserRecovery: {
        ...existing?.browserRecovery,
        destination: "hugging-face",
        episodeIds: [...intent.episodeIds],
        repository: intent.repository!,
        branch: intent.branch!,
        visibility: intent.visibility!,
        missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility!,
        ...(intent.uploadMode ? { uploadMode: intent.uploadMode } : {}),
        ...(intent.uploadPrincipal ? { uploadPrincipal: intent.uploadPrincipal } : {}),
        artefacts: [...event.artefacts],
      },
    });    if (!uploadMode) {
      await this.settlePreparedUploadStartFailure(event.requestId);
      this.schedulePendingUploadResume();
      return;
    }
    this.exportIntents.set(event.requestId, uploadIntent);
    if (!this.startHuggingFaceUpload(
      event.requestId,
      uploadIntent,
      event.artefacts,
      this.restoredExportJobIds.has(event.requestId),
    )) {
      this.resumedExportJobIds.delete(event.requestId);
      await this.settlePreparedUploadStartFailure(event.requestId, false);
      this.schedulePendingUploadResume();
    }
  }

  private async settlePreparedUploadStartFailure(requestId: string, reportFailure = true) {
    const currentJob = this.controller?.snapshot.jobs.find((job) => job.id === requestId);
    const episodeIds = this.exportIntents.get(requestId)?.episodeIds
      ?? currentJob?.browserRecovery?.episodeIds
      ?? [];
    if (reportFailure) {    }
    await this.upsertJob({
      id: requestId,
      type: "upload",
      state: "failed",
      detail: SOLO_PREPARED_UPLOAD_START_FAILURE,
      createdAt: this.jobCreatedAt(requestId),
      updatedAt: new Date().toISOString(),
    });
    this.exportIntents.delete(requestId);
    this.resumedExportJobIds.delete(requestId);
    this.exportController?.updateProgress(null);    this.showActivity(SOLO_PREPARED_UPLOAD_START_FAILURE, "error");
  }

  private startHuggingFaceUpload(
    requestId: string,
    intent: SoloExportIntent,
    artefacts: AccountUploadManifestArtefact[],
    recovered = false,
  ) {
    let verifiedIntent = intent;
    if (!recovered) {
      try {
        verifiedIntent = this.requireCurrentVerifiedUploadIntent(intent);
      } catch (error) {        return false;
      }
    }
    const authority = intent.uploadMode
      ? this.huggingFaceUploadAuthorityFor(intent.uploadMode)
      : null;
    if (
      !authority
      || !intent.uploadMode
      || !intent.uploadPrincipal
      || intent.uploadPrincipal !== authority.principal
    ) {      return false;
    }
    if (this.uploadController || this.uploadCompletion) {
      const stateError = new Error("A Hugging Face upload is already running");
      stateError.name = "InvalidStateError";      return false;
    }
    const uploadMode = intent.uploadMode;
    const completion = uploadMode === "account"
      ? this.startAccountUpload(requestId, verifiedIntent, artefacts)
      : this.startHeadsetUpload(requestId, verifiedIntent, artefacts);    this.uploadMode = uploadMode;
    this.uploadCompletion = completion;
    void completion.finally(() => {
      if (this.uploadCompletion === completion) {
        this.uploadCompletion = null;
        this.uploadMode = null;
        if (this.root) this.renderSoloProvisioning(this.root);
        this.schedulePendingUploadResume();
      }
    });
    return true;
  }

  private async revalidateUploadDestination(
    intent: SoloExportIntent,
    mode: "account" | "headset",
    signal: AbortSignal,
  ) {
    if (!intent.repository || !intent.visibility) {
      throw new Error("The Hugging Face upload destination is incomplete");
    }
    const [organisation = "", repository = "", ...remainder] = intent.repository.split("/");
    if (remainder.length > 0) {
      throw new Error("The Hugging Face upload destination is invalid");
    }
    const destination = normaliseSoloHuggingFaceDestination({
      organisation,
      repository,
      branch: intent.branch ?? "",
      visibility: intent.visibility,
      missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
    });
    let result: AccountExportDestinationValidation | null;
    if (mode === "account") {
      result = await this.accountClient.validateDestination({
        organisation: destination.organisation,
        repository: destination.repository,
        branch: destination.branch,
        visibility: destination.visibility,
        missingRepositoryBehaviour: destination.missingRepositoryBehaviour,
      }, signal);
    } else if (this.soloHuggingFaceCredential) {
      const owners = await loadSoloHuggingFaceOwners(
        this.soloHuggingFaceCredential,
        signal,
      );
      result = await validateSoloHuggingFaceDestination(
        this.soloHuggingFaceCredential,
        new Set(owners),
        destination,
        signal,
      );
    } else {
      result = null;
    }
    if (
      !result
      || result.version !== 1
      || result.repository !== destination.resolved
      || result.branch !== destination.branch
      || result.visibility !== destination.visibility
      || (result.availability !== "existing" && result.availability !== "creatable")
      || !isHuggingFaceAppendAllocation(result.append)
      || (
        intent.appendAllocation !== undefined
        && !sameHuggingFaceAppendAllocation(intent.appendAllocation, result.append)
      )
    ) {
      throw new Error("The Hugging Face destination changed after it was reviewed");
    }
    return result;
  }

  private async startAccountUpload(
    requestId: string,
    intent: SoloExportIntent,
    artefacts: AccountUploadManifestArtefact[],
  ) {
    const controller = this.controller;
    const account = this.accountSession;
    if (
      !controller
      || !account?.signedIn
      || !account.subject
      || !account.huggingFace.subject
      || account.huggingFace.state !== "ready"
      || !intent.repository
      || !intent.branch
      || !intent.visibility
    ) {      await this.upsertJob({
        id: requestId,
        type: "upload",
        state: "failed",
        detail: "The CERES account authorisation changed before the upload began",
        createdAt: this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      });      this.exportController?.updateProgress(null);
      return;
    }
    const authenticationEpoch = this.authenticationEpoch;
    const abort = new AbortController();
    let retainedAppendAllocation = intent.appendAllocation
      ? { ...intent.appendAllocation }
      : null;
    let authoritativeCompletedJob: AccountUploadJob | null = null;
    this.uploadController = abort;
    try {
      const destination = await this.revalidateUploadDestination(intent, "account", abort.signal);
      retainedAppendAllocation = { ...destination.append };
      assertSoloUploadArtefactAllocation(artefacts, destination.append);
      const workerResult = await runSoloUploadInWorker({
        mode: "account",
        expectedAccountSubject: account.subject,
        expectedHuggingFaceSubject: account.huggingFace.subject,
        sessionId: controller.sessionId,
        repository: destination.repository,
        branch: intent.branch,
        visibility: destination.visibility,
        missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
        appendAllocation: destination.append,
        episodeIds: [...intent.episodeIds],
        artefacts,
        signal: abort.signal,
        onProgress: (completed, total, detail, stage) => {
          const progressDetail = soloUploadProgressDetail(artefacts, detail);
          if (abort.signal.aborted) return;
          const presentationStage = soloUploadPresentationStage(stage);          if (total > 0 && completed <= total) {
            this.exportController?.updateProgress({
              jobId: requestId,
              completed,
              total,
              detail: progressDetail,
              stage: presentationStage,
            });
          }
          void this.upsertJob({
            id: requestId,
            type: "upload",
            state: "running",
            detail: progressDetail,
            createdAt: this.jobCreatedAt(requestId),
            updatedAt: new Date().toISOString(),
            ...(controller.snapshot.jobs.find((job) => job.id === requestId)?.browserRecovery
              ? {
                  browserRecovery: controller.snapshot.jobs.find((job) => job.id === requestId)!
                    .browserRecovery,
                }
              : {}),
          });
        },
      });
      if (workerResult.mode !== "account") {
        throw new Error("The background account upload returned an invalid result");
      }
      const accountJob = workerResult.job;
      if (
        accountJob.accountSubject !== account.subject
        || accountJob.huggingFaceSubject !== account.huggingFace.subject
      ) {
        throw new Error("The Hugging Face upload authority changed while the upload was running");
      }
      if (accountJob.status === "completed") authoritativeCompletedJob = accountJob;
      if (accountJob.status === "finalising") {        const existing = controller.snapshot.jobs.find((job) => job.id === requestId);
        await this.upsertJob({
          id: requestId,
          type: "upload",
          state: "running",
          detail: "Hugging Face finalisation is continuing in the background",
          createdAt: this.jobCreatedAt(requestId),
          updatedAt: new Date().toISOString(),
          browserRecovery: {
            ...existing?.browserRecovery,
            destination: "hugging-face",
            episodeIds: [...intent.episodeIds],
            repository: destination.repository,
            branch: intent.branch,
            visibility: destination.visibility,
            missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
            uploadMode: "account",
            uploadPrincipal: intent.uploadPrincipal,
            accountUploadJobId: accountJob.id,
            appendAllocation: { ...destination.append },
            artefacts: [...artefacts],
          },
        });
        this.exportController?.updateProgress(null);
        this.exportIntents.delete(requestId);
        this.resumedExportJobIds.add(requestId);
        this.startAccountUploadReconciliation({
          requestId,
          accountJob,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: controller.sessionId,
          episodeIds: intent.episodeIds,
          cancellationPending: false,
        });
        this.showActivity(
          "Hugging Face finalisation is continuing in the background",
          "system",
        );
        return;
      }
      const currentAccount = this.accountSession;
      if (
        this.authenticationEpoch !== authenticationEpoch
        || this.accountDisconnecting
        || !currentAccount?.signedIn
        || currentAccount.subject !== account.subject
        || currentAccount.huggingFace.state !== "ready"
        || currentAccount.huggingFace.subject !== account.huggingFace.subject
      ) {
        throw new Error("The Hugging Face upload authority changed before completion was recorded");
      }
      const upload = verifiedEpisodeUploadFromAccountJob(
        accountJob,
        controller.sessionId,
        intent.episodeIds,
      );
      await controller.recordEpisodeUpload(intent.episodeIds, upload);
      await this.upsertJob({
        id: requestId,
        type: "upload",
        state: "completed",
        detail: soloUploadCompletionDetail(artefacts, upload.commitOid),
        createdAt: this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      }, true);      this.exportController?.updateProgress(null);
      if (this.authenticationEpoch === authenticationEpoch) {
        this.showActivity(
          `${soloUploadCompletionDetail(artefacts, upload.commitOid)} for ${account.huggingFace.username ?? "account"}`,
          "system",
        );
      }
      this.exportIntents.delete(requestId);
    } catch (error) {
      if (authoritativeCompletedJob) {
        const existing = controller.snapshot.jobs.find((job) => job.id === requestId);
        await this.upsertJob({
          id: requestId,
          type: "upload",
          state: "running",
          detail: "Hugging Face completed; CERES is retrying local completion persistence",
          createdAt: this.jobCreatedAt(requestId),
          updatedAt: new Date().toISOString(),
          browserRecovery: {
            ...existing?.browserRecovery,
            destination: "hugging-face",
            episodeIds: [...intent.episodeIds],
            repository: intent.repository,
            branch: intent.branch,
            visibility: intent.visibility,
            missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
            uploadMode: "account",
            uploadPrincipal: intent.uploadPrincipal,
            accountUploadJobId: authoritativeCompletedJob.id,
            ...(retainedAppendAllocation
              ? { appendAllocation: { ...retainedAppendAllocation } }
              : {}),
            artefacts: [...artefacts],
          },
        });
        this.exportIntents.delete(requestId);
        this.exportController?.updateProgress(null);
        this.resumedExportJobIds.add(requestId);
        this.startAccountUploadReconciliation({
          requestId,
          accountJob: authoritativeCompletedJob,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: controller.sessionId,
          episodeIds: intent.episodeIds,
          cancellationPending: false,
        });
        this.showActivity(
          "Hugging Face completed. CERES is retrying the local completion record.",
          "system",
        );
        return;
      }
      const cancellationUnconfirmed = error instanceof SoloUploadCancellationUnconfirmedError;
      if (cancellationUnconfirmed) {
        const existing = controller.snapshot.jobs.find((job) => job.id === requestId);
        await this.upsertJob({
          id: requestId,
          type: "upload",
          state: "running",
          detail: error.message,
          createdAt: this.jobCreatedAt(requestId),
          updatedAt: new Date().toISOString(),
          browserRecovery: {
            ...existing?.browserRecovery,
            destination: "hugging-face",
            episodeIds: [...intent.episodeIds],
            repository: intent.repository,
            branch: intent.branch,
            visibility: intent.visibility,
            missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
            uploadMode: "account",
            uploadPrincipal: intent.uploadPrincipal,
            ...(error.jobId ? { accountUploadJobId: error.jobId } : {}),
            ...(retainedAppendAllocation
              ? { appendAllocation: { ...retainedAppendAllocation } }
              : {}),
            cancellationPending: true,
            artefacts: [...artefacts],
          },
        });
        this.exportIntents.delete(requestId);
        this.exportController?.updateProgress(null);
        this.resumedExportJobIds.delete(requestId);
        this.resumedExportJobIds.add(requestId);
        this.startAccountUploadReconciliation({
          requestId,
          accountJob: error.jobId,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: controller.sessionId,
          episodeIds: intent.episodeIds,
          cancellationPending: true,
        });
        this.showActivity(
          "Hugging Face cancellation was not confirmed. CERES is reconciling the existing backend upload before reporting an outcome.",
          "system",
        );
        return;
      }
      const outcomeUnconfirmed = error instanceof SoloUploadOutcomeUnconfirmedError;
      if (outcomeUnconfirmed) {
        const existing = controller.snapshot.jobs.find((job) => job.id === requestId);
        await this.upsertJob({
          id: requestId,
          type: "upload",
          state: "running",
          detail: error.message,
          createdAt: this.jobCreatedAt(requestId),
          updatedAt: new Date().toISOString(),
          browserRecovery: {
            ...existing?.browserRecovery,
            destination: "hugging-face",
            episodeIds: [...intent.episodeIds],
            repository: intent.repository,
            branch: intent.branch,
            visibility: intent.visibility,
            missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
            uploadMode: "account",
            uploadPrincipal: intent.uploadPrincipal,
            ...(error.jobId ? { accountUploadJobId: error.jobId } : {}),
            ...(retainedAppendAllocation
              ? { appendAllocation: { ...retainedAppendAllocation } }
              : {}),
            cancellationPending: false,
            artefacts: [...artefacts],
          },
        });
        this.exportIntents.delete(requestId);
        this.exportController?.updateProgress(null);
        this.resumedExportJobIds.delete(requestId);
        this.resumedExportJobIds.add(requestId);
        this.startAccountUploadReconciliation({
          requestId,
          accountJob: error.jobId,
          accountSubject: account.subject,
          huggingFaceSubject: account.huggingFace.subject,
          sessionId: controller.sessionId,
          episodeIds: intent.episodeIds,
          cancellationPending: false,
        });
        this.showActivity(
          "The background upload response was lost. CERES is reconciling the existing backend upload before reporting an outcome.",
          "system",
        );
        return;
      }
      const cancelled = abort.signal.aborted;
      if (!cancelled) {      }
      const message = cancelled
        ? "Hugging Face sync cancelled"
        : soloHuggingFaceUploadErrorMessage(error);
      await this.upsertJob({
        id: requestId,
        type: "upload",
        state: cancelled ? "cancelled" : "failed",
        detail: message,
        createdAt: this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      }, cancelled);      this.exportController?.updateProgress(null);
      if (!cancelled) this.showActivity(message, "error");
    } finally {
      if (this.uploadController === abort) this.uploadController = null;
    }
  }

  private startAccountUploadReconciliation(input: SoloAccountUploadReconciliationInput) {
    if (this.accountUploadReconciliations.has(input.requestId)) return;
    const abort = new AbortController();
    this.accountUploadReconciliations.set(input.requestId, abort);
    void this.reconcileAccountUpload(input, abort.signal)
      .catch((error) => {
        if (!abort.signal.aborted && !this.disposed) {        }
        this.resumedExportJobIds.delete(input.requestId);
      })
      .finally(() => {
        if (this.accountUploadReconciliations.get(input.requestId) === abort) {
          this.accountUploadReconciliations.delete(input.requestId);
        }
        const state = this.controller?.snapshot.jobs.find(({ id }) => id === input.requestId)?.state;
        if (state === "completed" || state === "failed" || state === "cancelled") {
          this.schedulePendingUploadResume();
        }
      });
  }

  private async reconcileAccountUpload(
    input: SoloAccountUploadReconciliationInput,
    signal: AbortSignal,
  ) {
    try {
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === input.requestId);
      const cancellationPending = input.cancellationPending
        || existing?.browserRecovery?.cancellationPending === true;
      let accountJob = typeof input.accountJob === "string"
        ? await this.accountClient.uploadStatus(input.accountJob, signal)
        : input.accountJob;
      if (!accountJob) {
        try {
          accountJob = await this.reacquireAccountUpload(input, cancellationPending, signal);
        } catch (error) {
          if (!(error instanceof AccountExportRequestError) || error.status !== 404) throw error;
          const retainedJob = this.controller?.snapshot.jobs.find(
            (job) => job.id === input.requestId,
          ) ?? existing;
          await this.upsertJob({
            ...(retainedJob ?? {
              id: input.requestId,
              type: "upload" as const,
              createdAt: this.jobCreatedAt(input.requestId),
            }),
            state: "running",
            detail: cancellationPending
              ? "Hugging Face upload identity is not visible yet; cancellation remains pending"
              : "Hugging Face upload identity is not visible yet; recovery will retry automatically",
            updatedAt: new Date().toISOString(),
            ...(retainedJob?.browserRecovery
              ? {
                  browserRecovery: {
                    ...retainedJob.browserRecovery,
                    cancellationPending,
                  },
                }
              : {}),
          });
          this.scheduleAccountUploadRecoveryRetry(input.requestId);
          return;
        }
      }
      this.assertAccountUploadRecoveryIdentity(accountJob, input, true);
      if (
        cancellationPending
        && (
          accountJob.status === "pending"
          || accountJob.status === "preparing"
          || accountJob.status === "uploading"
        )
      ) {
        accountJob = await this.cancelAccountUploadForRecovery(accountJob, signal);
      }
      if (accountJob.status === "finalising") {        accountJob = await this.accountClient.reconcileUpload(accountJob, signal);
      }
      signal.throwIfAborted();
      this.assertAccountUploadRecoveryIdentity(accountJob, input, true);
      if (accountJob.status === "completed") {
        const controller = this.controller;
        if (!controller || controller.sessionId !== input.sessionId) return;
        const upload = verifiedEpisodeUploadFromAccountJob(
          accountJob,
          input.sessionId,
          input.episodeIds,
        );
        const existing = controller.snapshot.jobs.find((job) => job.id === input.requestId);
        const artefacts = existing?.browserRecovery?.artefacts ?? [];
        await controller.recordEpisodeUpload(input.episodeIds, upload);
        await this.upsertJob({
          id: input.requestId,
          type: "upload",
          state: "completed",
          detail: soloUploadCompletionDetail(artefacts, upload.commitOid),
          createdAt: this.jobCreatedAt(input.requestId),
          updatedAt: new Date().toISOString(),
        }, true);        this.exportController?.updateProgress(null);
        const currentAccount = this.accountSession;
        if (
          currentAccount?.signedIn
          && currentAccount.subject === input.accountSubject
          && currentAccount.huggingFace.state === "ready"
          && currentAccount.huggingFace.subject === input.huggingFaceSubject
        ) {
          this.showActivity(
            `${soloUploadCompletionDetail(artefacts, upload.commitOid)} for ${currentAccount.huggingFace.username ?? "account"}`,
            "system",
          );
        }
        return;
      }
      if (accountJob.status === "failed" || accountJob.status === "cancelled") {
        const cancelled = accountJob.status === "cancelled";
        const detail = cancelled
          ? "Hugging Face upload cancelled"
          : accountJob.error || "Hugging Face background finalisation failed";
        await this.upsertJob({
          id: input.requestId,
          type: "upload",
          state: cancelled ? "cancelled" : "failed",
          detail,
          createdAt: this.jobCreatedAt(input.requestId),
          updatedAt: new Date().toISOString(),
        }, true);        this.exportController?.updateProgress(null);
        if (!cancelled) {          this.showActivity(detail, "error");
        }
        return;
      }
      const currentJob = this.controller?.snapshot.jobs.find((job) => job.id === input.requestId);
      await this.upsertJob({
        ...(currentJob ?? {
          id: input.requestId,
          type: "upload" as const,
          createdAt: this.jobCreatedAt(input.requestId),
        }),
        state: "running",
        detail: "The existing Hugging Face backend upload remains recoverable",
        updatedAt: new Date().toISOString(),
      });
      this.scheduleAccountUploadRecoveryRetry(input.requestId);
    } catch (error) {
      if (signal.aborted || this.disposed) return;      const invalidResponse = error instanceof AccountUploadInvalidResponseError;
      const detail = invalidResponse
        ? "The account upload response was invalid; recovery will retry automatically"
        : error instanceof AccountUploadCancellationUnconfirmedError
          ? error.message
          : "Background finalisation status is unavailable; recovery will resume automatically";
      const existing = this.controller?.snapshot.jobs.find((job) => job.id === input.requestId);
      await this.upsertJob({
        ...(existing ?? {
          id: input.requestId,
          type: "upload" as const,
          createdAt: this.jobCreatedAt(input.requestId),
        }),
        state: "running",
        detail,
        updatedAt: new Date().toISOString(),
        ...(existing?.browserRecovery
          ? {
              browserRecovery: {
                ...existing.browserRecovery,
                ...(error instanceof AccountUploadCancellationUnconfirmedError && error.jobId
                  ? { accountUploadJobId: error.jobId }
                  : {}),
              },
            }
          : {}),
      });
      this.scheduleAccountUploadRecoveryRetry(input.requestId);
    }
  }

  private async reacquireAccountUpload(
    input: SoloAccountUploadReconciliationInput,
    cancellationPending: boolean,
    signal: AbortSignal,
  ) {
    const existing = this.controller?.snapshot.jobs.find((job) => job.id === input.requestId);
    const recovery = existing?.browserRecovery;
    if (
      !recovery
      || recovery.destination !== "hugging-face"
      || recovery.uploadMode !== "account"
      || !recovery.repository
      || !recovery.branch
      || !recovery.visibility
      || !recovery.artefacts?.length
      || !recovery.appendAllocation
      || !isHuggingFaceAppendAllocation(recovery.appendAllocation)
    ) {
      throw new Error("The retained account cancellation identity is incomplete");
    }
    const created = await this.accountClient.reacquireUpload({
      expectedAccountSubject: input.accountSubject,
      expectedHuggingFaceSubject: input.huggingFaceSubject,
      captureSessionId: input.sessionId,
      repository: recovery.repository,
      branch: recovery.branch,
      visibility: recovery.visibility,
      missingRepositoryBehaviour: recovery.missingRepositoryBehaviour ?? recovery.visibility,
      appendAllocation: recovery.appendAllocation,
      episodeIds: [...input.episodeIds],
      artefacts: [...recovery.artefacts].sort((left, right) => left.path.localeCompare(right.path)),
    }, signal);
    this.assertAccountUploadRecoveryIdentity(created.job, input, true);
    await this.upsertJob({
      ...existing,
      state: "running",
      detail: cancellationPending
        ? "Hugging Face upload identity reacquired; confirming cancellation"
        : "Hugging Face upload identity reacquired; checking its authoritative status",
      updatedAt: new Date().toISOString(),
      browserRecovery: {
        ...recovery,
        accountUploadJobId: created.job.id,
        cancellationPending,
      },
    });
    return created.job;
  }

  private assertAccountUploadRecoveryIdentity(
    accountJob: AccountUploadJob,
    input: SoloAccountUploadReconciliationInput,
    requireRetainedIdentity: boolean,
  ) {
    const recovery = this.controller?.snapshot.jobs.find((job) => job.id === input.requestId)
      ?.browserRecovery;
    const expectedJobId = typeof input.accountJob === "string"
      ? input.accountJob
      : input.accountJob?.id;
    if (
      (expectedJobId !== undefined && accountJob.id !== expectedJobId)
      || accountJob.accountSubject !== input.accountSubject
      || accountJob.huggingFaceSubject !== input.huggingFaceSubject
      || accountJob.captureSessionId !== input.sessionId
      || !sameAccountUploadEpisodeIds(accountJob.episodeIds, input.episodeIds)
    ) {
      throw new Error("The background Hugging Face upload identity changed");
    }
    if (!requireRetainedIdentity) return;
    if (
      !recovery
      || recovery.destination !== "hugging-face"
      || recovery.uploadMode !== "account"
      || !recovery.repository
      || !recovery.branch
      || !recovery.visibility
      || !recovery.appendAllocation
      || !isHuggingFaceAppendAllocation(recovery.appendAllocation)
      || !recovery.artefacts?.length
      || accountJob.repository !== recovery.repository
      || accountJob.branch !== recovery.branch
      || accountJob.visibility !== recovery.visibility
      || accountJob.missingRepositoryBehaviour !== (
        recovery.missingRepositoryBehaviour ?? recovery.visibility
      )
      || !matchesRetainedHuggingFaceAppendAllocation(
        accountJob.appendAllocation,
        recovery.appendAllocation,
      )
    ) {
      throw new Error("The retained account cancellation identity does not match the backend job");
    }
    const expectedArtefacts = [...recovery.artefacts]
      .sort((left, right) => left.path.localeCompare(right.path));
    const actualArtefacts = [...accountJob.artefacts]
      .sort((left, right) => left.path.localeCompare(right.path));
    if (
      actualArtefacts.length !== expectedArtefacts.length
      || actualArtefacts.some((artefact, index) => {
        const expected = expectedArtefacts[index];
        return !expected
          || artefact.path !== expected.path
          || artefact.sha256 !== expected.sha256
          || artefact.byteLength !== expected.byteLength
          || artefact.mediaType !== expected.mediaType;
      })
    ) {
      throw new Error("The retained account cancellation manifest does not match the backend job");
    }
  }

  private async cancelAccountUploadForRecovery(
    accountJob: AccountUploadJob,
    signal: AbortSignal,
  ) {
    try {
      const response = await this.accountClient.cancelUpload(accountJob.id, signal);
      if (response.job.id !== accountJob.id || response.job.status !== "cancelled") {
        throw new AccountUploadCancellationUnconfirmedError(
          accountJob.id,
          new Error("The backend did not acknowledge the upload as cancelled"),
        );
      }
      return response.job;
    } catch (error) {
      if (!(error instanceof AccountExportRequestError) || error.status !== 409) throw error;
      const racedJob = await this.accountClient.uploadStatus(accountJob.id, signal);
      if (racedJob.id !== accountJob.id) {
        throw new Error("The account service returned a different Hugging Face upload job");
      }
      if (
        racedJob.status === "pending"
        || racedJob.status === "preparing"
        || racedJob.status === "uploading"
      ) {
        throw new AccountUploadCancellationUnconfirmedError(accountJob.id, error);
      }
      return racedJob;
    }
  }

  private scheduleAccountUploadRecoveryRetry(requestId: string) {
    this.resumedExportJobIds.delete(requestId);
    window.setTimeout(() => {
      if (!this.disposed) this.schedulePendingUploadResume();
    }, SOLO_UPLOAD_RECOVERY_RETRY_MS);
  }

  private async startHeadsetUpload(
    requestId: string,
    intent: SoloExportIntent,
    artefacts: AccountUploadManifestArtefact[],
  ) {
    const controller = this.controller;
    const credential = this.soloHuggingFaceCredential;
    if (!controller || !credential || !intent.repository || !intent.branch || !intent.visibility) {      await this.upsertJob({
        id: requestId,
        type: "upload",
        state: "failed",
        detail: "The headset authorisation changed before the upload began",
        createdAt: this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      });      this.exportController?.updateProgress(null);
      return;
    }
    const authenticationEpoch = this.authenticationEpoch;
    const abort = new AbortController();
    this.uploadController = abort;
    try {
      const destination = await this.revalidateUploadDestination(intent, "headset", abort.signal);
      assertSoloUploadArtefactAllocation(artefacts, destination.append);
      const workerResult = await runSoloUploadInWorker({
        mode: "headset",
        credential,
        sessionId: controller.sessionId,
        repository: destination.repository,
        branch: intent.branch,
        visibility: destination.visibility,
        missingRepositoryBehaviour: intent.missingRepositoryBehaviour ?? intent.visibility,
        appendAllocation: destination.append,
        episodeIds: [...intent.episodeIds],
        artefacts,
        signal: abort.signal,
        onProgress: (completed, total, detail, stage) => {
          const progressDetail = soloUploadProgressDetail(artefacts, detail);
          if (abort.signal.aborted || this.authenticationEpoch !== authenticationEpoch) return;
          if (total > 0 && completed <= total) {
            this.exportController?.updateProgress({
              jobId: requestId,
              completed,
              total,
              detail: progressDetail,
              stage: soloUploadPresentationStage(stage),
            });
          }
          void this.upsertJob({
            id: requestId,
            type: "upload",
            state: "running",
            detail: progressDetail,
            createdAt: this.jobCreatedAt(requestId),
            updatedAt: new Date().toISOString(),
          });
        },
      });
      if (workerResult.mode !== "headset") {
        throw new Error("The background headset upload returned an invalid result");
      }
      const result = workerResult.result;
      await this.upsertJob({
        id: requestId,
        type: "upload",
        state: "completed",
        detail: soloUploadCompletionDetail(artefacts, result.commitOid),
        createdAt: this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      });      this.exportController?.updateProgress(null);
      if (this.authenticationEpoch === authenticationEpoch) {
        this.showActivity(
          `${soloUploadCompletionDetail(artefacts, result.commitOid)} for ${credential.username}`,
          "system",
        );
      }
      this.exportIntents.delete(requestId);
    } catch (error) {
      const cancelled = abort.signal.aborted;
      if (!cancelled) {      }
      const message = cancelled ? "Hugging Face sync cancelled" : soloHuggingFaceUploadErrorMessage(error);
      await this.upsertJob({
        id: requestId,
        type: "upload",
        state: cancelled ? "cancelled" : "failed",
        detail: message,
        createdAt: this.jobCreatedAt(requestId),
        updatedAt: new Date().toISOString(),
      });      this.exportController?.updateProgress(null);
      if (!cancelled) this.showActivity(message, "error");
    } finally {
      if (this.uploadController === abort) this.uploadController = null;
    }
  }

  private async upsertJob(job: CaptureJob, clearBrowserRecovery = false) {
    const existing = this.controller?.snapshot.jobs.find((entry) => entry.id === job.id);
    await this.controller?.upsertJob({
      ...existing,
      ...job,
      browserRecovery: clearBrowserRecovery
        ? undefined
        : job.browserRecovery ?? existing?.browserRecovery,
    });
  }





  private finishLerobotExportTiming(requestId: string) {
    const startedAt = this.lerobotExportStartedAt.get(requestId);
    this.lerobotExportStartedAt.delete(requestId);
    return startedAt === undefined ? null : Math.max(0, performance.now() - startedAt);
  }

  private jobElapsedMs(jobId: string) {
    const createdAt = this.controller?.snapshot.jobs.find((job) => job.id === jobId)?.createdAt;
    if (!createdAt) return null;
    const startedAt = Date.parse(createdAt);
    return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
  }

  private jobCreatedAt(jobId: string) {
    return this.controller?.snapshot.jobs.find((job) => job.id === jobId)?.createdAt
      ?? new Date().toISOString();
  }

  private async checkCapabilities(root: HTMLElement) {
    const storageManager = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    };
    const mediaDevices = navigator.mediaDevices as (MediaDevices & {
      getUserMedia?: MediaDevices["getUserMedia"];
    }) | undefined;
    const opfsAvailable = typeof storageManager?.getDirectory === "function";
    const mediaCaptureAvailable = typeof mediaDevices?.getUserMedia === "function";
    const capabilities: SoloCapability[] = [
      {
        id: "secure",
        label: "Secure context",
        state: window.isSecureContext ? "ready" : "blocked",
        detail: window.isSecureContext ? "HTTPS or trusted local origin" : "Open Solo over HTTPS",
      },
      {
        id: "opfs",
        label: "Durable storage",
        state: opfsAvailable ? "checking" : "blocked",
        detail: opfsAvailable ? "Checking OPFS write access" : "OPFS is unavailable",
      },
      {
        id: "storage",
        label: "Storage headroom",
        state: "checking",
        detail: "Calculating available capacity",
      },
      {
        id: "camera",
        label: "Camera capability",
        state: mediaCaptureAvailable ? "ready" : "blocked",
        detail: mediaCaptureAvailable ? "Permission requested when enabled" : "Media capture is unavailable",
      },
      {
        id: "microphone",
        label: "Microphone capability",
        state: mediaCaptureAvailable ? "ready" : "blocked",
        detail: mediaCaptureAvailable ? "Raw audio remains available without speech services" : "Audio capture is unavailable",
      },
      {
        id: "xr",
        label: "WebXR",
        state: navigator.xr ? "checking" : "blocked",
        detail: navigator.xr ? "Checking immersive AR support" : "WebXR is unavailable",
      },
    ];
    this.renderCapabilities(root, capabilities);
    try {
      if (!storageManager.getDirectory) throw new Error("OPFS is unavailable");
      const directory = await storageManager.getDirectory();
      const handle = await directory.getFileHandle(".ceres-solo-launch-probe", { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      await writable.write(new Uint8Array([0x43, 0x45, 0x52, 0x45, 0x53]));
      await writable.close();
      const verified = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      await directory.removeEntry(".ceres-solo-launch-probe");
      const opfs = capabilities.find((capability) => capability.id === "opfs")!;
      opfs.state = verified.length === 5 ? "ready" : "blocked";
      opfs.detail = verified.length === 5 ? "Write, commit and read-back verified" : "OPFS read-back failed";
    } catch (error) {
      const opfs = capabilities.find((capability) => capability.id === "opfs")!;
      opfs.state = "blocked";
      opfs.detail = errorMessage(error, "OPFS durability check failed");
    }
    const storageHeadroom = await checkSoloStorageHeadroom(storageManager);
    const storage = capabilities.find((capability) => capability.id === "storage")!;
    storage.state = storageHeadroom.state === "ready" ? "ready" : "blocked";
    storage.detail = storageHeadroom.detail;
    if (navigator.xr) {
      try {
        const supported = await navigator.xr.isSessionSupported("immersive-ar");
        const xr = capabilities.find((capability) => capability.id === "xr")!;
        xr.state = supported ? "ready" : "blocked";
        xr.detail = supported ? "Immersive AR available" : "Immersive AR is not supported";
      } catch (error) {
        const xr = capabilities.find((capability) => capability.id === "xr")!;
        xr.state = "blocked";
        xr.detail = errorMessage(error, "WebXR check failed");
      }
    }
    this.renderCapabilities(root, capabilities);
  }

  private renderCapabilities(root: HTMLElement, capabilities: SoloCapability[]) {
    root.querySelector<HTMLElement>("#solo-capabilities")!.innerHTML = capabilities.map((capability) => `
      <li class="is-${capability.state}">
        <span>${escapeHtml(capability.label)}</span>
        <b>${capability.state.toUpperCase()}</b>
        <small>${escapeHtml(capability.detail)}</small>
      </li>
    `).join("");
  }

  private async refreshAccountSession(
    root: HTMLElement,
    requestedAuthenticationEpoch?: number,
  ) {
    if (this.authenticationSignOutInProgress && requestedAuthenticationEpoch === undefined) return;
    const authenticationEpoch = requestedAuthenticationEpoch
      ?? this.invalidateSoloAuthentication();
    if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
    await this.soloOauthCompletion;
    if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
    const headsetCredential = loadSoloHuggingFaceCredential(
      SOLO_HEADSET_CREDENTIAL_LOAD_TIMEOUT_MS,
    );
    this.accountSession = null;
    this.accountSessionChecked = false;
    this.accountUnavailable = false;
    this.renderSoloHuggingFaceBackgroundCheck(root);
    this.exportController?.updateAccount(null, "checking");
    const headsetCredentialRefresh = this.refreshSoloHuggingFaceCredential(
      root,
      authenticationEpoch,
      headsetCredential,
    );
    let session: AccountExportSession | null = null;
    let unavailable = false;
    const accountAbort = new AbortController();
    const accountTimeout = window.setTimeout(() => {
      accountAbort.abort(new DOMException("CERES account session timed out", "TimeoutError"));
    }, SOLO_ACCOUNT_SESSION_TIMEOUT_MS);
    try {
      session = await this.accountClient.session(accountAbort.signal);
    } catch {
      unavailable = true;
    } finally {
      window.clearTimeout(accountTimeout);
    }
    if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
    this.accountSession = session;
    this.accountUnavailable = unavailable;
    this.accountSessionChecked = true;
    this.exportController?.updateAccount(
      this.accountSession,
      this.accountUnavailable ? "unavailable" : this.accountSession ? "available" : "checking",
    );
    const accountReady = Boolean(
      this.accountSession?.signedIn
      && this.accountSession.huggingFace.state === "ready"
    );
    if (accountReady) {
      this.renderSoloHuggingFaceCredentialState(root, {
        status: "account-ready",
        username: this.accountSession?.huggingFace.username ?? "CERES account",
      });
      this.renderSoloExportSettings(root);
      this.markHuggingFaceOauthSystemTransitionReady();
      this.pushXrConsoleState();
    }
    const headsetCredentialState = await headsetCredentialRefresh;
    if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
    if (!accountReady) {
      if (headsetCredentialState === "invalid") {
        this.showActivity(
          "Stored Hugging Face authorisation is no longer usable. Sign in again.",
          "error",
        );
        this.renderSoloHuggingFaceCredentialState(root, { status: "invalid" });
      } else if (headsetCredentialState === "transient") {
        this.showActivity(
          "Stored Hugging Face authorisation could not be verified. Try again.",
          "error",
        );
        this.renderSoloHuggingFaceCredentialState(root, { status: "transient" });
      } else if (headsetCredentialState === "none") {
        this.renderSoloHuggingFaceCredentialState(root, { status: "none" });
      } else if (headsetCredentialState === "unavailable") {
        this.renderSoloHuggingFaceCredentialState(root, { status: "unavailable" });
      }
    }
    this.renderSoloExportSettings(root);
    this.markHuggingFaceOauthSystemTransitionReady();
    this.pushXrConsoleState();
    void this.tryResumePendingUpload();
  }

  private async completeSoloHuggingFaceOauth(
    root: HTMLElement,
    authenticationEpoch: number,
  ) {
    const current = new URL(location.href);
    const hasOauthReturn = current.searchParams.has("code") || current.searchParams.has("state");
    try {
      const credential = await completeSoloHuggingFaceOauth();
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      if (credential) {
        this.oauthReturnState = "connected";
        this.showActivity(`Hugging Face authorised for ${credential.username}`, "system");
      }
    } catch (error) {
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      if (hasOauthReturn) this.oauthReturnState = "failed";
      this.showActivity(error instanceof Error ? error.message : "Hugging Face authorisation failed", "error");
    } finally {
      if (!this.disposed && this.root === root) {
        this.oauthCallbackInFlight = false;
        this.renderSystemTransition();
      }
    }
  }

  private async beginSoloHuggingFaceOauth(root: HTMLElement) {
    if (this.authenticationSignOutInProgress) return;
    this.huggingFaceActionBusy = true;
    this.huggingFaceActionBusyText = "Opening Hugging Face";
    this.renderSoloHuggingFaceProcessing(root);
    const action = root.querySelector<HTMLButtonElement>("#solo-hf-action");
    if (action) {
      action.disabled = true;
      action.textContent = "Opening Hugging Face";
    }
    this.invalidateSoloAuthentication();
    try {
      await beginSoloHuggingFaceOauth(location.href);
    } catch (error) {
      this.showActivity(error instanceof Error ? error.message : "Hugging Face authorisation could not start", "error");
      await this.refreshAccountSession(root);
    }
  }

  private async logoutSoloHuggingFace(root: HTMLElement) {
    if (this.authenticationSignOutInProgress) return;
    this.authenticationSignOutInProgress = true;
    const logout = root.querySelector<HTMLButtonElement>("#solo-hf-logout");
    if (logout) logout.disabled = true;
    const uploadCompletion = this.uploadMode === "headset"
      ? this.uploadCompletion
      : null;
    const authenticationEpoch = this.invalidateSoloAuthentication();
    try {
      await this.settleUploadForSignOut(uploadCompletion);
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      await this.soloOauthCompletion;
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      await deleteSoloHuggingFaceCredential();
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      this.renderSoloHuggingFaceCredentialState(root, { status: "none" });
      this.showActivity("Hugging Face logged out on this headset", "system");
    } catch {
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      this.renderSoloHuggingFaceCredentialState(root, { status: "logout-failed" });
      this.showActivity("Hugging Face could not be logged out on this headset. Try again.", "error");
    } finally {
      this.authenticationSignOutInProgress = false;
      if (logout && this.authenticationIsCurrent(authenticationEpoch, root)) logout.disabled = false;
    }
  }

  private async signOutSoloHuggingFace(root: HTMLElement) {
    if (
      this.accountSession?.signedIn
      && this.accountSession.huggingFace.state === "ready"
    ) {
      await this.disconnectSoloHuggingFaceAccount(root);
      return;
    }
    await this.logoutSoloHuggingFace(root);
  }

  private async disconnectSoloHuggingFaceAccount(root: HTMLElement) {
    if (this.authenticationSignOutInProgress) return;
    this.authenticationSignOutInProgress = true;
    const logout = root.querySelector<HTMLButtonElement>("#solo-hf-logout");
    if (logout) logout.disabled = true;
    this.accountDisconnecting = true;
    const uploadCompletion = this.uploadMode === "account"
      ? this.uploadCompletion
      : null;
    if (this.uploadMode === "account") this.uploadController?.abort();
    const authenticationEpoch = this.invalidateSoloAuthentication();
    try {
      await this.settleUploadForSignOut(uploadCompletion);
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      const disconnectAbort = new AbortController();
      const disconnectTimeout = window.setTimeout(() => {
        disconnectAbort.abort(new DOMException("Hugging Face disconnect timed out", "TimeoutError"));
      }, SOLO_ACCOUNT_SESSION_TIMEOUT_MS);
      try {
        await this.accountClient.disconnectHuggingFace(disconnectAbort.signal);
      } finally {
        window.clearTimeout(disconnectTimeout);
      }
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      await this.refreshAccountSession(root, authenticationEpoch);
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      this.showActivity("Hugging Face disconnected from your CERES account", "system");
    } catch {
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      this.showActivity("Hugging Face could not be disconnected from your CERES account. Try again.", "error");
    } finally {
      this.accountDisconnecting = false;
      this.authenticationSignOutInProgress = false;
      if (logout && this.authenticationIsCurrent(authenticationEpoch, root)) logout.disabled = false;
    }
  }

  private async refreshSoloHuggingFaceCredential(
    root: HTMLElement,
    authenticationEpoch: number,
    headsetCredential: Promise<SoloHuggingFaceCredential | null>,
  ) {
    const state = root.querySelector<HTMLElement>("#solo-hf-state");
    const action = root.querySelector<HTMLButtonElement>("#solo-hf-action");
    const logout = root.querySelector<HTMLButtonElement>("#solo-hf-logout");
    if (!state || !action || !logout) return;
    this.huggingFaceActionBusy = false;
    this.renderSoloHuggingFaceProcessing(root);
    action.disabled = false;
    action.hidden = false;
    logout.hidden = true;
    action.textContent = "Sign in to Hugging Face";
    const accountReady = () => Boolean(
      this.accountSessionChecked
      && this.accountSession?.signedIn
      && this.accountSession.huggingFace.state === "ready",
    );
    try {
      const credential = await headsetCredential;
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      if (credential) {
        const verification = await verifySoloHuggingFaceCredential(
          credential,
          undefined,
          { timeoutMs: SOLO_HEADSET_CREDENTIAL_VERIFY_TIMEOUT_MS },
        );
        if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
        if (verification.status === "invalid") {
          await deleteSoloHuggingFaceCredential();
          if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
          return "invalid" as const;
        }
        if (verification.status === "transient") {
          return "transient" as const;
        }
        this.soloHuggingFaceCredential = verification.credential;
        this.soloHuggingFaceSubject = verification.subject;
        this.exportController?.updateHeadsetHuggingFaceAccount(
          verification.credential.username,
        );
        if (!accountReady()) {
          this.renderSoloHuggingFaceCredentialState(root, {
            status: "ready",
            username: verification.credential.username,
          });
        }
        this.markHuggingFaceOauthSystemTransitionReady();
        this.pushXrConsoleState();
        return "ready" as const;
      }
      return "none" as const;
    } catch {
      if (!this.authenticationIsCurrent(authenticationEpoch, root)) return;
      this.soloHuggingFaceCredential = null;
      this.soloHuggingFaceSubject = null;
      this.exportController?.updateHeadsetHuggingFaceAccount(null);
      return "unavailable" as const;
    } finally {
      if (this.authenticationIsCurrent(authenticationEpoch, root)) {
        this.huggingFaceActionBusy = false;
        action.disabled = false;
        this.renderSoloExportSettings(root);
      }
    }
  }

  private renderSoloHuggingFaceBackgroundCheck(root: HTMLElement) {
    const state = root.querySelector<HTMLElement>("#solo-hf-state");
    const action = root.querySelector<HTMLButtonElement>("#solo-hf-action");
    const logout = root.querySelector<HTMLButtonElement>("#solo-hf-logout");
    if (!state || !action || !logout) return;
    this.huggingFaceActionBusy = false;
    state.textContent = "Checking for an existing authorisation in the background.";
    state.className = "solo-account-state";
    action.hidden = false;
    action.disabled = false;
    action.textContent = "Sign in to Hugging Face";
    logout.hidden = true;
    this.renderSoloHuggingFaceProcessing(root);
  }

  private invalidateSoloAuthentication() {
    this.authenticationEpoch += 1;
    if (this.uploadMode === "headset") this.uploadController?.abort();
    this.repositoryCatalogueAbort?.abort();
    this.repositoryCatalogueAbort = null;
    this.invalidateSoloRepositoryDestination();
    this.soloHuggingFaceCredential = null;
    this.soloHuggingFaceSubject = null;
    this.exportController?.updateHeadsetHuggingFaceAccount(null);
    return this.authenticationEpoch;
  }

  private availableHuggingFaceUploadMode(): "account" | "headset" | null {
    return this.availableHuggingFaceUploadAuthority()?.mode ?? null;
  }

  private huggingFaceUploadAuthorities(): SoloHuggingFaceUploadAuthority[] {
    const authorities: SoloHuggingFaceUploadAuthority[] = [];
    if (this.soloHuggingFaceCredential && this.soloHuggingFaceSubject) {
      authorities.push({
        mode: "headset",
        principal: `headset:${this.soloHuggingFaceSubject}`,
      });
    }
    const accountSubject = this.accountSession?.subject?.trim();
    const accountHuggingFaceSubject = this.accountSession?.huggingFace.subject?.trim();
    if (
      this.accountSessionChecked
      && !this.accountDisconnecting
      && !this.accountUnavailable
      && this.accountSession?.signedIn
      && this.accountSession.huggingFace.state === "ready"
      && accountSubject
      && accountHuggingFaceSubject
    ) {
      authorities.push({
        mode: "account",
        principal: `account:${accountSubject}:${accountHuggingFaceSubject}`,
      });
    }
    return authorities;
  }

  private huggingFaceUploadAuthorityFor(mode: "account" | "headset") {
    return soloHuggingFaceUploadAuthorityForMode(
      mode,
      this.huggingFaceUploadAuthorities(),
    );
  }

  private availableHuggingFaceUploadAuthority(): SoloHuggingFaceUploadAuthority | null {
    const authorities = this.huggingFaceUploadAuthorities();
    return soloHuggingFaceUploadAuthorityForMode("account", authorities)
      ?? soloHuggingFaceUploadAuthorityForMode("headset", authorities);
  }

  private authenticationIsCurrent(authenticationEpoch: number, root: HTMLElement) {
    return !this.disposed
      && this.root === root
      && this.authenticationEpoch === authenticationEpoch;
  }

  private renderSoloHuggingFaceCredentialState(
    root: HTMLElement,
    presentation:
      | { status: "none" | "invalid" | "transient" | "unavailable" | "logout-failed" }
      | { status: "ready" | "account-ready"; username: string },
  ) {
    const state = root.querySelector<HTMLElement>("#solo-hf-state");
    const action = root.querySelector<HTMLButtonElement>("#solo-hf-action");
    const logout = root.querySelector<HTMLButtonElement>("#solo-hf-logout");
    if (!state || !action || !logout) return;
    this.huggingFaceActionBusy = false;
    action.disabled = false;
    this.renderSoloHuggingFaceProcessing(root);
    action.hidden = false;
    logout.hidden = true;
    logout.disabled = false;
    if (presentation.status === "ready" || presentation.status === "account-ready") {
      state.textContent = presentation.username;
      state.className = "solo-account-state is-ready";
      action.hidden = true;
      logout.hidden = false;
      return;
    }
    if (presentation.status === "invalid") {
      state.textContent = "Stored Hugging Face authorisation is no longer usable. Sign in again.";
      state.className = "solo-account-state is-warning";
      action.textContent = "Sign in to Hugging Face";
      return;
    }
    if (presentation.status === "transient") {
      state.textContent = "Stored Hugging Face authorisation could not be verified. Try again.";
      state.className = "solo-account-state is-warning";
      action.textContent = "Reauthorise Hugging Face";
      logout.hidden = false;
      return;
    }
    if (presentation.status === "unavailable") {
      state.textContent = "Hugging Face authorisation is unavailable in this browser.";
      state.className = "solo-account-state is-warning";
      action.textContent = "Retry Hugging Face sign-in";
      return;
    }
    if (presentation.status === "logout-failed") {
      state.textContent = "Hugging Face could not be logged out on this headset. Try again.";
      state.className = "solo-account-state is-warning";
      action.hidden = true;
      logout.hidden = false;
      return;
    }
    state.textContent = "Authorise Hugging Face only on this headset.";
    state.className = "solo-account-state";
    action.textContent = "Sign in to Hugging Face";
  }

  private async settleUploadForSignOut(uploadCompletion: Promise<void> | null) {
    if (!uploadCompletion) return;
    let timeout: number | null = null;
    await Promise.race([
      uploadCompletion.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = window.setTimeout(resolve, 5_000);
      }),
    ]);
    if (timeout !== null) window.clearTimeout(timeout);
  }

  private markHuggingFaceOauthSystemTransitionReady() {
    const pending = this.pendingSystemTransition;
    if (
      !pending
      || pending.kind !== "hf-oauth"
      || pending.phase !== "outside-xr"
      || this.availableHuggingFaceUploadAuthority() === null
    ) return;
    this.pendingSystemTransition = requireSoloSystemTransitionXrReentry(pending);
    persistSoloSystemTransition(localStorage, this.pendingSystemTransition);
    this.renderSystemTransition();
  }

  private soloOauthReturnPath() {
    const sessionId = this.controller?.sessionId
      ?? new URL(location.href).searchParams.get("session");
    const url = new URL("/launch/capture/", location.origin);
    url.searchParams.set("mode", "solo");
    if (sessionId && SOLO_SESSION_ID_PATTERN.test(sessionId)) {
      url.searchParams.set("session", sessionId);
    }
    return `${url.pathname}${url.search}`;
  }

  private clearSoloOauthReturnMarker() {
    this.oauthReturnState = null;
    const url = new URL(location.href);
    url.searchParams.delete("export");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  private renderResumeOffer(root: HTMLElement) {
    const sessionId = this.rememberedSoloSession();
    const button = root.querySelector<HTMLButtonElement>("#solo-resume-session")!;
    button.hidden = !sessionId;
    button.dataset.sessionId = sessionId ?? "";
    root.querySelector<HTMLElement>("#solo-resume-detail")!.textContent = sessionId
      ? `Resume ${sessionId}`
      : "No interrupted Solo session was found";
  }

  private rememberedSoloSession() {
    try {
      const stored = localStorage.getItem(SOLO_ACTIVE_SESSION_STORAGE_KEY);
      return stored && SOLO_SESSION_ID_PATTERN.test(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  private setActiveSession(sessionId: string) {
    rememberSoloSession(sessionId);
    const url = new URL("/launch/capture/", location.origin);
    url.searchParams.set("mode", "solo");
    url.searchParams.set("session", sessionId);
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  private navigateToSoloSession(sessionId: string) {
    if (!SOLO_SESSION_ID_PATTERN.test(sessionId)) return;
    const snapshot = this.controller?.snapshot;
    if (snapshot && (snapshot.run.status === "running" || snapshot.run.recordingState !== "idle")) {
      this.showActivity("Finish the active Solo run before changing session", "error");
      return;
    }
    const url = new URL("/launch/capture/", location.origin);
    url.searchParams.set("mode", "solo");
    url.searchParams.set("session", sessionId);
    location.assign(`${url.pathname}${url.search}`);
  }

  private setLaunchState(root: HTMLElement, message: string, state: "idle" | "busy" | "ready" | "error") {
    const node = root.querySelector<HTMLElement>("#solo-launch-state")!;
    node.textContent = message;
    node.className = `solo-launch-state is-${state}`;
  }

  private showActivity(error: unknown, tone: "system" | "error") {
    const message = typeof error === "string" ? error : errorMessage(error, "Solo operation failed");
    if (tone === "error") {
      this.xrNotice = message;
      this.pushXrConsoleState();
    }
    const node = this.root?.querySelector<HTMLElement>("#solo-activity");
    if (!node) return;
    node.textContent = message;
    node.className = `sr-only solo-activity is-${tone}`;
    const captureStatus = this.root?.querySelector<HTMLElement>("#capture-status");
    if (captureStatus) captureStatus.textContent = message;
  }

  private startTiming() {
    if (this.timingTimer !== null) window.clearInterval(this.timingTimer);
    this.timingTimer = window.setInterval(() => {
      const controller = this.controller;
      if (!controller) return;
      this.renderSnapshot(controller.snapshot);
      if (
        soloRunCanResume(controller.snapshot)
        && this.launchPresentation?.xr !== "active"
      ) return;
      void controller.advanceTime().catch((error) => this.showActivity(error, "error"));
    }, 100);
  }
}

function soloCoordinatorMarkup() {
  return `
    <div id="solo-capture-host"></div>
    <section id="solo-system-transition" class="solo-system-transition" aria-live="polite" hidden>
      <span>Quest hand-off</span>
      <strong id="solo-transition-detail">Complete the Quest browser hand-off, then return to Solo XR.</strong>
      <button id="solo-transition-action" class="prompt-audio-button" type="button">Continue</button>
      <input id="solo-transition-file" type="file" accept=".json,.yaml,.yml,application/json,text/yaml" hidden>
      <button id="solo-return-xr" class="join-xr-button" type="button" hidden>Return to Solo XR</button>
    </section>
    <div id="solo-coordinator-state" hidden aria-hidden="true">
      <section id="solo-session-gate">
        <button id="solo-new-session" type="button">New session</button>
        <button id="solo-resume-session" type="button" hidden>Resume session</button>
        <button id="solo-recheck" type="button">Recheck device</button>
        <p id="solo-resume-detail">No interrupted Solo session was found</p>
        <p id="solo-launch-state" class="solo-launch-state is-idle">Starting Solo capture.</p>
        <ul id="solo-capabilities"></ul>
      </section>
      <section id="solo-workspace" hidden></section>
    </div>
    <p id="solo-activity" class="sr-only solo-activity is-system" role="status" aria-live="polite">Solo is local until you request an export.</p>
  `;
}

export function soloPostAcquisitionEpisodes(
  snapshot: Pick<SessionSnapshot, "episodes" | "attempts">,
) {
  return [...snapshot.episodes, ...snapshot.attempts]
    .filter((episode) => episode.endedAt
      && episode.integrity === "valid"
      && (episode.outcome === "completed" || episode.outcome === "successful" || episode.outcome === "stopped")
      && episode.frameCount > 0)
    .sort((left, right) => Date.parse(right.endedAt!) - Date.parse(left.endedAt!));
}

export function soloPostAcquisitionQualityWindowForSnapshot(
  snapshot: Pick<SessionSnapshot, "run" | "currentEpisode" | "pendingEpisode">,
) {
  if (snapshot.run.recordingState !== "idle"
    || snapshot.currentEpisode !== null
    || snapshot.pendingEpisode !== null) return null;
  return soloPostAcquisitionQualityWindow(snapshot.run);
}

export function soloPostAcquisitionRunEpisodes(
  snapshot: Pick<SessionSnapshot, "episodes" | "attempts" | "run">,
) {
  const runStartedAtMs = snapshot.run.startedAtMs;
  if (runStartedAtMs === null) return [];
  const runEndedAtMs = snapshot.run.endedAtMs ?? Number.POSITIVE_INFINITY;
  return soloPostAcquisitionEpisodes(snapshot).filter((episode) => {
    const episodeStartedAtMs = Date.parse(episode.startedAt);
    const episodeEndedAtMs = Date.parse(episode.endedAt!);
    return Number.isFinite(episodeStartedAtMs)
      && Number.isFinite(episodeEndedAtMs)
      && episodeStartedAtMs >= runStartedAtMs
      && episodeEndedAtMs <= runEndedAtMs;
  });
}

export function soloRunQualityPresentationKey(
  snapshot: Pick<SessionSnapshot, "configuration" | "run" | "sessionId">,
  episodes: readonly Pick<
    Episode,
    | "endedAt"
    | "firstRecorderSequence"
    | "frameCount"
    | "gapCount"
    | "id"
    | "lastRecorderSequence"
    | "recorderSlotCount"
  >[],
) {
  return JSON.stringify({
    sessionId: snapshot.sessionId,
    recorderRateHz: snapshot.configuration.recorderRateHz,
    runStartedAtMs: snapshot.run.startedAtMs,
    runEndedAtMs: snapshot.run.endedAtMs,
    episodes: [...episodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((episode) => ({
        id: episode.id,
        endedAt: episode.endedAt,
        frameCount: episode.frameCount,
        gapCount: episode.gapCount ?? 0,
        recorderSlotCount: episode.recorderSlotCount ?? 0,
        firstRecorderSequence: episode.firstRecorderSequence ?? null,
        lastRecorderSequence: episode.lastRecorderSequence ?? null,
      })),
  });
}

export function soloCaptureConfigurationsEqual(
  left: CaptureConfiguration,
  right: CaptureConfiguration,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function postAcquisitionRetryDelay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 150);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Solo run quality analysis was cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function soloCaptureConfigurationAlreadyApplied(
  configuration: CaptureConfiguration,
  snapshot: Pick<SessionSnapshot, "configuration" | "configurationStatus">,
) {
  const status = snapshot.configurationStatus;
  return soloCaptureConfigurationsEqual(configuration, snapshot.configuration)
    && status.state === "applied"
    && status.appliedRevision === status.revision;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

type SoloXrDraftIntent = Extract<
  SoloXrConsoleIntent,
  {
    type:
      | "draft-focus-task"
      | "draft-add-task"
      | "draft-delete-focused-task"
      | "draft-move-task"
      | "draft-convert-task"
      | "draft-save-task-properties"
      | "draft-adjust-number"
      | "draft-set-number"
      | "draft-set-text";
  }
>;

function isSoloDraftIntent(intent: SoloXrConsoleIntent): intent is SoloXrDraftIntent {
  return intent.type === "draft-focus-task"
    || intent.type === "draft-add-task"
    || intent.type === "draft-delete-focused-task"
    || intent.type === "draft-move-task"
    || intent.type === "draft-convert-task"
    || intent.type === "draft-save-task-properties"
    || intent.type === "draft-adjust-number"
    || intent.type === "draft-set-number"
    || intent.type === "draft-set-text";
}

export function soloConfigurationWithAudioRecordingOverride(
  configuration: CaptureConfiguration,
  override: boolean | null,
) {
  return override === null || configuration.recordAudio === override
    ? configuration
    : { ...configuration, recordAudio: override };
}
