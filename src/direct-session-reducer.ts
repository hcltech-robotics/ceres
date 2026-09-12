import { assertVerifiedEpisodeHuggingFaceUpload, defaultCaptureStatus, defaultConfiguration, isRepetitionTask, isStateBoundRunControlAction, nextRunControlCursor, normaliseSessionTelemetryMode, normaliseSoloSessionPreferences, normaliseSoloStorageHeadroom, normaliseSoloWorkspaceState, soloHandsReadyToRecord, type CaptureConfiguration, type CaptureJob, type CaptureStatus, type DirectBeamCommand, type DirectRunState, type DirectTaskPresentationAcknowledgement, type Episode, type EpisodeSegment, type EpisodeSegmentAnnotationAction, type PromptAudioStatus, type RecorderRunEvent, type RuntimeFeatures, type SessionSnapshot, type SoloSessionPreferences, type SoloStorageHeadroom, type SoloWorkspaceState, type VerifiedEpisodeHuggingFaceUpload } from "../shared/protocol.js";
import { defaultHandDisplaySettings, type HandDisplaySettings } from "../shared/hand-display.js";
import { captureMetadataFromStatus } from "../shared/capture-metadata.js";
import type { CameraRegistration } from "../shared/camera-registration.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";
import { CYCLE_PAUSE_MS, taskResetDurationMs } from "../shared/run-sequencing.js";
import type { MonitorRecordingSummary } from "./recorder/monitor-recording-summary.js";

export type DirectCaptureCommand =
  | { type: "configuration"; configuration: CaptureConfiguration; revision: number; checksum: string }
  | { type: "hand-display"; settings: HandDisplaySettings }
  | { type: "camera-registration"; registration: CameraRegistration | null }
  | { type: "run-state"; state: DirectRunState }
  | DirectBeamCommand
  | { type: "control"; action: "recording-event"; event: RecorderRunEvent; episode: Episode }
  | { type: "control"; action: "recording-arming" | "recording-recover-arming" | "recording-started" | "recording-paused" | "recording-resumed" | "recording-stopping" | "recording-recover-stopping" | "recording-stopped"; episode?: Episode };

export type DirectRunControlAction = "start-sequence" | "start" | "pause" | "resume" | "stop" | "finish" | "success" | "fail" | "retry" | "next";
export type DirectRunControlActor = "director" | "demonstrator";
export type DirectEpisodeProvenance = Required<Pick<
  Episode,
  | "operatingMode"
  | "selectedStartTaskId"
  | "startCountdownMs"
  | "taskSpecVersion"
  | "taskSpecHash"
  | "taskSpecification"
>>;
const SYNC_LOCK_MS = 2_500;

type DirectRecordingOutcome = Extract<Episode["outcome"], "completed" | "stopped">;
type DirectRunTransition = "cycle-boundary" | "stop-run" | "finish-run";

export function clearInterruptedBeamDeliveries(pending: Set<string>, displayedDeliveryId: string | null) {
  const hadPending = pending.size > 0;
  const displayedDeliveryInterrupted = displayedDeliveryId !== null && pending.has(displayedDeliveryId);
  pending.clear();
  return { hadPending, displayedDeliveryInterrupted };
}

export function isCurrentTaskPresentation(
  snapshot: SessionSnapshot,
  acknowledgement: DirectTaskPresentationAcknowledgement,
) {
  if (snapshot.configurationStatus.appliedRevision !== acknowledgement.revision) return false;
  const task = snapshot.configuration.tasks[snapshot.run.activeTaskIndex];
  if (!task || task.id !== acknowledgement.taskId) return false;
  const expectedState = snapshot.run.status === "running" && snapshot.run.phase === "active-task"
    ? "active"
    : "assigned";
  return acknowledgement.state === expectedState;
}

export class DirectSessionReducer {
  private readonly startedAt: string;
  private revision = 0;
  private snapshotValue: SessionSnapshot;
  private readonly recordingTransitions = new Map<string, DirectRunTransition>();
  private pendingActiveTaskPublication = false;
  private episodeProvenance: DirectEpisodeProvenance | null = null;

  constructor(
    sessionId: string,
    private readonly now: () => number = Date.now,
    private readonly allocateId: () => string = () => crypto.randomUUID(),
    initialRecorderRateHz = defaultConfiguration.recorderRateHz,
  ) {
    const initialConfiguration = structuredClone(defaultConfiguration);
    initialConfiguration.recorderRateHz = initialRecorderRateHz;
    this.startedAt = new Date(this.now()).toISOString();
    this.snapshotValue = {
      sessionId,
      startedAt: this.startedAt,
      telemetryMode: "standard",
      telemetryModeAuthoritative: false,
      operatingMode: "direct",
      features: { speech: true },
      handDisplay: { ...defaultHandDisplaySettings },
      cameraRegistration: null,
      captureConnected: false,
      monitorCount: 1,
      recording: false,
      activeTaskIndex: 0,
      run: initialRun(),
      configuration: initialConfiguration,
      configurationStatus: { state: "applied", revision: 0, checksum: "direct-0", appliedRevision: 0, error: null },
      sequenceReadiness: { ready: false, blockers: [{ code: "no-task", message: "Configure at least one recordable task" }] },
      recordingReadiness: { ready: false, blockers: [{ code: "sequence-not-started", message: "Start the sequence before recording" }] },
      currentEpisode: null,
      pendingEpisode: null,
      episodes: [],
      attempts: [],
      jobs: [],
      promptAudioStatus: { state: "unavailable", detail: "Prompt audio is disabled for direct sessions" },
      promptDeliveries: [],
      lastFrame: null,
      lastTranscript: null,
      commandLog: [],
      captureStatus: { ...defaultCaptureStatus, recorderRateHz: initialRecorderRateHz },
    };
    this.refreshReadiness();
  }

  get snapshot() {
    return structuredClone(this.snapshotValue);
  }

  get captureStatus() {
    return structuredClone(this.snapshotValue.captureStatus);
  }

  recordEpisodeUpload(episodeIds: readonly string[], upload: VerifiedEpisodeHuggingFaceUpload) {
    if (episodeIds.length === 0 || new Set(episodeIds).size !== episodeIds.length) {
      throw new Error("Hugging Face upload episode selection is invalid");
    }
    assertVerifiedEpisodeHuggingFaceUpload(upload, this.snapshotValue.sessionId, episodeIds);
    for (const episodeId of episodeIds) {
      const episode = this.snapshotValue.episodes.find((entry) => entry.id === episodeId)
        ?? this.snapshotValue.attempts.find((entry) => entry.id === episodeId);
      if (!episode || !isExportableEpisode(episode)) throw new Error(`Episode ${episodeId} is not available for upload metadata`);
      episode.huggingFaceUpload = structuredClone(upload);
    }
  }

  deleteEpisode(episodeId: string) {
    if (this.snapshotValue.operatingMode === "solo"
      && (this.snapshotValue.currentEpisode
        || this.snapshotValue.pendingEpisode
        || this.snapshotValue.run.recordingState !== "idle")) {
      throw new Error("Solo episodes cannot be deleted while a recording is active");
    }
    if (this.snapshotValue.currentEpisode?.id === episodeId || this.snapshotValue.pendingEpisode?.id === episodeId) {
      throw new Error("An active recording cannot be deleted");
    }
    const before = this.snapshotValue.episodes.length + this.snapshotValue.attempts.length;
    this.snapshotValue.episodes = this.snapshotValue.episodes.filter((entry) => entry.id !== episodeId);
    this.snapshotValue.attempts = this.snapshotValue.attempts.filter((entry) => entry.id !== episodeId);
    if (this.snapshotValue.episodes.length + this.snapshotValue.attempts.length === before) throw new Error("Episode was not found");
  }

  upsertJob(job: CaptureJob) {
    if (!job.id.trim() || !job.detail.trim()) throw new Error("Capture job identity and detail are required");
    const index = this.snapshotValue.jobs.findIndex((entry) => entry.id === job.id);
    if (index < 0) this.snapshotValue.jobs.push(structuredClone(job));
    else this.snapshotValue.jobs[index] = structuredClone(job);
  }

  removeJob(jobId: string) {
    const before = this.snapshotValue.jobs.length;
    this.snapshotValue.jobs = this.snapshotValue.jobs.filter((job) => job.id !== jobId);
    if (this.snapshotValue.jobs.length === before) throw new Error("Capture job was not found");
  }

