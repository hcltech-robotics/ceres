import {
  isHuggingFaceAppendAllocation,
  type AccountExportDestinationValidation,
  type AccountExportSession,
  type HuggingFaceMissingRepositoryBehaviour,
} from "../shared/export-destination.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";
import {
  isSoloWorkspaceRepositorySegment,
  type CaptureJob,
  type Episode,
  type SessionSnapshot,
} from "../shared/protocol.js";

export type SoloExportDestination = "opfs" | "folder" | "hugging-face";
export type SoloAccountAvailability = "checking" | "available" | "unavailable";
export type SoloExportProgressStage =
  | "creating"
  | "preparing"
  | "uploading"
  | "finalising"
  | "completed"
  | "cancelled";

export interface SoloExportRequest {
  destination: SoloExportDestination;
  sessionId: string;
  episodeIds: readonly string[];
  repository?: string;
  branch?: string;
  visibility?: "private" | "public";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  uploadMode?: "account" | "headset";
  uploadPrincipal?: string;
}

export interface SoloExportControllerPorts {
  start(request: SoloExportRequest): Promise<void>;
  cancel(): Promise<void>;
  retry(request: SoloExportRequest): Promise<void>;
  deleteEpisode(episodeId: string): Promise<void>;
}

export interface SoloRepositorySettings {
  organisation: string;
  repository: string;
  branch: string;
  visibility: "private" | "public";
  missingRepositoryBehaviour: HuggingFaceMissingRepositoryBehaviour;
}

export interface SoloExportProgressInput {
  jobId: string | null;
  completed: number;
  total: number;
  detail: string;
  stage?: SoloExportProgressStage;
}

export interface SoloExportProgress extends SoloExportProgressInput {
  fraction: number;
}

export interface SoloEpisodeProjection {
  id: string;
  kind: "accepted" | "attempt";
  episode: Readonly<Episode>;
  selected: boolean;
  exportable: boolean;
  deleteRequested: boolean;
}

export interface SoloAccountPresentation {
  state: "checking" | "local-only" | "sign-in" | "connect" | "reauthenticate" | "connected";
  label: string;
  action: "none" | "connect" | "reauthenticate" | "manage";
  actionLabel: string | null;
  username: string | null;
  canUpload: boolean;
}

export interface SoloDeleteConfirmation {
  episodeId: string;
  taskLabel: string;
}

export interface SoloExportControllerState {
  sessionId: string | null;
  selectionAvailable: boolean;
  episodes: readonly Readonly<SoloEpisodeProjection>[];
  selectedEpisodeIds: readonly string[];
  exportEpisodeIds: readonly string[];
  deleteConfirmation: Readonly<SoloDeleteConfirmation> | null;
  deletingEpisodeId: string | null;
  repositorySettings: Readonly<SoloRepositorySettings>;
  account: Readonly<SoloAccountPresentation>;
  jobs: readonly Readonly<CaptureJob>[];
  active: Readonly<{
    busy: boolean;
    operation: "start" | "cancel" | "retry" | null;
    job: Readonly<CaptureJob> | null;
    progress: Readonly<SoloExportProgress> | null;
    canCancel: boolean;
  }>;
  retry: Readonly<{
    available: boolean;
    job: Readonly<CaptureJob> | null;
    request: Readonly<SoloExportRequest> | null;
  }>;
  lastError: string | null;
}

export type SoloExportStateListener = (state: Readonly<SoloExportControllerState>) => void;

interface EpisodeValue {
  kind: SoloEpisodeProjection["kind"];
  episode: Episode;
}

interface RetryValue {
  job: CaptureJob | null;
  request: SoloExportRequest | null;
}

