import {
  defaultConfiguration,
  isRepetitionTask,
  normaliseCaptureConfiguration,
  normaliseSoloSessionPreferences,
  normaliseSoloStorageHeadroom,
  normaliseSoloWorkspaceState,
  soloHandsReadyToRecord,
  type CaptureConfiguration,
  type CaptureJob,
  type CaptureStatus,
  type PromptAudioStatus,
  type RuntimeFeatures,
  type SessionSnapshot,
  type SoloSessionPreferences,
  type SoloWorkspaceState,
  type VerifiedEpisodeHuggingFaceUpload,
} from "../shared/protocol.js";
import {
  CERES_TASK_SPEC_VERSION,
  taskSpecificationFromCaptureConfiguration,
  taskSpecificationSha256Hex,
} from "../shared/task-specification.js";
import type { HandDisplaySettings } from "../shared/hand-display.js";
import {
  DirectSessionReducer,
  type DirectCaptureCommand,
  type DirectRunControlAction,
} from "./direct-session-reducer.js";
import type { MonitorRecordingSummary } from "./recorder/monitor-recording-summary.js";
import {
  SoloSessionPersistence,
  type SoloRecorderControlMessage,
  type SoloSessionPersistencePort,
} from "./solo-session-persistence.js";

export interface SoloRecorderResult {
  type: "recording-accepted" | "recording-rejected" | "recording-finalised";
  episodeId: string;
  error?: string;
}

export interface SoloSessionControllerOptions {
  persistence?: SoloSessionPersistencePort;
  now?: () => number;
  allocateId?: () => string;
  initialRecorderRateHz?: number;
  preferences?: Partial<SoloSessionPreferences>;
  applyCaptureCommands?: (commands: readonly DirectCaptureCommand[]) => void | Promise<void>;
  finalisationSummaryTimeoutMs?: number;
  recoveredRecorderTimeoutMs?: number;
}

export type SoloSnapshotListener = (snapshot: SessionSnapshot) => void;
export type SoloCaptureCommandSink = (
  commands: readonly DirectCaptureCommand[],
) => void | Promise<void>;

const isRecorderReady = (status: CaptureStatus) =>
  status.recorder === "armed"
  || status.recorder === "recording"
  || status.recorder === "paused";
const SOLO_STORAGE_HEADROOM_RECHECK_MS = 1_000;
export const SOLO_FINALISATION_SUMMARY_TIMEOUT_MS = 15_000;
export const SOLO_RECOVERED_RECORDER_TIMEOUT_MS = 30_000;