  restore(snapshot: SessionSnapshot, captureConnected = false) {
    if (snapshot.sessionId !== this.snapshotValue.sessionId) throw new Error("Monitor recorder snapshot belongs to another session");
    this.snapshotValue = structuredClone(snapshot);
    this.snapshotValue.telemetryMode = "disabled";
    this.snapshotValue.telemetryModeAuthoritative = false;
    this.snapshotValue.captureStatus = {
      ...defaultCaptureStatus,
      ...this.snapshotValue.captureStatus,
    };
    this.snapshotValue.operatingMode ??= "direct";
    if (this.snapshotValue.operatingMode === "solo") {
      const preferences = normaliseSoloSessionPreferences(this.snapshotValue.solo?.preferences);
      this.snapshotValue.solo = {
        preferences,
        selectedStartTaskId: typeof this.snapshotValue.solo?.selectedStartTaskId === "string"
          ? this.snapshotValue.solo.selectedStartTaskId
          : null,
        startCountdownDeadlineMs: Number.isSafeInteger(this.snapshotValue.solo?.startCountdownDeadlineMs)
          && (this.snapshotValue.solo?.startCountdownDeadlineMs ?? -1) >= 0
          ? this.snapshotValue.solo!.startCountdownDeadlineMs
          : null,
        storageHeadroom: normaliseSoloStorageHeadroom(this.snapshotValue.solo?.storageHeadroom),
        workspace: normaliseSoloWorkspaceState(this.snapshotValue.solo?.workspace),
      };
    } else {
      this.snapshotValue.solo = undefined;
    }
    this.snapshotValue.run.directorReady ??= false;
    this.snapshotValue.run.demonstratorReady ??= false;
    this.snapshotValue.run.syncLockStartedAtMs ??= null;
    this.snapshotValue.run.recordingLatched = true;
    this.normaliseEpisodeSegments(this.snapshotValue.currentEpisode);
    this.normaliseEpisodeSegments(this.snapshotValue.pendingEpisode);
    for (const episode of this.snapshotValue.episodes) this.normaliseEpisodeSegments(episode);
    for (const episode of this.snapshotValue.attempts) this.normaliseEpisodeSegments(episode);
    this.snapshotValue.captureConnected = captureConnected;
    this.snapshotValue.monitorCount = 1;
    this.revision = snapshot.configurationStatus.revision;
    this.episodeProvenance = null;
    this.recordingTransitions.clear();
    this.pendingActiveTaskPublication = this.snapshotValue.run.status === "running"
      && this.snapshotValue.run.recordingState === "arming"
      && this.snapshotValue.pendingEpisode !== null;
    if (this.pendingActiveTaskPublication) {
      this.snapshotValue.run.phase = null;
      this.snapshotValue.run.takeStartedAtMs = null;
      this.snapshotValue.run.takeElapsedMs = 0;
    }
    if (this.snapshotValue.run.recordingState === "stopping"
      && (this.snapshotValue.currentEpisode || this.snapshotValue.pendingEpisode)) {
      const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode!;
      const transition: DirectRunTransition = this.snapshotValue.run.status !== "running" || this.snapshotValue.run.phase === null
        ? episode.runFinalisation === "finish-requested" ? "finish-run" : "stop-run"
        : "cycle-boundary";
      this.recordingTransitions.set(episode.id, transition);
    }
    this.refreshReadiness();
  }

  setCaptureConnected(connected: boolean): DirectCaptureCommand[] {
    this.snapshotValue.captureConnected = connected;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setTelemetryMode(telemetryMode: unknown) {
    this.snapshotValue.telemetryMode = normaliseSessionTelemetryMode(telemetryMode, "disabled");
    this.snapshotValue.telemetryModeAuthoritative = telemetryMode === "standard" || telemetryMode === "disabled";
  }

  resetTelemetryModeAuthority() {
    this.snapshotValue.telemetryMode = "disabled";
    this.snapshotValue.telemetryModeAuthoritative = false;
  }

  setRuntimeFeatures(features: RuntimeFeatures): DirectCaptureCommand[] {
    this.snapshotValue.features = { ...features };
    return [this.runStateCommand()];
  }

  setCaptureStatus(status: CaptureStatus): DirectCaptureCommand[] {
    this.snapshotValue.captureStatus = structuredClone(status);
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setCaptureStatusVolatile(status: CaptureStatus) {
    this.snapshotValue.captureStatus = structuredClone(status);
  }

  setPromptAudioStatus(status: PromptAudioStatus): DirectCaptureCommand[] {
    this.snapshotValue.promptAudioStatus = structuredClone(status);
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  enableSolo(preferences: SoloSessionPreferences): DirectCaptureCommand[] {
    const normalised = normaliseSoloSessionPreferences(preferences);
    this.snapshotValue.operatingMode = "solo";
    this.snapshotValue.solo = {
      preferences: normalised,
      selectedStartTaskId: this.snapshotValue.solo?.selectedStartTaskId ?? null,
      startCountdownDeadlineMs: this.snapshotValue.solo?.startCountdownDeadlineMs ?? null,
      storageHeadroom: normaliseSoloStorageHeadroom(this.snapshotValue.solo?.storageHeadroom),
      workspace: normaliseSoloWorkspaceState(this.snapshotValue.solo?.workspace),
    };
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setSoloStorageHeadroom(status: SoloStorageHeadroom): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo" || !this.snapshotValue.solo) {
      throw new Error("Storage headroom requires a Solo session");
    }
    this.snapshotValue.solo.storageHeadroom = normaliseSoloStorageHeadroom(status);
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setSoloPreferences(preferences: SoloSessionPreferences): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo" || !this.snapshotValue.solo) {
      throw new Error("Solo preferences require a Solo session");
    }
    if (this.snapshotValue.run.status === "running"
      || this.snapshotValue.run.recordingState !== "idle"
      || this.snapshotValue.currentEpisode
      || this.snapshotValue.pendingEpisode) {
      throw new Error("Solo preferences are locked while a run or recording is active");
    }
    this.snapshotValue.solo.preferences = normaliseSoloSessionPreferences(preferences);
    this.clearSoloSelection();
    this.episodeProvenance = null;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setSoloWorkspace(workspace: SoloWorkspaceState): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo" || !this.snapshotValue.solo) {
      throw new Error("Solo workspace state requires a Solo session");
    }
    this.snapshotValue.solo.workspace = normaliseSoloWorkspaceState(workspace);
    return [];
  }