const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export class SoloExportController {
  private readonly listeners = new Set<SoloExportStateListener>();
  private sessionIdValue: string | null = null;
  private episodeOperationBlockerValue: string | null =
    "Solo session is not available for episode review";
  private episodeValues: EpisodeValue[] = [];
  private jobValues: CaptureJob[] = [];
  private readonly selectedEpisodeIds = new Set<string>();
  private deleteConfirmationValue: SoloDeleteConfirmation | null = null;
  private deletingEpisodeIdValue: string | null = null;
  private accountAvailabilityValue: SoloAccountAvailability = "checking";
  private accountSessionValue: AccountExportSession | null = null;
  private headsetHuggingFaceUsernameValue: string | null = null;
  private repositorySettingsValue: SoloRepositorySettings = {
    organisation: "",
    repository: "ceres-capture",
    branch: "main",
    visibility: "private",
    missingRepositoryBehaviour: "private",
  };
  private verifiedRepositoryDestinationValue: AccountExportDestinationValidation | null = null;
  private readonly touchedRepositorySettings = new Set<keyof SoloRepositorySettings>();
  private progressValue: SoloExportProgress | null = null;
  private operationValue: SoloExportControllerState["active"]["operation"] = null;
  private lastFailedRequest: SoloExportRequest | null = null;
  private lastErrorValue: string | null = null;
  private stateValue: Readonly<SoloExportControllerState>;

  constructor(private readonly ports: SoloExportControllerPorts) {
    this.stateValue = this.buildState();
  }

  get snapshot() {
    return this.stateValue;
  }

  subscribe(listener: SoloExportStateListener) {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => {
      this.listeners.delete(listener);
    };
  }

  updateSession(snapshot: SessionSnapshot | null) {
    if (!snapshot) {
      this.sessionIdValue = null;
      this.episodeOperationBlockerValue = "Solo session is not available for episode review";
      this.episodeValues = [];
      this.jobValues = [];
      this.selectedEpisodeIds.clear();
      this.deleteConfirmationValue = null;
      this.deletingEpisodeIdValue = null;
      this.progressValue = null;
      this.publish();
      return;
    }

    this.sessionIdValue = snapshot.sessionId;
    this.episodeOperationBlockerValue = soloEpisodeOperationBlocker(snapshot);
    const acceptedIds = new Set(snapshot.episodes.map(({ id }) => id));
    this.episodeValues = [
      ...snapshot.episodes.map((value): EpisodeValue => ({
        kind: "accepted",
        episode: structuredClone(value),
      })),
      ...snapshot.attempts
        .filter(({ id }) => !acceptedIds.has(id))
        .map((value): EpisodeValue => ({
          kind: "attempt",
          episode: structuredClone(value),
        })),
    ].sort(compareEpisodeValues);
    this.jobValues = snapshot.jobs
      .map((value) => structuredClone(value))
      .sort(compareJobs);

    const validIds = new Set(this.episodeValues.map(({ episode }) => episode.id));
    for (const episodeId of this.selectedEpisodeIds) {
      if (!validIds.has(episodeId)) this.selectedEpisodeIds.delete(episodeId);
    }
    if (this.deleteConfirmationValue
      && (!validIds.has(this.deleteConfirmationValue.episodeId)
        || this.episodeOperationBlockerValue !== null)) {
      this.deleteConfirmationValue = null;
    }
    if (this.deletingEpisodeIdValue && !validIds.has(this.deletingEpisodeIdValue)) {
      this.deletingEpisodeIdValue = null;
    }
    this.publish();
  }

  updateAccount(
    session: AccountExportSession | null,
    availability: SoloAccountAvailability = session ? "available" : "checking",
  ) {
    if (availability === "available" && !session) {
      throw new Error("An available Solo account requires a credential-free account session");
    }
    const previousDestinationKey = this.repositorySettingsDestinationKey();
    this.accountAvailabilityValue = availability;
    this.accountSessionValue = session ? structuredClone(session) : null;
    if (session && availability === "available") this.applyAccountDefaults(session);
    if (
      !this.accountHuggingFaceReady()
      && this.headsetHuggingFaceUsernameValue
      && !this.touchedRepositorySettings.has("organisation")
    ) {
      this.repositorySettingsValue.organisation = this.headsetHuggingFaceUsernameValue;
    }
    if (
      availability !== "available"
      || this.repositorySettingsDestinationKey() !== previousDestinationKey
    ) {
      this.verifiedRepositoryDestinationValue = null;
    }
    this.publish();
  }

  updateHeadsetHuggingFaceAccount(username: string | null) {
    const previousDestinationKey = this.repositorySettingsDestinationKey();
    this.headsetHuggingFaceUsernameValue = username?.trim() || null;
    if (this.headsetHuggingFaceUsernameValue
      && !this.accountHuggingFaceReady()
      && !this.touchedRepositorySettings.has("organisation")) {
      this.repositorySettingsValue.organisation = this.headsetHuggingFaceUsernameValue;
    }
    if (
      !this.headsetHuggingFaceUsernameValue
      || this.repositorySettingsDestinationKey() !== previousDestinationKey
    ) {
      this.verifiedRepositoryDestinationValue = null;
    }
    this.publish();
  }

  updateRepositorySettings(settings: Partial<SoloRepositorySettings>) {
    const previousDestinationKey = this.repositorySettingsDestinationKey();
    if (settings.organisation !== undefined) {
      this.repositorySettingsValue.organisation = settings.organisation.trim();
      this.touchedRepositorySettings.add("organisation");
    }
    if (settings.repository !== undefined) {
      this.repositorySettingsValue.repository = settings.repository.trim();
      this.touchedRepositorySettings.add("repository");
    }
    if (settings.branch !== undefined) {
      this.repositorySettingsValue.branch = settings.branch.trim();
      this.touchedRepositorySettings.add("branch");
    }
    if (settings.visibility !== undefined) {
      if (settings.visibility !== "private" && settings.visibility !== "public") {
        throw new Error("Solo repository visibility must be private or public");
      }
      this.repositorySettingsValue.visibility = settings.visibility;
      this.touchedRepositorySettings.add("visibility");
      if (settings.missingRepositoryBehaviour === undefined) {
        this.repositorySettingsValue.missingRepositoryBehaviour = settings.visibility;
        this.touchedRepositorySettings.add("missingRepositoryBehaviour");
      }
    }
    if (settings.missingRepositoryBehaviour !== undefined) {
      if (
        settings.missingRepositoryBehaviour !== "do-not-create"
        && settings.missingRepositoryBehaviour !== "private"
        && settings.missingRepositoryBehaviour !== "public"
      ) {
        throw new Error("Solo missing repository behaviour is invalid");
      }
      this.repositorySettingsValue.missingRepositoryBehaviour = settings.missingRepositoryBehaviour;
      this.touchedRepositorySettings.add("missingRepositoryBehaviour");
      if (settings.missingRepositoryBehaviour !== "do-not-create") {
        this.repositorySettingsValue.visibility = settings.missingRepositoryBehaviour;
      }
    }
    if (this.repositorySettingsDestinationKey() !== previousDestinationKey) {
      this.verifiedRepositoryDestinationValue = null;
    }
    this.publish();
  }

  updateVerifiedRepositoryDestination(
    destination: AccountExportDestinationValidation | null,
  ) {
    if (destination === null) {
      this.verifiedRepositoryDestinationValue = null;
      this.publish();
      return;
    }
    if (
      destination.version !== 1
      || (destination.availability !== "existing" && destination.availability !== "creatable")
      || (destination.visibility !== "private" && destination.visibility !== "public")
      || !validBranch(destination.branch)
      || !isHuggingFaceAppendAllocation(destination.append)
    ) {
      throw new Error("The verified Hugging Face destination is invalid");
    }
    const settings = this.repositorySettingsValue;
    const configuredRepository = `${settings.organisation}/${settings.repository}`;
    if (
      destination.repository !== configuredRepository
      || destination.branch !== settings.branch
      || destination.visibility !== settings.visibility
    ) {
      throw new Error("The verified Hugging Face destination does not match the current settings");
    }
    this.verifiedRepositoryDestinationValue = structuredClone(destination);
    this.publish();
  }

  updateProgress(progress: SoloExportProgressInput | null) {
    if (!progress) {
      this.progressValue = null;
      this.publish();
      return;
    }
    if (!Number.isFinite(progress.completed)
      || !Number.isFinite(progress.total)
      || progress.completed < 0
      || progress.total <= 0
      || progress.completed > progress.total) {
      throw new Error("Solo export progress must have bounded completed and total values");
    }
    this.progressValue = {
      jobId: progress.jobId,
      completed: progress.completed,
      total: progress.total,
      fraction: progress.completed / progress.total,
      detail: progress.detail,
      ...(progress.stage ? { stage: progress.stage } : {}),
    };
    this.publish();
  }

  toggleEpisodeSelection(episodeId: string) {
    this.assertSelectionAvailable();
    this.requireEpisode(episodeId);
    if (this.selectedEpisodeIds.has(episodeId)) this.selectedEpisodeIds.delete(episodeId);
    else this.selectedEpisodeIds.add(episodeId);
    this.publish();
  }

  clearEpisodeSelection() {
    this.assertSelectionAvailable();
    this.selectedEpisodeIds.clear();
    this.publish();
  }

  requestDelete(episodeId: string) {
    this.assertSelectionAvailable();
    if (this.deletingEpisodeIdValue) throw new Error("A Solo episode deletion is already active");
    const value = this.requireEpisode(episodeId);
    this.deleteConfirmationValue = {
      episodeId,
      taskLabel: value.episode.taskLabel,
    };
    this.lastErrorValue = null;
    this.publish();
  }

  cancelDelete() {
    if (this.deletingEpisodeIdValue) throw new Error("The active Solo episode deletion cannot be cancelled");
    this.deleteConfirmationValue = null;
    this.publish();
  }

  async confirmDelete() {
    const confirmation = this.deleteConfirmationValue;
    if (!confirmation) throw new Error("No Solo episode is awaiting deletion");
    this.assertSelectionAvailable();
    this.requireEpisode(confirmation.episodeId);
    if (this.deletingEpisodeIdValue) throw new Error("A Solo episode deletion is already active");
    this.deletingEpisodeIdValue = confirmation.episodeId;
    this.lastErrorValue = null;
    this.publish();
    try {
      await this.ports.deleteEpisode(confirmation.episodeId);
      this.selectedEpisodeIds.delete(confirmation.episodeId);
      this.deleteConfirmationValue = null;
    } catch (error) {
      this.lastErrorValue = errorMessage(error);
      throw error;
    } finally {
      this.deletingEpisodeIdValue = null;
      this.publish();
    }
  }

  async start(destination: SoloExportDestination) {
    this.assertNoActiveExport();
    const request = this.createRequest(destination, this.requestedExportEpisodeIds());
    await this.runExportOperation("start", request, () => this.ports.start(request));
  }

  async startEpisodes(
    destination: SoloExportDestination,
    episodeIds: readonly string[],
  ) {
    this.assertNoActiveExport();
    const request = this.createRequest(destination, episodeIds, true);
    await this.runExportOperation("start", request, () => this.ports.start(request));
  }

  async cancel() {
    const activeJob = this.activeJob();
    if (this.operationValue) throw new Error("Another Solo export operation is in progress");
    if (!activeJob && !this.progressValue) throw new Error("There is no active Solo export to cancel");
    if (this.progressValue?.stage === "finalising") {
      throw new Error("The Hugging Face upload is finalising and can no longer be aborted");
    }
    this.operationValue = "cancel";
    this.lastErrorValue = null;
    this.publish();
    try {
      await this.ports.cancel();
      this.progressValue = null;
    } catch (error) {
      this.lastErrorValue = errorMessage(error);
      throw error;
    } finally {
      this.operationValue = null;
      this.publish();
    }
  }

  async retry() {
    this.assertNoActiveExport();
    const candidate = this.retryValue();
    if (!candidate.request) throw new Error("There is no Solo export available to retry");
    const request = this.validateRequest(candidate.request);
    await this.runExportOperation("retry", request, () => this.ports.retry(request));
  }

  private async runExportOperation(
    operation: "start" | "retry",
    request: SoloExportRequest,
    run: () => Promise<void>,
  ) {
    this.operationValue = operation;
    this.lastErrorValue = null;
    this.publish();
    try {
      await run();
      this.lastFailedRequest = null;
    } catch (error) {
      this.lastFailedRequest = request;
      this.lastErrorValue = errorMessage(error);
      throw error;
    } finally {
      this.operationValue = null;
      this.publish();
    }
  }

  private createRequest(
    destination: SoloExportDestination,
    episodeIds: readonly string[],
    allowBlockedSelection = false,
  ) {
    if (!this.sessionIdValue) throw new Error("Solo session is not available for export");
    const base = {
      destination,
      sessionId: this.sessionIdValue,
      episodeIds: [...episodeIds],
    };
    if (destination !== "hugging-face") return this.validateRequest(base, allowBlockedSelection);
    const settings = this.repositorySettingsValue;
    return this.validateRequest({
      ...base,
      repository: `${settings.organisation}/${settings.repository}`,
      branch: settings.branch,
      visibility: settings.visibility,
      missingRepositoryBehaviour: settings.missingRepositoryBehaviour,
    }, allowBlockedSelection);
  }

  private validateRequest(
    value: SoloExportRequest,
    allowBlockedSelection = false,
  ): SoloExportRequest {
    if (value.destination !== "opfs"
      && value.destination !== "folder"
      && value.destination !== "hugging-face") {
      throw new Error("The Solo export destination is not supported");
    }
    if (!this.sessionIdValue || value.sessionId !== this.sessionIdValue) {
      throw new Error("Solo export request does not match the active session");
    }
    if (!allowBlockedSelection) this.assertSelectionAvailable();
    const episodeIds = [...new Set(value.episodeIds)];
    if (episodeIds.length === 0) throw new Error("No exportable Solo episodes are selected");
    if (episodeIds.length !== value.episodeIds.length) {
      throw new Error("Solo export episode selection contains duplicates");
    }
    for (const episodeId of episodeIds) {
      const episodeValue = this.requireEpisode(episodeId);
      if (!isExportableEpisode(episodeValue.episode)) {
        throw new Error(`Solo episode ${episodeId} is not exportable`);
      }
    }
    if (value.destination !== "hugging-face") {
      return immutableRequest({
        destination: value.destination,
        sessionId: value.sessionId,
        episodeIds,
      });
    }
    if (!this.accountPresentation().canUpload) {
      throw new Error("Connect Hugging Face before starting a Solo sync");
    }
    const [organisation, repository, ...remainder] = (value.repository ?? "").split("/");
    if (remainder.length > 0 || !isSoloWorkspaceRepositorySegment(organisation)) {
      throw new Error("Set an allowed Hugging Face organisation");
    }
    if (!isSoloWorkspaceRepositorySegment(repository)) {
      throw new Error("Set a valid Hugging Face repository name");
    }
    if (!validBranch(value.branch ?? "")) {
      throw new Error("Set a valid Hugging Face branch");
    }
    if (value.visibility !== "private" && value.visibility !== "public") {
      throw new Error("Set a valid Hugging Face visibility");
    }
    const verifiedDestination = this.requireVerifiedRepositoryDestination(
      `${organisation}/${repository}`,
      value.branch!,
      value.visibility,
    );
    const missingRepositoryBehaviour = value.missingRepositoryBehaviour ?? value.visibility;
    if (
      missingRepositoryBehaviour !== "do-not-create"
      && missingRepositoryBehaviour !== "private"
      && missingRepositoryBehaviour !== "public"
    ) {
      throw new Error("Set a valid missing repository behaviour");
    }
    return immutableRequest({
      destination: "hugging-face",
      sessionId: value.sessionId,
      episodeIds,
      repository: verifiedDestination.repository,
      branch: value.branch,
      visibility: verifiedDestination.visibility,
      missingRepositoryBehaviour,
      ...(value.uploadMode ? { uploadMode: value.uploadMode } : {}),
      ...(value.uploadPrincipal ? { uploadPrincipal: value.uploadPrincipal } : {}),
    });
  }

  private exportEpisodeIds() {
    const selected = this.selectedEpisodeIds;
    return this.episodeValues
      .filter(({ episode }) => (
        isExportableEpisode(episode)
        && (selected.size === 0 || selected.has(episode.id))
      ))
      .map(({ episode }) => episode.id);
  }

  private requestedExportEpisodeIds() {
    if (this.selectedEpisodeIds.size === 0) return this.exportEpisodeIds();
    return this.episodeValues
      .filter(({ episode }) => this.selectedEpisodeIds.has(episode.id))
      .map(({ episode }) => episode.id);
  }

  private requireEpisode(episodeId: string) {
    const value = this.episodeValues.find(({ episode }) => episode.id === episodeId);
    if (!value) throw new Error(`Episode ${episodeId} is not in the Solo catalogue`);
    return value;
  }

  private assertSelectionAvailable() {
    if (this.episodeOperationBlockerValue) throw new Error(this.episodeOperationBlockerValue);
  }

  private assertNoActiveExport() {
    if (this.operationValue || this.activeJob() || this.progressValue) {
      throw new Error("A Solo export or upload is already active");
    }
  }

  private repositorySettingsDestinationKey() {
    const settings = this.repositorySettingsValue;
    return JSON.stringify([
      settings.organisation,
      settings.repository,
      settings.branch,
      settings.visibility,
      settings.missingRepositoryBehaviour,
    ]);
  }

  private requireVerifiedRepositoryDestination(
    repository: string,
    branch: string,
    visibility: "private" | "public",
  ) {
    const destination = this.verifiedRepositoryDestinationValue;
    if (
      !destination
      || destination.repository !== repository
      || destination.branch !== branch
      || destination.visibility !== visibility
    ) {
      throw new Error("Verify the current Hugging Face destination before starting a Solo sync");
    }
    return destination;
  }

  private activeJob() {
    return this.jobValues.find(({ state }) => state === "queued" || state === "running") ?? null;
  }

  private retryValue(): RetryValue {
    const completedRequests = new Set<string>();
    let job: CaptureJob | null = null;
    for (const candidate of this.jobValues) {
      const requestKey = captureJobRequestKey(candidate);
      if (candidate.state === "completed") {
        if (requestKey) completedRequests.add(requestKey);
        continue;
      }
      if ((candidate.state === "failed" || candidate.state === "cancelled")
        && (!requestKey || !completedRequests.has(requestKey))) {
        job = candidate;
        break;
      }
    }
    const request = job ? this.requestFromJob(job) : this.lastFailedRequest;
    return { job, request };
  }

  private requestFromJob(job: CaptureJob) {
    const recovery = job.browserRecovery;
    if (!recovery || !this.sessionIdValue) return null;
    const base = {
      destination: recovery.destination,
      sessionId: this.sessionIdValue,
      episodeIds: [...recovery.episodeIds],
    };
    if (recovery.destination !== "hugging-face") return immutableRequest(base);
    if (!recovery.repository || !recovery.branch || !recovery.visibility) return null;
    return immutableRequest({
      ...base,
      destination: "hugging-face",
      repository: recovery.repository,
      branch: recovery.branch,
      visibility: recovery.visibility,
      missingRepositoryBehaviour: recovery.missingRepositoryBehaviour ?? recovery.visibility,
      ...(recovery.uploadMode ? { uploadMode: recovery.uploadMode } : {}),
      ...(recovery.uploadPrincipal ? { uploadPrincipal: recovery.uploadPrincipal } : {}),
    });
  }

  private applyAccountDefaults(session: AccountExportSession) {
    if (!this.touchedRepositorySettings.has("organisation")) {
      this.repositorySettingsValue.organisation = session.defaults.organisation
        || session.huggingFace.username
        || "";
    }
    if (!this.touchedRepositorySettings.has("repository")) {
      this.repositorySettingsValue.repository = `${session.defaults.repositoryPrefix || "ceres-"}capture`;
    }
    if (!this.touchedRepositorySettings.has("branch")) {
      this.repositorySettingsValue.branch = "main";
    }
    if (!this.touchedRepositorySettings.has("visibility")) {
      this.repositorySettingsValue.visibility = session.defaults.visibility;
    }
    if (!this.touchedRepositorySettings.has("missingRepositoryBehaviour")) {
      this.repositorySettingsValue.missingRepositoryBehaviour = session.defaults.visibility;
    }
  }

  private accountPresentation(): SoloAccountPresentation {
    if (this.accountHuggingFaceReady()) {
      const account = this.accountSessionValue!;
      return {
        state: "connected",
        label: `Hugging Face connected / ${account.huggingFace.username ?? "account"}`,
        action: "manage",
        actionLabel: "Manage connection",
        username: account.huggingFace.username,
        canUpload: true,
      };
    }
    if (this.headsetHuggingFaceUsernameValue) {
      return {
        state: "connected",
        label: `Hugging Face connected / ${this.headsetHuggingFaceUsernameValue}`,
        action: "manage",
        actionLabel: "Reauthorise",
        username: this.headsetHuggingFaceUsernameValue,
        canUpload: true,
      };
    }
    if (this.accountAvailabilityValue === "checking") {
      return {
        state: "checking",
        label: "Checking account connection",
        action: "none",
        actionLabel: null,
        username: null,
        canUpload: false,
      };
    }
    if (this.accountAvailabilityValue === "unavailable" || !this.accountSessionValue) {
      return {
        state: "sign-in",
        label: "Hugging Face is not authorised on this headset",
        action: "connect",
        actionLabel: "Sign in to Hugging Face",
        username: null,
        canUpload: false,
      };
    }
    const account = this.accountSessionValue;
    if (!account.signedIn) {
      return {
        state: "sign-in",
        label: "Hugging Face is not authorised on this headset",
        action: "connect",
        actionLabel: "Sign in to Hugging Face",
        username: null,
        canUpload: false,
      };
    }
    if (account.huggingFace.state === "reauthentication_required") {
      return {
        state: "reauthenticate",
        label: "Reauthenticate Hugging Face",
        action: "reauthenticate",
        actionLabel: "Reauthenticate",
        username: account.huggingFace.username,
        canUpload: false,
      };
    }
    if (account.huggingFace.state === "disconnected") {
      return {
        state: "connect",
        label: "Connect Hugging Face",
        action: "connect",
        actionLabel: "Connect Hugging Face",
        username: account.huggingFace.username,
        canUpload: false,
      };
    }
    return {
      state: "connected",
      label: `Hugging Face connected / ${account.huggingFace.username ?? "account"}`,
      action: "manage",
      actionLabel: "Manage connection",
      username: account.huggingFace.username,
      canUpload: true,
    };
  }

  private accountHuggingFaceReady() {
    return this.accountAvailabilityValue === "available"
      && this.accountSessionValue?.signedIn === true
      && this.accountSessionValue.huggingFace.state === "ready";
  }

  private buildState(): Readonly<SoloExportControllerState> {
    const selectionAvailable = this.sessionIdValue !== null
      && this.episodeOperationBlockerValue === null;
    const exportEpisodeIds = this.exportEpisodeIds();
    const activeJob = this.activeJob();
    const retry = this.retryValue();
    let retryRequest: SoloExportRequest | null = null;
    let retryAvailable = false;
    if (retry.request && selectionAvailable && !activeJob && !this.progressValue && !this.operationValue) {
      try {
        retryRequest = this.validateRequest(retry.request);
        retryAvailable = true;
      } catch {
        retryRequest = retry.request;
      }
    } else {
      retryRequest = retry.request;
    }
    const busy = Boolean(activeJob || this.progressValue || this.operationValue);
    const state: SoloExportControllerState = {
      sessionId: this.sessionIdValue,
      selectionAvailable,
      episodes: this.episodeValues.map(({ episode, kind }) => ({
        id: episode.id,
        kind,
        episode: structuredClone(episode),
        selected: this.selectedEpisodeIds.has(episode.id),
        exportable: isExportableEpisode(episode),
        deleteRequested: this.deleteConfirmationValue?.episodeId === episode.id,
      })),
      selectedEpisodeIds: this.episodeValues
        .map(({ episode }) => episode.id)
        .filter((episodeId) => this.selectedEpisodeIds.has(episodeId)),
      exportEpisodeIds,
      deleteConfirmation: this.deleteConfirmationValue
        ? { ...this.deleteConfirmationValue }
        : null,
      deletingEpisodeId: this.deletingEpisodeIdValue,
      repositorySettings: { ...this.repositorySettingsValue },
      account: this.accountPresentation(),
      jobs: this.jobValues.map((value) => structuredClone(value)),
      active: {
        busy,
        operation: this.operationValue,
        job: activeJob ? structuredClone(activeJob) : null,
        progress: this.progressValue ? { ...this.progressValue } : null,
        canCancel: Boolean(
          (activeJob || this.progressValue)
          && this.operationValue !== "cancel"
          && this.progressValue?.stage !== "finalising",
        ),
      },
      retry: {
        available: retryAvailable,
        job: retry.job ? structuredClone(retry.job) : null,
        request: retryRequest,
      },
      lastError: this.lastErrorValue,
    };
    return deepFreeze(state);
  }

  private publish() {
    this.stateValue = this.buildState();
    for (const listener of this.listeners) listener(this.stateValue);
  }
}