export class SoloSessionController {
  private readonly reducer: DirectSessionReducer;
  private readonly persistence: SoloSessionPersistencePort;
  private readonly now: () => number;
  private readonly finalisationSummaryTimeoutMs: number;
  private readonly recoveredRecorderTimeoutMs: number;
  private readonly listeners = new Set<SoloSnapshotListener>();
  private operationTail = Promise.resolve();
  private captureCommandSink: SoloCaptureCommandSink | null;
  private mounted = false;
  private runtimeMounted = false;
  private recoveredRecorderEpisodeId: string | null = null;
  private recorderNextSequence: number | null = null;
  private lastStorageHeadroomCheckAtMs: number | null = null;
  private volatilePublishTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveredRecorderTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveredRecorderWatchdogGeneration = 0;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    options: SoloSessionControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.finalisationSummaryTimeoutMs = Math.max(
      1,
      options.finalisationSummaryTimeoutMs ?? SOLO_FINALISATION_SUMMARY_TIMEOUT_MS,
    );
    this.recoveredRecorderTimeoutMs = Math.max(
      1,
      options.recoveredRecorderTimeoutMs ?? SOLO_RECOVERED_RECORDER_TIMEOUT_MS,
    );
    this.reducer = new DirectSessionReducer(
      sessionId,
      this.now,
      options.allocateId,
      options.initialRecorderRateHz ?? defaultConfiguration.recorderRateHz,
    );
    this.persistence = options.persistence ?? new SoloSessionPersistence();
    this.captureCommandSink = options.applyCaptureCommands ?? null;
    this.reducer.enableSolo(normaliseSoloSessionPreferences(options.preferences));
  }

  get snapshot() {
    return this.reducer.snapshot;
  }

  readonly appendRecorderBlock = (sequence: number, block: ArrayBuffer) =>
    this.persistence.appendRecorderBlock(sequence, block);

  subscribe(listener: SoloSnapshotListener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  setCaptureCommandSink(sink: SoloCaptureCommandSink | null) {
    this.captureCommandSink = sink;
  }

  setRecorderControlSink(sink: ((message: SoloRecorderControlMessage) => void) | null) {
    this.persistence.setRecorderControlSink(sink);
  }

  mount(captureRuntimeMounted = false) {
    return this.enqueue(async () => {
      this.assertNotDisposed();
      if (this.mounted) return this.snapshot;
      const opened = await this.persistence.open(this.sessionId);
      this.recorderNextSequence = opened.nextSequence;
      this.runtimeMounted = captureRuntimeMounted;
      if (opened.snapshot) {
        this.reducer.restore(opened.snapshot, false);
        const preferences = normaliseSoloSessionPreferences(opened.snapshot.solo?.preferences);
        this.reducer.enableSolo(preferences);
        this.reducer.cancelSoloStart();
        this.deferRecoveredRecorderAuthority();
        if (this.runtimeMounted && this.reducer.captureStatus.recorder === "failed") {
          await this.interruptRecoveredRecorderAuthority(
            recoveredRecorderInterruptionReason(this.reducer.captureStatus),
          );
        }
      }
      this.reducer.setCaptureConnected(
        this.recoveredRecorderEpisodeId === null
          && this.runtimeMounted
          && isRecorderReady(this.reducer.snapshot.captureStatus),
      );
      await this.revalidateSoloStorageHeadroom();
      await this.prepareEpisodeProvenance();
      await this.persistence.saveSnapshot(this.reducer.snapshot);
      this.mounted = true;
      this.scheduleRecoveredRecorderWatchdog();
      this.publishSnapshot();
      this.persistence.sendRecorderReady(opened.nextSequence);
      await this.applyCaptureCommands(this.captureSynchronisationCommands());
      return this.snapshot;
    });
  }

  start(captureRuntimeMounted = false) {
    return this.mount(captureRuntimeMounted);
  }

  restore(snapshot: SessionSnapshot, captureRuntimeMounted = this.runtimeMounted) {
    return this.enqueue(async () => {
      this.assertMounted();
      const previous = this.reducer.snapshot;
      const previousRuntimeMounted = this.runtimeMounted;
      const previousRecoveredRecorderEpisodeId = this.recoveredRecorderEpisodeId;
      const previousStorageHeadroomCheckAtMs = this.lastStorageHeadroomCheckAtMs;
      this.cancelRecoveredRecorderWatchdog();
      let commands: DirectCaptureCommand[];
      try {
        this.runtimeMounted = captureRuntimeMounted;
        this.reducer.restore(snapshot, false);
        this.reducer.enableSolo(normaliseSoloSessionPreferences(snapshot.solo?.preferences));
        this.reducer.cancelSoloStart();
        this.deferRecoveredRecorderAuthority();
        if (this.runtimeMounted && this.reducer.captureStatus.recorder === "failed") {
          await this.interruptRecoveredRecorderAuthority(
            recoveredRecorderInterruptionReason(this.reducer.captureStatus),
          );
        }
        this.reducer.setCaptureConnected(
          this.recoveredRecorderEpisodeId === null
            && this.runtimeMounted
            && isRecorderReady(this.reducer.snapshot.captureStatus),
        );
        await this.revalidateSoloStorageHeadroom();
        await this.prepareEpisodeProvenance();
        commands = this.captureSynchronisationCommands();
        await this.persistence.saveSnapshot(this.reducer.snapshot);
      } catch (error) {
        this.runtimeMounted = previousRuntimeMounted;
        this.recoveredRecorderEpisodeId = previousRecoveredRecorderEpisodeId;
        this.lastStorageHeadroomCheckAtMs = previousStorageHeadroomCheckAtMs;
        this.reducer.restore(previous, previous.captureConnected);
        this.scheduleRecoveredRecorderWatchdog();
        await this.prepareEpisodeProvenance();
        this.publishSnapshot();
        throw error;
      }
      this.scheduleRecoveredRecorderWatchdog();
      this.publishSnapshot();
      await this.applyCaptureCommands(commands);
      return commands;
    });
  }

  configure(configuration: CaptureConfiguration) {
    return this.commitMutation(() => (
      this.reducer.configure(normaliseCaptureConfiguration(configuration))
    ));
  }

  setPreferences(preferences: Partial<SoloSessionPreferences>) {
    const normalised = normaliseSoloSessionPreferences(preferences);
    return this.commitMutation(() => this.reducer.setSoloPreferences(normalised));
  }

  setWorkspace(workspace: SoloWorkspaceState) {
    const normalised = normaliseSoloWorkspaceState(workspace);
    return this.commitMutation(() => this.reducer.setSoloWorkspace(normalised), true);
  }

  setHandDisplay(settings: HandDisplaySettings) {
    return this.commitMutation(() => this.reducer.setHandDisplay(settings));
  }

  async selectStartTask(taskId: string) {
    const storageCommands = await this.commitMutation(() => this.revalidateSoloStorageHeadroom());
    let immediate = false;
    const commands = await this.commitMutation(async () => {
      this.assertSoloStartReady();
      await this.prepareEpisodeProvenance(taskId);
      const preferences = this.reducer.snapshot.solo!.preferences;
      const handsReady = soloHandsReadyToRecord(this.reducer.snapshot.captureStatus);
      immediate = handsReady && preferences.startCountdownMs === 0;
      // A controller in hand stops that hand being tracked, so a selection made
      // with a controller defers the countdown until both hands are free.
      return this.reducer.selectSoloStartTask(
        taskId,
        handsReady ? this.now() + preferences.startCountdownMs : null,
      );
    });
    if (immediate) {
      return [...storageCommands, ...commands, ...await this.advanceTime()];
    }
    return [...storageCommands, ...commands];
  }

  cancelCountdown() {
    return this.commitMutation(() => this.reducer.cancelSoloStart());
  }

  resetCompletedRun() {
    return this.commitMutation(() => this.reducer.resetCompletedSoloRun());
  }

  control(action: DirectRunControlAction | "instructions", nextCursor?: string) {
    if (action === "instructions") {
      return Promise.reject(new Error("Solo instructions use the active task presentation"));
    }
    if (action === "start-sequence") {
      return Promise.reject(new Error("Select a runnable task to start the Solo countdown"));
    }
    return this.commitMutation(() => (
      this.reducer.control(action, "demonstrator", nextCursor)
    ));
  }

  reviewFinalisedEpisode(episodeId: string, annotation: "pass" | "fail") {
    return this.commitMutation(() => this.reducer.reviewFinalisedSoloEpisode(episodeId, annotation));
  }

  advanceTime() {
    return this.commitMutation(async () => {
      const solo = this.reducer.snapshot.solo;
      const run = this.reducer.snapshot.run;
      const preRun = run.status === "stopped" && run.recordingState === "idle";
      if (preRun && solo?.selectedStartTaskId != null && solo.startCountdownDeadlineMs == null) {
        if (this.soloStartBlockers().length > 0) return this.reducer.cancelSoloStart();
        const preferences = solo.preferences;
        return this.reducer.armSoloStartCountdown(this.now() + preferences.startCountdownMs);
      }
      if (preRun && solo?.startCountdownDeadlineMs != null) {
        const now = this.now();
        const storageCheckDue = now >= solo.startCountdownDeadlineMs
          || this.lastStorageHeadroomCheckAtMs === null
          || now < this.lastStorageHeadroomCheckAtMs
          || now - this.lastStorageHeadroomCheckAtMs >= SOLO_STORAGE_HEADROOM_RECHECK_MS;
        const storageCommands = storageCheckDue
          ? await this.revalidateSoloStorageHeadroom()
          : [];
        if (this.soloStartBlockers().length > 0) return this.reducer.cancelSoloStart();
        if (!soloHandsReadyToRecord(this.reducer.snapshot.captureStatus)) {
          return [...storageCommands, ...this.reducer.cancelSoloStart()];
        }
        if (this.now() >= solo.startCountdownDeadlineMs) {
          await this.prepareEpisodeProvenance(solo.selectedStartTaskId ?? undefined);
        }
        const commands = this.reducer.advanceTime();
        return commands.length > 0 ? [...storageCommands, ...commands] : storageCommands;
      }
      return this.reducer.advanceTime();
    });
  }

  setCaptureConnected(connected: boolean) {
    return this.enqueue(async () => {
      this.assertMounted();
      const previous = this.reducer.snapshot;
      const previousRecoveredRecorderEpisodeId = this.recoveredRecorderEpisodeId;
      let commands: DirectCaptureCommand[];
      try {
        if (connected
          && this.recoveredRecorderEpisodeId !== null
          && recoveredRecorderStatusSettled(this.reducer.captureStatus)) {
          await this.interruptRecoveredRecorderAuthority(
            recoveredRecorderInterruptionReason(this.reducer.captureStatus),
          );
        }
        commands = this.reducer.setCaptureConnected(
          this.recoveredRecorderEpisodeId === null
            && connected
            && isRecorderReady(this.reducer.captureStatus),
        );
        if (!connected && this.reducer.snapshot.solo?.startCountdownDeadlineMs != null) {
          commands = this.reducer.cancelSoloStart();
        }
        await this.persistence.saveSnapshot(this.reducer.snapshot);
      } catch (error) {
        this.recoveredRecorderEpisodeId = previousRecoveredRecorderEpisodeId;
        this.reducer.restore(previous, previous.captureConnected);
        this.scheduleRecoveredRecorderWatchdog();
        await this.prepareEpisodeProvenance();
        this.publishSnapshot();
        throw error;
      }
      this.runtimeMounted = connected;
      this.publishSnapshot();
      await this.applyCaptureCommands(commands);
      return commands;
    });
  }

  setCaptureStatus(status: CaptureStatus) {
    return this.enqueue(() => this.applyCaptureStatus(status));
  }

  setPromptAudioStatus(status: PromptAudioStatus) {
    return this.commitMutation(() => {
      const commands = this.reducer.setPromptAudioStatus(status);
      if (this.reducer.snapshot.solo?.startCountdownDeadlineMs != null
        && !this.reducer.snapshot.sequenceReadiness.ready) {
        return this.reducer.cancelSoloStart();
      }
      return commands;
    });
  }

  setRuntimeFeatures(features: RuntimeFeatures) {
    return this.commitMutation(() => this.reducer.setRuntimeFeatures(features));
  }

  configurationApplied(revision: number, checksum: string) {
    return this.commitMutation(() => this.reducer.configurationApplied(revision, checksum));
  }

  recordingAccepted(episodeId: string) {
    return this.commitMutation(() => this.reducer.recordingAccepted(episodeId));
  }

  recordingRejected(episodeId: string, error: string) {
    return this.commitMutation(() => this.reducer.recordingRejected(episodeId, error));
  }

  recordingFinalised(
    episodeId: string,
    summary: MonitorRecordingSummary | undefined,
    error?: string,
  ) {
    return this.commitMutation(() => (
      this.reducer.recordingFinalised(episodeId, summary, error)
    ));
  }

  async handleRecorderResult(result: SoloRecorderResult) {
    if (result.type === "recording-accepted") return this.recordingAccepted(result.episodeId);
    if (result.type === "recording-rejected") {
      return this.recordingRejected(
        result.episodeId,
        result.error || "The Solo capture recorder rejected the episode",
      );
    }
    let summary: MonitorRecordingSummary | undefined;
    let finalisationError = result.error;
    try {
      summary = await this.summariseWithinFinalisationDeadline(result.episodeId);
    } catch (error) {
      finalisationError ??= error instanceof Error
        ? error.message
        : "The Solo recorder could not summarise the episode";
    }
    return this.recordingFinalised(result.episodeId, summary, finalisationError);
  }

  deleteEpisode(episodeId: string) {
    return this.commitMutation(() => {
      this.reducer.deleteEpisode(episodeId);
      return [];
    }, true);
  }

  recordEpisodeUpload(episodeIds: readonly string[], upload: VerifiedEpisodeHuggingFaceUpload) {
    return this.commitMutation(() => {
      this.reducer.recordEpisodeUpload(episodeIds, upload);
      return [];
    }, true);
  }

  upsertJob(job: CaptureJob) {
    return this.commitMutation(() => {
      this.reducer.upsertJob(job);
      return [];
    }, true);
  }

  removeJob(jobId: string) {
    return this.commitMutation(() => {
      this.reducer.removeJob(jobId);
      return [];
    }, true);
  }

  synchronise() {
    return this.enqueue(async () => {
      this.assertMounted();
      const commands = this.captureSynchronisationCommands();
      await this.persistence.saveSnapshot(this.reducer.snapshot);
      this.publishSnapshot();
      await this.applyCaptureCommands(commands);
      return commands;
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.cancelRecoveredRecorderWatchdog();
    if (this.mounted) {
      await this.setCaptureConnected(false).catch(() => undefined);
    }
    this.disposed = true;
    this.cancelRecoveredRecorderWatchdog();
    this.cancelVolatileSnapshotPublish();
    this.listeners.clear();
    await this.persistence.close();
  }

  private async applyCaptureStatus(
    status: CaptureStatus,
    expectedRecoveredEpisodeId?: string,
  ) {
    this.assertMounted();
    if (expectedRecoveredEpisodeId !== undefined
      && this.recoveredRecorderEpisodeId !== expectedRecoveredEpisodeId) return [];
    const recoveryReady = this.runtimeMounted
      && this.recoveredRecorderEpisodeId !== null
      && recoveredRecorderStatusSettled(status);
    const currentSolo = this.reducer.snapshot.solo;
    const countdownHandLoss = this.reducer.snapshot.run.status === "stopped"
      && this.reducer.snapshot.run.recordingState === "idle"
      && currentSolo?.selectedStartTaskId != null
      && currentSolo.startCountdownDeadlineMs !== null
      && !soloHandsReadyToRecord(status);
    const persist = recoveryReady
      || countdownHandLoss
      || captureStatusRequiresDurableSnapshot(this.reducer.captureStatus, status);
    if (!persist) {
      this.reducer.setCaptureStatusVolatile(status);
      this.scheduleVolatileSnapshotPublish();
      return [];
    }
    const previous = this.reducer.snapshot;
    const previousRecoveredRecorderEpisodeId = this.recoveredRecorderEpisodeId;
    let commands: DirectCaptureCommand[];
    try {
      if (recoveryReady) {
        await this.interruptRecoveredRecorderAuthority(
          recoveredRecorderInterruptionReason(status),
        );
      }
      this.reducer.setCaptureStatus(status);
      commands = this.reducer.setCaptureConnected(
        this.recoveredRecorderEpisodeId === null
          && this.runtimeMounted
          && isRecorderReady(status),
      );
      const solo = this.reducer.snapshot.solo;
      const preRun = this.reducer.snapshot.run.status === "stopped"
        && this.reducer.snapshot.run.recordingState === "idle";
      // A waiting target is cancelled by ordinary readiness loss. A live
      // countdown is also cancelled if either hand is no longer tracked.
      if (preRun && solo?.selectedStartTaskId != null
        && (this.soloStartBlockers().length > 0
          || (solo.startCountdownDeadlineMs !== null
            && !soloHandsReadyToRecord(this.reducer.snapshot.captureStatus)))) {
        commands = [...commands, ...this.reducer.cancelSoloStart()];
      }
      await this.persistence.saveSnapshot(this.reducer.snapshot);
    } catch (error) {
      this.recoveredRecorderEpisodeId = previousRecoveredRecorderEpisodeId;
      this.reducer.restore(previous, previous.captureConnected);
      this.scheduleRecoveredRecorderWatchdog();
      await this.prepareEpisodeProvenance();
      this.publishSnapshot();
      throw error;
    }
    this.cancelVolatileSnapshotPublish();
    this.publishSnapshot();
    await this.applyCaptureCommands(commands);
    if (status.recorder === "arming" && this.recorderNextSequence != null) {
      this.persistence.sendRecorderReady(this.recorderNextSequence);
    }
    return commands;
  }

  private summariseWithinFinalisationDeadline(episodeId: string) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("Solo recorder finalisation timed out before the episode summary was available"));
      }, this.finalisationSummaryTimeoutMs);
    });
    return Promise.race([
      this.persistence.summarise(episodeId),
      deadline,
    ]).finally(() => {
      if (timeout !== null) clearTimeout(timeout);
    });
  }

  private commitMutation(
    mutation: () => DirectCaptureCommand[] | Promise<DirectCaptureCommand[]>,
    persistWhenCommandless = false,
  ) {
    return this.enqueue(async () => {
      this.assertMounted();
      const previous = this.reducer.snapshot;
      const previousStorageHeadroomCheckAtMs = this.lastStorageHeadroomCheckAtMs;
      let commands: DirectCaptureCommand[];
      try {
        commands = await mutation();
        if (commands.length === 0 && !persistWhenCommandless) return commands;
        await this.persistence.saveSnapshot(this.reducer.snapshot);
      } catch (error) {
        this.lastStorageHeadroomCheckAtMs = previousStorageHeadroomCheckAtMs;
        this.reducer.restore(previous, previous.captureConnected);
        await this.prepareEpisodeProvenance();
        this.publishSnapshot();
        throw error;
      }
      this.publishSnapshot();
      await this.applyCaptureCommands(commands);
      return commands;
    });
  }

  private async prepareEpisodeProvenance(selectedStartTaskId?: string) {
    const snapshot = this.reducer.snapshot;
    if (snapshot.operatingMode !== "solo" || !snapshot.solo) {
      this.reducer.setEpisodeProvenance(null);
      return;
    }
    const selected = selectedStartTaskId ?? snapshot.solo.selectedStartTaskId;
    if (!selected) {
      this.reducer.setEpisodeProvenance(null);
      return;
    }
    const specification = taskSpecificationFromCaptureConfiguration(snapshot.configuration);
    this.reducer.setEpisodeProvenance({
      operatingMode: "solo",
      selectedStartTaskId: selected,
      startCountdownMs: snapshot.solo.preferences.startCountdownMs,
      taskSpecVersion: CERES_TASK_SPEC_VERSION,
      taskSpecHash: await taskSpecificationSha256Hex(specification),
      taskSpecification: specification,
    });
  }

  private deferRecoveredRecorderAuthority() {
    const snapshot = this.reducer.snapshot;
    const episode = snapshot.currentEpisode ?? snapshot.pendingEpisode;
    this.recoveredRecorderEpisodeId = episode && (snapshot.run.recordingState === "arming"
      || snapshot.run.recordingState === "recording"
      || snapshot.run.recordingState === "paused"
      || snapshot.run.recordingState === "stopping")
      ? episode.id
      : null;
  }

  private async interruptRecoveredRecorderAuthority(reason?: string) {
    const recoveredEpisodeId = this.recoveredRecorderEpisodeId;
    if (!recoveredEpisodeId) return;
    const snapshot = this.reducer.snapshot;
    const episode = snapshot.currentEpisode ?? snapshot.pendingEpisode;
    if (!episode || episode.id !== recoveredEpisodeId || (snapshot.run.recordingState !== "arming"
      && snapshot.run.recordingState !== "recording"
      && snapshot.run.recordingState !== "paused"
      && snapshot.run.recordingState !== "stopping")) {
      throw new Error("Recovered Solo recorder authority no longer matches the interrupted episode");
    }
    let summary: MonitorRecordingSummary | undefined;
    try {
      summary = await this.summariseWithinFinalisationDeadline(episode.id);
    } catch {
      summary = undefined;
    }
    this.reducer.interruptSoloRecovery(
      summary,
      reason ?? "Solo recording was interrupted by a page reload before durable finalisation completed",
    );
    this.recoveredRecorderEpisodeId = null;
    this.cancelRecoveredRecorderWatchdog();
  }

  private scheduleRecoveredRecorderWatchdog() {
    this.cancelRecoveredRecorderWatchdog();
    const episodeId = this.recoveredRecorderEpisodeId;
    if (!episodeId || !this.mounted || this.disposed) return;
    const generation = this.recoveredRecorderWatchdogGeneration;
    this.recoveredRecorderTimer = setTimeout(() => {
      this.recoveredRecorderTimer = null;
      if (this.disposed || generation !== this.recoveredRecorderWatchdogGeneration) return;
      const reason = "Solo recorder finalisation recovery timed out before the interrupted journal tail became durable";
      const status: CaptureStatus = {
        ...this.reducer.captureStatus,
        recorder: "failed",
        lastError: reason,
      };
      void this.enqueue(() => {
        if (generation !== this.recoveredRecorderWatchdogGeneration) return Promise.resolve([]);
        return this.applyCaptureStatus(status, episodeId);
      }).catch(() => undefined);
    }, this.recoveredRecorderTimeoutMs);
  }

  private cancelRecoveredRecorderWatchdog() {
    this.recoveredRecorderWatchdogGeneration += 1;
    if (this.recoveredRecorderTimer === null) return;
    clearTimeout(this.recoveredRecorderTimer);
    this.recoveredRecorderTimer = null;
  }

  private soloStartBlockers() {
    return this.reducer.snapshot.sequenceReadiness.blockers.map(({ message }) => message);
  }

  private async revalidateSoloStorageHeadroom() {
    let status;
    try {
      status = normaliseSoloStorageHeadroom(await this.persistence.checkStorageHeadroom());
    } catch (error) {
      const detail = error instanceof Error && error.message.trim()
        ? `Storage headroom check failed: ${error.message.trim()}`
        : "Storage headroom check failed";
      status = normaliseSoloStorageHeadroom({
        state: "blocked",
        availableBytes: null,
        checkedAtMs: this.now(),
        detail,
      });
    }
    this.lastStorageHeadroomCheckAtMs = this.now();
    return this.reducer.setSoloStorageHeadroom(status);
  }

  private assertSoloStartReady() {
    if (this.recoveredRecorderEpisodeId !== null) {
      throw new Error("Solo recorder recovery must finish before selecting a new task");
    }
    const snapshot = this.reducer.snapshot;
    if ((snapshot.run.status !== "stopped" && snapshot.run.status !== "complete")
      || snapshot.run.recordingState !== "idle"
      || snapshot.currentEpisode
      || snapshot.pendingEpisode) {
      throw new Error("The Solo run is already active");
    }
    const blockers = this.soloStartBlockers();
    if (blockers.length > 0) throw new Error(blockers.join("; "));
    if (!snapshot.configuration.tasks.some(isRepetitionTask)) {
      throw new Error("Configure at least one recordable Solo task");
    }
  }

  private applyCaptureCommands(commands: readonly DirectCaptureCommand[]) {
    if (commands.length === 0 || !this.captureCommandSink) return Promise.resolve();
    return Promise.resolve(this.captureCommandSink(commands));
  }

  private captureSynchronisationCommands() {
    const commands = this.reducer.synchronise();
    if (this.recoveredRecorderEpisodeId === null) return commands;
    return commands.filter((command) => command.type !== "control"
      || (command.action !== "recording-recover-arming"
        && command.action !== "recording-recover-stopping"));
  }

  private publishSnapshot() {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private scheduleVolatileSnapshotPublish() {
    if (this.volatilePublishTimer !== null) return;
    this.volatilePublishTimer = setTimeout(() => {
      this.volatilePublishTimer = null;
      void this.enqueue(async () => {
        if (!this.disposed && this.mounted) this.publishSnapshot();
      }).catch(() => undefined);
    }, 100);
  }

  private cancelVolatileSnapshotPublish() {
    if (this.volatilePublishTimer === null) return;
    clearTimeout(this.volatilePublishTimer);
    this.volatilePublishTimer = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation);
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private assertMounted() {
    this.assertNotDisposed();
    if (!this.mounted) throw new Error("Solo session controller is not mounted");
  }

  private assertNotDisposed() {
    if (this.disposed) throw new Error("Solo session controller is disposed");
  }
}