  /**
   * A null deadline defers the countdown. The task is selected and the run is
   * committed, but the countdown does not begin until `armSoloStartCountdown`
   * observes both hands tracked.
   */
  selectSoloStartTask(taskId: string, countdownDeadlineMs: number | null): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo" || !this.snapshotValue.solo) {
      throw new Error("A Solo start task requires a Solo session");
    }
    if ((this.snapshotValue.run.status !== "stopped" && this.snapshotValue.run.status !== "complete")
      || this.snapshotValue.currentEpisode
      || this.snapshotValue.pendingEpisode
      || this.snapshotValue.run.recordingState !== "idle") {
      throw new Error("The Solo start task cannot change while a run or recording is active");
    }
    if (countdownDeadlineMs !== null
      && (!Number.isSafeInteger(countdownDeadlineMs) || countdownDeadlineMs < 0)) {
      throw new Error("The Solo countdown deadline is invalid");
    }
    const taskIndex = this.snapshotValue.configuration.tasks.findIndex((task) => task.id === taskId);
    const task = this.snapshotValue.configuration.tasks[taskIndex];
    if (!task || !isRepetitionTask(task)) throw new Error("Select a recordable Solo start task");
    if (!this.snapshotValue.sequenceReadiness.ready) {
      throw new Error(this.snapshotValue.sequenceReadiness.blockers.map((blocker) => blocker.message).join("; "));
    }
    if (this.snapshotValue.run.status === "complete") this.snapshotValue.run = initialRun();
    this.snapshotValue.run.activeTaskIndex = taskIndex;
    this.snapshotValue.solo.selectedStartTaskId = task.id;
    this.snapshotValue.solo.startCountdownDeadlineMs = countdownDeadlineMs;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  /**
   * Starts the countdown for a start task that was selected while the
   * demonstrator still had a controller in hand.
   */
  armSoloStartCountdown(countdownDeadlineMs: number): DirectCaptureCommand[] {
    const solo = this.snapshotValue.solo;
    if (this.snapshotValue.operatingMode !== "solo" || !solo) return [];
    if (this.snapshotValue.run.status !== "stopped" || this.snapshotValue.run.recordingState !== "idle") return [];
    if (solo.selectedStartTaskId === null || solo.startCountdownDeadlineMs !== null) return [];
    if (!Number.isSafeInteger(countdownDeadlineMs) || countdownDeadlineMs < 0) {
      throw new Error("The Solo countdown deadline is invalid");
    }
    if (!soloHandsReadyToRecord(this.snapshotValue.captureStatus)) return [];
    solo.startCountdownDeadlineMs = countdownDeadlineMs;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  cancelSoloStart(): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo" || !this.snapshotValue.solo) return [];
    if (this.snapshotValue.run.status !== "stopped") return [];
    if (this.snapshotValue.solo.selectedStartTaskId === null
      && this.snapshotValue.solo.startCountdownDeadlineMs === null) return [];
    this.clearSoloSelection();
    this.episodeProvenance = null;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  resetCompletedSoloRun(): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo" || !this.snapshotValue.solo) {
      throw new Error("Only a completed Solo run can be reset");
    }
    if (this.snapshotValue.run.status === "stopped") return [];
    if (this.snapshotValue.run.status !== "complete"
      || this.snapshotValue.run.recordingState !== "idle"
      || this.snapshotValue.currentEpisode
      || this.snapshotValue.pendingEpisode) {
      throw new Error("Wait for the Solo run to finish finalising before resetting it");
    }
    this.snapshotValue.run = initialRun();
    this.clearSoloSelection();
    this.episodeProvenance = null;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setEpisodeProvenance(provenance: DirectEpisodeProvenance | null) {
    if (provenance && provenance.operatingMode !== "solo") {
      throw new Error("Direct episode provenance must identify Solo operation");
    }
    if (provenance && (
      !provenance.selectedStartTaskId
      || !Number.isSafeInteger(provenance.startCountdownMs)
      || provenance.startCountdownMs < 0
      || !Number.isSafeInteger(provenance.taskSpecVersion)
      || provenance.taskSpecVersion < 1
      || !/^[0-9a-f]{64}$/.test(provenance.taskSpecHash)
    )) {
      throw new Error("Solo episode provenance is invalid");
    }
    this.episodeProvenance = provenance ? structuredClone(provenance) : null;
  }

  synchronise(): DirectCaptureCommand[] {
    const commands: DirectCaptureCommand[] = [
      {
        type: "configuration",
        configuration: structuredClone(this.snapshotValue.configuration),
        revision: this.snapshotValue.configurationStatus.revision,
        checksum: this.snapshotValue.configurationStatus.checksum,
      },
      { type: "hand-display", settings: structuredClone(this.snapshotValue.handDisplay) },
      { type: "camera-registration", registration: structuredClone(this.snapshotValue.cameraRegistration ?? null) },
      this.runStateCommand(),
    ];
    const recovery = this.recoveryCommand();
    if (recovery) commands.push(recovery);
    return commands;
  }

  pendingFinalisation() {
    const episode = this.snapshotValue.currentEpisode;
    return this.snapshotValue.run.recordingState === "stopping" && episode
      ? { episodeId: episode.id }
      : null;
  }

  configure(configuration: CaptureConfiguration): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode === "solo"
      && (this.snapshotValue.run.status === "running"
        || this.snapshotValue.run.status === "complete"
        || this.snapshotValue.run.recordingState !== "idle"
        || this.snapshotValue.currentEpisode !== null
        || this.snapshotValue.pendingEpisode !== null)) {
      throw new Error("Solo configuration is locked until the current run is ready for configuration");
    }
    this.revision += 1;
    const checksum = `direct-${this.revision}`;
    this.snapshotValue.configuration = structuredClone(configuration);
    this.snapshotValue.configurationStatus = { state: "sent", revision: this.revision, checksum, appliedRevision: null, error: null };
    this.snapshotValue.run = initialRun();
    if (this.snapshotValue.solo) {
      this.snapshotValue.solo.selectedStartTaskId = null;
      this.snapshotValue.solo.startCountdownDeadlineMs = null;
    }
    this.episodeProvenance = null;
    this.pendingActiveTaskPublication = false;
    this.snapshotValue.captureStatus = {
      ...this.snapshotValue.captureStatus,
      recorder: "arming",
      recorderRateHz: configuration.recorderRateHz,
      lastError: null,
    };
    this.refreshReadiness();
    return [
      { type: "configuration", configuration: structuredClone(configuration), revision: this.revision, checksum },
      this.runStateCommand(),
    ];
  }

  setCameraRegistration(registration: CameraRegistration | null): DirectCaptureCommand[] {
    this.snapshotValue.cameraRegistration = structuredClone(registration);
    return [{ type: "camera-registration", registration: structuredClone(registration) }];
  }

  configurationApplied(revision: number, checksum: string): DirectCaptureCommand[] {
    const status = this.snapshotValue.configurationStatus;
    if (revision !== status.revision || checksum !== status.checksum) throw new Error("Capture acknowledged a non-current direct configuration");
    status.state = "applied";
    status.appliedRevision = revision;
    status.error = null;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  setHandDisplay(settings: HandDisplaySettings): DirectCaptureCommand[] {
    this.snapshotValue.handDisplay = structuredClone(settings);
    return [{ type: "hand-display", settings: structuredClone(settings) }];
  }

  control(action: DirectRunControlAction, actor?: DirectRunControlActor, nextCursor?: string): DirectCaptureCommand[] {
    if (action === "start-sequence") return actor ? this.toggleReady(actor) : this.beginSequence();
    if (action === "start") return [this.runStateCommand()];
    if (action === "pause") return this.pauseRecording();
    if (action === "resume") return this.resumeRecording();
    if (action === "stop"
      && this.snapshotValue.operatingMode === "solo"
      && this.snapshotValue.run.status === "stopped") {
      return this.cancelSoloStart();
    }
    if (action === "stop") return this.stopRun();
    if (action === "finish" && actor !== "demonstrator") {
      throw new Error("Only the demonstrator can finish the run");
    }
    const normalisedAction = action === "next" ? "next-task" : action;
    if (isStateBoundRunControlAction(normalisedAction)
      && nextCursor !== nextRunControlCursor(this.snapshotValue, normalisedAction)) {
      return [this.runStateCommand()];
    }
    if (action === "finish") return this.finishRun();
    if (action === "success" || action === "fail") {
      return this.annotateTake(action === "success" ? "pass" : "fail", actor ?? "director");
    }
    if (action === "retry") return this.retryTake(actor ?? "director");
    return this.nextTake(actor ?? "director");
  }

  reviewFinalisedSoloEpisode(episodeId: string, annotation: "pass" | "fail"): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo") {
      throw new Error("Post-acquisition QA is available only for Solo episodes");
    }
    const acceptedIndex = this.snapshotValue.episodes.findIndex(({ id }) => id === episodeId);
    const attemptIndex = this.snapshotValue.attempts.findIndex(({ id }) => id === episodeId);
    const fromAccepted = acceptedIndex >= 0;
    const index = fromAccepted ? acceptedIndex : attemptIndex;
    const source = fromAccepted ? this.snapshotValue.episodes : this.snapshotValue.attempts;
    const episode = index >= 0 ? source[index] : undefined;
    if (!episode || !episode.endedAt || episode.integrity !== "valid") {
      throw new Error("Post-acquisition QA requires a durably finalised Solo episode");
    }
    if (episode.annotation === annotation && episode.accepted === (annotation === "pass")) return [];
    episode.annotation = annotation;
    episode.accepted = annotation === "pass";
    for (const segment of episode.segments ?? []) {
      segment.accepted = episode.accepted
        && segment.outcome === "completed"
        && (segment.recorderSlotCount ?? 0) > 0
        && segment.startSourceTimestampUs !== undefined
        && segment.endSourceTimestampUs !== undefined;
    }
    if ((annotation === "pass") === fromAccepted) return [this.runStateCommand()];
    source.splice(index, 1);
    const destination = annotation === "pass" ? this.snapshotValue.episodes : this.snapshotValue.attempts;
    destination.unshift(episode);
    return [this.runStateCommand()];
  }

  recordingAccepted(episodeId: string): DirectCaptureCommand[] {
    const episode = this.snapshotValue.pendingEpisode;
    if (!episode) {
      const activeDuplicate = this.snapshotValue.currentEpisode?.id === episodeId
        && (this.snapshotValue.run.recordingState === "recording"
          || this.snapshotValue.run.recordingState === "paused"
          || this.snapshotValue.run.recordingState === "stopping");
      if (activeDuplicate
        || this.snapshotValue.episodes.some((entry) => entry.id === episodeId)
        || this.snapshotValue.attempts.some((entry) => entry.id === episodeId)) return [];
    }
    const transition = episode ? this.pendingTransition(episode) : null;
    const pendingStop = episode?.id === episodeId
      && this.snapshotValue.run.recordingState === "stopping"
      && (transition === "stop-run" || transition === "finish-run");
    if (!episode || episode.id !== episodeId
      || (this.snapshotValue.run.recordingState !== "arming" && !pendingStop)) {
      throw new Error("Capture accepted an unexpected direct recording");
    }
    const now = this.now();
    this.snapshotValue.pendingEpisode = null;
    this.snapshotValue.currentEpisode = episode;
    const commands: DirectCaptureCommand[] = [
      { type: "control", action: "recording-started", episode: structuredClone(episode) },
    ];
    if (transition !== null) {
      this.snapshotValue.run.recordingState = "stopping";
      this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "recording", lastError: null };
      commands.push({ type: "control", action: "recording-stopping", episode: structuredClone(episode) });
    } else if (this.pendingActiveTaskPublication || this.snapshotValue.run.phase === "active-task") {
      if (this.pendingActiveTaskPublication) {
        this.snapshotValue.run.phase = "active-task";
        this.snapshotValue.run.takeStartedAtMs = now;
        this.snapshotValue.run.takeElapsedMs = 0;
        this.pendingActiveTaskPublication = false;
      }
      this.snapshotValue.run.recordingState = "recording";
      this.snapshotValue.run.recordingStartedAtMs = now;
      this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "recording", lastError: null };
    } else {
      this.snapshotValue.run.recordingState = "paused";
      this.snapshotValue.run.recordingStartedAtMs = null;
      this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "paused", lastError: null };
      commands.push({ type: "control", action: "recording-paused", episode: structuredClone(episode) });
    }
    this.refreshReadiness();
    commands.push(this.runStateCommand());
    return commands;
  }

  recordingRejected(episodeId: string, error: string): DirectCaptureCommand[] {
    const episode = this.snapshotValue.pendingEpisode;
    if (!episode && this.snapshotValue.attempts.some((entry) => entry.id === episodeId)) return [];
    const transition = episode ? this.pendingTransition(episode) : null;
    const pendingStop = episode?.id === episodeId
      && this.snapshotValue.run.recordingState === "stopping"
      && (transition === "stop-run" || transition === "finish-run");
    if (!episode || episode.id !== episodeId
      || (this.snapshotValue.run.recordingState !== "arming" && !pendingStop)) {
      throw new Error("Capture rejected an unexpected direct recording");
    }
    const rejectedSegment = this.latestSegment(episode);
    if (rejectedSegment?.outcome === "recording") {
      rejectedSegment.endedAt = new Date(this.now()).toISOString();
      rejectedSegment.outcome = "stopped";
      rejectedSegment.accepted = false;
    }
    episode.endedAt = new Date(this.now()).toISOString();
    episode.outcome = "stopped";
    episode.integrity = "interrupted";
    episode.integrityReason = error;
    this.snapshotValue.attempts.unshift(structuredClone(episode));
    this.snapshotValue.pendingEpisode = null;
    this.pendingActiveTaskPublication = false;
    this.snapshotValue.run.recordingState = "idle";
    this.snapshotValue.run.recordingStartedAtMs = null;
    this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "failed", lastError: error };
    if (transition === "stop-run") this.finishStoppedRun();
    else this.finishErroredRun(error);
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  recordingFinalised(episodeId: string, summary: MonitorRecordingSummary | undefined, error?: string): DirectCaptureCommand[] {
    const currentEpisode = this.snapshotValue.currentEpisode;
    if (!currentEpisode && (this.snapshotValue.episodes.some((entry) => entry.id === episodeId)
      || this.snapshotValue.attempts.some((entry) => entry.id === episodeId))) return [];
    if (!currentEpisode || currentEpisode.id !== episodeId || this.snapshotValue.run.recordingState !== "stopping") throw new Error("Capture finalised an unexpected direct recording");
    let episode = structuredClone(currentEpisode);
    const transition = this.pendingTransition(episode);
    const requestedOutcome: DirectRecordingOutcome = episode.outcome === "completed" ? "completed" : "stopped";
    let summaryValidationFailure: string | undefined;
    if (summary) {
      try {
        episode.frameCount = summary.frameCount;
        episode.gapCount = summary.gapCount;
        episode.mediaChunkCount = summary.mediaChunkCount;
        episode.recorderSlotCount = summary.recorderSlotCount;
        if (summary.firstRecorderSequence !== null) episode.firstRecorderSequence = summary.firstRecorderSequence;
        if (summary.lastRecorderSequence !== null) episode.lastRecorderSequence = summary.lastRecorderSequence;
        episode.qualitySummary.frameCount = summary.frameCount;
        episode.qualitySummary.gapCount = summary.gapCount;
        episode.qualitySummary.decision = summary.gapCount > 0 ? "caution" : "go";
        episode.qualitySummary.reasons = summary.gapCount > 0 ? [`${summary.gapCount} recorder gap${summary.gapCount === 1 ? "" : "s"}`] : [];
        for (const entry of summary.runEvents ?? []) {
          this.applyRecorderRunEvent(episode, entry.event, entry.sourceTimestampUs);
        }
        for (const segment of episode.segments ?? []) {
          const segmentSummary = summary.segmentSummaries?.[segment.id];
          segment.frameCount = segmentSummary?.frameCount ?? 0;
          segment.gapCount = segmentSummary?.gapCount ?? 0;
          segment.recorderSlotCount = segmentSummary?.recorderSlotCount ?? 0;
        }
      } catch (validationError) {
        summaryValidationFailure = validationError instanceof Error
          ? validationError.message
          : "The monitor recorder summary is invalid";
        episode = structuredClone(currentEpisode);
      }
    }
    const segments = episode.segments ?? [];
    const uncoveredSegment = segments.find((segment) => (
      segment.outcome === "completed" || segment.outcome === "retry"
    ) && (segment.recorderSlotCount ?? 0) === 0);
    const unboundedSegment = segments.find((segment) => (
      segment.outcome === "completed" || segment.outcome === "retry"
    ) && (segment.startSourceTimestampUs === undefined || segment.endSourceTimestampUs === undefined));
    const reversedSegment = segments.find((segment) => (
      segment.outcome === "completed" || segment.outcome === "retry"
    ) && segment.startSourceTimestampUs !== undefined
      && segment.endSourceTimestampUs !== undefined
      && segment.startSourceTimestampUs > segment.endSourceTimestampUs);
    const invalidAccountingSegment = segments.find((segment) => {
      const frameCount = segment.frameCount ?? 0;
      const gapCount = segment.gapCount ?? 0;
      const slotCount = segment.recorderSlotCount ?? 0;
      return !Number.isSafeInteger(frameCount) || frameCount < 0
        || !Number.isSafeInteger(gapCount) || gapCount < 0
        || !Number.isSafeInteger(slotCount) || slotCount < 0
        || slotCount !== frameCount + gapCount;
    });
    const segmentFrameCount = segments.reduce((total, segment) => total + (segment.frameCount ?? 0), 0);
    const segmentSlotCount = segments.reduce((total, segment) => total + (segment.recorderSlotCount ?? 0), 0);
    const segmentGapCount = segments.reduce((total, segment) => total + (segment.gapCount ?? 0), 0);
    const frameLeakage = segments.length > 0 && segmentFrameCount !== episode.frameCount;
    const slotLeakage = segments.length > 0 && segmentSlotCount !== (episode.recorderSlotCount ?? 0);
    const gapLeakage = segments.length > 0 && segmentGapCount !== (episode.gapCount ?? 0);
    const failure = error
      ?? summaryValidationFailure
      ?? (!summary || summary.frameCount === 0 ? "The monitor recorder received no sensor frames for this episode" : undefined)
      ?? (uncoveredSegment ? `Task segment ${uncoveredSegment.taskLabel} has no durable recorder slots` : undefined)
      ?? (unboundedSegment && unboundedSegment.startSourceTimestampUs === undefined
        ? `Task segment ${unboundedSegment.taskLabel} has no durable segment-start event`
        : undefined)
      ?? (unboundedSegment && unboundedSegment.endSourceTimestampUs === undefined
        ? `Task segment ${unboundedSegment.taskLabel} has no durable segment-end event`
        : undefined)
      ?? (reversedSegment ? `Task segment ${reversedSegment.taskLabel} ends before its durable segment-start event` : undefined)
      ?? (invalidAccountingSegment
        ? `Task segment ${invalidAccountingSegment.taskLabel} recorder accounting is inconsistent`
        : undefined)
      ?? (frameLeakage ? "Episode sensor frames are not fully attributed to durable task segments" : undefined)
      ?? (slotLeakage ? "Episode recorder slots are not fully attributed to durable task segments" : undefined)
      ?? (gapLeakage ? "Episode recorder gaps are not fully attributed to durable task segments" : undefined)
      ?? (transition === null ? "The pending direct run transition could not be recovered" : undefined);
    const terminalRecorderFailure = error
      ?? summaryValidationFailure
      ?? (!summary ? "The monitor recorder did not provide a finalisation summary" : undefined);
    if (failure) {
      const failedSegment = this.latestSegment(episode);
      if (failedSegment?.outcome === "recording") {
        failedSegment.endedAt = new Date(this.now()).toISOString();
        failedSegment.outcome = "stopped";
      }
    }
    episode.endedAt = new Date(this.now()).toISOString();
    episode.outcome = failure ? "stopped" : requestedOutcome;
    episode.accepted = !failure && episode.outcome === "completed";
    episode.integrity = failure ? "interrupted" : "valid";
    if (episode.accepted && episode.runFinalisation === "finish-requested") {
      episode.runFinalisation = "finish-completed";
    }
    if (failure) episode.integrityReason = failure;
    for (const segment of segments) {
      segment.accepted = episode.accepted
        && segment.outcome === "completed"
        && (segment.recorderSlotCount ?? 0) > 0
        && segment.startSourceTimestampUs !== undefined
        && segment.endSourceTimestampUs !== undefined
        && segment.startSourceTimestampUs <= segment.endSourceTimestampUs;
    }
    if (episode.accepted) this.snapshotValue.episodes.unshift(structuredClone(episode));
    else this.snapshotValue.attempts.unshift(structuredClone(episode));
    this.snapshotValue.currentEpisode = null;
    this.snapshotValue.pendingEpisode = null;
    this.snapshotValue.run.recordingState = "idle";
    this.snapshotValue.run.recordingStartedAtMs = null;
    const recorderFailure = requestedOutcome === "completed" ? failure : terminalRecorderFailure;
    this.snapshotValue.captureStatus = recorderFailure
      ? { ...this.snapshotValue.captureStatus, recorder: "failed", lastError: recorderFailure }
      : { ...this.snapshotValue.captureStatus, recorder: "armed", lastError: null };
    this.recordingTransitions.delete(episode.id);
    if (transition === "stop-run") {
      const startedAtMs = this.snapshotValue.run.startedAtMs;
      const endedAtMs = Date.parse(episode.endedAt);
      this.finishStoppedRun();
      this.snapshotValue.run.startedAtMs = startedAtMs;
      this.snapshotValue.run.endedAtMs = endedAtMs;
    }
    else if (transition === "finish-run" && !failure) this.finishCompletedRun(Date.parse(episode.endedAt));
    else if (failure) this.finishErroredRun(failure);
    else if (transition !== "cycle-boundary") this.finishErroredRun("The pending direct run transition could not be recovered");
    this.refreshReadiness();
    return [
      { type: "control", action: "recording-stopped", episode: structuredClone(episode) },
      this.runStateCommand(),
    ];
  }

  interruptSoloRecovery(
    summary: MonitorRecordingSummary | undefined,
    reason = "Solo recording was interrupted before durable finalisation completed",
  ): DirectCaptureCommand[] {
    if (this.snapshotValue.operatingMode !== "solo") {
      throw new Error("Only a Solo session can interrupt stale local recorder authority");
    }
    const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    const recordingState = this.snapshotValue.run.recordingState;
    if (!episode || (recordingState !== "arming"
      && recordingState !== "recording"
      && recordingState !== "paused"
      && recordingState !== "stopping")) return [];
    this.snapshotValue.currentEpisode = episode;
    this.snapshotValue.pendingEpisode = null;
    this.snapshotValue.run.recordingState = "stopping";
    this.markPendingTransition(episode, "stopped", "stop-run");
    return this.recordingFinalised(episode.id, summary, reason)
      .filter((command) => command.type === "run-state");
  }

  private applyRecorderRunEvent(
    episode: Episode,
    event: RecorderRunEvent,
    sourceTimestampUs: number,
  ) {
    const segment = episode.segments?.find((candidate) => candidate.id === event.segmentId);
    if (!segment) throw new Error("Recorder run event identifies an unknown task segment");
    if (event.type === "annotation") {
      const annotation = segment.annotations.find((candidate) => candidate.id === event.annotationId);
      if (!annotation || annotation.action !== event.action || annotation.actor !== event.actor) {
        throw new Error("Recorder annotation event does not match the authoritative cycle annotation");
      }
      if (annotation.sourceTimestampUs !== undefined && annotation.sourceTimestampUs !== sourceTimestampUs) {
        throw new Error("Recorder annotation event source timestamp conflicts with the authoritative cycle annotation");
      }
      annotation.sourceTimestampUs ??= sourceTimestampUs;
      return;
    }
    if (segment.taskId !== event.taskId || segment.taskLabel !== event.taskLabel) {
      throw new Error("Recorder run event task metadata does not match the authoritative cycle segment");
    }
    if (event.type === "segment-start" && segment.endSourceTimestampUs !== undefined) {
      throw new Error("Recorder segment-start event follows its durable segment-end event");
    }
    if (event.type === "segment-end") {
      if (segment.startSourceTimestampUs === undefined) {
        throw new Error("Recorder segment-end event has no durable segment-start event");
      }
      if (sourceTimestampUs < segment.startSourceTimestampUs) {
        throw new Error("Recorder segment-end event precedes its durable segment-start event");
      }
    }
    const existingTimestampUs = event.type === "segment-start"
      ? segment.startSourceTimestampUs
      : segment.endSourceTimestampUs;
    if (existingTimestampUs !== undefined && existingTimestampUs !== sourceTimestampUs) {
      throw new Error("Recorder run event source timestamp conflicts with the authoritative cycle segment");
    }
    if (event.type === "segment-start") segment.startSourceTimestampUs ??= sourceTimestampUs;
    else segment.endSourceTimestampUs ??= sourceTimestampUs;
  }

  advanceTime(): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    if (run.status === "stopped"
      && this.snapshotValue.operatingMode === "solo"
      && this.snapshotValue.solo?.startCountdownDeadlineMs != null) {
      if (!this.snapshotValue.sequenceReadiness.ready) return this.cancelSoloStart();
      if (!soloHandsReadyToRecord(this.snapshotValue.captureStatus)) return this.cancelSoloStart();
      if (this.now() >= this.snapshotValue.solo.startCountdownDeadlineMs) return this.beginSequence();
      return [];
    }
    if (run.status === "stopped" && run.syncLockStartedAtMs != null
      && this.now() - run.syncLockStartedAtMs >= SYNC_LOCK_MS) {
      return this.beginSequence();
    }
    if (run.status !== "running") return [];
    const now = this.now();
    if ((run.phase === "post-task-pause" || run.phase === "task-pause" || run.phase === "cycle-pause")
      && run.resetDeadlineMs !== null
      && now >= run.resetDeadlineMs) {
      if (run.phase === "cycle-pause") return this.finishCyclePause();
      return this.finishReset();
    }
    const task = this.currentTask();
    if (!task || task.type !== "timed"
      || run.phase !== "active-task"
      || run.recordingState === "paused"
      || run.recordingState === "stopping"
      || run.takeStartedAtMs === null) return [];
    const elapsedMs = run.takeElapsedMs + Math.max(0, now - run.takeStartedAtMs);
    if (elapsedMs < task.durationS * 1_000) return [];
    return this.completeCurrentTask(now);
  }

  private toggleReady(actor: DirectRunControlActor): DirectCaptureCommand[] {
    const run = this.snapshotValue.run;
    if (run.status !== "stopped") throw new Error("Readiness can only change before the run starts");
    const key = actor === "director" ? "directorReady" : "demonstratorReady";
    if (run[key] === true) {
      run[key] = false;
      run.syncLockStartedAtMs = null;
    } else {
      if (!this.snapshotValue.sequenceReadiness.ready) {
        throw new Error(this.snapshotValue.sequenceReadiness.blockers.map((blocker) => blocker.message).join("; "));
      }
      run[key] = true;
      if (run.directorReady === true && run.demonstratorReady === true) run.syncLockStartedAtMs = this.now();
    }
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  private beginSequence(): DirectCaptureCommand[] {
    if (!this.snapshotValue.sequenceReadiness.ready) {
      throw new Error(this.snapshotValue.sequenceReadiness.blockers.map((blocker) => blocker.message).join("; "));
    }
    let startTaskIndex = 0;
    if (this.snapshotValue.operatingMode === "solo") {
      const solo = this.snapshotValue.solo;
      if (!solo?.selectedStartTaskId
        || solo.startCountdownDeadlineMs === null
        || this.now() < solo.startCountdownDeadlineMs) {
        throw new Error("Select a Solo start task and wait for its countdown");
      }
      startTaskIndex = this.snapshotValue.configuration.tasks.findIndex((task) => task.id === solo.selectedStartTaskId);
      if (startTaskIndex < 0 || !isRepetitionTask(this.snapshotValue.configuration.tasks[startTaskIndex]!)) {
        throw new Error("The selected Solo start task is no longer available");
      }
      solo.startCountdownDeadlineMs = null;
    }
    this.snapshotValue.run = initialRun();
    this.snapshotValue.run.status = "running";
    this.snapshotValue.run.startedAtMs = this.now();
    this.snapshotValue.run.recordingLatched = true;
    this.snapshotValue.run.activeTaskIndex = startTaskIndex;
    this.enterCurrentRunItem(true);
    this.refreshReadiness();
    const commands = this.startOrResumeRecordingForCurrentTask();
    return commands.length > 0 ? commands : [this.runStateCommand()];
  }

  private startOrResumeRecordingForCurrentTask(): DirectCaptureCommand[] {
    const task = this.currentTask();
    if (this.snapshotValue.run.status !== "running" || this.snapshotValue.run.phase !== "active-task"
      || !task || !isRepetitionTask(task)) return [];
    if (this.snapshotValue.pendingEpisode) {
      const episode = this.snapshotValue.pendingEpisode;
      if (this.latestSegment(episode)?.outcome === "recording") return [];
      const segment = this.openCurrentSegment(episode);
      return [this.recordingEventCommand(episode, {
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      })];
    }
    if (this.snapshotValue.currentEpisode) {
      if (this.snapshotValue.run.recordingState !== "paused") return [];
      const segment = this.openCurrentSegment(this.snapshotValue.currentEpisode);
      return [this.recordingEventCommand(this.snapshotValue.currentEpisode, {
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      }), ...this.resumeRecording()];
    }
    return this.startRecording();
  }

  private startRecording(): DirectCaptureCommand[] {
    if (!this.snapshotValue.recordingReadiness.ready) throw new Error(this.snapshotValue.recordingReadiness.blockers.map((blocker) => blocker.message).join("; "));
    const task = this.currentTask()!;
    if (this.snapshotValue.operatingMode === "solo") {
      const solo = this.snapshotValue.solo;
      if (!this.episodeProvenance
        || this.episodeProvenance.selectedStartTaskId !== solo?.selectedStartTaskId
        || this.episodeProvenance.startCountdownMs !== solo.preferences.startCountdownMs) {
        throw new Error("Solo episode provenance is not prepared for the selected run");
      }
    }
    const episode: Episode = {
      id: this.allocateId(),
      runTitle: this.snapshotValue.configuration.runTitle,
      runDescription: this.snapshotValue.configuration.runDescription,
      taskId: task.id,
      taskLabel: task.label,
      taskDescription: task.instructions,
      cycle: this.snapshotValue.run.cycle,
      repetition: this.snapshotValue.run.repetition,
      take: this.snapshotValue.run.take,
      startedAt: new Date(this.now()).toISOString(),
      outcome: "recording",
      annotation: null,
      accepted: false,
      integrity: "pending",
      configurationRevision: this.snapshotValue.configurationStatus.revision,
      frameCount: 0,
      mediaChunkCount: 0,
      qualitySummary: emptyQualitySummary(),
      qualityEvents: [],
      captureMetadata: captureMetadataFromStatus(
        this.snapshotValue.captureStatus,
        this.snapshotValue.cameraRegistration,
        this.snapshotValue.configuration,
      ),
      ...(this.episodeProvenance ? structuredClone(this.episodeProvenance) : {}),
      segments: [],
    };
    const segment = this.openCurrentSegment(episode);
    this.snapshotValue.pendingEpisode = episode;
    this.snapshotValue.run.recordingState = "arming";
    this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "arming", lastError: null };
    const commands: DirectCaptureCommand[] = [
      { type: "control", action: "recording-arming", episode: structuredClone(episode) },
      this.recordingEventCommand(episode, {
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      }),
    ];
    this.pendingActiveTaskPublication = true;
    this.snapshotValue.run.phase = null;
    this.snapshotValue.run.takeStartedAtMs = null;
    this.snapshotValue.run.takeElapsedMs = 0;
    this.refreshReadiness();
    return commands;
  }

  private resumeRecording(): DirectCaptureCommand[] {
    const episode = this.snapshotValue.currentEpisode;
    if (!episode || this.snapshotValue.run.status !== "running" || this.snapshotValue.run.phase !== "active-task"
      || this.snapshotValue.run.recordingState !== "paused") {
      throw new Error("Only a paused direct recording can be resumed");
    }
    const now = this.now();
    this.snapshotValue.run.takeStartedAtMs ??= now;
    this.snapshotValue.run.recordingStartedAtMs = now;
    this.snapshotValue.run.recordingState = "recording";
    this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "recording" };
    this.refreshReadiness();
    return [
      { type: "control", action: "recording-resumed", episode: structuredClone(episode) },
      this.runStateCommand(),
    ];
  }

  private annotateTake(annotation: "pass" | "fail", actor: DirectRunControlActor): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    if (run.status !== "running" || run.phase !== "post-task-pause" || !run.reviewEpisodeId) {
      throw new Error("Pass and fail are only available during the task reset");
    }
    const episode = this.activeCycleEpisode(run.reviewEpisodeId);
    if (!episode) throw new Error("The task available for annotation is no longer present");
    const segment = this.appendSegmentAnnotation(episode, annotation, actor);
    const annotationEntry = segment.annotations.at(-1)!;
    episode.annotation = annotation;
    this.refreshReadiness();
    return [this.recordingEventCommand(episode, {
      type: "annotation",
      segmentId: segment.id,
      annotationId: annotationEntry.id,
      action: annotation,
      actor,
    }), this.runStateCommand()];
  }

  private pauseRecording(): DirectCaptureCommand[] {
    const episode = this.snapshotValue.currentEpisode;
    if (!episode || this.snapshotValue.run.status !== "running" || this.snapshotValue.run.phase !== "active-task"
      || this.snapshotValue.run.recordingState !== "recording") {
      throw new Error("Only an active direct recording can be paused");
    }
    this.freezeRunClocks();
    this.snapshotValue.run.recordingState = "paused";
    this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "paused" };
    this.refreshReadiness();
    return [
      { type: "control", action: "recording-paused", episode: structuredClone(episode) },
      this.runStateCommand(),
    ];
  }

  private retryTake(actor: DirectRunControlActor): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    const boundaryCommands = run.status === "running" && run.phase === "active-task"
      ? this.completeCurrentTask()
      : [];
    if (run.status !== "running" || run.phase !== "post-task-pause" || !run.reviewEpisodeId) {
      throw new Error("Retry is only available during the task reset");
    }
    const episode = this.activeCycleEpisode(run.reviewEpisodeId);
    const segment = episode ? this.latestSegment(episode) : null;
    if (!episode || !segment) throw new Error("The task available for retry is no longer present");
    this.appendSegmentAnnotation(episode, "retry", actor);
    const annotationEntry = segment.annotations.at(-1)!;
    segment.outcome = "retry";
    segment.accepted = false;
    this.refreshReadiness();
    return [...boundaryCommands.slice(0, -1), this.recordingEventCommand(episode, {
      type: "annotation",
      segmentId: segment.id,
      annotationId: annotationEntry.id,
      action: "retry",
      actor,
    }), this.runStateCommand()];
  }

  private nextTake(actor: DirectRunControlActor): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    if (run.status !== "running") throw new Error("Start the direct run before advancing the task sequence");
    if (run.phase === "cycle-pause") {
      return this.finishCyclePause();
    }
    if (run.phase === "active-task") {
      const commands = this.completeCurrentTask();
      const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
      if (episode) {
        const segment = this.appendSegmentAnnotation(episode, "next", actor);
        const annotationEntry = segment.annotations.at(-1)!;
        commands.splice(1, 0, this.recordingEventCommand(episode, {
          type: "annotation",
          segmentId: segment.id,
          annotationId: annotationEntry.id,
          action: "next",
          actor,
        }));
      }
      return commands;
    }
    if (run.phase !== "post-task-pause" && run.phase !== "task-pause") {
      throw new Error("Next is only available during a reset");
    }
    if (run.phase === "post-task-pause" && run.reviewEpisodeId) {
      const episode = this.activeCycleEpisode(run.reviewEpisodeId);
      if (episode) {
        const segment = this.appendSegmentAnnotation(episode, "next", actor);
        const annotationEntry = segment.annotations.at(-1)!;
        const commands = this.advanceAfterReset(false);
        commands.unshift(this.recordingEventCommand(episode, {
          type: "annotation",
          segmentId: segment.id,
          annotationId: annotationEntry.id,
          action: "next",
          actor,
        }));
        return commands;
      }
    }
    return this.advanceAfterReset(false);
  }

  private requestRecordingStop(outcome: DirectRecordingOutcome, transition: DirectRunTransition): DirectCaptureCommand[] {
    const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    if (!episode) throw new Error("There is no active direct recording to stop");
    this.markPendingTransition(episode, outcome, transition);
    if (this.snapshotValue.run.recordingState === "arming") {
      this.snapshotValue.run.recordingState = "stopping";
      this.refreshReadiness();
      return [this.runStateCommand()];
    }
    if (this.snapshotValue.run.recordingState !== "recording" && this.snapshotValue.run.recordingState !== "paused") {
      throw new Error("The direct recorder is already finalising a transition");
    }
    this.freezeRunClocks();
    this.snapshotValue.run.recordingState = "stopping";
    this.refreshReadiness();
    return [
      { type: "control", action: "recording-stopping", episode: structuredClone(episode) },
      this.runStateCommand(),
    ];
  }

  private stopRun(): DirectCaptureCommand[] {
    if (this.snapshotValue.run.status !== "running") throw new Error("The direct run is not active");
    const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    if (episode && this.snapshotValue.run.recordingState === "stopping") {
      this.markPendingTransition(episode, "stopped", "stop-run");
      this.refreshReadiness();
      return [this.runStateCommand()];
    }
    if (episode) {
      const segment = this.latestSegment(episode);
      const commands: DirectCaptureCommand[] = [];
      if (segment?.outcome === "recording") {
        segment.endedAt = new Date(this.now()).toISOString();
        segment.outcome = "stopped";
        segment.accepted = false;
        if (this.snapshotValue.currentEpisode && this.snapshotValue.run.recordingState === "recording") {
          this.freezeRunClocks();
          this.snapshotValue.run.recordingState = "paused";
          this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "paused" };
          commands.push({ type: "control", action: "recording-paused", episode: structuredClone(episode) });
        }
        commands.push(this.recordingEventCommand(episode, {
          type: "segment-end",
          segmentId: segment.id,
          taskId: segment.taskId,
          taskLabel: segment.taskLabel,
        }));
      }
      return [...commands, ...this.requestRecordingStop("stopped", "stop-run")];
    }
    if (this.snapshotValue.run.recordingState !== "idle") throw new Error("The direct run is waiting for a recorder transition");
    this.finishStoppedRun();
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  private finishRun(): DirectCaptureCommand[] {
    if (this.snapshotValue.run.status !== "running") throw new Error("The direct run is not active");
    if (this.snapshotValue.run.recordingState === "arming") {
      throw new Error("Wait for the direct recorder to accept the recording before finishing the run");
    }
    const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    if (episode) {
      if (this.snapshotValue.run.recordingState === "stopping") {
        throw new Error("The direct recorder is already finalising a transition");
      }
      episode.runFinalisation = "finish-requested";
      const segment = this.latestSegment(episode);
      const commands: DirectCaptureCommand[] = [];
      if (segment?.outcome === "recording") {
        segment.endedAt = new Date(this.now()).toISOString();
        segment.outcome = "completed";
        segment.accepted = false;
        if (this.snapshotValue.currentEpisode && this.snapshotValue.run.recordingState === "recording") {
          this.freezeRunClocks();
          this.snapshotValue.run.recordingState = "paused";
          this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "paused" };
          commands.push({ type: "control", action: "recording-paused", episode: structuredClone(episode) });
        }
        commands.push(this.recordingEventCommand(episode, {
          type: "segment-end",
          segmentId: segment.id,
          taskId: segment.taskId,
          taskLabel: segment.taskLabel,
        }));
      }
      return [...commands, ...this.requestRecordingStop("completed", "finish-run")];
    }
    if (this.snapshotValue.run.recordingState !== "idle") throw new Error("The direct run is waiting for a recorder transition");
    this.finishCompletedRun(this.now());
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  private markPendingTransition(episode: Episode, outcome: DirectRecordingOutcome, transition: DirectRunTransition) {
    episode.outcome = outcome;
    this.recordingTransitions.set(episode.id, transition);
    if (transition === "stop-run" || transition === "finish-run") {
      this.snapshotValue.run.resetDeadlineMs = null;
      this.snapshotValue.run.phase = null;
    }
  }

  private pendingTransition(episode: Episode): DirectRunTransition | null {
    const stored = this.recordingTransitions.get(episode.id);
    if (stored) return stored;
    if (episode.runFinalisation === "finish-requested") return "finish-run";
    if (episode.outcome === "recording") return null;
    if (this.snapshotValue.run.phase === null) return "stop-run";
    if (this.snapshotValue.run.phase === "cycle-pause") return "cycle-boundary";
    return null;
  }

  private enterCurrentRunItem(deferActiveTask = false) {
    const task = this.currentTask();
    if (!task) {
      this.snapshotValue.run.phase = "cycle-pause";
      this.snapshotValue.run.resetDeadlineMs = this.now() + CYCLE_PAUSE_MS;
      return;
    }
    const now = this.now();
    const { run } = this.snapshotValue;
    if (!this.snapshotValue.currentEpisode && !this.snapshotValue.pendingEpisode) run.recordingState = "idle";
    run.recordingStartedAtMs = null;
    run.recordingElapsedMs = 0;
    run.takeStartedAtMs = task.type === "pause" || !deferActiveTask ? now : null;
    run.takeElapsedMs = 0;
    run.resetDeadlineMs = null;
    run.reviewEpisodeId = null;
    run.error = null;
    if (task.type === "pause") {
      run.phase = "task-pause";
      run.resetDeadlineMs = now + task.durationS * 1_000;
      return;
    }
    run.phase = "active-task";
  }

  private completeCurrentTask(now = this.now()): DirectCaptureCommand[] {
    const task = this.currentTask();
    const { run } = this.snapshotValue;
    if (run.status !== "running" || run.phase !== "active-task" || !task || !isRepetitionTask(task)) {
      throw new Error("Only an active task can enter its reset");
    }
    const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    if (!episode) throw new Error("The cycle recording is not available");
    const segment = this.latestSegment(episode);
    if (!segment || segment.outcome !== "recording") throw new Error("The active task segment is not available");
    segment.endedAt = new Date(now).toISOString();
    segment.outcome = "completed";
    segment.accepted = false;
    this.freezeRunClocks(now);
    run.phase = "post-task-pause";
    run.reviewEpisodeId = episode.id;
    run.resetDeadlineMs = now + taskResetDurationMs(task.resetTimeS);
    const commands: DirectCaptureCommand[] = [];
    if (this.snapshotValue.currentEpisode && run.recordingState === "recording") {
      run.recordingState = "paused";
      this.snapshotValue.captureStatus = { ...this.snapshotValue.captureStatus, recorder: "paused" };
      commands.push({ type: "control", action: "recording-paused", episode: structuredClone(episode) });
    }
    commands.push(this.recordingEventCommand(episode, {
      type: "segment-end",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }));
    this.refreshReadiness();
    commands.push(this.runStateCommand());
    return commands;
  }

  private finishReset(): DirectCaptureCommand[] {
    const retry = this.snapshotValue.run.phase === "post-task-pause"
      && this.latestSegment(this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode)?.outcome === "retry";
    return this.advanceAfterReset(retry);
  }

  private advanceAfterReset(retryCurrentTask: boolean): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    run.resetDeadlineMs = null;
    run.reviewEpisodeId = null;
    if (!retryCurrentTask) this.advanceRunCursor();
    if (run.activeTaskIndex >= this.snapshotValue.configuration.tasks.length) return this.beginCycleBoundary();
    this.enterCurrentRunItem(true);
    this.refreshReadiness();
    const commands = this.startOrResumeRecordingForCurrentTask();
    return commands.length > 0 ? commands : [this.runStateCommand()];
  }

  private advanceRunCursor() {
    const task = this.currentTask();
    const { run } = this.snapshotValue;
    if (!task || !isRepetitionTask(task)) {
      run.activeTaskIndex += 1;
      run.repetition = 1;
      run.take = 1;
      return;
    }
    const repetitions = Math.max(1, task.repeatCount);
    if (run.repetition < repetitions) {
      run.repetition += 1;
      run.take = run.repetition;
      return;
    }
    run.repetition = 1;
    run.take = 1;
    run.activeTaskIndex += 1;
  }

  private beginCycleBoundary(): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    run.phase = "cycle-pause";
    run.resetDeadlineMs = this.now() + CYCLE_PAUSE_MS;
    run.takeStartedAtMs = null;
    run.recordingStartedAtMs = null;
    run.error = null;
    const episode = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    if (episode) return this.requestRecordingStop("completed", "cycle-boundary");
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  private finishCyclePause(): DirectCaptureCommand[] {
    const { run } = this.snapshotValue;
    if (run.phase !== "cycle-pause") return [];
    if (this.snapshotValue.currentEpisode || this.snapshotValue.pendingEpisode || run.recordingState === "stopping") {
      return [this.runStateCommand()];
    }
    const totalCycles = Math.max(1, this.snapshotValue.configuration.totalCycles);
    run.resetDeadlineMs = null;
    if (run.cycle < totalCycles) {
      run.cycle += 1;
      run.activeTaskIndex = 0;
      run.repetition = 1;
      run.take = 1;
      this.enterCurrentRunItem(true);
      this.refreshReadiness();
      const commands = this.startOrResumeRecordingForCurrentTask();
      return commands.length > 0 ? commands : [this.runStateCommand()];
    }
    run.status = "complete";
    run.phase = null;
    run.recordingState = this.snapshotValue.currentEpisode || this.snapshotValue.pendingEpisode ? "stopping" : "idle";
    run.endedAtMs = this.now();
    run.takeStartedAtMs = null;
    run.recordingStartedAtMs = null;
    run.resetDeadlineMs = null;
    run.error = null;
    this.refreshReadiness();
    return [this.runStateCommand()];
  }

  private openCurrentSegment(episode: Episode): EpisodeSegment {
    const task = this.currentTask();
    if (!task || !isRepetitionTask(task)) throw new Error("A recordable task is required to open a segment");
    const taskDescription = task.instructions && task.instructions !== "--"
      ? task.instructions
      : this.snapshotValue.configuration.runDescription || this.snapshotValue.configuration.runTitle;
    episode.segments ??= [];
    const segment: EpisodeSegment = {
      id: `${episode.id}-segment-${episode.segments.length + 1}`,
      taskId: task.id,
      taskLabel: task.label,
      taskDescription,
      repetition: this.snapshotValue.run.repetition,
      take: this.snapshotValue.run.take,
      startedAt: new Date(this.now()).toISOString(),
      frameCount: 0,
      gapCount: 0,
      recorderSlotCount: 0,
      outcome: "recording",
      accepted: false,
      annotations: [],
    };
    episode.segments.push(segment);
    return segment;
  }

  private appendSegmentAnnotation(
    episode: Episode,
    action: EpisodeSegmentAnnotationAction,
    actor: DirectRunControlActor,
  ): EpisodeSegment {
    const segment = this.latestSegment(episode);
    if (!segment || segment.outcome === "recording") throw new Error("Only a completed task segment can be annotated");
    segment.annotations.push({
      id: `${segment.id}-annotation-${segment.annotations.length + 1}`,
      action,
      actor,
      timestampMs: this.now(),
    });
    return segment;
  }

  private latestSegment(episode: Episode | null | undefined) {
    return episode?.segments?.at(-1) ?? null;
  }

  private activeCycleEpisode(episodeId: string) {
    const active = this.snapshotValue.currentEpisode ?? this.snapshotValue.pendingEpisode;
    if (active?.id === episodeId) return active;
    return this.snapshotValue.episodes.find((episode) => episode.id === episodeId)
      ?? this.snapshotValue.attempts.find((episode) => episode.id === episodeId)
      ?? null;
  }

  private normaliseEpisodeSegments(episode: Episode | null) {
    if (!episode) return;
    episode.segments ??= [];
    for (const segment of episode.segments) {
      segment.annotations ??= [];
      segment.frameCount ??= 0;
      segment.gapCount ??= 0;
      segment.recorderSlotCount ??= 0;
    }
  }

  private recordingEventCommand(episode: Episode, event: RecorderRunEvent): DirectCaptureCommand {
    return {
      type: "control",
      action: "recording-event",
      event,
      episode: structuredClone(episode),
    };
  }

  private freezeRunClocks(now = this.now()) {
    const { run } = this.snapshotValue;
    if (run.takeStartedAtMs !== null) {
      run.takeElapsedMs += Math.max(0, now - run.takeStartedAtMs);
      run.takeStartedAtMs = null;
    }
    if (run.recordingStartedAtMs !== null) {
      run.recordingElapsedMs += Math.max(0, now - run.recordingStartedAtMs);
      run.recordingStartedAtMs = null;
    }
  }

  private finishErroredRun(error: string) {
    this.pendingActiveTaskPublication = false;
    this.freezeRunClocks();
    const { run } = this.snapshotValue;
    run.status = "error";
    run.phase = null;
    run.recordingState = "idle";
    run.endedAtMs = this.now();
    run.resetDeadlineMs = null;
    run.error = error;
    if (this.snapshotValue.operatingMode === "solo") {
      this.clearSoloSelection();
      this.episodeProvenance = null;
    }
  }

  private finishCompletedRun(endedAtMs = this.now()) {
    this.pendingActiveTaskPublication = false;
    this.freezeRunClocks(endedAtMs);
    const { run } = this.snapshotValue;
    run.status = "complete";
    run.phase = null;
    run.recordingState = "idle";
    run.endedAtMs = endedAtMs;
    run.reviewEpisodeId = null;
    run.resetDeadlineMs = null;
    run.error = null;
  }

  private finishStoppedRun(preserveRecorderStop = false) {
    this.pendingActiveTaskPublication = false;
    if (!preserveRecorderStop) {
      this.snapshotValue.pendingEpisode = null;
      this.snapshotValue.currentEpisode = null;
    }
    this.snapshotValue.run = initialRun();
    if (this.snapshotValue.operatingMode === "solo") {
      this.clearSoloSelection();
      this.episodeProvenance = null;
    }
    if (preserveRecorderStop) this.snapshotValue.run.recordingState = "stopping";
  }

  private runStateCommand(): DirectCaptureCommand {
    return {
      type: "run-state",
      state: {
        operatingMode: this.snapshotValue.operatingMode,
        solo: structuredClone(this.snapshotValue.solo),
        features: { ...this.snapshotValue.features },
        run: structuredClone(this.snapshotValue.run),
        recording: this.snapshotValue.recording,
        currentEpisode: structuredClone(this.snapshotValue.currentEpisode),
        pendingEpisode: structuredClone(this.snapshotValue.pendingEpisode),
      },
    };
  }

  private recoveryCommand(): DirectCaptureCommand | null {
    if ((this.snapshotValue.run.recordingState === "arming" || this.snapshotValue.run.recordingState === "stopping")
      && this.snapshotValue.pendingEpisode) {
      return {
        type: "control",
        action: "recording-recover-arming",
        episode: structuredClone(this.snapshotValue.pendingEpisode),
      };
    }
    if (this.snapshotValue.run.recordingState === "stopping" && this.snapshotValue.currentEpisode) {
      return {
        type: "control",
        action: "recording-recover-stopping",
        episode: structuredClone(this.snapshotValue.currentEpisode),
      };
    }
    return null;
  }

  private currentTask() {
    return this.snapshotValue.configuration.tasks[this.snapshotValue.run.activeTaskIndex] ?? null;
  }

  private clearSoloSelection() {
    if (!this.snapshotValue.solo) return;
    this.snapshotValue.solo.selectedStartTaskId = null;
    this.snapshotValue.solo.startCountdownDeadlineMs = null;
    this.snapshotValue.run.activeTaskIndex = 0;
  }

  private refreshReadiness() {
    this.synchroniseCompatibilityFields();
    const task = this.currentTask();
    const requiredPromptAudioUnavailable = (
      this.snapshotValue.operatingMode === "solo"
      && (
        this.snapshotValue.configuration.promptAudio.enabled
        || this.snapshotValue.configuration.promptAudio.useTextToSpeech
      )
      && this.snapshotValue.configuration.promptAudio.required
      && this.snapshotValue.promptAudioStatus.state !== "ready"
    );
    const soloCameraUnavailable = this.snapshotValue.operatingMode === "solo"
      && this.snapshotValue.captureStatus.camera !== "ready";
    const soloXrUnavailable = this.snapshotValue.operatingMode === "solo"
      && this.snapshotValue.captureStatus.xr !== "active";
    const soloStorageUnavailable = this.snapshotValue.operatingMode === "solo"
      && this.snapshotValue.solo?.storageHeadroom.state !== "ready";
    const sequenceBlockers: SessionSnapshot["sequenceReadiness"]["blockers"] = [];
    if (this.snapshotValue.run.status === "running") sequenceBlockers.push({ code: "sequence-active", message: "The direct sequence is already active" });
    if (!this.snapshotValue.configuration.tasks.some(isRepetitionTask)) {
      sequenceBlockers.push({ code: "no-task", message: "Configure at least one recordable task" });
    }
    if (!this.snapshotValue.captureConnected) sequenceBlockers.push({ code: "capture-disconnected", message: "The demonstrator is not connected" });
    if (this.snapshotValue.configurationStatus.state !== "applied") sequenceBlockers.push({ code: "configuration-not-applied", message: "Configuration is waiting for the demonstrator" });
    if (requiredPromptAudioUnavailable) {
      sequenceBlockers.push({
        code: "audio-not-ready",
        message: this.snapshotValue.promptAudioStatus.detail || "Required prompt audio is not ready",
      });
    }
    if (soloStorageUnavailable) {
      sequenceBlockers.push({
        code: "storage-not-ready",
        message: this.snapshotValue.solo?.storageHeadroom.detail || "Solo storage headroom is not ready",
      });
    }
    if (soloCameraUnavailable) {
      sequenceBlockers.push({
        code: "camera-not-ready",
        message: "The Solo camera is not ready",
      });
    }
    if (soloXrUnavailable) {
      sequenceBlockers.push({
        code: "xr-not-active",
        message: "The Solo XR runtime is not active",
      });
    }
    if (this.snapshotValue.captureStatus.recorder === "failed") sequenceBlockers.push({ code: "recorder-failed", message: "The demonstrator recorder failed" });
    else if (this.snapshotValue.captureStatus.recorder !== "armed") sequenceBlockers.push({ code: "recorder-not-armed", message: "The demonstrator recorder is not armed" });
    this.snapshotValue.sequenceReadiness = { ready: sequenceBlockers.length === 0, blockers: sequenceBlockers };
    const blockers: SessionSnapshot["recordingReadiness"]["blockers"] = [];
    if (this.snapshotValue.run.status !== "running") blockers.push({ code: "sequence-not-started", message: "Start the sequence before recording" });
    if (this.snapshotValue.run.phase !== "active-task") blockers.push({ code: "run-not-ready", message: "Recording is only available during an active task" });
    if (!this.snapshotValue.captureConnected) blockers.push({ code: "capture-disconnected", message: "The demonstrator is not connected" });
    if (this.snapshotValue.configurationStatus.state !== "applied") blockers.push({ code: "configuration-not-applied", message: "Configuration is waiting for the demonstrator" });
    if (requiredPromptAudioUnavailable) {
      blockers.push({
        code: "audio-not-ready",
        message: this.snapshotValue.promptAudioStatus.detail || "Required prompt audio is not ready",
      });
    }
    if (soloStorageUnavailable) {
      blockers.push({
        code: "storage-not-ready",
        message: this.snapshotValue.solo?.storageHeadroom.detail || "Solo storage headroom is not ready",
      });
    }
    if (soloCameraUnavailable) {
      blockers.push({
        code: "camera-not-ready",
        message: "The Solo camera is not ready",
      });
    }
    if (soloXrUnavailable) {
      blockers.push({
        code: "xr-not-active",
        message: "The Solo XR runtime is not active",
      });
    }
    if (!task) blockers.push({ code: "no-task", message: "There is no active task" });
    else if (task.type === "pause") blockers.push({ code: "task-not-recordable", message: "The active task is a pause" });
    if (this.snapshotValue.captureStatus.recorder === "failed") blockers.push({ code: "recorder-failed", message: "The demonstrator recorder failed" });
    else if (this.snapshotValue.captureStatus.recorder !== "armed") blockers.push({ code: "recorder-not-armed", message: "The demonstrator recorder is not armed" });
    if (this.snapshotValue.currentEpisode || this.snapshotValue.pendingEpisode || this.snapshotValue.run.recordingState !== "idle") {
      blockers.push({ code: "recording-active", message: "A recording transition is already active" });
    }
    this.snapshotValue.recordingReadiness = { ready: blockers.length === 0, blockers };
  }

  private synchroniseCompatibilityFields() {
    this.snapshotValue.activeTaskIndex = this.snapshotValue.run.activeTaskIndex;
    this.snapshotValue.recording = this.snapshotValue.run.recordingState === "recording";
  }
}

function initialRun() {
  return {
    status: "stopped" as const,
    phase: null,
    recordingState: "idle" as const,
    directorReady: false,
    demonstratorReady: false,
    syncLockStartedAtMs: null,
    recordingLatched: true,
    startedAtMs: null,
    endedAtMs: null,
    cycle: 1,
    activeTaskIndex: 0,
    repetition: 1,
    take: 1,
    takeStartedAtMs: null,
    takeElapsedMs: 0,
    recordingStartedAtMs: null,
    recordingElapsedMs: 0,
    reviewEpisodeId: null,
    resetDeadlineMs: null,
    error: null,
  };
}

function emptyQualitySummary() {
  return {
    decision: "go" as const,
    reasons: [],
    frameCount: 0,
    gapCount: 0,
    maxLeftHandSpeedMps: 0,
    maxRightHandSpeedMps: 0,
    slowHandEvents: 0,
    trackingLossEvents: 0,
  };
}