function soloEpisodeOperationBlocker(snapshot: SessionSnapshot): string | null {
  if (snapshot.run.recordingState === "stopping") {
    return "Solo episode review and export are unavailable while finalising";
  }
  if (snapshot.run.status === "running") {
    return "Solo episode review and export are unavailable during an active run";
  }
  if (snapshot.solo?.startCountdownDeadlineMs != null) {
    return "Solo episode review and export are unavailable during the start countdown";
  }
  if (snapshot.currentEpisode !== null || snapshot.pendingEpisode !== null) {
    return "Solo episode review and export are unavailable during an active episode boundary";
  }
  if (snapshot.recording || snapshot.run.recordingState !== "idle") {
    return "Solo episode review and export are unavailable while recording";
  }
  return null;
}

function immutableRequest(request: SoloExportRequest) {
  return deepFreeze({
    ...request,
    episodeIds: [...request.episodeIds],
  });
}

function compareEpisodeValues(left: EpisodeValue, right: EpisodeValue) {
  return right.episode.startedAt.localeCompare(left.episode.startedAt)
    || left.episode.id.localeCompare(right.episode.id);
}

function compareJobs(left: CaptureJob, right: CaptureJob) {
  return right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function captureJobRequestKey(job: CaptureJob) {
  const recovery = job.browserRecovery;
  if (!recovery) return null;
  return JSON.stringify([
    recovery.destination,
    [...recovery.episodeIds].sort(),
    recovery.repository ?? null,
    recovery.branch ?? null,
    recovery.visibility ?? null,
  ]);
}

function validBranch(value: unknown): value is string {
  return typeof value === "string"
    && branchPattern.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.endsWith(".lock")
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