function captureStatusRequiresDurableSnapshot(previous: CaptureStatus, next: CaptureStatus) {
  return previous.headsetModel !== next.headsetModel
    || previous.sensorSource !== next.sensorSource
    || previous.questBrowser !== next.questBrowser
    || previous.camera !== next.camera
    || previous.xr !== next.xr
    || previous.transport !== next.transport
    || previous.selectedCameraDeviceId !== next.selectedCameraDeviceId
    || previous.selectedCameraLabel !== next.selectedCameraLabel
    || previous.selectedCameraWidth !== next.selectedCameraWidth
    || previous.selectedCameraHeight !== next.selectedCameraHeight
    || JSON.stringify(previous.selectedCameraFrame) !== JSON.stringify(next.selectedCameraFrame)
    || previous.selectedCameraFrameRate !== next.selectedCameraFrameRate
    || previous.selectedCameraSide !== next.selectedCameraSide
    || previous.recorder !== next.recorder
    || previous.recorderRateHz !== next.recorderRateHz
    || previous.lastError !== next.lastError;
}

function recoveredRecorderStatusSettled(status: CaptureStatus) {
  return status.recorder === "failed"
    || status.recorder === "armed" && status.recorderPendingBlocks === 0;
}

function recoveredRecorderInterruptionReason(status: CaptureStatus) {
  if (status.recorder !== "failed") return undefined;
  return status.lastError?.trim()
    || "Solo recorder recovery failed before durable finalisation completed";
}
