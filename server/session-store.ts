import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, statfs, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HAND_SPEED_CRITICAL_MPS, HandSpeedTracker } from "../shared/capture-quality.js";
import { captureMetadataFromStatus } from "../shared/capture-metadata.js";
import { normaliseCameraRegistration, type CameraRegistration } from "../shared/camera-registration.js";
import { defaultHandDisplaySettings, normaliseHandDisplaySettings, type HandDisplaySettings } from "../shared/hand-display.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";
import { CYCLE_PAUSE_MS, taskResetDurationMs } from "../shared/run-sequencing.js";
import {
  CERES_TASK_SPEC_VERSION,
  canonicalTaskSpecification,
  hasTaskSpecificationProvenance,
  taskSpecificationFromCaptureConfiguration,
} from "../shared/task-specification.js";
import type {
  CaptureConfiguration,
  AsrStatusState,
  CapturePairingRejectionCode,
  CaptureStatus,
  CaptureJob,
  ClientRole,
  Episode,
  VerifiedEpisodeHuggingFaceUpload,
  EpisodeSegment,
  EpisodeSegmentAnnotationAction,
  PromptAudioStatus,
  PromptDelivery,
  RecordingReadiness,
  RecorderBlock,
  RecorderErrorCode,
  RecorderRunEvent,
  RuntimeFeatures,
  RunProgress,
  SequenceReadiness,
  SensorFrame,
  SessionSnapshot,
  SessionTelemetryMode,
  TaskDefinition,
  WebRtcSignal,
} from "../shared/protocol.js";
import {
  CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
  CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE,
  decodeRecorderBlock,
  decodeRecorderMediaPayload,
  decodeRecorderRunEvent,
  defaultCaptureStatus,
  defaultConfiguration,
  isRepetitionTask,
  isStateBoundRunControlAction,
  normaliseCaptureConfiguration,
  normaliseSessionTelemetryMode,
  nextRunControlCursor,
  RECORDER_BLOCK_HEADER_BYTES,
  RecorderBlockFlags,
  RecorderProtocolError,
  recorderBlockByteLength,
} from "../shared/protocol.js";

export interface SessionConnection {
  id: string;
  role: ClientRole;
  pairingId?: string;
  activeWebRtcPeerId?: string;
  monitorLoadStage?: number;
  connectedAtMs?: number;
  telemetryMode?: SessionTelemetryMode;
  lastSensorFrameAtMs?: number;
  send: (type: string, payload: unknown) => void;
  close?: (code: number, reason: string) => void;
}

export type SessionConnectResult =
  | { accepted: true; replacedConnectionIds: string[]; captureIntentGranted?: boolean }
  | { accepted: false; retryable: true; message: string }
  | { accepted: false; code: CapturePairingRejectionCode; message: string };

export type CaptureAuthorityResult =
  | { accepted: true; alreadyActive: boolean }
  | { accepted: false; retryable: true; message: string }
  | { accepted: false; code: CapturePairingRejectionCode; message: string };

interface SessionState {
  id: string;
  exportCapability: string;
  startedAt: string;
  telemetryMode: SessionTelemetryMode;
  telemetryModeAuthoritative: boolean;
  telemetryModeOwnerId: string | null;
  captureConnected: boolean;
  monitorCount: number;
  recording: boolean;
  run: RunProgress;
  handDisplay: HandDisplaySettings;
  cameraRegistration: CameraRegistration | null;
  timedTaskTimer: ReturnType<typeof setTimeout> | null;
  resetTimer: ReturnType<typeof setTimeout> | null;
  syncLockTimer: ReturnType<typeof setTimeout> | null;
  runTail: Promise<void>;
  configuration: CaptureConfiguration;
  requestedConfiguration: CaptureConfiguration;
  configurationRevision: number;
  configurationChecksum: string;
  configurationAppliedRevision: number | null;
  configurationAppliedChecksum: string | null;
  configurationError: string | null;
  configurationTail: Promise<void>;
  currentEpisode: Episode | null;
  pendingEpisode: Episode | null;
  episodes: Episode[];
  attempts: Episode[];
  recorderAcceptedEpisodeId: string | null;
  pendingStopOutcome: "stopped" | "completed" | null;
  pendingRunAction: "stop-run" | "finish-run" | "cycle-boundary" | null;
  pendingRunTransitionApplied: boolean;
  pendingTaskPublication: "sequence-started" | "task-selected" | null;
  pendingReviewAnnotation: "pass" | "fail" | null;
  jobs: CaptureJob[];
  promptAudioStatus: PromptAudioStatus;
  promptDeliveries: PromptDelivery[];
  lastFrame: SensorFrame | null;
  lastTranscript: { text: string; timestampMs: number } | null;
  commandLog: Array<{ command: string; text: string; timestampMs: number }>;
  captureStatus: CaptureStatus;
  connections: Set<SessionConnection>;
  pairedCapturePairingId: string | null;
  captureCandidateId: string | null;
  activeCaptureId: string | null;
  activeRecorderId: string | null;
  webRtcCaptureByPeer: Map<string, string>;
  recorderArmed: boolean;
  recorderFailed: boolean;
  recorderLedgerLoaded: boolean;
  recorderLedger: Map<number, RecorderLedgerEntry>;
  recorderMaterialised: Set<number>;
  recorderPendingBoundary: RecorderPendingBoundary | null;
  qualityTrackers: Map<string, HandSpeedTracker>;
  monitorLoadStage: number;
}

interface RecorderLedgerEntry {
  checksum: number;
  episodeId: string;
  recorderFrameIndex: number;
  sourceTimestampUs: number;
  flags: number;
}

interface PersistedConfiguration {
  schema: "ceres-capture-configuration-v2";
  revision: number;
  checksum: string;
  savedAt: string;
  configuration: CaptureConfiguration;
}

interface PersistedEpisodeCommit {
  schema: "ceres-episode-commit-v1" | "ceres-episode-commit-v2";
  sessionId: string;
  episodeId: string;
  taskSpecVersion?: number;
  taskSpecHash?: string;
  checksum: string;
  episode: Episode;
}

interface RecorderPendingBoundary {
  episodeId: string;
  segmentId: string;
  outcome: "completed" | "stopped";
  event: Extract<RecorderRunEvent, { taskId: string }> & { type: "segment-end" };
  resetElapsed: boolean;
  publishedRecorderId: string | null;
}

interface RecorderPromotionPlan {
  episode: Episode;
  taskPublication: SessionState["pendingTaskPublication"];
  stopping: boolean;
  activeTask: boolean;
  recovered: boolean;
  boundaryEvent: RecorderPendingBoundary["event"] | null;
  scheduleReset: boolean;
}

export interface RecorderWriteResult {
  status: "durable" | "duplicate";
  block: RecorderBlock;
}

export class RecorderStoreError extends Error {
  readonly code: RecorderErrorCode;
  readonly expectedSequence?: number;

  constructor(code: RecorderErrorCode, message: string, expectedSequence?: number) {
    super(message);
    this.name = "RecorderStoreError";
    this.code = code;
    this.expectedSequence = expectedSequence;
  }
}

export type UploadCompletionVerifier = (receipt: string, expected: { requestId: string; sessionId: string }) => VerifiedEpisodeHuggingFaceUpload;

export interface SessionStoreOptions {
  dataRoot?: string;
  minimumFreeBytes?: number;
  features?: RuntimeFeatures;
  defaultRecorderRateHz?: number;
  syncLockMs?: number;
  uploadCompletionVerifier?: UploadCompletionVerifier;
}

const commandMatchers: Array<[string, RegExp]> = [
  ["failed-episode", /\bfailed\s+episode\b/i],
  ["successful-episode", /\b(successful|success)\b/i],
  ["next-task", /\bnext\s+task\b/i],
  ["show-instructions", /\bshow\s+(the\s+)?instructions\b/i],
  ["start-recording", /\b(start|record)\b/i],
  ["acknowledge", /\bok(?:ay)?\b/i],
];

const recorderPayloadDecoder = new TextDecoder("utf-8", { fatal: true });
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly episodePersistenceTails = new Map<string, Promise<void>>();
  private readonly dataRoot: string;
  private readonly minimumFreeBytes: number;
  private readonly features: RuntimeFeatures;
  private readonly defaultRecorderRateHz: number;
  private readonly syncLockMs: number;
  private readonly uploadCompletionVerifier: UploadCompletionVerifier | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? process.env.CERES_DATA_DIR ?? "data");
    const minimumFreeBytes = options.minimumFreeBytes ?? Number(process.env.CERES_MIN_FREE_BYTES ?? 512 * 1024 * 1024);
    if (!Number.isFinite(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error("CERES_MIN_FREE_BYTES must be a non-negative finite number");
    this.minimumFreeBytes = minimumFreeBytes;
    this.features = {
      speech: options.features?.speech !== false,
    };
    const defaultRecorderRateHz = options.defaultRecorderRateHz ?? defaultConfiguration.recorderRateHz;
    if (!Number.isFinite(defaultRecorderRateHz) || defaultRecorderRateHz <= 0) throw new Error("The default recorder rate must be a positive finite number");
    this.defaultRecorderRateHz = defaultRecorderRateHz;
    const syncLockMs = options.syncLockMs ?? 2_500;
    if (!Number.isFinite(syncLockMs) || syncLockMs < 0) throw new Error("The sync lock duration must be a non-negative finite number");
    this.syncLockMs = syncLockMs;
    this.uploadCompletionVerifier = options.uploadCompletionVerifier;
  }

  connect(sessionId: string, connection: SessionConnection): SessionConnectResult {
    const session = this.get(sessionId);
    connection.connectedAtMs ??= Date.now();
    let replacedConnections: SessionConnection[] = [];
    if (connection.role === "capture") {
      const pairing = this.bindCapturePairing(session, connection);
      if (!pairing.accepted) return pairing;
      connection.telemetryMode = normaliseSessionTelemetryMode(connection.telemetryMode, "disabled");
      replacedConnections = pairing.replacedConnections;
      session.connections.add(connection);
      const captureIntentGranted = !this.signallingCapture(session);
      this.publishSnapshot(session);
      return {
        accepted: true,
        replacedConnectionIds: replacedConnections.map((entry) => entry.id),
        captureIntentGranted,
      };
    } else if (connection.role === "recorder") {
      const pairing = this.bindRecorderPairing(session, connection);
      if (!pairing.accepted) return pairing;
      replacedConnections = pairing.replacedConnections;
      session.connections.add(connection);
      session.activeRecorderId = connection.id;
    } else if (connection.role === "monitor") {
      session.connections.add(connection);
      connection.monitorLoadStage = 0;
      session.monitorCount += 1;
    } else if (connection.role === "monitor-control") {
      session.connections.add(connection);
    }
    this.publishSnapshot(session);
    return { accepted: true, replacedConnectionIds: replacedConnections.map((entry) => entry.id) };
  }

  disconnect(sessionId: string, connection: SessionConnection): Promise<void> {
    const session = this.get(sessionId);
    const wasActiveCapture = connection.role === "capture" && session.activeCaptureId === connection.id;
    const wasCaptureCandidate = connection.role === "capture" && session.captureCandidateId === connection.id;
    const ownedTelemetryMode = connection.role === "capture" && session.telemetryModeOwnerId === connection.id;
    const wasActiveRecorder = connection.role === "recorder" && session.activeRecorderId === connection.id;
    const activeTakeLost = wasActiveCapture && Boolean(session.currentEpisode || session.pendingEpisode);
    session.connections.delete(connection);
    if (session.run.status === "stopped") {
      if (connection.role === "capture") session.run.demonstratorReady = false;
      if ((connection.role === "monitor" || connection.role === "monitor-control")
        && ![...session.connections].some((candidate) => candidate.role === "monitor" || candidate.role === "monitor-control")) {
        session.run.directorReady = false;
      }
      if (session.run.directorReady !== true || session.run.demonstratorReady !== true) {
        this.clearSyncLockTimer(session);
        session.run.syncLockStartedAtMs = null;
      }
    }
    if (connection.role === "monitor") session.webRtcCaptureByPeer.delete(connection.id);
    else if (connection.role === "capture") {
      for (const [peerId, captureId] of session.webRtcCaptureByPeer) {
        if (captureId === connection.id) session.webRtcCaptureByPeer.delete(peerId);
      }
      if (wasCaptureCandidate) session.captureCandidateId = null;
      if (ownedTelemetryMode) this.clearTelemetryModeAuthority(session);
      if (wasCaptureCandidate) {
        session.configurationAppliedRevision = null;
        session.configurationAppliedChecksum = null;
        session.promptAudioStatus = session.configuration.promptAudio.enabled || session.configuration.promptAudio.useTextToSpeech
          ? { state: "locked", detail: "The demonstrator device is disconnected" }
          : { state: "unavailable", detail: "Prompt audio is disabled for this run" };
        session.captureStatus = resetCaptureStatusForOwner(session.captureStatus, session.configuration.recorderRateHz);
      }
      if (wasActiveCapture) this.deactivateCapture(session);
      else if (wasCaptureCandidate) {
        const replacement = this.preferredCapture(session);
        if (replacement) this.grantCaptureIntent(session, replacement);
        else {
          const recorder = [...session.connections].find((candidate) => candidate.role === "recorder"
            && candidate.id === session.activeRecorderId);
          if (recorder) this.suspendRecorder(session, recorder, "Recorder lost its provisional capture tab");
        }
      }
    } else if (wasActiveRecorder) {
      session.activeRecorderId = null;
      session.recorderArmed = false;
      session.captureStatus = {
        ...session.captureStatus,
        recorder: session.recorderFailed ? "failed" : "arming",
      };
      this.publishCaptureStatus(session);
    }
    const interruption = activeTakeLost
      ? this.enqueueRun(session, () => this.interruptEpisode(session, "The active demonstrator capture client disconnected"))
        .catch((error) => this.setRunError(session, error))
      : Promise.resolve();
    session.monitorCount = [...session.connections].filter((entry) => entry.role === "monitor").length;
    if (connection.role === "monitor") this.updateMonitorLoadStage(session);
    this.publishSnapshot(session);
    return interruption;
  }

  async restartSession(sessionId: string, connection: SessionConnection) {
    const session = this.get(sessionId);
    if (!session.connections.has(connection) || connection.role !== "monitor-control") {
      throw new Error("Only the connected capture director can restart the session");
    }
    if (session.run.status === "running" || session.currentEpisode || session.pendingEpisode
      || session.run.recordingState !== "idle") {
      throw new Error("Stop and finalise the active run before restarting the session");
    }
    const message = "The capture director restarted the session";
    const attachedCaptureConnections = [...session.connections]
      .filter((candidate) => candidate.role === "capture" || candidate.role === "recorder");
    for (const candidate of attachedCaptureConnections) {
      candidate.send("pairing-rejected", {
        code: candidate.role === "capture" ? "capture-session-restarted" : "recorder-pairing-required",
        message,
      });
      await this.disconnect(sessionId, candidate);
      candidate.close?.(CAPTURE_PAIRING_REJECTED_CLOSE_CODE, message);
    }
    this.publishSnapshot(session);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const session = this.get(sessionId);
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      telemetryMode: session.telemetryMode,
      telemetryModeAuthoritative: session.telemetryModeAuthoritative,
      features: this.features,
      handDisplay: session.handDisplay,
      cameraRegistration: session.cameraRegistration,
      captureConnected: session.captureConnected,
      monitorCount: session.monitorCount,
      recording: session.recording,
      activeTaskIndex: session.run.activeTaskIndex,
      run: { ...session.run },
      configuration: session.configuration,
      configurationStatus: {
        state: session.configurationError
          ? "error"
          : session.configurationAppliedRevision === session.configurationRevision
            && session.configurationAppliedChecksum === session.configurationChecksum
            ? "applied"
            : "sent",
        revision: session.configurationRevision,
        checksum: session.configurationChecksum,
        appliedRevision: session.configurationAppliedRevision,
        error: session.configurationError,
      },
      sequenceReadiness: this.sequenceReadiness(session),
      recordingReadiness: this.recordingReadiness(session),
      currentEpisode: session.currentEpisode,
      pendingEpisode: session.pendingEpisode,
      episodes: session.episodes,
      attempts: session.attempts,
      jobs: session.jobs,
      promptAudioStatus: session.promptAudioStatus,
      promptDeliveries: session.promptDeliveries,
      lastFrame: session.lastFrame,
      lastTranscript: session.lastTranscript,
      commandLog: session.commandLog,
      captureStatus: session.captureStatus,
    };
  }

  async setConfiguration(sessionId: string, configuration: CaptureConfiguration) {
    const session = this.get(sessionId);
    await this.enqueueConfiguration(session, async () => {
      if (session.run.status === "running") {
        throw new Error("Run configuration cannot change while the run is active");
      }
      const submittedConfiguration = normaliseCaptureConfiguration(configuration);
      const nextRequestedConfiguration = preserveDisabledSpeechSettings(
        submittedConfiguration,
        session.requestedConfiguration,
        this.features,
      );
      const nextConfiguration = applyRuntimeFeaturePolicy(nextRequestedConfiguration, this.features);
      const nextChecksum = configurationChecksum(nextConfiguration);
      const requestedChanged = configurationChecksum(nextRequestedConfiguration) !== configurationChecksum(session.requestedConfiguration);
      if (nextChecksum === session.configurationChecksum && !requestedChanged) {
        this.publishConfiguration(session);
        this.publishSnapshot(session);
        return;
      }
      const nextRevision = session.configurationRevision + 1;
      const persisted: PersistedConfiguration = {
        schema: "ceres-capture-configuration-v2",
        revision: nextRevision,
        checksum: configurationChecksum(nextRequestedConfiguration),
        savedAt: new Date().toISOString(),
        configuration: nextRequestedConfiguration,
      };
      try {
        await mkdir(this.sessionRoot(session), { recursive: true });
        await this.writeDurable(this.configurationPath(session), Buffer.from(JSON.stringify(persisted, null, 2)));
      } catch (error) {
        session.configurationError = error instanceof Error ? error.message : "Configuration persistence failed";
        this.publishSnapshot(session);
        throw error;
      }
      session.configuration = nextConfiguration;
      session.requestedConfiguration = nextRequestedConfiguration;
      session.configurationRevision = nextRevision;
      session.configurationChecksum = nextChecksum;
      session.configurationAppliedRevision = null;
      session.configurationAppliedChecksum = null;
      session.configurationError = null;
      this.clearRunTimers(session);
      session.run = initialRunProgress();
      session.pendingTaskPublication = null;
      session.captureStatus = {
        ...session.captureStatus,
        recorder: "arming",
        recorderRateHz: nextConfiguration.recorderRateHz,
        lastError: null,
      };
      session.promptAudioStatus = nextConfiguration.promptAudio.enabled || nextConfiguration.promptAudio.useTextToSpeech
        ? { state: "locked", detail: "Enable prompt audio on the demonstrator device" }
        : { state: "unavailable", detail: "Prompt audio is disabled for this run" };
      this.publishConfiguration(session);
      this.publishSnapshot(session);
    });
  }

  setHandDisplay(sessionId: string, settings: HandDisplaySettings, connection?: SessionConnection) {
    const session = this.get(sessionId);
    if (connection?.role === "capture") this.assertActiveCapture(session, connection, "change hand display settings");
    else if (connection && connection.role !== "monitor" && connection.role !== "monitor-control") throw new Error("Only the capture director or active demonstrator can change hand display settings");
    const next = normaliseHandDisplaySettings(settings);
    if (session.handDisplay.handMode === next.handMode
      && session.handDisplay.handShading === next.handShading
      && session.handDisplay.handTrail === next.handTrail) return;
    session.handDisplay = next;
    this.publish(session, "hand-display", { settings: next });
  }

  setTelemetryMode(sessionId: string, connection: SessionConnection, telemetryMode: unknown) {
    const session = this.get(sessionId);
    this.assertSignallingCapture(session, connection);
    const next = normaliseSessionTelemetryMode(telemetryMode, "disabled");
    connection.telemetryMode = next;
    if (session.telemetryMode === next
      && session.telemetryModeAuthoritative
      && session.telemetryModeOwnerId === connection.id) return;
    session.telemetryMode = next;
    session.telemetryModeAuthoritative = true;
    session.telemetryModeOwnerId = connection.id;
    this.publishSnapshot(session);
  }

  setCameraRegistration(sessionId: string, registration: unknown, connection: SessionConnection) {
    const session = this.get(sessionId);
    if (connection.role !== "monitor" && connection.role !== "monitor-control") {
      throw new Error("Only the capture director can register the outward camera");
    }
    const next = normaliseCameraRegistration(registration);
    if (isDeepStrictEqual(session.cameraRegistration, next)) return;
    session.cameraRegistration = next;
    this.publish(session, "camera-registration", { registration: next });
    this.publishSnapshot(session);
  }

  acknowledgeConfiguration(sessionId: string, connection: SessionConnection, revision: number, checksum: string) {
    const session = this.get(sessionId);
    this.assertSignallingCapture(session, connection);
    if (revision !== session.configurationRevision || checksum !== session.configurationChecksum) {
      session.configurationError = `Capture acknowledged configuration revision ${revision} with a non-current checksum`;
      this.publishSnapshot(session);
      throw new Error(session.configurationError);
    }
    if (session.configurationAppliedRevision === revision && session.configurationAppliedChecksum === checksum) return;
    session.configurationAppliedRevision = revision;
    session.configurationAppliedChecksum = checksum;
    session.configurationError = null;
    this.publishSnapshot(session);
  }

  setPromptAudioStatus(sessionId: string, connection: SessionConnection, status: PromptAudioStatus) {
    const session = this.get(sessionId);
    this.assertSignallingCapture(session, connection);
    session.promptAudioStatus = status;
    this.publishSnapshot(session);
  }

  acknowledgePrompt(
    sessionId: string,
    connection: SessionConnection,
    deliveryId: string,
    state: PromptDelivery["state"],
    error?: string,
  ) {
    const session = this.get(sessionId);
    this.assertActiveCapture(session, connection, "acknowledge prompt playback");
    const delivery = session.promptDeliveries.find((entry) => entry.id === deliveryId);
    if (!delivery) throw new Error("Prompt delivery is no longer known to the session");
    if (delivery.state === "completed" || delivery.state === "failed") {
      if (delivery.state === state) return;
      throw new Error("Prompt delivery is already finalised");
    }
    const ranks: Record<PromptDelivery["state"], number> = { queued: 0, started: 1, completed: 2, failed: 2 };
    if (ranks[state] < ranks[delivery.state]) throw new Error("Prompt acknowledgement moved backwards");
    delivery.state = state;
    delivery.error = state === "failed" ? error?.trim() || "Prompt playback failed" : null;
    delivery.updatedAt = new Date().toISOString();
    if (state === "failed") {
      session.promptAudioStatus = { state: "error", detail: delivery.error ?? "Prompt playback failed" };
    }
    this.publishSnapshot(session);
  }

  async acceptRecording(sessionId: string, connection: SessionConnection, episodeId: string) {
    const session = this.get(sessionId);
    await this.enqueueRun(session, async () => {
      this.assertActiveCapture(session, connection, "accept a recording request");
      if (!session.pendingEpisode || session.pendingEpisode.id !== episodeId) throw new Error("The recording request is no longer current");
      const acceptedEpisode = structuredClone(session.pendingEpisode);
      acceptedEpisode.recorderAcceptedAt ??= new Date().toISOString();
      await this.persistEpisode(session, acceptedEpisode);
      session.pendingEpisode = acceptedEpisode;
      session.recorderAcceptedEpisodeId = episodeId;
      if ((acceptedEpisode.recorderSlotCount ?? 0) > 0) await this.promotePendingEpisode(session, acceptedEpisode);
      else this.publishSnapshot(session);
    });
  }

  async setCaptureStatus(sessionId: string, connection: SessionConnection, status: CaptureStatus) {
    const session = this.get(sessionId);
    this.assertSignallingCapture(session, connection);
    session.captureStatus = {
      ...defaultCaptureStatus,
      ...status,
      recorder: session.captureStatus.recorder,
      recorderRateHz: session.configuration.recorderRateHz,
      recorderFrameIndex: session.captureStatus.recorderFrameIndex,
      recorderGaps: session.captureStatus.recorderGaps,
      recorderDurableAckSequence: session.captureStatus.recorderDurableAckSequence,
    };
    this.publish(session, "capture-status", { status: session.captureStatus });
    this.publishSnapshot(session);
  }

  isActiveRecorder(sessionId: string, connection: SessionConnection) {
    const session = this.get(sessionId);
    return connection.role === "recorder"
      && session.connections.has(connection)
      && session.activeRecorderId === connection.id
      && connection.pairingId === this.authorisedRecorderPairingId(session);
  }

  async armRecorder(sessionId: string, connection?: SessionConnection): Promise<{ nextSequence: number }> {
    const session = this.get(sessionId);
    if (connection) this.assertActiveRecorder(session, connection, "arm the recorder");
    return this.enqueueRecorder(session, async () => {
      if (connection) this.assertActiveRecorder(session, connection, "arm the recorder");
      if (session.recorderFailed) throw new RecorderStoreError("write-failed", "The recorder writer is failed and cannot be re-armed");
      session.captureStatus = {
        ...session.captureStatus,
        recorder: "arming",
        recorderRateHz: session.configuration.recorderRateHz,
      };
      this.publishCaptureStatus(session);
      try {
        await mkdir(this.sessionRoot(session), { recursive: true });
        await this.assertStorageSafe();
        await this.probeRecorderJournal(session);
        if (connection) this.assertActiveRecorder(session, connection, "arm the recorder");
        const recoveredPromotion = await this.loadRecorderLedger(
          session,
          connection ? () => this.assertActiveRecorder(session, connection, "arm the recorder") : undefined,
        );
        if (connection) this.assertActiveRecorder(session, connection, "arm the recorder");
        const recoveryPublication = recoveredPromotion
          ?? this.pendingBoundaryPublication(session, connection?.id ?? "");
        session.recorderArmed = true;
        session.captureStatus = {
          ...session.captureStatus,
          recorder: session.run.recordingState === "paused" ? "paused"
            : session.run.recordingState === "stopping" || session.recording ? "recording"
              : "armed",
          recorderDurableAckSequence: this.highestRecorderSequence(session),
        };
        if (recoveryPublication) this.publishPendingEpisodePromotion(session, recoveryPublication);
        this.publishCaptureStatus(session);
        return { nextSequence: this.highestRecorderSequence(session) + 1 };
      } catch (error) {
        const recorderError = this.asRecorderStoreError(error);
        if (!connection || this.isActiveRecorder(session.id, connection)) this.failRecorderState(session, recorderError);
        throw recorderError;
      }
    });
  }

  failRecorder(sessionId: string, error: unknown) {
    this.failRecorderState(this.get(sessionId), error);
  }

  async recordRecorderBlock(
    sessionId: string,
    block: RecorderBlock,
    encoded: Uint8Array,
    connection?: SessionConnection,
  ): Promise<RecorderWriteResult> {
    const session = this.get(sessionId);
    return this.enqueueRecorder(session, async () => {
      const assertAuthority = () => {
        if (connection) this.assertActiveRecorder(session, connection, "write recorder blocks");
      };
      const awaitAuthorised = async <T>(operation: () => Promise<T>): Promise<T> => {
        assertAuthority();
        const result = await operation();
        assertAuthority();
        return result;
      };
      const mutateAuthorised = (mutation: () => void) => {
        assertAuthority();
        mutation();
        assertAuthority();
      };
      let journalAppendStarted = false;
      try {
        assertAuthority();
        if (!session.recorderArmed || session.recorderFailed) throw new RecorderStoreError("write-failed", "The durable recorder path is not armed");
        if (block.sessionId !== session.id) throw new RecorderStoreError("session-mismatch", "Recorder block session does not match the registered session");
        this.assertRecorderFlags(block);
        if (!session.configuration.recordAudio && (block.flags & RecorderBlockFlags.AudioChunk) !== 0) {
          throw new RecorderStoreError("invalid-block", "Raw microphone audio is disabled for this recording");
        }
        const recoveredPromotion = await awaitAuthorised(() => this.loadRecorderLedger(session, assertAuthority));
        if (recoveredPromotion) mutateAuthorised(() => this.publishPendingEpisodePromotion(session, recoveredPromotion));
        const episode = await awaitAuthorised(() => this.resolveRecorderEpisode(session, block.episodeId, assertAuthority));
        const expectedSequence = this.highestRecorderSequence(session) + 1;
        const existing = session.recorderLedger.get(block.sequence);
        if (existing) {
          if (existing.checksum !== block.checksum || existing.episodeId !== block.episodeId || existing.recorderFrameIndex !== block.recorderFrameIndex) {
            throw new RecorderStoreError("sequence-conflict", `Recorder sequence ${block.sequence} conflicts with the durable block`, expectedSequence);
          }
          if (!await awaitAuthorised(() => this.isRecorderBlockMaterialised(session, episode, block, assertAuthority))) {
            await awaitAuthorised(() => this.materialiseRecorderBlock(session, episode, block, assertAuthority));
            mutateAuthorised(() => this.accountRecorderBlock(episode, block));
            let promoted = false;
            if (this.isRecorderTimelineBlock(block) && session.recorderAcceptedEpisodeId === episode.id) {
              promoted = await awaitAuthorised(() => this.promotePendingEpisode(session, episode, assertAuthority));
            }
            if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0 && episode.outcome !== "recording") {
              await awaitAuthorised(() => this.assembleRecorderMedia(session, episode));
            }
            if (!promoted) await awaitAuthorised(() => this.persistEpisode(session, episode));
          } else if ((block.flags & RecorderBlockFlags.RunEvent) !== 0) {
            mutateAuthorised(() => {
              this.reconcileRecorderRunEvent(episode, decodeRecorderRunEvent(block.payload), block.sourceTimestampUs);
              episode.firstRecorderSequence = episode.firstRecorderSequence === undefined
                ? block.sequence
                : Math.min(episode.firstRecorderSequence, block.sequence);
              episode.lastRecorderSequence = episode.lastRecorderSequence === undefined
                ? block.sequence
                : Math.max(episode.lastRecorderSequence, block.sequence);
            });
            await awaitAuthorised(() => this.persistEpisode(session, episode));
          } else if (this.isRecorderTimelineBlock(block)) {
            await awaitAuthorised(() => this.reconcileMaterialisedRecorderAccounting(session, episode, assertAuthority));
            const promoted = session.recorderAcceptedEpisodeId === episode.id
              && await awaitAuthorised(() => this.promotePendingEpisode(session, episode, assertAuthority));
            if (!promoted) await awaitAuthorised(() => this.persistEpisode(session, episode));
          }
          mutateAuthorised(() => this.settleRecorderPendingBoundary(session, episode, block));
          mutateAuthorised(() => {
            session.captureStatus = {
              ...session.captureStatus,
              recorderDurableAckSequence: Math.max(session.captureStatus.recorderDurableAckSequence, block.sequence),
            };
            this.publishCaptureStatus(session);
          });
          return { status: "duplicate", block };
        }
        if (block.sequence !== expectedSequence) {
          throw new RecorderStoreError("out-of-order", `Recorder sequence ${block.sequence} arrived while ${expectedSequence} was required`, expectedSequence);
        }
        this.assertRecorderContinuity(session, block);
        if ((block.flags & RecorderBlockFlags.RunEvent) !== 0) {
          this.validateRecorderRunEvent(episode, decodeRecorderRunEvent(block.payload), block.sourceTimestampUs);
        }
        await awaitAuthorised(() => this.assertStorageSafe(encoded.byteLength * 2));
        // The run tail serialises recorder writes. JavaScript does not yield between this
        // final authority check and starting the append, so replacement cannot enter the gap.
        assertAuthority();
        journalAppendStarted = true;
        const append = this.appendDurable(this.recorderJournalPath(session), encoded);
        await append;
        assertAuthority();
        mutateAuthorised(() => {
          session.recorderLedger.set(block.sequence, {
            checksum: block.checksum,
            episodeId: block.episodeId,
            recorderFrameIndex: block.recorderFrameIndex,
            sourceTimestampUs: block.sourceTimestampUs,
            flags: block.flags,
          });
        });
        await awaitAuthorised(() => this.materialiseRecorderBlock(session, episode, block, assertAuthority));
        mutateAuthorised(() => this.accountRecorderBlock(episode, block));
        let promoted = false;
        if (this.isRecorderTimelineBlock(block) && session.recorderAcceptedEpisodeId === episode.id) {
          promoted = await awaitAuthorised(() => this.promotePendingEpisode(session, episode, assertAuthority));
        }
        if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0 && episode.outcome !== "recording") {
          await awaitAuthorised(() => this.assembleRecorderMedia(session, episode));
        }
        if (!promoted) await awaitAuthorised(() => this.persistEpisode(session, episode));
        mutateAuthorised(() => this.settleRecorderPendingBoundary(session, episode, block));
        mutateAuthorised(() => {
          session.captureStatus = {
            ...session.captureStatus,
            recorder: session.recorderFailed ? "failed"
              : session.run.recordingState === "paused" ? "paused"
                : session.run.recordingState === "recording" && episode.outcome === "recording" ? "recording"
                  : session.pendingEpisode ? "arming" : "armed",
            recorderFrameIndex: block.recorderFrameIndex,
            recorderGaps: session.captureStatus.recorderGaps + ((block.flags & RecorderBlockFlags.Gap) !== 0 ? 1 : 0),
            recorderDurableAckSequence: block.sequence,
          };
          this.publishCaptureStatus(session);
        });
        journalAppendStarted = false;
        return { status: "durable", block };
      } catch (error) {
        const recorderError = this.asRecorderStoreError(error);
        if (recorderError.code === "not-capture" || journalAppendStarted) session.recorderLedgerLoaded = false;
        if (recorderError.code === "write-failed" || recorderError.code === "storage-unsafe") this.failRecorderState(session, recorderError);
        throw recorderError;
      }
    });
  }

  async recordFrame(sessionId: string, connection: SessionConnection, frame: SensorFrame) {
    const session = this.get(sessionId);
    this.claimActiveCaptureForSensor(session, connection);
    const canonicalFrame = canonicalSensorFrame(frame);
    session.lastFrame = canonicalFrame;
    session.captureStatus = {
      ...session.captureStatus,
      handTracking: canonicalFrame.leftHand.tracked || canonicalFrame.rightHand.tracked ? "active" : "waiting",
      lastFrameAt: canonicalFrame.timestampMs,
    };
    this.publishMonitors(session, "sensor-frame", { frame: canonicalFrame });
  }

  private async materialiseRecorderBlock(
    session: SessionState,
    episode: Episode,
    block: RecorderBlock,
    assertAuthority?: () => void,
  ) {
    const root = this.episodeRoot(session, episode.id);
    await mkdir(root, { recursive: true });
    assertAuthority?.();
    if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0) {
      decodeRecorderMediaPayload(block.payload);
      const chunkRoot = path.join(root, "video", "recorder-chunks");
      await mkdir(chunkRoot, { recursive: true });
      assertAuthority?.();
      await this.writeAtomic(this.recorderMediaChunkPath(session, episode.id, block.sequence), block.payload);
      assertAuthority?.();
      session.recorderMaterialised.add(block.sequence);
      return;
    }
    if ((block.flags & RecorderBlockFlags.AudioChunk) !== 0) {
      const audio = decodeRecorderMediaPayload(block.payload);
      const audioRoot = path.join(root, "audio");
      await mkdir(audioRoot, { recursive: true });
      assertAuthority?.();
      await this.writeAtomic(path.join(audioRoot, `${String(block.sequence).padStart(10, "0")}.${mediaExtension(audio.mimeType, "webm")}`), audio.data);
      assertAuthority?.();
      session.recorderMaterialised.add(block.sequence);
      return;
    }
    if ((block.flags & RecorderBlockFlags.RunEvent) !== 0) {
      const event = decodeRecorderRunEvent(block.payload);
      assertAuthority?.();
      this.applyRecorderRunEvent(episode, event, block.sourceTimestampUs);
      assertAuthority?.();
      await this.appendDurable(path.join(root, "run-events.jsonl"), Buffer.from(`${JSON.stringify({
        sequence: block.sequence,
        sourceTimestampUs: block.sourceTimestampUs,
        event,
      })}\n`));
      assertAuthority?.();
      session.recorderMaterialised.add(block.sequence);
      return;
    }
    if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
      const materialisation = this.recorderTimelineMaterialisation(episode, block);
      const reason = materialisation.gapReason!;
      await this.appendDurable(path.join(root, "sensors.jsonl"), Buffer.from(`${JSON.stringify(materialisation.record)}\n`));
      assertAuthority?.();
      episode.qualitySummary.gapCount = (episode.gapCount ?? 0) + 1;
      episode.qualityEvents.push({
        timestampMs: block.sourceTimestampUs / 1_000,
        type: "gap",
        detail: reason,
      });
      this.refreshEpisodeQualityDecision(episode);
      session.recorderMaterialised.add(block.sequence);
      return;
    }
    const materialisation = this.recorderTimelineMaterialisation(episode, block);
    const canonicalFrame = materialisation.frame!;
    await this.appendDurable(path.join(root, "sensors.jsonl"), Buffer.from(`${JSON.stringify(materialisation.record)}\n`));
    assertAuthority?.();
    session.recorderMaterialised.add(block.sequence);
    this.accountEpisodeFrameQuality(session, episode, canonicalFrame);
    session.lastFrame = canonicalFrame;
    session.captureStatus = {
      ...session.captureStatus,
      handTracking: canonicalFrame.leftHand.tracked || canonicalFrame.rightHand.tracked ? "active" : "waiting",
      lastFrameAt: canonicalFrame.timestampMs,
    };
    this.publishMonitors(session, "sensor-frame", { frame: canonicalFrame });
  }

  private recorderTimelineMaterialisation(episode: Episode, block: RecorderBlock): {
    record: Record<string, unknown>;
    frame?: SensorFrame;
    gapReason?: string;
  } {
    const recorder: {
      sessionId: string;
      episodeId: string;
      sequence: number;
      recorderFrameIndex: number;
      sourceTimestampUs: number;
      flags: number;
      checksum: number;
      segmentId?: string;
    } = {
      sessionId: block.sessionId,
      episodeId: block.episodeId,
      sequence: block.sequence,
      recorderFrameIndex: block.recorderFrameIndex,
      sourceTimestampUs: block.sourceTimestampUs,
      flags: block.flags,
      checksum: block.checksum,
    };
    const segmentId = this.recorderSegmentForTimestamp(episode, block.sourceTimestampUs)?.id;
    if (segmentId) recorder.segmentId = segmentId;
    if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
      const gapReason = block.payload.byteLength > 0 ? recorderPayloadDecoder.decode(block.payload) : "missing-source-sample";
      return {
        gapReason,
        record: {
          timestampMs: block.sourceTimestampUs / 1_000,
          frameIndex: block.recorderFrameIndex,
          gap: true,
          reason: gapReason,
          recorder,
        },
      };
    }
    if ((block.flags & RecorderBlockFlags.SensorFrameJson) === 0) {
      throw new RecorderStoreError("invalid-block", "A recorder sample must identify its payload encoding");
    }
    let frame: SensorFrame;
    try {
      frame = JSON.parse(recorderPayloadDecoder.decode(block.payload)) as SensorFrame;
    } catch {
      throw new RecorderStoreError("invalid-block", "Recorder sensor payload is not valid UTF-8 JSON");
    }
    if (!frame || typeof frame !== "object" || !frame.leftHand || !frame.rightHand || !frame.sceneStatus) {
      throw new RecorderStoreError("invalid-block", "Recorder sensor payload is missing required telemetry fields");
    }
    const canonicalFrame = canonicalSensorFrame(frame, block.sourceTimestampUs / 1_000, block.recorderFrameIndex);
    return {
      frame: canonicalFrame,
      record: {
        ...canonicalFrame,
        recorder,
      },
    };
  }

  private applyRecorderRunEvent(episode: Episode, event: RecorderRunEvent, sourceTimestampUs: number) {
    const segment = this.validateRecorderRunEvent(episode, event, sourceTimestampUs);
    if (event.type === "annotation") {
      segment.annotations.find((entry) => entry.id === event.annotationId)!.sourceTimestampUs ??= sourceTimestampUs;
    } else if (event.type === "segment-start") {
      segment.startSourceTimestampUs ??= sourceTimestampUs;
    } else {
      segment.endSourceTimestampUs ??= sourceTimestampUs;
    }
  }

  private reconcileRecorderRunEvent(episode: Episode, event: RecorderRunEvent, sourceTimestampUs: number) {
    const segment = episode.segments?.find((entry) => entry.id === event.segmentId);
    if (event.type === "annotation") {
      const annotation = segment?.annotations.find((entry) => entry.id === event.annotationId);
      if (annotation?.sourceTimestampUs === sourceTimestampUs) return;
    } else if (event.type === "segment-start" && segment?.startSourceTimestampUs === sourceTimestampUs) {
      return;
    } else if (event.type === "segment-end" && segment?.endSourceTimestampUs === sourceTimestampUs) {
      return;
    }
    this.applyRecorderRunEvent(episode, event, sourceTimestampUs);
  }

  private validateRecorderRunEvent(episode: Episode, event: RecorderRunEvent, sourceTimestampUs: number) {
    const segment = episode.segments?.find((entry) => entry.id === event.segmentId);
    if (!segment) throw new RecorderStoreError("invalid-block", "Recorder run event identifies an unknown task segment");
    if (event.type === "annotation") {
      const annotation = segment.annotations.find((entry) => entry.id === event.annotationId);
      if (!annotation) throw new RecorderStoreError("invalid-block", "Recorder annotation event identifies an unknown authoritative annotation");
      if (annotation.action !== event.action || annotation.actor !== event.actor) {
        throw new RecorderStoreError("invalid-block", "Recorder annotation event conflicts with the authoritative annotation");
      }
      if (annotation.sourceTimestampUs !== undefined && annotation.sourceTimestampUs !== sourceTimestampUs) {
        throw new RecorderStoreError("invalid-block", "Recorder annotation event source timestamp conflicts with the durable annotation");
      }
    } else {
      if (segment.taskId !== event.taskId || segment.taskLabel !== event.taskLabel) {
        throw new RecorderStoreError("invalid-block", "Recorder run event task metadata conflicts with the episode segment");
      }
      if (event.type === "segment-start" && segment.endSourceTimestampUs !== undefined) {
        throw new RecorderStoreError("invalid-block", "Recorder segment-start event follows its durable segment-end event");
      }
      if (event.type === "segment-end") {
        if (segment.startSourceTimestampUs === undefined) {
          throw new RecorderStoreError("invalid-block", "Recorder segment-end event has no durable segment-start event");
        }
        if (sourceTimestampUs < segment.startSourceTimestampUs) {
          throw new RecorderStoreError("invalid-block", "Recorder segment-end event precedes its durable segment-start event");
        }
      }
      const existingTimestampUs = event.type === "segment-start"
        ? segment.startSourceTimestampUs
        : segment.endSourceTimestampUs;
      if (existingTimestampUs !== undefined && existingTimestampUs !== sourceTimestampUs) {
        throw new RecorderStoreError("invalid-block", "Recorder run event source timestamp conflicts with the durable task segment");
      }
    }
    return segment;
  }

  private accountRecorderBlock(episode: Episode, block: RecorderBlock) {
    episode.firstRecorderSequence ??= block.sequence;
    episode.lastRecorderSequence = block.sequence;
    if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0) {
      episode.mediaChunkCount += 1;
      return;
    }
    if ((block.flags & RecorderBlockFlags.AudioChunk) !== 0) return;
    if ((block.flags & RecorderBlockFlags.RunEvent) !== 0) return;
    episode.recorderSlotCount = (episode.recorderSlotCount ?? 0) + 1;
    const segment = this.recorderSegmentForTimestamp(episode, block.sourceTimestampUs);
    if (segment) segment.recorderSlotCount = (segment.recorderSlotCount ?? 0) + 1;
    if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
      episode.gapCount = (episode.gapCount ?? 0) + 1;
      if (segment) segment.gapCount = (segment.gapCount ?? 0) + 1;
    } else {
      episode.frameCount += 1;
      episode.qualitySummary.frameCount = episode.frameCount;
      if (segment) segment.frameCount = (segment.frameCount ?? 0) + 1;
    }
  }

  private accountEpisodeFrameQuality(session: SessionState, episode: Episode, frame: SensorFrame) {
    let tracker = session.qualityTrackers.get(episode.id);
    if (!tracker) {
      tracker = new HandSpeedTracker();
      session.qualityTrackers.set(episode.id, tracker);
    }
    const sample = tracker.update(frame);
    const summary = episode.qualitySummary;
    summary.maxLeftHandSpeedMps = Math.max(summary.maxLeftHandSpeedMps, sample.leftMps);
    summary.maxRightHandSpeedMps = Math.max(summary.maxRightHandSpeedMps, sample.rightMps);
    if (sample.leftWarningStarted) {
      summary.slowHandEvents += 1;
      episode.qualityEvents.push({ timestampMs: frame.timestampMs, type: "slow-hands", hand: "left", value: sample.leftMps });
    }
    if (sample.rightWarningStarted) {
      summary.slowHandEvents += 1;
      episode.qualityEvents.push({ timestampMs: frame.timestampMs, type: "slow-hands", hand: "right", value: sample.rightMps });
    }
    if (sample.leftTrackingLost) {
      summary.trackingLossEvents += 1;
      episode.qualityEvents.push({ timestampMs: frame.timestampMs, type: "tracking-loss", hand: "left" });
    }
    if (sample.rightTrackingLost) {
      summary.trackingLossEvents += 1;
      episode.qualityEvents.push({ timestampMs: frame.timestampMs, type: "tracking-loss", hand: "right" });
    }
    this.refreshEpisodeQualityDecision(episode);
  }

  private refreshEpisodeQualityDecision(episode: Episode) {
    const summary = episode.qualitySummary;
    const reasons: string[] = [];
    const maximumSpeed = Math.max(summary.maxLeftHandSpeedMps, summary.maxRightHandSpeedMps);
    if (summary.gapCount > 0) reasons.push(`${summary.gapCount} recorder gap${summary.gapCount === 1 ? "" : "s"}`);
    if (summary.trackingLossEvents > 0) reasons.push(`${summary.trackingLossEvents} hand tracking loss event${summary.trackingLossEvents === 1 ? "" : "s"}`);
    if (summary.slowHandEvents > 0) reasons.push(`${summary.slowHandEvents} slow-hand warning${summary.slowHandEvents === 1 ? "" : "s"}`);
    summary.reasons = reasons;
    summary.decision = maximumSpeed >= HAND_SPEED_CRITICAL_MPS ? "stop" : reasons.length > 0 ? "caution" : "go";
  }

  private isRecorderTimelineBlock(block: Pick<RecorderBlock, "flags">) {
    return (block.flags & (RecorderBlockFlags.SensorFrameJson | RecorderBlockFlags.Gap)) !== 0;
  }

  private recorderSegmentForTimestamp(episode: Episode, sourceTimestampUs: number, segmentId?: string) {
    const segments = episode.segments ?? [];
    if (segmentId) {
      const candidate = segments.find((entry) => entry.id === segmentId);
      if (!candidate || candidate.startSourceTimestampUs === undefined) return undefined;
      if (sourceTimestampUs < candidate.startSourceTimestampUs) return undefined;
      if (candidate.endSourceTimestampUs !== undefined && sourceTimestampUs > candidate.endSourceTimestampUs) return undefined;
      return candidate;
    }
    const bounded = segments.filter((candidate) => candidate.startSourceTimestampUs !== undefined);
    return [...bounded].reverse().find((candidate) => {
      if (sourceTimestampUs < candidate.startSourceTimestampUs!) return false;
      if (candidate.endSourceTimestampUs !== undefined && sourceTimestampUs > candidate.endSourceTimestampUs) return false;
      return true;
    });
  }

  private async reconcileMaterialisedRecorderAccounting(
    session: SessionState,
    episode: Episode,
    assertAuthority?: () => void,
  ) {
    let content: string;
    try {
      content = await readFile(path.join(this.episodeRoot(session, episode.id), "sensors.jsonl"), "utf8");
      assertAuthority?.();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    episode.frameCount = 0;
    episode.gapCount = 0;
    episode.recorderSlotCount = 0;
    for (const segment of episode.segments ?? []) {
      segment.frameCount = 0;
      segment.gapCount = 0;
      segment.recorderSlotCount = 0;
    }
    const episodeSequences = [...session.recorderLedger.entries()]
      .filter(([, entry]) => entry.episodeId === episode.id)
      .map(([sequence]) => sequence);
    episode.firstRecorderSequence = episodeSequences.length > 0 ? Math.min(...episodeSequences) : undefined;
    episode.lastRecorderSequence = episodeSequences.length > 0 ? Math.max(...episodeSequences) : undefined;
    const accountedSequences = new Set<number>();
    for (const line of content.split("\n")) {
      if (!line) continue;
      let record: {
        recorder?: {
          sessionId?: string;
          episodeId?: string;
          sequence?: number;
          recorderFrameIndex?: number;
          sourceTimestampUs?: number;
          flags?: number;
          checksum?: number;
          segmentId?: string;
        };
      };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        throw new RecorderStoreError("write-failed", "The sensor sidecar contains invalid JSON");
      }
      const recorder = record.recorder;
      if (!recorder) continue;
      if (recorder.sessionId !== session.id
        || recorder.episodeId !== episode.id
        || !Number.isSafeInteger(recorder.sequence)
        || !Number.isSafeInteger(recorder.recorderFrameIndex)
        || !Number.isSafeInteger(recorder.sourceTimestampUs)
        || !Number.isSafeInteger(recorder.flags)
        || !Number.isSafeInteger(recorder.checksum)) {
        throw new RecorderStoreError("write-failed", "The sensor sidecar contains invalid recorder accounting data");
      }
      const sequence = recorder.sequence!;
      const ledger = session.recorderLedger.get(sequence);
      if (!ledger
        || ledger.episodeId !== recorder.episodeId
        || ledger.recorderFrameIndex !== recorder.recorderFrameIndex
        || ledger.sourceTimestampUs !== recorder.sourceTimestampUs
        || ledger.flags !== recorder.flags
        || ledger.checksum !== recorder.checksum
        || !this.isRecorderTimelineBlock({ flags: ledger.flags })) {
        throw new RecorderStoreError("write-failed", "The sensor sidecar conflicts with the durable recorder journal");
      }
      if (typeof recorder.segmentId === "string"
        && !episode.segments?.some((segment) => segment.id === recorder.segmentId)) {
        throw new RecorderStoreError("write-failed", "The sensor sidecar identifies an unknown task segment");
      }
      if (accountedSequences.has(sequence)) continue;
      accountedSequences.add(sequence);
      const segment = this.recorderSegmentForTimestamp(
        episode,
        ledger.sourceTimestampUs,
        typeof recorder.segmentId === "string" ? recorder.segmentId : undefined,
      );
      episode.recorderSlotCount += 1;
      if (segment) segment.recorderSlotCount = (segment.recorderSlotCount ?? 0) + 1;
      if ((ledger.flags & RecorderBlockFlags.Gap) !== 0) {
        episode.gapCount += 1;
        if (segment) segment.gapCount = (segment.gapCount ?? 0) + 1;
      } else {
        episode.frameCount += 1;
        if (segment) segment.frameCount = (segment.frameCount ?? 0) + 1;
      }
    }
    episode.qualitySummary.frameCount = episode.frameCount;
    episode.qualitySummary.gapCount = episode.gapCount;
    this.refreshEpisodeQualityDecision(episode);
  }

  private async promotePendingEpisode(
    session: SessionState,
    episode: Episode,
    assertAuthority?: () => void,
  ): Promise<boolean> {
    const promotedEpisode = this.preparePendingEpisodePromotion(session, episode);
    if (!promotedEpisode) return false;
    assertAuthority?.();
    await this.persistEpisode(session, promotedEpisode);
    assertAuthority?.();
    const plan = this.applyPendingEpisodePromotion(session, promotedEpisode);
    assertAuthority?.();
    this.publishPendingEpisodePromotion(session, plan);
    assertAuthority?.();
    return true;
  }

  private preparePendingEpisodePromotion(session: SessionState, episode: Episode): Episode | null {
    const segment = this.latestSegment(episode);
    if (session.pendingEpisode?.id !== episode.id
      || (episode.recorderSlotCount ?? 0) <= 0
      || segment?.startSourceTimestampUs === undefined
      || (segment.recorderSlotCount ?? 0) <= 0) return null;
    const promotedEpisode = structuredClone(episode);
    promotedEpisode.integrity = "valid";
    return promotedEpisode;
  }

  private applyPendingEpisodePromotion(session: SessionState, promotedEpisode: Episode): RecorderPromotionPlan {
    const taskPublication = session.pendingTaskPublication;
    const stopping = session.pendingStopOutcome !== null;
    const now = Date.now();
    if (taskPublication && !stopping) {
      session.run.phase = "active-task";
      session.run.takeStartedAtMs = now;
      session.run.takeElapsedMs = 0;
    }
    session.pendingEpisode = null;
    session.currentEpisode = promotedEpisode;
    const activeTask = session.run.phase === "active-task" && !stopping;
    session.recording = activeTask;
    session.run.recordingState = stopping ? "stopping" : activeTask ? "recording" : "paused";
    session.run.recordingStartedAtMs = activeTask ? now : null;
    session.run.error = null;
    session.captureStatus = { ...session.captureStatus, recorder: activeTask ? "recording" : "paused" };
    session.pendingTaskPublication = null;
    return {
      episode: promotedEpisode,
      taskPublication,
      stopping,
      activeTask,
      recovered: false,
      boundaryEvent: null,
      scheduleReset: false,
    };
  }

  private applyRecoveredActiveEpisode(session: SessionState, episode: Episode): RecorderPromotionPlan {
    const segment = this.latestSegment(episode);
    if (!segment) throw new RecorderStoreError("write-failed", "The recovered active episode has no active task segment");
    if (segment.outcome !== "recording") return this.applyRecoveredClosedSegment(session, episode, segment);
    const activeTaskIndex = session.configuration.tasks.findIndex((task) => task.id === segment.taskId);
    if (activeTaskIndex < 0) {
      throw new RecorderStoreError("write-failed", "The recovered active episode identifies an unknown task");
    }
    const now = Date.now();
    const episodeStartedAtMs = Date.parse(episode.startedAt);
    const segmentStartedAtMs = Date.parse(segment.startedAt);
    const directorReady = session.run.directorReady;
    const demonstratorReady = session.run.demonstratorReady;
    session.pendingEpisode = null;
    session.currentEpisode = episode;
    session.recording = true;
    session.recorderAcceptedEpisodeId = null;
    session.pendingStopOutcome = null;
    session.pendingRunAction = null;
    session.pendingRunTransitionApplied = false;
    session.pendingTaskPublication = null;
    session.pendingReviewAnnotation = null;
    session.run = {
      ...initialRunProgress(),
      status: "running",
      phase: "active-task",
      recordingState: "recording",
      directorReady,
      demonstratorReady,
      recordingLatched: true,
      startedAtMs: Number.isFinite(episodeStartedAtMs) ? episodeStartedAtMs : now,
      cycle: episode.cycle,
      activeTaskIndex,
      repetition: segment.repetition,
      take: segment.take,
      takeStartedAtMs: Number.isFinite(segmentStartedAtMs) ? segmentStartedAtMs : now,
      recordingStartedAtMs: Number.isFinite(segmentStartedAtMs) ? segmentStartedAtMs : now,
    };
    session.captureStatus = { ...session.captureStatus, recorder: "recording" };
    return {
      episode,
      taskPublication: null,
      stopping: false,
      activeTask: true,
      recovered: true,
      boundaryEvent: null,
      scheduleReset: false,
    };
  }

  private applyRecoveredEpisode(session: SessionState, episode: Episode): RecorderPromotionPlan {
    return this.applyRecoveredActiveEpisode(session, episode);
  }

  private applyRecoveredCompletedRun(session: SessionState, episode: Episode) {
    const segment = this.latestSegment(episode);
    if (!segment) throw new RecorderStoreError("write-failed", "The recovered completed run has no task segment");
    const activeTaskIndex = session.configuration.tasks.findIndex((task) => task.id === segment.taskId);
    if (activeTaskIndex < 0) {
      throw new RecorderStoreError("write-failed", "The recovered completed run identifies an unknown task");
    }
    const now = Date.now();
    const episodeStartedAtMs = Date.parse(episode.startedAt);
    const episodeEndedAtMs = episode.endedAt ? Date.parse(episode.endedAt) : now;
    const segmentStartedAtMs = Date.parse(segment.startedAt);
    const segmentEndedAtMs = segment.endedAt ? Date.parse(segment.endedAt) : episodeEndedAtMs;
    const directorReady = session.run.directorReady;
    const demonstratorReady = session.run.demonstratorReady;
    session.currentEpisode = null;
    session.pendingEpisode = null;
    session.recording = false;
    session.recorderAcceptedEpisodeId = null;
    session.pendingStopOutcome = null;
    session.pendingRunAction = null;
    session.pendingRunTransitionApplied = false;
    session.pendingTaskPublication = null;
    session.pendingReviewAnnotation = null;
    session.run = {
      ...initialRunProgress(),
      status: "complete",
      phase: null,
      recordingState: "idle",
      directorReady,
      demonstratorReady,
      recordingLatched: true,
      startedAtMs: Number.isFinite(episodeStartedAtMs) ? episodeStartedAtMs : now,
      endedAtMs: Number.isFinite(episodeEndedAtMs) ? episodeEndedAtMs : now,
      cycle: episode.cycle,
      activeTaskIndex,
      repetition: segment.repetition,
      take: segment.take,
      takeElapsedMs: Number.isFinite(segmentStartedAtMs) && Number.isFinite(segmentEndedAtMs)
        ? Math.max(0, segmentEndedAtMs - segmentStartedAtMs)
        : 0,
      recordingElapsedMs: Number.isFinite(episodeStartedAtMs) && Number.isFinite(episodeEndedAtMs)
        ? Math.max(0, episodeEndedAtMs - episodeStartedAtMs)
        : 0,
    };
    session.captureStatus = { ...session.captureStatus, recorder: "armed" };
    this.publishSnapshot(session);
  }

  private applyRecoveredClosedSegment(
    session: SessionState,
    episode: Episode,
    segment: EpisodeSegment,
  ): RecorderPromotionPlan {
    if (segment.outcome !== "completed" && segment.outcome !== "retry" && segment.outcome !== "stopped") {
      throw new RecorderStoreError("write-failed", "The recovered active episode has no recoverable task boundary");
    }
    const activeTaskIndex = session.configuration.tasks.findIndex((task) => task.id === segment.taskId);
    if (activeTaskIndex < 0) {
      throw new RecorderStoreError("write-failed", "The recovered active episode identifies an unknown task");
    }
    const task = session.configuration.tasks[activeTaskIndex];
    const now = Date.now();
    const episodeStartedAtMs = Date.parse(episode.startedAt);
    const segmentStartedAtMs = Date.parse(segment.startedAt);
    const segmentEndedAtMs = segment.endedAt ? Date.parse(segment.endedAt) : now;
    const directorReady = session.run.directorReady;
    const demonstratorReady = session.run.demonstratorReady;
    const finishing = episode.runFinalisation === "finish-requested";
    const stopping = segment.outcome === "stopped" || finishing;
    const missingBoundary = segment.endSourceTimestampUs === undefined;
    const resetDurationMs = isRepetitionTask(task) ? taskResetDurationMs(task.resetTimeS) : 0;
    const resetDeadlineMs = Number.isFinite(segmentEndedAtMs) ? segmentEndedAtMs + resetDurationMs : now;

    session.pendingEpisode = null;
    session.currentEpisode = episode;
    session.recording = false;
    session.recorderAcceptedEpisodeId = null;
    session.pendingStopOutcome = finishing ? "completed" : stopping ? "stopped" : null;
    session.pendingRunAction = finishing ? "finish-run" : stopping ? "stop-run" : null;
    session.pendingRunTransitionApplied = stopping;
    session.pendingTaskPublication = null;
    session.pendingReviewAnnotation = null;
    session.run = {
      ...initialRunProgress(),
      status: segment.outcome === "stopped" ? "stopped" : "running",
      phase: stopping ? null : "post-task-pause",
      recordingState: stopping ? "stopping" : "paused",
      directorReady,
      demonstratorReady,
      recordingLatched: true,
      startedAtMs: Number.isFinite(episodeStartedAtMs) ? episodeStartedAtMs : now,
      endedAtMs: segment.outcome === "stopped" ? now : null,
      cycle: episode.cycle,
      activeTaskIndex,
      repetition: segment.repetition,
      take: segment.take,
      takeElapsedMs: Number.isFinite(segmentStartedAtMs) && Number.isFinite(segmentEndedAtMs)
        ? Math.max(0, segmentEndedAtMs - segmentStartedAtMs)
        : 0,
      recordingElapsedMs: Number.isFinite(segmentStartedAtMs) && Number.isFinite(segmentEndedAtMs)
        ? Math.max(0, segmentEndedAtMs - segmentStartedAtMs)
        : 0,
      reviewEpisodeId: stopping ? null : episode.id,
      resetDeadlineMs: stopping ? null : resetDeadlineMs,
    };
    session.captureStatus = { ...session.captureStatus, recorder: stopping ? "recording" : "paused" };

    let boundaryEvent: RecorderPendingBoundary["event"] | null = null;
    if (missingBoundary) {
      if (segment.outcome === "retry") {
        throw new RecorderStoreError("write-failed", "A retried task segment is missing its durable segment-end event");
      }
      boundaryEvent = {
        type: "segment-end",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      };
      this.beginRecorderPendingBoundary(session, episode, segment, boundaryEvent);
      if (!stopping && resetDeadlineMs <= now) session.recorderPendingBoundary!.resetElapsed = true;
    }

    return {
      episode,
      taskPublication: null,
      stopping,
      activeTask: false,
      recovered: true,
      boundaryEvent,
      scheduleReset: !stopping && !missingBoundary,
    };
  }

  private pendingBoundaryPublication(session: SessionState, recorderId: string): RecorderPromotionPlan | null {
    const boundary = session.recorderPendingBoundary;
    const episode = session.currentEpisode ?? session.pendingEpisode;
    if (!boundary || !episode || boundary.episodeId !== episode.id || boundary.publishedRecorderId === recorderId) return null;
    return {
      episode,
      taskPublication: null,
      stopping: boundary.outcome === "stopped" || session.pendingRunAction === "finish-run",
      activeTask: false,
      recovered: true,
      boundaryEvent: boundary.event,
      scheduleReset: false,
    };
  }

  private publishPendingEpisodePromotion(session: SessionState, plan: RecorderPromotionPlan) {
    this.publish(session, "control", { action: "recording-started", episode: plan.episode, task: this.currentTask(session) });
    if (plan.stopping) {
      if (plan.boundaryEvent) {
        this.publish(session, "control", { action: "recording-paused", episode: plan.episode });
        this.publishRecorderRunEvent(session, plan.episode, plan.boundaryEvent);
      }
      this.publish(session, "control", { action: "recording-stopping", episode: plan.episode });
    } else if (plan.activeTask) {
      this.scheduleTimedCompletion(session);
      if (!plan.recovered) {
        this.queuePrompt(session, "task-start");
        if (plan.taskPublication) this.publish(session, "control", { action: plan.taskPublication, task: this.currentTask(session) });
      }
    } else this.publish(session, "control", { action: "recording-paused", episode: plan.episode });
    if (plan.scheduleReset) this.scheduleResetExpiry(session);
    if (!plan.stopping && plan.boundaryEvent) this.publishRecorderRunEvent(session, plan.episode, plan.boundaryEvent);
    this.publishSnapshot(session);
  }

  async recordMedia(sessionId: string, connection: SessionConnection, mimeType: string, sequence: number, dataBase64: string) {
    const session = this.get(sessionId);
    this.assertActiveCapture(session, connection, "report capture media");
    if (!session.recording || !session.currentEpisode) return;
    const root = this.episodeRoot(session, session.currentEpisode.id);
    await mkdir(path.join(root, "video"), { recursive: true });
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    await this.appendDurable(path.join(root, "video", `passthrough.${extension}`), Buffer.from(dataBase64, "base64"));
    session.currentEpisode.mediaChunkCount += 1;
    this.publishSnapshot(session);
  }

  async recordAudio(sessionId: string, connection: SessionConnection, mimeType: string, sequence: number, dataBase64: string) {
    const session = this.get(sessionId);
    this.assertActiveCapture(session, connection, "report capture audio");
    if (session.recording && session.currentEpisode && session.configuration.recordAudio) {
      const root = this.episodeRoot(session, session.currentEpisode.id);
      await mkdir(path.join(root, "audio"), { recursive: true });
      const extension = mimeType.includes("wav") ? "wav" : "webm";
      await this.writeDurable(path.join(root, "audio", `${String(sequence).padStart(6, "0")}.${extension}`), Buffer.from(dataBase64, "base64"));
    }
  }

  async recordTranscript(sessionId: string, text: string, timestampMs: number, connection?: SessionConnection) {
    if (!this.features.speech) return;
    const session = this.get(sessionId);
    if (!text) return;
    const command = commandMatchers.find(([, pattern]) => pattern.test(text))?.[0];
    const action = command === "successful-episode" ? "success"
      : command === "failed-episode" ? "fail"
        : command === "next-task" ? "next-task"
          : null;
    const controlCursor = action ? nextRunControlCursor(session, action) : null;
    await this.enqueueRun(session, async () => {
      if (connection) this.assertActiveCapture(session, connection, "report a transcript");
      session.lastTranscript = { text, timestampMs };
      if (session.recording && session.currentEpisode) {
        await appendFile(path.join(this.episodeRoot(session, session.currentEpisode.id), "transcript.jsonl"), `${JSON.stringify({ text, timestampMs })}\n`);
      }
      this.publish(session, "transcript", { text, timestampMs });
      await this.applyVoiceCommand(session, text, timestampMs, command, action, controlCursor);
      this.publishSnapshot(session);
    });
  }

  async control(sessionId: string, action: string, connection?: SessionConnection, nextCursor?: string) {
    const session = this.get(sessionId);
    if (connection?.role === "capture") this.assertActiveCapture(session, connection, "control the run");
    else if (connection && connection.role !== "monitor" && connection.role !== "monitor-control") throw new Error("Only the capture director or active demonstrator can control the run");
    await this.enqueueRun(session, async () => {
      const actor = connection?.role === "capture" ? "demonstrator" : "director";
      if (isStateBoundRunControlAction(action)
        && (action === "finish" || connection !== undefined || nextCursor !== undefined)
        && nextCursor !== nextRunControlCursor(session, action)) {
        this.publishSnapshot(session);
        return;
      }
      if (action === "start-sequence") {
        if (connection) this.toggleReady(session, connection.role === "capture" ? "demonstrator" : "director");
        else await this.startSequence(session);
      } else if (action === "start") this.publishSnapshot(session);
      else if (action === "pause") this.pauseRecording(session);
      else if (action === "stop") await this.stopRun(session);
      else if (action === "finish") await this.finishRun(session);
      else if (action === "success") await this.annotateTake(session, "pass", actor);
      else if (action === "fail") await this.annotateTake(session, "fail", actor);
      else if (action === "retry") await this.retryTake(session, actor);
      else if (action === "resume") this.resumeRecording(session);
      else if (action === "next-task") await this.nextTask(session, actor);
      else if (action === "show-instructions") this.sendInstructions(session);
      else throw new Error(`Unknown run control ${action}`);
    });
  }

  async finaliseRecording(sessionId: string, connection: SessionConnection, episodeId: string, failureReason?: string) {
    const session = this.get(sessionId);
    await this.enqueueRun(session, async () => {
      this.assertActiveCapture(session, connection, "finalise a recording");
      const episode = session.currentEpisode ?? session.pendingEpisode;
      if (!episode || episode.id !== episodeId) {
        const alreadyFinalised = session.episodes.some((entry) => entry.id === episodeId)
          || session.attempts.some((entry) => entry.id === episodeId);
        if (alreadyFinalised) return;
        throw new Error("The capture client finalised an unexpected episode");
      }
      const failureDetail = typeof failureReason === "string" ? failureReason.trim().slice(0, 512) : "";
      if (failureDetail) {
        this.failRecorderState(session, new RecorderStoreError("write-failed", failureDetail));
        await this.interruptEpisode(session, "Recorder finalisation failed");
        return;
      }
      const outcome = session.pendingStopOutcome;
      if (!outcome) return;
      session.pendingStopOutcome = null;
      try {
        await this.stopEpisode(session, outcome);
      } catch (error) {
        await this.interruptEpisode(session, "Recorder finalisation failed").catch(() => undefined);
        throw error;
      }
    });
  }

  beam(sessionId: string, text: string, speak: boolean, visual: boolean) {
    const session = this.get(sessionId);
    const message = text.trim();
    if (!message) return;
    this.activeCapture(session)?.send("beam", { text: message, speak: this.features.speech && speak, visual });
  }

  private queuePrompt(session: SessionState, transition: PromptDelivery["transition"]) {
    const configuration = session.configuration.promptAudio;
    if (!configuration.enabled && !configuration.useTextToSpeech) return;
    const task = this.currentTask(session);
    const text = transition === "task-start"
      ? task?.instructions && task.instructions !== "--" ? task.instructions : session.configuration.runDescription || session.configuration.runTitle
      : transition === "reset" ? "Reset for the next task occurrence"
        : `${session.configuration.runTitle} complete`;
    const assetUrl = configuration.enabled
      ? transition === "task-start"
        ? configuration.taskStartAssetUrl
        : transition === "reset" ? configuration.resetAssetUrl : configuration.completionAssetUrl
      : "";
    if (!text && !assetUrl) return;
    const now = new Date().toISOString();
    const delivery: PromptDelivery = {
      id: crypto.randomUUID(),
      transition,
      text,
      assetUrl,
      state: "queued",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    session.promptDeliveries.unshift(delivery);
    session.promptDeliveries = session.promptDeliveries.slice(0, 50);
    this.activeCapture(session)?.send("prompt", { delivery, useTextToSpeech: configuration.useTextToSpeech });
    this.publishSnapshot(session);
  }

  relay(sessionId: string, source: SessionConnection, type: string, payload: unknown) {
    const session = this.get(sessionId);
    for (const connection of session.connections) if (connection !== source) connection.send(type, payload);
  }

  setMonitorLoad(sessionId: string, source: SessionConnection, stage: number) {
    if (source.role !== "monitor") return;
    const session = this.get(sessionId);
    source.monitorLoadStage = Math.min(5, Math.max(0, Math.trunc(Number.isFinite(stage) ? stage : 0)));
    this.updateMonitorLoadStage(session);
  }

  runSecondaryWork(sessionId: string) {
    return this.get(sessionId).monitorLoadStage < 5;
  }

  requestCaptureIntent(sessionId: string, connection: SessionConnection): CaptureAuthorityResult {
    const session = this.get(sessionId);
    const authority = this.captureAuthorityDecision(session, connection);
    if (!authority.accepted || authority.alreadyActive) return authority;
    this.grantCaptureIntent(session, connection);
    this.publishSnapshot(session);
    return authority;
  }

  activateCaptureAuthority(sessionId: string, connection: SessionConnection): CaptureAuthorityResult {
    const session = this.get(sessionId);
    const authority = this.captureAuthorityDecision(session, connection);
    if (!authority.accepted) return authority;
    if (!authority.alreadyActive) {
      session.pairedCapturePairingId ??= connection.pairingId!;
      this.grantCaptureIntent(session, connection);
      this.activateCapture(session, connection);
      for (const candidate of [...session.connections]) {
        if (candidate.role !== "capture" || candidate.id === connection.id) continue;
        candidate.send("capture-intent-suspended", {});
        candidate.close?.(CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE, "Capture connection superseded by an active XR tab");
      }
      for (const recorder of [...session.connections]) {
        if (recorder.role !== "recorder" || recorder.pairingId === connection.pairingId) continue;
        this.suspendRecorder(session, recorder, "Recorder superseded by the active XR tab");
      }
    }
    connection.send("capture-authority-granted", {});
    this.publishSnapshot(session);
    return authority;
  }

  requestOffer(sessionId: string, requester: SessionConnection) {
    if (requester.role !== "monitor") return;
    const session = this.get(sessionId);
    const capture = this.signallingCapture(session);
    if (!capture) return;
    capture.activeWebRtcPeerId = requester.id;
    session.webRtcCaptureByPeer.set(requester.id, capture.id);
    capture.send("webrtc-request-offer", { peerId: requester.id });
  }

  relayWebRtc(sessionId: string, source: SessionConnection, peerId: string, signal: WebRtcSignal) {
    const session = this.get(sessionId);
    if (!peerId) return;
    if (source.role === "capture") {
      this.assertSignallingCapture(session, source);
      if (session.webRtcCaptureByPeer.get(peerId) !== source.id) return;
      for (const connection of session.connections) {
        if (connection.role === "monitor" && connection.id === peerId) connection.send("webrtc-signal", { peerId, signal });
      }
      return;
    }
    if (source.id !== peerId) return;
    const captureId = session.webRtcCaptureByPeer.get(peerId);
    const capture = this.signallingCapture(session);
    if (capture?.id !== captureId) return;
    capture?.send("webrtc-signal", { peerId, signal });
  }

  createExport(sessionId: string) {
    const session = this.get(sessionId);
    const job = this.createJob(session, "export", "Queued LeRobot v3 export");
    void this.runExport(session, job);
  }

  async recordEpisodeUpload(
    sessionId: string,
    connection: SessionConnection,
    requestId: string,
    episodeIds: string[],
    receipt: string,
  ): Promise<{ status: "durable" | "duplicate"; upload: VerifiedEpisodeHuggingFaceUpload }> {
    const session = this.get(sessionId);
    if (!session.connections.has(connection) || (connection.role !== "monitor" && connection.role !== "monitor-control")) {
      throw new Error("Only the capture director can record a Hugging Face upload");
    }
    if (!this.uploadCompletionVerifier) {
      throw new Error("Backend-verified Hugging Face upload receipts are not configured");
    }
    const ids = validateEpisodeUploadCommit(requestId, episodeIds, receipt);
    const upload = this.uploadCompletionVerifier(receipt, { requestId, sessionId });
    if (upload.requestId !== requestId || upload.captureSessionId !== sessionId || !sameEpisodeSelection(ids, upload.episodeIds)) {
      throw new Error("The upload completion proof does not match the selected episodes");
    }
    return this.enqueueRun(session, async () => {
      const episodes = ids.map((episodeId) => {
        const episode = session.episodes.find((entry) => entry.id === episodeId)
          ?? session.attempts.find((entry) => entry.id === episodeId);
        if (!episode || !isExportableEpisode(episode)) {
          throw new Error(`Episode ${episodeId} is not available for upload metadata`);
        }
        return episode;
      });
      const reusedRequest = [...session.episodes, ...session.attempts]
        .map((episode) => episode.huggingFaceUpload)
        .find((candidate) => candidate?.requestId === requestId && candidate.completionReceipt !== receipt);
      if (reusedRequest) {
        throw new Error("The upload metadata request identity was already used for different proof");
      }
      let mutated = false;
      for (const episode of episodes) {
        if (isDeepStrictEqual(episode.huggingFaceUpload, upload)) continue;
        await this.persistEpisodeMutation(session, episode, (candidate) => {
          candidate.huggingFaceUpload = structuredClone(upload);
        });
        mutated = true;
      }
      if (mutated) this.publishSnapshot(session);
      return { status: mutated ? "durable" : "duplicate", upload };
    });
  }

  async deleteEpisode(sessionId: string, connection: SessionConnection, episodeId: string) {
    const session = this.get(sessionId);
    if (!session.connections.has(connection) || (connection.role !== "monitor" && connection.role !== "monitor-control")) {
      throw new Error("Only the capture director can delete an episode");
    }
    await this.enqueueRun(session, async () => {
      if (session.currentEpisode?.id === episodeId || session.pendingEpisode?.id === episodeId) {
        throw new Error("An active recording cannot be deleted");
      }
      const episode = session.episodes.find((entry) => entry.id === episodeId)
        ?? session.attempts.find((entry) => entry.id === episodeId);
      if (!episode) throw new Error("Episode was not found");
      await this.writeAtomic(
        path.join(this.episodeRoot(session, episode.id), "deleted.json"),
        Buffer.from(JSON.stringify({ deletedAt: new Date().toISOString() }, null, 2)),
      );
      session.episodes = session.episodes.filter((entry) => entry.id !== episode.id);
      session.attempts = session.attempts.filter((entry) => entry.id !== episode.id);
      this.publishSnapshot(session);
    });
  }

  private async startEpisode(
    session: SessionState,
    taskPublication: SessionState["pendingTaskPublication"] = null,
  ) {
    const readiness = this.recordingReadiness(session);
    if (!readiness.ready) throw new Error(`Recording is not ready: ${readiness.blockers.map((blocker) => blocker.message).join("; ")}`);
    if (session.run.status !== "running" || session.run.phase !== "active-task" || session.run.recordingState !== "idle") {
      throw new Error("Recording can only start during an active take");
    }
    const task = this.currentTask(session);
    if (!task || !isRepetitionTask(task)) throw new Error("The active run item cannot be recorded");
    const taskDescription = task?.instructions && task.instructions !== "--"
      ? task.instructions
      : session.configuration.runDescription || session.configuration.runTitle;
    const taskSpecification = taskSpecificationFromCaptureConfiguration(session.configuration);
    const taskSpecHash = taskSpecificationHash(taskSpecification);
    const episode: Episode = {
      id: crypto.randomUUID(),
      runTitle: session.configuration.runTitle,
      runDescription: session.configuration.runDescription,
      taskId: task?.id ?? null,
      taskLabel: task?.label ?? session.configuration.runTitle,
      taskDescription,
      cycle: session.run.cycle,
      repetition: session.run.repetition,
      take: session.run.take,
      startedAt: new Date().toISOString(),
      outcome: "recording",
      annotation: null,
      accepted: false,
      integrity: "pending",
      configurationRevision: session.configurationRevision,
      frameCount: 0,
      mediaChunkCount: 0,
      recorderSlotCount: 0,
      gapCount: 0,
      qualitySummary: {
        decision: "go",
        reasons: [],
        frameCount: 0,
        gapCount: 0,
        maxLeftHandSpeedMps: 0,
        maxRightHandSpeedMps: 0,
        slowHandEvents: 0,
        trackingLossEvents: 0,
      },
      qualityEvents: [],
      captureMetadata: captureMetadataFromStatus(
        session.captureStatus,
        session.cameraRegistration,
        session.configuration,
      ),
      taskSpecVersion: CERES_TASK_SPEC_VERSION,
      taskSpecHash,
      taskSpecification,
      segments: [],
    };
    const segment = this.openCurrentSegment(session, episode);
    try {
      await this.assertStorageSafe();
    } catch (error) {
      const recorderError = this.asRecorderStoreError(error);
      this.failRecorderState(session, recorderError);
      throw recorderError;
    }
    try {
      await this.persistTaskSpecification(session, episode);
      await this.persistEpisode(session, episode);
    } catch (error) {
      const recorderError = this.asRecorderStoreError(error);
      this.failRecorderState(session, recorderError);
      throw recorderError;
    }
    session.recording = false;
    session.pendingEpisode = episode;
    session.recorderAcceptedEpisodeId = null;
    session.run.recordingState = "arming";
    session.run.error = null;
    session.pendingTaskPublication = taskPublication;
    if (taskPublication) {
      session.run.phase = null;
      session.run.takeStartedAtMs = null;
      session.run.takeElapsedMs = 0;
    }
    session.captureStatus = {
      ...session.captureStatus,
      recorder: "arming",
      recorderFrameIndex: -1,
      recorderGaps: 0,
    };
    this.publish(session, "control", { action: "recording-arming", episode, task });
    this.publishRecorderRunEvent(session, episode, {
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    });
    this.publishSnapshot(session);
  }

  publishAsrStatus(sessionId: string, state: AsrStatusState) {
    if (!this.features.speech) return;
    this.publish(this.get(sessionId), "asr-status", { state });
  }

  private requestEpisodeStop(
    session: SessionState,
    outcome: "stopped" | "completed",
    nextAction: SessionState["pendingRunAction"],
  ) {
    const episode = session.currentEpisode ?? session.pendingEpisode;
    if (!episode) throw new Error("There is no active recording to stop");
    if (session.pendingStopOutcome) return;
    if (nextAction === "stop-run" || nextAction === "finish-run") {
      this.clearRunTimers(session);
      session.run.phase = null;
      session.run.resetDeadlineMs = null;
    } else this.clearTimedTaskTimer(session);
    this.freezeTakeAndRecordingClocks(session);
    session.pendingStopOutcome = outcome;
    session.pendingRunAction = nextAction;
    session.pendingRunTransitionApplied = true;
    session.run.recordingState = "stopping";
    this.publish(session, "control", { action: "recording-stopping", episode });
    this.publishSnapshot(session);
  }

  private async stopEpisode(session: SessionState, outcome: "stopped" | "completed") {
    const activeEpisode = session.currentEpisode ?? session.pendingEpisode;
    if (!activeEpisode) throw new Error("There is no active recording to stop");
    const episode = structuredClone(activeEpisode);
    this.clearTimedTaskTimer(session);
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
    const valid = episode.integrity === "valid"
      && (episode.recorderSlotCount ?? 0) > 0
      && episode.frameCount > 0
      && !uncoveredSegment
      && !unboundedSegment
      && !reversedSegment
      && !invalidAccountingSegment
      && !frameLeakage
      && !slotLeakage
      && !gapLeakage;
    episode.outcome = valid ? outcome : "stopped";
    episode.accepted = valid && outcome === "completed";
    episode.integrity = valid ? "valid" : "interrupted";
    if (episode.accepted && episode.runFinalisation === "finish-requested") {
      episode.runFinalisation = "finish-completed";
    }
    session.pendingReviewAnnotation = null;
    if (!valid) {
      episode.integrityReason ??= uncoveredSegment
        ? `Task segment ${uncoveredSegment.taskLabel} has no durable recorder slots`
        : unboundedSegment && unboundedSegment.startSourceTimestampUs === undefined
          ? `Task segment ${unboundedSegment.taskLabel} has no durable segment-start event`
          : unboundedSegment && unboundedSegment.endSourceTimestampUs === undefined
            ? `Task segment ${unboundedSegment.taskLabel} has no durable segment-end event`
            : reversedSegment
              ? `Task segment ${reversedSegment.taskLabel} ends before its durable segment-start event`
              : invalidAccountingSegment
                ? `Task segment ${invalidAccountingSegment.taskLabel} recorder accounting is inconsistent`
              : frameLeakage
                ? "Episode sensor frames are not fully attributed to durable task segments"
                : slotLeakage
                  ? "Episode recorder slots are not fully attributed to durable task segments"
                  : gapLeakage
                    ? "Episode recorder gaps are not fully attributed to durable task segments"
              : (episode.recorderSlotCount ?? 0) === 0
                ? "Recording stopped before the first durable recorder slot"
                : "Recording stopped before the first durable sensor frame";
    }
    for (const segment of segments) {
      segment.accepted = episode.accepted
        && segment.outcome === "completed"
        && (segment.recorderSlotCount ?? 0) > 0
        && segment.startSourceTimestampUs !== undefined
        && segment.endSourceTimestampUs !== undefined;
    }
    episode.endedAt = new Date().toISOString();
    try {
      await this.assembleRecorderMedia(session, episode);
      await this.persistEpisode(session, episode);
    } catch (error) {
      const recorderError = this.asRecorderStoreError(error);
      this.failRecorderState(session, recorderError);
      throw recorderError;
    }
    session.recording = false;
    session.currentEpisode = null;
    session.pendingEpisode = null;
    session.recorderAcceptedEpisodeId = null;
    session.pendingTaskPublication = null;
    session.pendingStopOutcome = null;
    const nextAction = session.pendingRunAction;
    session.pendingRunAction = null;
    session.pendingRunTransitionApplied = false;
    session.pendingReviewAnnotation = null;
    session.qualityTrackers.delete(episode.id);
    if (episode.accepted) {
      session.episodes.unshift(episode);
    } else {
      session.attempts.unshift(episode);
    }
    session.run.recordingState = session.currentEpisode || session.pendingEpisode ? "stopping" : "idle";
    session.run.recordingStartedAtMs = null;
    session.captureStatus = { ...session.captureStatus, recorder: session.recorderFailed ? "failed" : "armed" };
    this.publish(session, "control", { action: "recording-stopped", episode });
    if (nextAction === "stop-run") this.finishStoppedRun(session);
    else if (nextAction === "finish-run") {
      if (episode.accepted) this.finishCompletedRun(session, Date.parse(episode.endedAt));
      else this.setRunError(session, new Error(episode.integrityReason ?? "Finished recording did not pass recorder validation"));
    } else this.publishSnapshot(session);
    if (episode.accepted && session.configuration.uploadAfterEpisode) {
      this.createExport(session.id);
    }
  }

  private async interruptEpisode(session: SessionState, reason: string) {
    const episode = session.currentEpisode ?? session.pendingEpisode;
    if (!episode) return;
    this.clearRunTimers(session);
    const segment = this.latestSegment(episode);
    if (segment?.outcome === "recording") {
      segment.endedAt = new Date().toISOString();
      segment.outcome = "stopped";
      segment.accepted = false;
    }
    episode.outcome = "stopped";
    episode.accepted = false;
    episode.integrity = "interrupted";
    episode.integrityReason = reason;
    episode.endedAt = new Date().toISOString();
    let persistenceError: unknown = null;
    try {
      await this.assembleRecorderMedia(session, episode);
      await this.persistEpisode(session, episode);
    } catch (error) {
      persistenceError = error;
      this.failRecorderState(session, error);
    }
    session.recording = false;
    session.currentEpisode = null;
    session.pendingEpisode = null;
    session.recorderAcceptedEpisodeId = null;
    session.pendingTaskPublication = null;
    session.pendingStopOutcome = null;
    session.pendingRunAction = null;
    session.pendingRunTransitionApplied = false;
    session.pendingReviewAnnotation = null;
    session.qualityTrackers.delete(episode.id);
    session.episodes = session.episodes.filter((entry) => entry.id !== episode.id);
    if (!session.attempts.some((entry) => entry.id === episode.id)) session.attempts.unshift(episode);
    session.captureStatus = { ...session.captureStatus, recorder: session.recorderFailed ? "failed" : "armed" };
    this.publish(session, "control", { action: "recording-stopped", episode });
    this.finishStoppedRun(session);
    if (persistenceError) throw persistenceError;
  }

  private async failClosedRunTransition(session: SessionState, error: unknown): Promise<never> {
    const recorderError = this.asRecorderStoreError(error);
    this.failRecorderState(session, recorderError);
    try {
      await this.interruptEpisode(session, `Run transition failed: ${recorderError.message}`);
    } catch {
      // The recorder is already failed and the in-memory episode has been detached.
    }
    this.setRunError(session, recorderError);
    throw recorderError;
  }

  private async nextTask(session: SessionState, actor: "director" | "demonstrator") {
    if (session.run.status !== "running") throw new Error("Start the run before advancing the task sequence");
    if (session.run.phase === "cycle-pause") {
      await this.finishCyclePause(session);
      return;
    }
    if (session.run.phase === "active-task") {
      await this.completeCurrentTask(session);
      const activeEpisode = session.currentEpisode ?? session.pendingEpisode;
      if (activeEpisode) {
        const episode = await this.persistEpisodeMutation(session, activeEpisode, (candidate) => {
          this.appendSegmentAnnotation(candidate, "next", actor);
        });
        const segment = this.latestSegment(episode)!;
        const annotationEntry = segment.annotations.at(-1)!;
        this.publishRecorderRunEvent(session, episode, {
          type: "annotation",
          segmentId: segment.id,
          annotationId: annotationEntry.id,
          action: "next",
          actor,
        });
      }
      return;
    }
    if (session.run.phase !== "post-task-pause" && session.run.phase !== "task-pause") {
      throw new Error("Next is only available during a reset");
    }
    if (session.run.phase === "post-task-pause" && session.run.reviewEpisodeId) {
      const activeEpisode = this.activeCycleEpisode(session, session.run.reviewEpisodeId);
      if (activeEpisode) {
        const episode = await this.persistEpisodeMutation(session, activeEpisode, (candidate) => {
          this.appendSegmentAnnotation(candidate, "next", actor);
        });
        const segment = this.latestSegment(episode)!;
        const annotationEntry = segment.annotations.at(-1)!;
        this.publishRecorderRunEvent(session, episode, {
          type: "annotation",
          segmentId: segment.id,
          annotationId: annotationEntry.id,
          action: "next",
          actor,
        });
      }
    }
    await this.advanceAfterReset(session, false);
  }

  private async annotateTake(
    session: SessionState,
    annotation: "pass" | "fail",
    actor: "director" | "demonstrator",
  ) {
    if (session.run.status !== "running"
      || session.run.phase !== "post-task-pause") {
      throw new Error("Pass and fail are only available during the task reset");
    }
    if (!session.run.reviewEpisodeId) throw new Error("Pass and fail are only available during the task reset");
    const activeEpisode = this.activeCycleEpisode(session, session.run.reviewEpisodeId);
    if (!activeEpisode) throw new Error("The task available for annotation is no longer present");
    const episode = await this.persistEpisodeMutation(session, activeEpisode, (candidate) => {
      this.appendSegmentAnnotation(candidate, annotation, actor);
      candidate.annotation = annotation;
    });
    const segment = this.latestSegment(episode)!;
    const annotationEntry = segment.annotations.at(-1)!;
    this.publishRecorderRunEvent(session, episode, {
      type: "annotation",
      segmentId: segment.id,
      annotationId: annotationEntry.id,
      action: annotation,
      actor,
    });
    this.publish(session, "control", { action: "take-annotated", episode });
    this.publishSnapshot(session);
  }

  private async retryTake(session: SessionState, actor: "director" | "demonstrator") {
    if (session.run.status === "running" && session.run.phase === "active-task") {
      await this.completeCurrentTask(session);
    }
    if (session.run.status !== "running" || session.run.phase !== "post-task-pause" || !session.run.reviewEpisodeId) {
      throw new Error("Retry is only available during the task reset");
    }
    const activeEpisode = this.activeCycleEpisode(session, session.run.reviewEpisodeId);
    const activeSegment = activeEpisode ? this.latestSegment(activeEpisode) : null;
    if (!activeEpisode || !activeSegment) throw new Error("The task available for retry is no longer present");
    const episode = await this.persistEpisodeMutation(session, activeEpisode, (candidate) => {
      const segment = this.appendSegmentAnnotation(candidate, "retry", actor);
      segment.outcome = "retry";
      segment.accepted = false;
    });
    const segment = this.latestSegment(episode)!;
    const annotationEntry = segment.annotations.at(-1)!;
    this.publishRecorderRunEvent(session, episode, {
      type: "annotation",
      segmentId: segment.id,
      annotationId: annotationEntry.id,
      action: "retry",
      actor,
    });
    this.publishSnapshot(session);
  }

  private advanceRunCursor(session: SessionState) {
    const task = this.currentTask(session);
    if (!task || !isRepetitionTask(task)) {
      session.run.activeTaskIndex += 1;
      session.run.repetition = 1;
      session.run.take = 1;
      return;
    }
    const repetitions = Math.max(1, task.repeatCount);
    if (session.run.repetition < repetitions) {
      session.run.repetition += 1;
      session.run.take = session.run.repetition;
      return;
    }
    session.run.repetition = 1;
    session.run.take = 1;
    session.run.activeTaskIndex += 1;
  }

  private beginCycleBoundary(session: SessionState) {
    session.pendingTaskPublication = null;
    session.run.phase = "cycle-pause";
    session.run.resetDeadlineMs = Date.now() + CYCLE_PAUSE_MS;
    session.run.takeStartedAtMs = null;
    session.run.recordingStartedAtMs = null;
    session.run.error = null;
    this.scheduleResetExpiry(session);
    this.queuePrompt(session, "reset");
    if (session.currentEpisode || session.pendingEpisode) {
      this.requestEpisodeStop(session, "completed", "cycle-boundary");
      return;
    }
    this.publishSnapshot(session);
  }

  private async finishCyclePause(session: SessionState) {
    if (session.run.phase !== "cycle-pause") return;
    if (session.currentEpisode || session.pendingEpisode || session.run.recordingState === "stopping") {
      session.run.resetDeadlineMs = Date.now() + 100;
      this.scheduleResetExpiry(session);
      return;
    }
    const totalCycles = Math.max(1, session.configuration.totalCycles);
    const previousRun = structuredClone(session.run);
    const previousTaskPublication = session.pendingTaskPublication;
    session.run.resetDeadlineMs = null;
    if (session.run.cycle < totalCycles) {
      session.run.cycle += 1;
      session.run.activeTaskIndex = 0;
      session.run.repetition = 1;
      session.run.take = 1;
      this.enterCurrentRunItem(session, true);
      const task = this.currentTask(session);
      if (task?.type === "pause") {
        this.publish(session, "control", { action: "task-selected", task });
        this.publishSnapshot(session);
      } else {
        try {
          await this.startOrResumeRecordingForCurrentTask(session, "task-selected");
        } catch (error) {
          session.run = previousRun;
          session.pendingTaskPublication = previousTaskPublication;
          return this.failClosedRunTransition(session, error);
        }
      }
      return;
    }
    this.clearRunTimers(session);
    session.run.status = "complete";
    session.run.phase = null;
    session.run.recordingState = session.currentEpisode || session.pendingEpisode ? "stopping" : "idle";
    session.run.endedAtMs = Date.now();
    session.run.takeStartedAtMs = null;
    session.run.recordingStartedAtMs = null;
    session.pendingTaskPublication = null;
    this.queuePrompt(session, "completion");
    this.publishSnapshot(session);
  }

  private toggleReady(session: SessionState, actor: "director" | "demonstrator") {
    if (session.run.status !== "stopped") throw new Error("Readiness can only change before the run starts");
    const key = actor === "director" ? "directorReady" : "demonstratorReady";
    if (session.run[key] === true) {
      session.run[key] = false;
      this.clearSyncLockTimer(session);
      session.run.syncLockStartedAtMs = null;
    } else {
      const readiness = this.sequenceReadiness(session);
      if (!readiness.ready) throw new Error(`Sequence is not ready: ${readiness.blockers.map((blocker) => blocker.message).join("; ")}`);
      session.run[key] = true;
      if (session.run.directorReady === true && session.run.demonstratorReady === true) {
        const startedAtMs = Date.now();
        session.run.syncLockStartedAtMs = startedAtMs;
        this.clearSyncLockTimer(session);
        session.syncLockTimer = setTimeout(() => {
          session.syncLockTimer = null;
          void this.enqueueRun(session, async () => {
            if (session.run.status !== "stopped" || session.run.syncLockStartedAtMs !== startedAtMs) return;
            await this.startSequence(session);
          }).catch((error) => this.setRunError(session, error));
        }, this.syncLockMs);
        session.syncLockTimer.unref();
        this.publish(session, "control", { action: "sync-lock", startedAtMs });
      }
    }
    this.publishSnapshot(session);
  }

  private async startSequence(session: SessionState) {
    const readiness = this.sequenceReadiness(session);
    if (!readiness.ready) throw new Error(`Sequence is not ready: ${readiness.blockers.map((blocker) => blocker.message).join("; ")}`);
    const previousRun = structuredClone(session.run);
    const previousReviewAnnotation = session.pendingReviewAnnotation;
    const previousTaskPublication = session.pendingTaskPublication;
    session.pendingReviewAnnotation = null;
    this.clearRunTimers(session);
    session.run = initialRunProgress();
    session.run.status = "running";
    session.run.startedAtMs = Date.now();
    session.run.recordingLatched = true;
    session.run.take = 1;
    session.pendingTaskPublication = null;
    this.enterCurrentRunItem(session, true);
    const task = this.currentTask(session);
    if (task?.type === "pause") {
      this.publish(session, "control", { action: "sequence-started", task });
      this.publishSnapshot(session);
    } else {
      try {
        await this.startOrResumeRecordingForCurrentTask(session, "sequence-started");
      } catch (error) {
        session.run = previousRun;
        session.pendingReviewAnnotation = previousReviewAnnotation;
        session.pendingTaskPublication = previousTaskPublication;
        return this.failClosedRunTransition(session, error);
      }
    }
  }

  private async startOrResumeRecordingForCurrentTask(
    session: SessionState,
    taskPublication: Exclude<SessionState["pendingTaskPublication"], null>,
  ) {
    const task = this.currentTask(session);
    if (session.run.status !== "running" || session.run.phase !== "active-task" || !task || !isRepetitionTask(task)) return;
    if (session.pendingEpisode) {
      let episode = session.pendingEpisode;
      if (this.latestSegment(episode)?.outcome === "recording") {
        session.pendingTaskPublication ??= taskPublication;
        session.run.phase = null;
        session.run.takeStartedAtMs = null;
        session.run.takeElapsedMs = 0;
        this.publishSnapshot(session);
        return;
      }
      episode = await this.persistEpisodeMutation(session, episode, (candidate) => {
        this.openCurrentSegment(session, candidate);
      });
      const segment = this.latestSegment(episode)!;
      session.pendingTaskPublication ??= taskPublication;
      session.run.phase = null;
      session.run.takeStartedAtMs = null;
      session.run.takeElapsedMs = 0;
      this.publishRecorderRunEvent(session, episode, {
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      });
      this.publishSnapshot(session);
      return;
    }
    if (session.currentEpisode) {
      if (session.run.recordingState !== "paused") return;
      const episode = await this.persistEpisodeMutation(session, session.currentEpisode, (candidate) => {
        this.openCurrentSegment(session, candidate);
      });
      const segment = this.latestSegment(episode)!;
      this.publishRecorderRunEvent(session, episode, {
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      });
      this.resumeRecording(session, false);
      this.queuePrompt(session, "task-start");
      this.publish(session, "control", { action: taskPublication, task: this.currentTask(session) });
      this.publishSnapshot(session);
      return;
    }
    await this.startEpisode(session, taskPublication);
  }

  private pauseRecording(session: SessionState) {
    if (session.run.status !== "running" || session.run.recordingState !== "recording" || !session.currentEpisode) {
      throw new Error("Only an active recording can be paused");
    }
    this.clearTimedTaskTimer(session);
    this.freezeTakeAndRecordingClocks(session);
    session.run.recordingState = "paused";
    session.recording = false;
    session.captureStatus = { ...session.captureStatus, recorder: "paused" };
    this.publish(session, "control", { action: "recording-paused", episode: session.currentEpisode });
    this.publishSnapshot(session);
  }

  private resumeRecording(session: SessionState, publishState = true) {
    if (session.run.status !== "running" || session.run.phase !== "active-task"
      || session.run.recordingState !== "paused" || !session.currentEpisode) {
      throw new Error("Only a paused recording can be resumed");
    }
    const now = Date.now();
    session.run.takeStartedAtMs = now;
    session.run.recordingStartedAtMs = now;
    session.run.recordingState = "recording";
    session.recording = true;
    session.captureStatus = { ...session.captureStatus, recorder: "recording" };
    this.scheduleTimedCompletion(session);
    this.publish(session, "control", { action: "recording-resumed", episode: session.currentEpisode });
    if (publishState) this.publishSnapshot(session);
  }

  private enterCurrentRunItem(session: SessionState, deferActiveTask = false) {
    const task = this.currentTask(session);
    if (!task) {
      session.run.phase = "cycle-pause";
      session.run.resetDeadlineMs = Date.now() + CYCLE_PAUSE_MS;
      session.run.error = null;
      return;
    }
    const now = Date.now();
    if (!session.currentEpisode && !session.pendingEpisode) session.run.recordingState = "idle";
    session.run.recordingStartedAtMs = null;
    session.run.recordingElapsedMs = 0;
    session.run.takeStartedAtMs = task.type === "pause" || !deferActiveTask ? now : null;
    session.run.takeElapsedMs = 0;
    session.run.resetDeadlineMs = null;
    session.run.reviewEpisodeId = null;
    if (task.type === "pause") {
      session.run.phase = "task-pause";
      session.run.resetDeadlineMs = now + task.durationS * 1_000;
      this.scheduleResetExpiry(session);
      this.queuePrompt(session, "reset");
      return;
    }
    session.run.phase = "active-task";
    session.run.error = null;
    if (!deferActiveTask) {
      this.scheduleTimedCompletion(session);
      this.queuePrompt(session, "task-start");
    }
  }

  private async stopRun(session: SessionState) {
    if (session.run.status !== "running") throw new Error("The run is not active");
    if (session.currentEpisode || session.pendingEpisode) {
      let episode = session.currentEpisode ?? session.pendingEpisode!;
      const segment = this.latestSegment(episode);
      if (segment?.outcome === "recording") {
        const now = Date.now();
        this.clearRunTimers(session);
        this.freezeTakeAndRecordingClocks(session, now);
        if (session.currentEpisode && session.run.recordingState === "recording") {
          session.run.recordingState = "paused";
          session.recording = false;
          session.captureStatus = { ...session.captureStatus, recorder: "paused" };
          this.publish(session, "control", { action: "recording-paused", episode });
        }
        try {
          episode = await this.persistEpisodeMutation(session, episode, (candidate) => {
            const candidateSegment = this.latestSegment(candidate);
            if (!candidateSegment || candidateSegment.id !== segment.id || candidateSegment.outcome !== "recording") {
              throw new Error("The active task segment is no longer available");
            }
            candidateSegment.endedAt = new Date(now).toISOString();
            candidateSegment.outcome = "stopped";
            candidateSegment.accepted = false;
          });
        } catch (error) {
          return this.failClosedRunTransition(session, error);
        }
        const stoppedSegment = this.latestSegment(episode)!;
        const event: RecorderPendingBoundary["event"] = {
          type: "segment-end",
          segmentId: stoppedSegment.id,
          taskId: stoppedSegment.taskId,
          taskLabel: stoppedSegment.taskLabel,
        };
        this.publishRecorderRunEvent(session, episode, event);
      }
      this.requestEpisodeStop(session, "stopped", "stop-run");
      return;
    }
    this.finishStoppedRun(session);
  }

  private async finishRun(session: SessionState) {
    if (session.run.status !== "running") throw new Error("The run is not active");
    if (session.run.recordingState === "arming") {
      throw new Error("Wait for the recorder to accept the recording before finishing the run");
    }
    if (session.currentEpisode || session.pendingEpisode) {
      if (session.run.recordingState === "stopping") {
        throw new Error("The recorder is already finalising a transition");
      }
      let episode = session.currentEpisode ?? session.pendingEpisode!;
      const segment = this.latestSegment(episode);
      const closeSegment = segment?.outcome === "recording";
      const now = Date.now();
      const pauseRecorder = closeSegment
        && session.currentEpisode !== null
        && session.run.recordingState === "recording";
      try {
        episode = await this.persistEpisodeMutation(session, episode, (candidate) => {
          candidate.runFinalisation = "finish-requested";
          if (closeSegment) {
            const candidateSegment = this.latestSegment(candidate);
            if (!candidateSegment || candidateSegment.id !== segment.id || candidateSegment.outcome !== "recording") {
              throw new Error("The active task segment is no longer available");
            }
            candidateSegment.endedAt = new Date(now).toISOString();
            candidateSegment.outcome = "completed";
            candidateSegment.accepted = false;
          }
        });
      } catch (error) {
        return this.failClosedRunTransition(session, error);
      }
      if (closeSegment) {
        this.clearRunTimers(session);
        this.freezeTakeAndRecordingClocks(session, now);
        if (pauseRecorder) {
          session.run.recordingState = "paused";
          session.recording = false;
          session.captureStatus = { ...session.captureStatus, recorder: "paused" };
          this.publish(session, "control", { action: "recording-paused", episode });
        }
        const completedSegment = this.latestSegment(episode)!;
        this.publishRecorderRunEvent(session, episode, {
          type: "segment-end",
          segmentId: completedSegment.id,
          taskId: completedSegment.taskId,
          taskLabel: completedSegment.taskLabel,
        });
      }
      this.requestEpisodeStop(session, "completed", "finish-run");
      return;
    }
    if (session.run.recordingState !== "idle") throw new Error("The run is waiting for a recorder transition");
    this.finishCompletedRun(session);
  }

  private finishStoppedRun(session: SessionState, preserveRecorderStop = false) {
    this.clearRunTimers(session);
    session.recording = false;
    if (!preserveRecorderStop) session.pendingReviewAnnotation = null;
    if (!preserveRecorderStop) {
      session.pendingRunAction = null;
      session.pendingStopOutcome = null;
      session.pendingRunTransitionApplied = false;
      session.pendingTaskPublication = null;
    }
    session.run = initialRunProgress();
    if (preserveRecorderStop) session.run.recordingState = "stopping";
    this.publish(session, "control", { action: "sequence-stopped" });
    this.publishSnapshot(session);
  }

  private finishCompletedRun(session: SessionState, endedAtMs = Date.now()) {
    this.clearRunTimers(session);
    session.recording = false;
    session.pendingReviewAnnotation = null;
    session.pendingRunAction = null;
    session.pendingStopOutcome = null;
    session.pendingRunTransitionApplied = false;
    session.pendingTaskPublication = null;
    session.run.status = "complete";
    session.run.phase = null;
    session.run.recordingState = "idle";
    session.run.endedAtMs = endedAtMs;
    session.run.takeStartedAtMs = null;
    session.run.recordingStartedAtMs = null;
    session.run.reviewEpisodeId = null;
    session.run.resetDeadlineMs = null;
    session.run.error = null;
    this.queuePrompt(session, "completion");
    this.publishSnapshot(session);
  }

  private async completeCurrentTask(session: SessionState, now = Date.now()) {
    const task = this.currentTask(session);
    if (session.run.status !== "running" || session.run.phase !== "active-task" || !task || !isRepetitionTask(task)) {
      throw new Error("Only an active task can enter its reset");
    }
    let episode = session.currentEpisode ?? session.pendingEpisode;
    if (!episode) throw new Error("The cycle recording is not available");
    const segment = this.latestSegment(episode);
    if (!segment || segment.outcome !== "recording") throw new Error("The active task segment is not available");
    try {
      episode = await this.persistEpisodeMutation(session, episode, (candidate) => {
        const candidateSegment = this.latestSegment(candidate);
        if (!candidateSegment || candidateSegment.id !== segment.id || candidateSegment.outcome !== "recording") {
          throw new Error("The active task segment is no longer available");
        }
        candidateSegment.endedAt = new Date(now).toISOString();
        candidateSegment.outcome = "completed";
        candidateSegment.accepted = false;
      });
    } catch (error) {
      return this.failClosedRunTransition(session, error);
    }
    const completedSegment = this.latestSegment(episode)!;
    const event: RecorderPendingBoundary["event"] = {
      type: "segment-end",
      segmentId: completedSegment.id,
      taskId: completedSegment.taskId,
      taskLabel: completedSegment.taskLabel,
    };
    this.clearRunTimers(session);
    this.freezeTakeAndRecordingClocks(session, now);
    session.run.phase = "post-task-pause";
    session.run.reviewEpisodeId = episode.id;
    session.run.resetDeadlineMs = now + taskResetDurationMs(task.resetTimeS);
    if (session.currentEpisode && session.run.recordingState === "recording") {
      session.run.recordingState = "paused";
      session.recording = false;
      session.captureStatus = { ...session.captureStatus, recorder: "paused" };
      this.publish(session, "control", { action: "recording-paused", episode });
    }
    this.publishRecorderRunEvent(session, episode, event);
    this.scheduleResetExpiry(session);
    this.queuePrompt(session, "reset");
    this.publishSnapshot(session);
  }

  private async finishReset(session: SessionState) {
    const retry = session.run.phase === "post-task-pause"
      && this.latestSegment(session.currentEpisode ?? session.pendingEpisode)?.outcome === "retry";
    await this.advanceAfterReset(session, retry);
  }

  private async advanceAfterReset(session: SessionState, retryCurrentTask: boolean) {
    const previousRun = structuredClone(session.run);
    const previousTaskPublication = session.pendingTaskPublication;
    this.clearRunTimers(session);
    session.run.reviewEpisodeId = null;
    session.run.resetDeadlineMs = null;
    if (!retryCurrentTask) this.advanceRunCursor(session);
    if (session.run.activeTaskIndex >= session.configuration.tasks.length) {
      this.beginCycleBoundary(session);
      return;
    }
    this.enterCurrentRunItem(session, true);
    const task = this.currentTask(session);
    if (task?.type === "pause") {
      this.publish(session, "control", { action: "task-selected", task });
      this.publishSnapshot(session);
    } else {
      try {
        await this.startOrResumeRecordingForCurrentTask(session, "task-selected");
      } catch (error) {
        session.run = previousRun;
        session.pendingTaskPublication = previousTaskPublication;
        return this.failClosedRunTransition(session, error);
      }
    }
  }

  private openCurrentSegment(session: SessionState, episode: Episode): EpisodeSegment {
    const task = this.currentTask(session);
    if (!task || !isRepetitionTask(task)) throw new Error("A recordable task is required to open a segment");
    const taskDescription = task.instructions && task.instructions !== "--"
      ? task.instructions
      : session.configuration.runDescription || session.configuration.runTitle;
    episode.segments ??= [];
    const segment: EpisodeSegment = {
      id: `${episode.id}-segment-${episode.segments.length + 1}`,
      taskId: task.id,
      taskLabel: task.label,
      taskDescription,
      repetition: session.run.repetition,
      take: session.run.take,
      startedAt: new Date().toISOString(),
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
    actor: "director" | "demonstrator",
  ): EpisodeSegment {
    const segment = this.latestSegment(episode);
    if (!segment || segment.outcome === "recording") throw new Error("Only a completed task segment can be annotated");
    segment.annotations.push({
      id: `${segment.id}-annotation-${segment.annotations.length + 1}`,
      action,
      actor,
      timestampMs: Date.now(),
    });
    return segment;
  }

  private latestSegment(episode: Episode | null | undefined) {
    return episode?.segments?.at(-1) ?? null;
  }

  private activeCycleEpisode(session: SessionState, episodeId: string) {
    const active = session.currentEpisode ?? session.pendingEpisode;
    if (active?.id === episodeId) return active;
    return session.episodes.find((episode) => episode.id === episodeId)
      ?? session.attempts.find((episode) => episode.id === episodeId)
      ?? null;
  }

  private async persistEpisodeMutation(
    session: SessionState,
    episode: Episode,
    mutate: (candidate: Episode) => void,
  ): Promise<Episode> {
    const candidate = structuredClone(episode);
    mutate(candidate);
    await this.persistEpisode(session, candidate);
    if (session.currentEpisode?.id === candidate.id) session.currentEpisode = candidate;
    if (session.pendingEpisode?.id === candidate.id) session.pendingEpisode = candidate;
    session.episodes = session.episodes.map((entry) => entry.id === candidate.id ? candidate : entry);
    session.attempts = session.attempts.map((entry) => entry.id === candidate.id ? candidate : entry);
    return candidate;
  }

  private beginRecorderPendingBoundary(
    session: SessionState,
    episode: Episode,
    segment: EpisodeSegment,
    event: RecorderPendingBoundary["event"],
  ) {
    if (segment.outcome !== "completed" && segment.outcome !== "stopped") {
      throw new Error("Only a committed segment transition can await a recorder boundary");
    }
    session.recorderPendingBoundary = {
      episodeId: episode.id,
      segmentId: segment.id,
      outcome: segment.outcome,
      event,
      resetElapsed: false,
      publishedRecorderId: null,
    };
  }

  private settleRecorderPendingBoundary(session: SessionState, episode: Episode, block: RecorderBlock) {
    const boundary = session.recorderPendingBoundary;
    if (!boundary || boundary.episodeId !== episode.id || (block.flags & RecorderBlockFlags.RunEvent) === 0) return;
    const event = decodeRecorderRunEvent(block.payload);
    if (event.type !== "segment-end"
      || event.segmentId !== boundary.segmentId
      || event.taskId !== boundary.event.taskId
      || event.taskLabel !== boundary.event.taskLabel) return;
    session.recorderPendingBoundary = null;
    if (boundary.outcome === "completed" && session.pendingRunAction !== "finish-run") {
      if (boundary.resetElapsed || session.run.resetDeadlineMs === null) session.run.resetDeadlineMs = Date.now();
      this.scheduleResetExpiry(session);
    }
    this.publishSnapshot(session);
  }

  private publishRecorderRunEvent(session: SessionState, episode: Episode, event: RecorderRunEvent) {
    this.publish(session, "control", { action: "recording-event", event, episode });
    const boundary = session.recorderPendingBoundary;
    if (event.type === "segment-end"
      && boundary?.episodeId === episode.id
      && boundary.segmentId === event.segmentId
      && session.activeRecorderId) {
      boundary.publishedRecorderId = session.activeRecorderId;
    }
  }

  private freezeTakeAndRecordingClocks(session: SessionState, now = Date.now()) {
    if (session.run.takeStartedAtMs !== null) {
      session.run.takeElapsedMs += Math.max(0, now - session.run.takeStartedAtMs);
      session.run.takeStartedAtMs = null;
    }
    if (session.run.recordingStartedAtMs !== null) {
      session.run.recordingElapsedMs += Math.max(0, now - session.run.recordingStartedAtMs);
      session.run.recordingStartedAtMs = null;
    }
  }

  private sendInstructions(session: SessionState) {
    const task = this.currentTask(session);
    const instructions = task?.instructions && task.instructions !== "--"
      ? task.instructions
      : session.configuration.runDescription || session.configuration.runTitle;
    this.publish(session, "control", { action: "show-instructions", instructions });
  }

  private async applyVoiceCommand(
    session: SessionState,
    text: string,
    timestampMs: number,
    command: string | undefined,
    action: "success" | "fail" | "next-task" | null,
    controlCursor: string | null,
  ) {
    if (!command) return;
    session.commandLog.unshift({ command, text, timestampMs });
    session.commandLog = session.commandLog.slice(0, 40);
    this.publish(session, "voice-command", { command, text, timestampMs });
    if (action && controlCursor !== nextRunControlCursor(session, action)) {
      this.publishSnapshot(session);
      return;
    }
    if (command === "start-recording") this.publish(session, "control", { action: "acknowledged" });
    else if (command === "successful-episode") await this.annotateTake(session, "pass", "demonstrator");
    else if (command === "failed-episode") await this.annotateTake(session, "fail", "demonstrator");
    else if (command === "next-task") await this.nextTask(session, "demonstrator");
    else if (command === "show-instructions") this.sendInstructions(session);
    else this.publish(session, "control", { action: "acknowledged" });
  }

  private createJob(session: SessionState, type: CaptureJob["type"], detail: string) {
    const now = new Date().toISOString();
    const job: CaptureJob = { id: crypto.randomUUID(), type, state: "queued", detail, createdAt: now, updatedAt: now };
    session.jobs.unshift(job);
    this.publishSnapshot(session);
    return job;
  }

  private updateJob(session: SessionState, job: CaptureJob, state: CaptureJob["state"], detail: string) {
    job.state = state;
    job.detail = detail;
    job.updatedAt = new Date().toISOString();
    this.publishSnapshot(session);
  }

  private async runExport(session: SessionState, job: CaptureJob) {
    this.updateJob(session, job, "running", "Writing LeRobot v3 tables, metadata and video shards");
    const input = path.join(this.dataRoot, "sessions", session.id);
    const output = path.join(this.dataRoot, "exports", session.id);
    const exporterPython = process.env.PYTHON ?? path.resolve("exporter/.venv/Scripts/python.exe");
    try {
      await new Promise<void>((resolve, reject) => {
        if (!existsSync(exporterPython)) throw new Error("LeRobot exporter environment is not installed");
        const child = spawn(exporterPython, ["exporter/export_lerobot.py", "--input", input, "--output", output], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
        let error = "";
        child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `Exporter exited with code ${code}`)));
      });
      this.updateJob(session, job, "completed", `LeRobot v3 dataset written to ${output}`);
    } catch (error) {
      this.updateJob(session, job, "failed", this.describeExportFailure(error));
    }
  }

  private describeExportFailure(error: unknown) {
    const detail = error instanceof Error ? error.message : "LeRobot export failed";
    if (/no module named ['\"]?lerobot|exporter environment is not installed/i.test(detail)) {
      return "LeRobot exporter is unavailable. Install exporter requirements, then retry.";
    }
    return detail.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 900);
  }

  private enqueueRecorder<T>(session: SessionState, operation: () => Promise<T>): Promise<T> {
    return this.enqueueRun(session, operation);
  }

  private enqueueConfiguration<T>(session: SessionState, operation: () => Promise<T>): Promise<T> {
    const result = session.configurationTail.then(operation, operation);
    session.configurationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueRun<T>(session: SessionState, operation: () => Promise<T>): Promise<T> {
    const result = session.runTail.then(operation, operation);
    session.runTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertRecorderFlags(block: RecorderBlock) {
    const allowedFlags = RecorderBlockFlags.Gap
      | RecorderBlockFlags.SensorFrameJson
      | RecorderBlockFlags.RunEvent
      | RecorderBlockFlags.MediaChunk
      | RecorderBlockFlags.AudioChunk;
    if ((block.flags & ~allowedFlags) !== 0) {
      throw new RecorderStoreError("invalid-block", "Recorder block contains unsupported flags");
    }
    const primaryFlags = [
      RecorderBlockFlags.Gap,
      RecorderBlockFlags.SensorFrameJson,
      RecorderBlockFlags.RunEvent,
      RecorderBlockFlags.MediaChunk,
      RecorderBlockFlags.AudioChunk,
    ].filter((flag) => (block.flags & flag) !== 0);
    if (primaryFlags.length !== 1) throw new RecorderStoreError("invalid-block", "Recorder blocks must identify exactly one payload kind");
  }

  private assertRecorderContinuity(session: SessionState, block: RecorderBlock) {
    const previousSequence = this.highestRecorderSequence(session);
    const previous = session.recorderLedger.get(previousSequence);
    if (!previous) {
      if (block.sequence !== 0) throw new RecorderStoreError("out-of-order", "The first recorder sequence must be zero", 0);
      if ((block.flags & (RecorderBlockFlags.Gap | RecorderBlockFlags.SensorFrameJson)) !== 0 && block.recorderFrameIndex !== 0) {
        throw new RecorderStoreError("out-of-order", "The first recorder frame index must be zero", 0);
      }
      return;
    }
    if (block.sourceTimestampUs < previous.sourceTimestampUs) {
      throw new RecorderStoreError("out-of-order", "Recorder source timestamps must not move backwards", block.sequence);
    }
    if ((block.flags & (RecorderBlockFlags.Gap | RecorderBlockFlags.SensorFrameJson)) === 0) return;
    let previousTelemetry: RecorderLedgerEntry | undefined;
    for (let sequence = previousSequence; sequence >= 0; sequence -= 1) {
      const candidate = session.recorderLedger.get(sequence);
      if (candidate && (candidate.flags & (RecorderBlockFlags.Gap | RecorderBlockFlags.SensorFrameJson)) !== 0) {
        previousTelemetry = candidate;
        break;
      }
    }
    const expectedFrameIndex = previousTelemetry?.episodeId === block.episodeId ? previousTelemetry.recorderFrameIndex + 1 : 0;
    if (block.recorderFrameIndex !== expectedFrameIndex) {
      throw new RecorderStoreError("out-of-order", `Recorder frame index ${block.recorderFrameIndex} arrived while ${expectedFrameIndex} was required`, block.sequence);
    }
    if (previousTelemetry?.episodeId === block.episodeId && block.sourceTimestampUs <= previousTelemetry.sourceTimestampUs) {
      throw new RecorderStoreError("out-of-order", "Recorder slot timestamps must increase monotonically", block.sequence);
    }
  }

  private async loadRecorderLedger(
    session: SessionState,
    assertAuthority?: () => void,
  ): Promise<RecorderPromotionPlan | null> {
    if (session.recorderLedgerLoaded) {
      assertAuthority?.();
      return null;
    }
    let journal: Uint8Array;
    try {
      assertAuthority?.();
      journal = await readFile(this.recorderJournalPath(session));
      assertAuthority?.();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        assertAuthority?.();
        session.recorderLedgerLoaded = true;
        return null;
      }
      throw error;
    }
    const recorderLedger = new Map<number, RecorderLedgerEntry>();
    const continuitySession = { ...session, recorderLedger };
    const blocks: RecorderBlock[] = [];
    let offset = 0;
    while (offset < journal.byteLength) {
      if (journal.byteLength - offset < RECORDER_BLOCK_HEADER_BYTES) {
        assertAuthority?.();
        await this.truncateDurable(this.recorderJournalPath(session), offset);
        assertAuthority?.();
        break;
      }
      const length = recorderBlockByteLength(journal, offset);
      if (offset + length > journal.byteLength) {
        assertAuthority?.();
        await this.truncateDurable(this.recorderJournalPath(session), offset);
        assertAuthority?.();
        break;
      }
      const block = decodeRecorderBlock(journal.subarray(offset, offset + length));
      const expectedSequence = recorderLedger.size;
      if (block.sequence !== expectedSequence) throw new RecorderStoreError("write-failed", `The recorder journal is not contiguous at sequence ${expectedSequence}`);
      if (block.sessionId !== session.id) throw new RecorderStoreError("session-mismatch", "Recorder journal block session does not match the registered session");
      this.assertRecorderFlags(block);
      this.assertRecorderContinuity(continuitySession, block);
      recorderLedger.set(block.sequence, {
        checksum: block.checksum,
        episodeId: block.episodeId,
        recorderFrameIndex: block.recorderFrameIndex,
        sourceTimestampUs: block.sourceTimestampUs,
        flags: block.flags,
      });
      blocks.push(block);
      offset += length;
    }

    const staged = this.createRecorderRecoverySession(session, recorderLedger);
    const reconciliation = await this.reconcileRecorderJournal(staged, blocks);
    assertAuthority?.();
    for (const episode of reconciliation.episodes.values()) {
      await this.persistEpisode(staged, episode);
      assertAuthority?.();
    }
    assertAuthority?.();
    session.recorderLedger = recorderLedger;
    session.recorderMaterialised = staged.recorderMaterialised;
    session.currentEpisode = staged.currentEpisode;
    session.pendingEpisode = staged.pendingEpisode;
    session.episodes = staged.episodes;
    session.attempts = staged.attempts;
    session.recorderAcceptedEpisodeId = staged.recorderAcceptedEpisodeId;
    session.qualityTrackers = staged.qualityTrackers;
    session.lastFrame = staged.lastFrame;
    session.recording = staged.recording;
    session.captureStatus = {
      ...session.captureStatus,
      handTracking: staged.captureStatus.handTracking,
      lastFrameAt: staged.captureStatus.lastFrameAt,
      recorder: staged.captureStatus.recorder,
      recorderFrameIndex: staged.captureStatus.recorderFrameIndex,
      recorderGaps: staged.captureStatus.recorderGaps,
    };
    const recoveredEpisode = reconciliation.promotion ?? reconciliation.activeEpisode;
    const promotionPlan = recoveredEpisode
      ? this.applyRecoveredEpisode(session, recoveredEpisode)
      : null;
    if (!promotionPlan && reconciliation.completedRunEpisode) {
      this.applyRecoveredCompletedRun(session, reconciliation.completedRunEpisode);
    }
    session.recorderLedgerLoaded = true;
    return promotionPlan;
  }

  private createRecorderRecoverySession(
    session: SessionState,
    recorderLedger: Map<number, RecorderLedgerEntry>,
  ): SessionState {
    return {
      ...session,
      run: structuredClone(session.run),
      captureStatus: { ...session.captureStatus },
      currentEpisode: session.currentEpisode ? structuredClone(session.currentEpisode) : null,
      pendingEpisode: session.pendingEpisode ? structuredClone(session.pendingEpisode) : null,
      episodes: session.episodes.map((episode) => structuredClone(episode)),
      attempts: session.attempts.map((episode) => structuredClone(episode)),
      connections: new Set(),
      recorderLedger,
      recorderMaterialised: new Set(),
      qualityTrackers: new Map(),
      timedTaskTimer: null,
      resetTimer: null,
      syncLockTimer: null,
    };
  }

  private async reconcileRecorderJournal(session: SessionState, blocks: RecorderBlock[]): Promise<{
    episodes: Map<string, Episode>;
    promotion: Episode | null;
    activeEpisode: Episode | null;
    completedRunEpisode: Episode | null;
  }> {
    const episodeBlocks = new Map<string, { episode: Episode; blocks: RecorderBlock[] }>();
    for (const block of blocks) {
      let recovery = episodeBlocks.get(block.episodeId);
      if (!recovery) {
        recovery = {
          episode: structuredClone(await this.resolveRecorderEpisode(session, block.episodeId)),
          blocks: [],
        };
        episodeBlocks.set(block.episodeId, recovery);
      }
      recovery.blocks.push(block);
    }

    for (const { episode } of episodeBlocks.values()) {
      for (const segment of episode.segments ?? []) {
        segment.startSourceTimestampUs = undefined;
        segment.endSourceTimestampUs = undefined;
        for (const annotation of segment.annotations) annotation.sourceTimestampUs = undefined;
      }
    }

    for (const { episode, blocks: durableEpisodeBlocks } of episodeBlocks.values()) {
      const root = this.episodeRoot(session, episode.id);
      const runEvents = durableEpisodeBlocks
        .filter((block) => (block.flags & RecorderBlockFlags.RunEvent) !== 0)
        .map((block) => ({
          sequence: block.sequence,
          record: {
            sequence: block.sequence,
            sourceTimestampUs: block.sourceTimestampUs,
            event: decodeRecorderRunEvent(block.payload),
          },
        }));
      await this.reconcileJsonlProjection(
        session,
        path.join(root, "run-events.jsonl"),
        runEvents,
      );
      for (const block of durableEpisodeBlocks) {
        if ((block.flags & RecorderBlockFlags.RunEvent) === 0) continue;
        this.reconcileRecorderRunEvent(episode, decodeRecorderRunEvent(block.payload), block.sourceTimestampUs);
      }

      const timeline = durableEpisodeBlocks
        .filter((block) => this.isRecorderTimelineBlock(block))
        .map((block) => ({
          sequence: block.sequence,
          record: this.recorderTimelineMaterialisation(episode, block).record,
        }));
      await this.reconcileJsonlProjection(
        session,
        path.join(root, "sensors.jsonl"),
        timeline,
      );

      for (const block of durableEpisodeBlocks) {
        if ((block.flags & (RecorderBlockFlags.MediaChunk | RecorderBlockFlags.AudioChunk)) === 0) continue;
        if (!await this.isRecorderBlockMaterialised(session, episode, block)) {
          await this.materialiseRecorderBlock(session, episode, block);
        }
      }
    }

    let promotion: Episode | null = null;
    for (const { episode, blocks: durableEpisodeBlocks } of episodeBlocks.values()) {
      this.rebuildRecorderEpisodeAccounting(session, episode, durableEpisodeBlocks);
      if (episode.mediaChunkCount > 0 && episode.outcome !== "recording") {
        await this.assembleRecorderMedia(session, episode);
      }
      if (session.currentEpisode?.id === episode.id) session.currentEpisode = episode;
      if (session.pendingEpisode?.id === episode.id) session.pendingEpisode = episode;
      session.episodes = session.episodes.map((entry) => entry.id === episode.id ? episode : entry);
      session.attempts = session.attempts.map((entry) => entry.id === episode.id ? episode : entry);
      if (session.recorderAcceptedEpisodeId === episode.id) {
        promotion = this.preparePendingEpisodePromotion(session, episode) ?? promotion;
      }
    }

    const latestBlock = blocks.at(-1);
    const activeEpisode = session.currentEpisode ?? session.pendingEpisode;
    session.captureStatus = {
      ...session.captureStatus,
      recorderFrameIndex: latestBlock?.recorderFrameIndex ?? session.captureStatus.recorderFrameIndex,
      recorderGaps: activeEpisode?.gapCount ?? 0,
    };
    const latestEpisode = latestBlock
      ? episodeBlocks.get(latestBlock.episodeId)?.episode ?? null
      : null;
    return {
      episodes: new Map([...episodeBlocks].map(([episodeId, recovery]) => [episodeId, recovery.episode])),
      promotion,
      activeEpisode: session.currentEpisode?.outcome === "recording" && session.currentEpisode.integrity === "valid"
        ? session.currentEpisode
        : null,
      completedRunEpisode: latestEpisode?.runFinalisation === "finish-completed"
        && latestEpisode.outcome === "completed"
        && latestEpisode.integrity === "valid"
        && latestEpisode.accepted
        && latestEpisode.configurationRevision === session.configurationRevision
        ? latestEpisode
        : null,
    };
  }

  private async reconcileJsonlProjection(
    session: SessionState,
    file: string,
    expected: Array<{ sequence: number; record: unknown }>,
  ) {
    const actual = await this.readRepairableJsonLines(file);
    if (actual.length > expected.length) {
      throw new RecorderStoreError("write-failed", "A recorder sidecar contains records not present in the durable recorder journal");
    }
    for (let index = 0; index < actual.length; index += 1) {
      if (!isDeepStrictEqual(actual[index], expected[index].record)) {
        throw new RecorderStoreError("write-failed", "A recorder sidecar conflicts with the durable recorder journal order");
      }
    }
    if (actual.length < expected.length) {
      const content = expected.map(({ record }) => JSON.stringify(record)).join("\n");
      await this.writeAtomic(file, Buffer.from(content ? `${content}\n` : ""));
    }
    for (const { sequence } of expected) session.recorderMaterialised.add(sequence);
  }

  private rebuildRecorderEpisodeAccounting(
    session: SessionState,
    episode: Episode,
    blocks: RecorderBlock[],
  ) {
    episode.frameCount = 0;
    episode.gapCount = 0;
    episode.recorderSlotCount = 0;
    episode.mediaChunkCount = 0;
    episode.firstRecorderSequence = blocks.at(0)?.sequence;
    episode.lastRecorderSequence = blocks.at(-1)?.sequence;
    episode.qualitySummary = emptyQualitySummary();
    episode.qualityEvents = [];
    session.qualityTrackers.delete(episode.id);
    for (const segment of episode.segments ?? []) {
      segment.frameCount = 0;
      segment.gapCount = 0;
      segment.recorderSlotCount = 0;
    }

    for (const block of blocks) {
      if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0) {
        episode.mediaChunkCount += 1;
        continue;
      }
      if (!this.isRecorderTimelineBlock(block)) continue;
      episode.recorderSlotCount += 1;
      const segment = this.recorderSegmentForTimestamp(episode, block.sourceTimestampUs);
      if (segment) segment.recorderSlotCount = (segment.recorderSlotCount ?? 0) + 1;
      if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
        const reason = block.payload.byteLength > 0
          ? recorderPayloadDecoder.decode(block.payload)
          : "missing-source-sample";
        episode.gapCount += 1;
        if (segment) segment.gapCount = (segment.gapCount ?? 0) + 1;
        episode.qualityEvents.push({
          timestampMs: block.sourceTimestampUs / 1_000,
          type: "gap",
          detail: reason,
        });
        continue;
      }
      let frame: SensorFrame;
      try {
        frame = JSON.parse(recorderPayloadDecoder.decode(block.payload)) as SensorFrame;
      } catch {
        throw new RecorderStoreError("invalid-block", "Recorder sensor payload is not valid UTF-8 JSON");
      }
      if (!frame || typeof frame !== "object" || !frame.leftHand || !frame.rightHand || !frame.sceneStatus) {
        throw new RecorderStoreError("invalid-block", "Recorder sensor payload is missing required telemetry fields");
      }
      const canonicalFrame = canonicalSensorFrame(frame, block.sourceTimestampUs / 1_000, block.recorderFrameIndex);
      episode.frameCount += 1;
      if (segment) segment.frameCount = (segment.frameCount ?? 0) + 1;
      this.accountEpisodeFrameQuality(session, episode, canonicalFrame);
      session.lastFrame = canonicalFrame;
    }
    episode.qualitySummary.frameCount = episode.frameCount;
    episode.qualitySummary.gapCount = episode.gapCount;
    this.refreshEpisodeQualityDecision(episode);
  }

  private async resolveRecorderEpisode(
    session: SessionState,
    episodeId: string,
    assertAuthority?: () => void,
  ): Promise<Episode> {
    if (!isSafeStorageIdentifier(episodeId)) throw new RecorderStoreError("episode-mismatch", "Recorder episode identifier is invalid");
    if (session.pendingEpisode?.id === episodeId) return session.pendingEpisode;
    if (session.currentEpisode?.id === episodeId) return session.currentEpisode;
    const known = session.episodes.find((episode) => episode.id === episodeId);
    if (known) return known;
    const knownAttempt = session.attempts.find((episode) => episode.id === episodeId);
    if (knownAttempt) return knownAttempt;
    let episode: Episode;
    try {
      episode = await this.readCommittedEpisode(session, episodeId);
      assertAuthority?.();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) throw new RecorderStoreError("episode-mismatch", "Recorder block episode is not known to the server");
      throw error;
    }
    if (!episode || episode.id !== episodeId) throw new RecorderStoreError("episode-mismatch", "Recorder episode metadata is invalid");
    episode.integrity ??= episode.frameCount > 0 ? "valid" : "interrupted";
    episode.cycle ??= 1;
    episode.repetition ??= 1;
    episode.take ??= 1;
    episode.annotation ??= episode.outcome === "successful" ? "pass" : episode.outcome === "failed" ? "fail" : null;
    episode.accepted ??= episode.outcome === "successful";
    episode.qualitySummary ??= emptyQualitySummary(episode.frameCount, episode.gapCount ?? 0);
    episode.qualityEvents ??= [];
    assertAuthority?.();
    if (episode.integrity === "pending" && episode.recorderAcceptedAt) session.recorderAcceptedEpisodeId = episode.id;
    if (episode.outcome === "recording" && episode.integrity === "valid" && !session.currentEpisode) {
      session.currentEpisode = episode;
      session.recording = true;
      session.captureStatus = { ...session.captureStatus, recorder: "recording" };
    } else if (episode.outcome === "recording" && episode.integrity === "pending" && !session.pendingEpisode) {
      session.pendingEpisode = episode;
      session.captureStatus = { ...session.captureStatus, recorder: "arming" };
    } else if (episode.integrity !== "valid" && !session.attempts.some((entry) => entry.id === episode.id)) {
      session.attempts.push(episode);
    } else if (!session.episodes.some((entry) => entry.id === episode.id)) {
      session.episodes.push(episode);
    }
    return episode;
  }

  private async readCommittedEpisode(session: SessionState, episodeId: string): Promise<Episode> {
    const root = this.episodeRoot(session, episodeId);
    const commitPath = path.join(root, "episode.commit.json");
    try {
      const parsed = JSON.parse(await readFile(commitPath, "utf8")) as Partial<PersistedEpisodeCommit>;
      if ((parsed.schema !== "ceres-episode-commit-v1" && parsed.schema !== "ceres-episode-commit-v2")
        || typeof parsed.checksum !== "string"
        || !parsed.episode) {
        throw new RecorderStoreError("write-failed", "Episode metadata commit marker is invalid");
      }
      const commitPayload = parsed.schema === "ceres-episode-commit-v2"
        ? {
            sessionId: parsed.sessionId,
            episodeId: parsed.episodeId,
            taskSpecVersion: parsed.taskSpecVersion,
            taskSpecHash: parsed.taskSpecHash,
            episode: parsed.episode,
          }
        : { sessionId: parsed.sessionId, episodeId: parsed.episodeId, episode: parsed.episode };
      const serialised = JSON.stringify(commitPayload);
      if (parsed.sessionId !== session.id
        || parsed.episodeId !== episodeId
        || parsed.episode.id !== episodeId
        || createHash("sha256").update(serialised).digest("hex") !== parsed.checksum) {
        throw new RecorderStoreError("write-failed", "Episode metadata commit marker checksum is invalid");
      }
      if (parsed.schema === "ceres-episode-commit-v2"
        && (parsed.taskSpecVersion !== parsed.episode.taskSpecVersion
          || parsed.taskSpecHash !== parsed.episode.taskSpecHash)) {
        throw new RecorderStoreError("write-failed", "Episode metadata commit marker task provenance is inconsistent");
      }
      await this.persistTaskSpecification(session, parsed.episode);
      return parsed.episode;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }

    const candidates: Array<{ episode: Episode; modifiedAtMs: number; preferred: boolean }> = [];
    for (const [name, preferred] of [["attempt.json", false], ["episode.json", true]] as const) {
      const file = path.join(root, name);
      try {
        const candidate = JSON.parse(await readFile(file, "utf8")) as Episode;
        if (!candidate || candidate.id !== episodeId) continue;
        candidates.push({ episode: candidate, modifiedAtMs: (await stat(file)).mtimeMs, preferred });
      } catch (error) {
        if (isFileSystemError(error, "ENOENT") || error instanceof SyntaxError) continue;
        throw error;
      }
    }
    const selected = candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs
      || Number(right.preferred) - Number(left.preferred))[0];
    if (!selected) throw new RecorderStoreError("episode-mismatch", "Recorder episode metadata is missing or corrupt");
    await this.persistTaskSpecification(session, selected.episode);
    return selected.episode;
  }

  private async isRecorderBlockMaterialised(
    session: SessionState,
    episode: Episode,
    block: RecorderBlock,
    assertAuthority?: () => void,
  ) {
    if (session.recorderMaterialised.has(block.sequence)) return true;
    if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0) {
      const file = this.recorderMediaChunkPath(session, block.episodeId, block.sequence);
      const materialised = await this.fileMatches(file, block.payload);
      assertAuthority?.();
      if (materialised) session.recorderMaterialised.add(block.sequence);
      return materialised;
    }
    if ((block.flags & RecorderBlockFlags.AudioChunk) !== 0) {
      const audio = decodeRecorderMediaPayload(block.payload);
      const file = path.join(this.episodeRoot(session, block.episodeId), "audio", `${String(block.sequence).padStart(10, "0")}.${mediaExtension(audio.mimeType, "webm")}`);
      const materialised = await this.fileMatches(file, audio.data);
      assertAuthority?.();
      if (materialised) session.recorderMaterialised.add(block.sequence);
      return materialised;
    }
    if ((block.flags & RecorderBlockFlags.RunEvent) !== 0) {
      const expected = {
        sequence: block.sequence,
        sourceTimestampUs: block.sourceTimestampUs,
        event: decodeRecorderRunEvent(block.payload),
      };
      return this.sidecarContainsExactRecord(
        session,
        path.join(this.episodeRoot(session, block.episodeId), "run-events.jsonl"),
        block.sequence,
        expected,
        (record) => (record as { sequence?: unknown }).sequence,
        assertAuthority,
      );
    }
    const expected = this.recorderTimelineMaterialisation(episode, block).record;
    return this.sidecarContainsExactRecord(
      session,
      path.join(this.episodeRoot(session, block.episodeId), "sensors.jsonl"),
      block.sequence,
      expected,
      (record) => (record as { recorder?: { sequence?: unknown } }).recorder?.sequence,
      assertAuthority,
    );
  }

  private async fileMatches(file: string, expected: Uint8Array) {
    try {
      return bytesEqual(await readFile(file), expected);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async sidecarContainsExactRecord(
    session: SessionState,
    file: string,
    sequence: number,
    expected: unknown,
    sequenceOf: (record: unknown) => unknown,
    assertAuthority?: () => void,
  ) {
    const records = await this.readRepairableJsonLines(file);
    assertAuthority?.();
    const matches = records.filter((record) => sequenceOf(record) === sequence);
    if (matches.length === 0) return false;
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], expected)) {
      throw new RecorderStoreError("write-failed", "A recorder sidecar conflicts with the durable recorder journal");
    }
    session.recorderMaterialised.add(sequence);
    return true;
  }

  private async readRepairableJsonLines(file: string): Promise<unknown[]> {
    let content: Uint8Array;
    try {
      content = await readFile(file);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return [];
      throw error;
    }
    const records: unknown[] = [];
    let lineStart = 0;
    for (let index = 0; index <= content.byteLength; index += 1) {
      const atEnd = index === content.byteLength;
      if (!atEnd && content[index] !== 0x0a) continue;
      if (index === lineStart) {
        lineStart = index + 1;
        continue;
      }
      if (atEnd && content.at(-1) !== 0x0a) {
        await this.truncateDurable(file, lineStart);
        return records;
      }
      try {
        const line = recorderPayloadDecoder.decode(content.subarray(lineStart, index));
        if (line.trim()) records.push(JSON.parse(line));
      } catch (error) {
        throw new RecorderStoreError("write-failed", `Recorder sidecar contains invalid JSON: ${error instanceof Error ? error.message : "invalid record"}`);
      }
      lineStart = index + 1;
    }
    return records;
  }

  private async persistEpisode(session: SessionState, episode: Episode) {
    const key = `${session.id}:${episode.id}`;
    const snapshot = structuredClone(episode);
    const previous = this.episodePersistenceTails.get(key) ?? Promise.resolve();
    const operation = previous.then(
      () => this.persistEpisodeNow(session, snapshot),
      () => this.persistEpisodeNow(session, snapshot),
    );
    const tail = operation.then(() => undefined, () => undefined);
    this.episodePersistenceTails.set(key, tail);
    try {
      await operation;
    } finally {
      if (this.episodePersistenceTails.get(key) === tail) this.episodePersistenceTails.delete(key);
    }
  }

  private async persistEpisodeNow(session: SessionState, episode: Episode) {
    const name = episode.integrity === "valid" ? "episode.json" : "attempt.json";
    const obsoleteName = episode.integrity === "valid" ? "attempt.json" : "episode.json";
    const root = this.episodeRoot(session, episode.id);
    await mkdir(root, { recursive: true });
    const taskSpecification = validateEpisodeTaskSpecification(episode);
    const commitPayload = taskSpecification
      ? {
          sessionId: session.id,
          episodeId: episode.id,
          taskSpecVersion: episode.taskSpecVersion,
          taskSpecHash: episode.taskSpecHash,
          episode,
        }
      : { sessionId: session.id, episodeId: episode.id, episode };
    const commit: PersistedEpisodeCommit = {
      schema: taskSpecification ? "ceres-episode-commit-v2" : "ceres-episode-commit-v1",
      ...commitPayload,
      checksum: createHash("sha256").update(JSON.stringify(commitPayload)).digest("hex"),
    };
    await this.writeAtomic(path.join(root, "episode.commit.json"), Buffer.from(JSON.stringify(commit, null, 2)));
    await this.writeAtomic(path.join(root, name), Buffer.from(JSON.stringify(episode, null, 2)));
    try {
      await unlink(path.join(root, obsoleteName));
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        // The commit marker is authoritative. An obsolete compatibility view is harmless.
      }
    }
  }

  private async persistTaskSpecification(session: SessionState, episode: Episode) {
    const canonical = validateEpisodeTaskSpecification(episode);
    if (canonical === null) return;
    const file = path.join(
      this.episodeRoot(session, episode.id),
      "task-specifications",
      `${episode.taskSpecHash}.json`,
    );
    try {
      const existing = await readFile(file, "utf8");
      if (existing !== canonical) {
        throw new RecorderStoreError("write-failed", "Stored task specification does not match its episode provenance");
      }
      return;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await this.writeAtomic(file, Buffer.from(canonical, "utf8"));
  }

  private async assembleRecorderMedia(session: SessionState, episode: Episode) {
    const chunkRoot = path.join(this.episodeRoot(session, episode.id), "video", "recorder-chunks");
    let chunks: string[];
    try {
      chunks = (await readdir(chunkRoot)).filter((name) => name.endsWith(".block")).sort();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    if (chunks.length === 0) return;
    let assembledBytes = 0;
    for (const chunk of chunks) assembledBytes += (await stat(path.join(chunkRoot, chunk))).size;
    await this.assertStorageSafe(assembledBytes);
    const first = decodeRecorderMediaPayload(await readFile(path.join(chunkRoot, chunks[0])));
    const output = path.join(this.episodeRoot(session, episode.id), "video", `passthrough.${mediaExtension(first.mimeType, "webm")}`);
    const handle = await open(output, "w");
    try {
      for (const chunkName of chunks) {
        const chunk = decodeRecorderMediaPayload(await readFile(path.join(chunkRoot, chunkName)));
        if (chunk.mimeType !== first.mimeType) throw new RecorderStoreError("write-failed", "Recorder media MIME type changed within an episode");
        await writeHandleFully(handle, chunk.data);
      }
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  private recorderMediaChunkPath(session: SessionState, episodeId: string, sequence: number) {
    return path.join(this.episodeRoot(session, episodeId), "video", "recorder-chunks", `${String(sequence).padStart(10, "0")}.block`);
  }

  private highestRecorderSequence(session: SessionState) {
    let highest = -1;
    for (const sequence of session.recorderLedger.keys()) if (sequence > highest) highest = sequence;
    return highest;
  }

  private async assertStorageSafe(pendingBytes = 0) {
    const statistics = await statfs(this.dataRoot);
    const freeBytes = Number(statistics.bavail) * Number(statistics.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes - pendingBytes < this.minimumFreeBytes) {
      throw new RecorderStoreError("storage-unsafe", `Recorder storage headroom is ${Math.max(0, Math.floor(freeBytes - pendingBytes))} bytes`);
    }
  }

  private async probeRecorderJournal(session: SessionState) {
    const handle = await open(this.recorderJournalPath(session), "a");
    try {
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  private async truncateDurable(file: string, length: number) {
    const handle = await open(file, "r+");
    try {
      await handle.truncate(length);
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  private async appendDurable(file: string, data: Uint8Array) {
    const handle = await open(file, "a");
    try {
      const result = await handle.write(data);
      if (result.bytesWritten !== data.byteLength) throw new RecorderStoreError("write-failed", `Recorder short write at ${file}`);
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  private async writeDurable(file: string, data: Uint8Array) {
    const handle = await open(file, "w");
    try {
      const result = await handle.write(data);
      if (result.bytesWritten !== data.byteLength) throw new RecorderStoreError("write-failed", `Recorder short write at ${file}`);
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  private async writeAtomic(file: string, data: Uint8Array) {
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporary, "wx");
      await writeHandleFully(handle, data);
      await handle.datasync();
      await handle.close();
      handle = null;
      await rename(temporary, file);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private failRecorderState(session: SessionState, error: unknown) {
    session.recorderArmed = false;
    session.recorderFailed = true;
    session.recording = false;
    const detail = error instanceof Error ? error.message : "Recorder writer failed";
    session.captureStatus = { ...session.captureStatus, recorder: "failed", lastError: detail };
    this.publishCaptureStatus(session);
  }

  private asRecorderStoreError(error: unknown) {
    if (error instanceof RecorderStoreError) return error;
    if (error instanceof RecorderProtocolError) return new RecorderStoreError(error.code, error.message);
    return new RecorderStoreError("write-failed", error instanceof Error ? error.message : "Recorder writer failed");
  }

  private sessionRoot(session: SessionState) {
    return path.join(this.dataRoot, "sessions", session.id);
  }

  private recorderJournalPath(session: SessionState) {
    return path.join(this.sessionRoot(session), "recorder.blocks");
  }

  private configurationPath(session: SessionState) {
    return path.join(this.sessionRoot(session), "configuration.json");
  }

  private currentTask(session: SessionState): TaskDefinition | undefined {
    return session.configuration.tasks[session.run.activeTaskIndex];
  }

  private scheduleTimedCompletion(session: SessionState) {
    this.clearTimedTaskTimer(session);
    const task = this.currentTask(session);
    if (!task || task.type !== "timed"
      || session.run.status !== "running"
      || session.run.phase !== "active-task"
      || session.run.recordingState === "paused"
      || session.run.recordingState === "stopping"
      || session.run.takeStartedAtMs === null) return;
    const cursor = `${session.run.cycle}:${session.run.activeTaskIndex}:${session.run.repetition}`;
    const elapsedMs = session.run.takeElapsedMs + Math.max(0, Date.now() - session.run.takeStartedAtMs);
    const remainingMs = Math.max(0, task.durationS * 1_000 - elapsedMs);
    session.timedTaskTimer = setTimeout(() => {
      session.timedTaskTimer = null;
      void this.enqueueRun(session, async () => {
        const currentCursor = `${session.run.cycle}:${session.run.activeTaskIndex}:${session.run.repetition}`;
        if (session.run.status !== "running" || session.run.phase !== "active-task" || currentCursor !== cursor) return;
        await this.completeCurrentTask(session);
      })
        .catch((error) => this.setRunError(session, error));
    }, remainingMs);
    session.timedTaskTimer.unref();
  }

  private scheduleResetExpiry(session: SessionState) {
    this.clearResetTimer(session);
    const deadline = session.run.resetDeadlineMs;
    const phase = session.run.phase;
    if (deadline === null || (phase !== "post-task-pause" && phase !== "task-pause" && phase !== "cycle-pause")) return;
    session.resetTimer = setTimeout(() => {
      session.resetTimer = null;
      void this.enqueueRun(session, async () => {
        if (session.run.status !== "running" || session.run.resetDeadlineMs !== deadline || session.run.phase !== phase) return;
        session.run.resetDeadlineMs = null;
        if (phase === "cycle-pause") {
          await this.finishCyclePause(session);
        } else {
          await this.finishReset(session);
        }
      }).catch((error) => this.setRunError(session, error));
    }, Math.max(0, deadline - Date.now()));
    session.resetTimer.unref();
  }

  private clearTimedTaskTimer(session: SessionState) {
    if (session.timedTaskTimer !== null) clearTimeout(session.timedTaskTimer);
    session.timedTaskTimer = null;
  }

  private clearResetTimer(session: SessionState) {
    if (session.resetTimer !== null) clearTimeout(session.resetTimer);
    session.resetTimer = null;
  }

  private clearSyncLockTimer(session: SessionState) {
    if (session.syncLockTimer !== null) clearTimeout(session.syncLockTimer);
    session.syncLockTimer = null;
  }

  private clearRunTimers(session: SessionState) {
    this.clearTimedTaskTimer(session);
    this.clearResetTimer(session);
    this.clearSyncLockTimer(session);
  }

  private setRunError(session: SessionState, error: unknown) {
    this.clearRunTimers(session);
    session.run.status = "error";
    session.run.phase = null;
    session.run.endedAtMs = Date.now();
    session.run.error = error instanceof Error ? error.message : "Run transition failed";
    session.pendingTaskPublication = null;
    this.publishSnapshot(session);
  }

  private recordingReadiness(session: SessionState): RecordingReadiness {
    const blockers: RecordingReadiness["blockers"] = [];
    const add = (code: RecordingReadiness["blockers"][number]["code"], message: string) => blockers.push({ code, message });
    const task = this.currentTask(session);
    if (session.run.status !== "running") add("sequence-not-started", "The run has not started");
    if (session.currentEpisode || session.pendingEpisode || session.run.recordingState !== "idle") {
      add("recording-active", "A recording attempt is already active");
    }
    if (session.run.phase !== "active-task") add("run-not-ready", "Recording is only available during an active task");
    if (!session.captureConnected) add("capture-disconnected", "The demonstrator capture client is disconnected");
    if (session.configurationAppliedRevision !== session.configurationRevision
      || session.configurationAppliedChecksum !== session.configurationChecksum) {
      add("configuration-not-applied", "The capture client has not applied the current run configuration");
    }
    if ((session.configuration.promptAudio.enabled || session.configuration.promptAudio.useTextToSpeech)
      && session.configuration.promptAudio.required
      && session.promptAudioStatus.state !== "ready") {
      add("audio-not-ready", session.promptAudioStatus.detail || "Required prompt audio is not ready");
    }
    if (!task) add("no-task", "No task is selected");
    else if (task.type === "pause") add("task-not-recordable", "The selected run item is a pause");
    if (session.recorderFailed) add("recorder-failed", "The durable recorder is failed");
    else if (!session.recorderArmed || session.captureStatus.recorder !== "armed") add("recorder-not-armed", "The durable recorder is not armed");
    return { ready: blockers.length === 0, blockers };
  }

  private sequenceReadiness(session: SessionState): SequenceReadiness {
    const blockers: SequenceReadiness["blockers"] = [];
    const add = (code: (typeof blockers)[number]["code"], message: string) => blockers.push({ code, message });
    if (session.run.status === "running") add("sequence-active", "The run is already active");
    if (!session.captureConnected) add("capture-disconnected", "The demonstrator capture client is disconnected");
    if (session.configurationAppliedRevision !== session.configurationRevision
      || session.configurationAppliedChecksum !== session.configurationChecksum) {
      add("configuration-not-applied", "The capture client has not applied the current run configuration");
    }
    if (!session.configuration.tasks.some(isRepetitionTask)) add("no-task", "The sequence has no recordable tasks");
    if ((session.configuration.promptAudio.enabled || session.configuration.promptAudio.useTextToSpeech)
      && session.configuration.promptAudio.required
      && session.promptAudioStatus.state !== "ready") {
      add("audio-not-ready", session.promptAudioStatus.detail || "Required prompt audio is not ready");
    }
    if (session.recorderFailed) add("recorder-failed", "The durable recorder is failed");
    else if (!session.recorderArmed || session.captureStatus.recorder !== "armed") {
      add("recorder-not-armed", "The durable recorder is not armed");
    }
    return { ready: blockers.length === 0, blockers };
  }

  exportCapability(sessionId: string): string {
    return this.get(sessionId).exportCapability;
  }

  authoriseEpisodeExport(sessionId: string, capability: string | undefined): boolean {
    const expected = this.sessions.get(sessionId)?.exportCapability;
    if (!expected || !capability || capability.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(capability, "ascii"));
  }

  private episodeRoot(session: SessionState, episodeId: string) {
    return path.join(this.sessionRoot(session), "episodes", episodeId);
  }

  private publishCaptureStatus(session: SessionState) {
    this.publish(session, "capture-status", { status: session.captureStatus });
  }

  private sendConfiguration(session: SessionState, connection: SessionConnection) {
    connection.send("configuration", {
      configuration: session.configuration,
      revision: session.configurationRevision,
      checksum: session.configurationChecksum,
    });
  }

  private publishConfiguration(session: SessionState) {
    const capture = this.signallingCapture(session);
    if (capture) this.sendConfiguration(session, capture);
  }

  private publishMonitors(session: SessionState, type: string, payload: unknown) {
    for (const connection of session.connections) if (connection.role === "monitor") connection.send(type, payload);
  }

  private publishSnapshot(session: SessionState) {
    this.publish(session, "snapshot", { snapshot: this.snapshot(session.id) });
  }

  private updateMonitorLoadStage(session: SessionState) {
    const nextStage = Math.max(0, ...[...session.connections]
      .filter((connection) => connection.role === "monitor")
      .map((connection) => connection.monitorLoadStage ?? 0));
    if (nextStage === session.monitorLoadStage) return;
    session.monitorLoadStage = nextStage;
    this.signallingCapture(session)?.send("monitor-load", { stage: nextStage });
  }

  private publish(session: SessionState, type: string, payload: unknown) {
    for (const connection of session.connections) {
      if (connection.role === "monitor-control" && type !== "snapshot") continue;
      if (connection.role === "capture"
        && connection.id !== session.activeCaptureId
        && connection.id !== session.captureCandidateId) continue;
      if (type === "control" && connection.role === "capture" && connection.id !== session.activeCaptureId) continue;
      connection.send(type, payload);
    }
  }

  private activeCapture(session: SessionState) {
    if (!session.activeCaptureId) return undefined;
    return [...session.connections].find((connection) => connection.role === "capture" && connection.id === session.activeCaptureId);
  }

  private signallingCapture(session: SessionState) {
    return this.activeCapture(session)
      ?? [...session.connections].find((connection) => connection.role === "capture" && connection.id === session.captureCandidateId);
  }

  private bindCapturePairing(session: SessionState, connection: SessionConnection):
    | { accepted: true; replacedConnections: SessionConnection[] }
    | { accepted: false; retryable: true; message: string }
    | { accepted: false; code: CapturePairingRejectionCode; message: string } {
    const pairingId = connection.pairingId;
    if (typeof pairingId !== "string" || !isSafeStorageIdentifier(pairingId)) {
      return {
        accepted: false,
        code: "capture-pairing-required",
        message: "The capture tab did not provide a valid pairing identity",
      };
    }
    if (session.pairedCapturePairingId && session.pairedCapturePairingId !== pairingId) {
      return {
        accepted: false,
        code: "capture-already-paired",
        message: "This QR session is already paired with another capture tab",
      };
    }
    const activeCapture = this.activeCapture(session);
    if (activeCapture) {
      return {
        accepted: false,
        retryable: true,
        message: "The paired capture tab is still connected",
      };
    }
    return { accepted: true, replacedConnections: [] };
  }

  private bindRecorderPairing(session: SessionState, connection: SessionConnection):
    | { accepted: true; replacedConnections: SessionConnection[] }
    | { accepted: false; retryable: true; message: string }
    | { accepted: false; code: CapturePairingRejectionCode; message: string } {
    const pairingId = connection.pairingId;
    if (typeof pairingId !== "string" || !isSafeStorageIdentifier(pairingId)) {
      return {
        accepted: false,
        code: "recorder-pairing-required",
        message: "The recorder did not provide a valid capture pairing identity",
      };
    }
    const authorisedPairingId = this.authorisedRecorderPairingId(session);
    if (!authorisedPairingId) {
      return {
        accepted: false,
        code: "recorder-pairing-pending",
        message: "The recorder cannot connect before its capture tab has paired",
      };
    }
    if (authorisedPairingId !== pairingId) {
      return {
        accepted: false,
        code: "recorder-pairing-rejected",
        message: "The recorder does not belong to the capture tab paired with this QR session",
      };
    }
    const connectedRecorder = [...session.connections].find((candidate) => candidate.role === "recorder");
    if (connectedRecorder) {
      return {
        accepted: false,
        retryable: true,
        message: "The paired capture recorder is still connected",
      };
    }
    return { accepted: true, replacedConnections: [] };
  }

  private preferredCapture(session: SessionState) {
    return [...session.connections]
      .filter((connection) => connection.role === "capture"
        && (!session.pairedCapturePairingId || connection.pairingId === session.pairedCapturePairingId))
      .sort((left, right) => (right.lastSensorFrameAtMs ?? Number.NEGATIVE_INFINITY) - (left.lastSensorFrameAtMs ?? Number.NEGATIVE_INFINITY)
        || (right.connectedAtMs ?? 0) - (left.connectedAtMs ?? 0))[0];
  }

  private activateCapture(session: SessionState, connection: SessionConnection) {
    if (connection.role !== "capture" || !session.connections.has(connection)) throw new Error("The active capture must be connected");
    if (session.activeCaptureId === connection.id) {
      session.captureConnected = true;
      return;
    }
    if (session.captureCandidateId === connection.id) {
      session.activeCaptureId = connection.id;
      session.captureConnected = true;
      return;
    }
    session.activeCaptureId = connection.id;
    session.captureCandidateId = connection.id;
    session.captureConnected = true;
    session.configurationAppliedRevision = null;
    session.configurationAppliedChecksum = null;
    session.promptAudioStatus = session.configuration.promptAudio.enabled || session.configuration.promptAudio.useTextToSpeech
      ? { state: "locked", detail: "Enable prompt audio on the demonstrator device" }
      : { state: "unavailable", detail: "Prompt audio is disabled for this run" };
    session.captureStatus = resetCaptureStatusForOwner(session.captureStatus, session.configuration.recorderRateHz);
    session.webRtcCaptureByPeer.clear();
    for (const candidate of session.connections) {
      if (candidate.role === "capture") candidate.activeWebRtcPeerId = undefined;
    }
    connection.send("monitor-load", { stage: session.monitorLoadStage });
    this.sendConfiguration(session, connection);
    for (const monitor of session.connections) {
      if (monitor.role !== "monitor") continue;
      session.webRtcCaptureByPeer.set(monitor.id, connection.id);
      connection.activeWebRtcPeerId = monitor.id;
      connection.send("webrtc-request-offer", { peerId: monitor.id });
    }
  }

  private deactivateCapture(session: SessionState) {
    session.activeCaptureId = null;
    session.captureCandidateId = null;
    session.captureConnected = false;
    session.configurationAppliedRevision = null;
    session.configurationAppliedChecksum = null;
    session.promptAudioStatus = session.configuration.promptAudio.enabled || session.configuration.promptAudio.useTextToSpeech
      ? { state: "locked", detail: "The demonstrator device is disconnected" }
      : { state: "unavailable", detail: "Prompt audio is disabled for this run" };
    session.captureStatus = resetCaptureStatusForOwner(session.captureStatus, session.configuration.recorderRateHz);
    session.webRtcCaptureByPeer.clear();
  }

  private captureAuthorityDecision(session: SessionState, connection: SessionConnection): CaptureAuthorityResult {
    const pairingId = connection.pairingId;
    if (connection.role !== "capture" || !session.connections.has(connection)
      || typeof pairingId !== "string" || !isSafeStorageIdentifier(pairingId)) {
      return {
        accepted: false,
        code: "capture-pairing-required",
        message: "The capture tab did not provide a valid pairing identity",
      };
    }
    if (session.pairedCapturePairingId && session.pairedCapturePairingId !== pairingId) {
      return {
        accepted: false,
        code: "capture-already-paired",
        message: "This QR session is already paired with another capture tab",
      };
    }
    const active = this.activeCapture(session);
    if (!active) return { accepted: true, alreadyActive: false };
    if (active.id === connection.id) return { accepted: true, alreadyActive: true };
    if (active.pairingId !== pairingId) {
      return {
        accepted: false,
        code: "capture-already-paired",
        message: "This QR session is already paired with another capture tab",
      };
    }
    return {
      accepted: false,
      retryable: true,
      message: "The paired capture tab is still connected",
    };
  }

  private grantCaptureIntent(session: SessionState, connection: SessionConnection) {
    const previous = this.signallingCapture(session);
    if (previous && previous.id !== connection.id) {
      previous.send("capture-intent-suspended", {});
      previous.activeWebRtcPeerId = undefined;
      for (const [peerId, captureId] of session.webRtcCaptureByPeer) {
        if (captureId === previous.id) session.webRtcCaptureByPeer.delete(peerId);
      }
      session.configurationAppliedRevision = null;
      session.configurationAppliedChecksum = null;
      session.promptAudioStatus = session.configuration.promptAudio.enabled || session.configuration.promptAudio.useTextToSpeech
        ? { state: "locked", detail: "Enable prompt audio on the demonstrator device" }
        : { state: "unavailable", detail: "Prompt audio is disabled for this run" };
      session.captureStatus = resetCaptureStatusForOwner(session.captureStatus, session.configuration.recorderRateHz);
    }
    const recorder = [...session.connections].find((candidate) => candidate.role === "recorder"
      && candidate.id === session.activeRecorderId
      && candidate.pairingId !== connection.pairingId);
    if (recorder) this.suspendRecorder(session, recorder, "Recorder superseded by another provisional capture tab");
    session.captureCandidateId = connection.id;
    this.applyTelemetryModeAuthority(session, connection);
    connection.send("capture-intent-granted", {});
    connection.send("monitor-load", { stage: session.monitorLoadStage });
    this.sendConfiguration(session, connection);
    for (const monitor of session.connections) {
      if (monitor.role !== "monitor") continue;
      session.webRtcCaptureByPeer.set(monitor.id, connection.id);
      connection.activeWebRtcPeerId = monitor.id;
      connection.send("webrtc-request-offer", { peerId: monitor.id });
    }
  }

  private suspendRecorder(session: SessionState, recorder: SessionConnection, reason: string) {
    if (session.activeRecorderId === recorder.id) {
      session.activeRecorderId = null;
      session.recorderArmed = false;
      session.captureStatus = {
        ...session.captureStatus,
        recorder: session.recorderFailed ? "failed" : "arming",
      };
    }
    recorder.close?.(CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE, reason);
  }

  private applyTelemetryModeAuthority(session: SessionState, connection: SessionConnection) {
    session.telemetryMode = normaliseSessionTelemetryMode(connection.telemetryMode, "disabled");
    session.telemetryModeAuthoritative = true;
    session.telemetryModeOwnerId = connection.id;
  }

  private clearTelemetryModeAuthority(session: SessionState) {
    session.telemetryMode = "disabled";
    session.telemetryModeAuthoritative = false;
    session.telemetryModeOwnerId = null;
  }

  private assertActiveCapture(session: SessionState, connection: SessionConnection, operation: string) {
    if (connection.role !== "capture" || !session.connections.has(connection) || connection.id !== session.activeCaptureId) {
      throw new Error(`Only the active capture client can ${operation}`);
    }
  }

  private assertSignallingCapture(session: SessionState, connection: SessionConnection) {
    if (connection.role !== "capture"
      || !session.connections.has(connection)
      || connection.id !== this.signallingCapture(session)?.id) {
      throw new Error("Only the selected capture client can relay WebRTC signalling");
    }
  }

  private assertActiveRecorder(session: SessionState, connection: SessionConnection, operation: string) {
    if (connection.role !== "recorder"
      || !session.connections.has(connection)
      || connection.id !== session.activeRecorderId
      || connection.pairingId !== this.authorisedRecorderPairingId(session)) {
      throw new RecorderStoreError("not-capture", `Only the active recorder for the paired capture can ${operation}`);
    }
  }

  private claimActiveCaptureForSensor(session: SessionState, connection: SessionConnection) {
    if (connection.role !== "capture" || !session.connections.has(connection)) {
      throw new Error("Only a connected capture client can report sensor frames");
    }
    connection.lastSensorFrameAtMs = Date.now();
    if (this.activeCapture(session)?.id !== connection.id) {
      throw new Error("Only the active capture client can report sensor frames");
    }
  }

  private authorisedRecorderPairingId(session: SessionState) {
    return session.pairedCapturePairingId ?? this.signallingCapture(session)?.pairingId ?? null;
  }

  private get(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const stored = this.loadConfiguration(sessionId);
      session = {
        id: sessionId,
        exportCapability: randomBytes(32).toString("base64url"),
        startedAt: new Date().toISOString(),
        telemetryMode: "standard",
        telemetryModeAuthoritative: false,
        telemetryModeOwnerId: null,
        captureConnected: false,
        monitorCount: 0,
        recording: false,
        run: initialRunProgress(),
        handDisplay: { ...defaultHandDisplaySettings },
        cameraRegistration: null,
        timedTaskTimer: null,
        resetTimer: null,
        syncLockTimer: null,
        runTail: Promise.resolve(),
        configuration: stored.configuration,
        requestedConfiguration: stored.requestedConfiguration,
        configurationRevision: stored.revision,
        configurationChecksum: stored.checksum,
        configurationAppliedRevision: null,
        configurationAppliedChecksum: null,
        configurationError: stored.error,
        configurationTail: Promise.resolve(),
        currentEpisode: null,
        pendingEpisode: null,
        episodes: [],
        attempts: [],
        recorderAcceptedEpisodeId: null,
        pendingStopOutcome: null,
        pendingRunAction: null,
        pendingRunTransitionApplied: false,
        pendingTaskPublication: null,
        pendingReviewAnnotation: null,
        jobs: [],
        promptAudioStatus: { state: "locked", detail: "Prompt audio setup is required on the demonstrator device" },
        promptDeliveries: [],
        lastFrame: null,
        lastTranscript: null,
        commandLog: [],
        captureStatus: { ...defaultCaptureStatus },
        connections: new Set(),
        pairedCapturePairingId: null,
        captureCandidateId: null,
        activeCaptureId: null,
        activeRecorderId: null,
        webRtcCaptureByPeer: new Map(),
        recorderArmed: false,
        recorderFailed: false,
        recorderLedgerLoaded: false,
        recorderLedger: new Map(),
        recorderMaterialised: new Set(),
        recorderPendingBoundary: null,
        qualityTrackers: new Map(),
        monitorLoadStage: 0,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private loadConfiguration(sessionId: string): {
    configuration: CaptureConfiguration;
    requestedConfiguration: CaptureConfiguration;
    revision: number;
    checksum: string;
    error: string | null;
  } {
    const requestedFallback = normaliseCaptureConfiguration({ ...defaultConfiguration, recorderRateHz: this.defaultRecorderRateHz });
    const fallback = applyRuntimeFeaturePolicy(requestedFallback, this.features);
    const file = path.join(this.dataRoot, "sessions", sessionId, "configuration.json");
    if (!existsSync(file)) return {
      configuration: fallback,
      requestedConfiguration: requestedFallback,
      revision: 1,
      checksum: configurationChecksum(fallback),
      error: null,
    };
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedConfiguration> & { configuration?: unknown };
      const requestedConfiguration = normaliseCaptureConfiguration(raw.configuration ?? raw);
      const configuration = applyRuntimeFeaturePolicy(requestedConfiguration, this.features);
      const revision = Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : 1;
      return { configuration, requestedConfiguration, revision, checksum: configurationChecksum(configuration), error: null };
    } catch (error) {
      return {
        configuration: fallback,
        requestedConfiguration: requestedFallback,
        revision: 1,
        checksum: configurationChecksum(fallback),
        error: error instanceof Error ? `Stored configuration is invalid: ${error.message}` : "Stored configuration is invalid",
      };
    }
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function resetCaptureStatusForOwner(current: CaptureStatus, recorderRateHz: number): CaptureStatus {
  return {
    ...defaultCaptureStatus,
    recorder: current.recorder,
    recorderRateHz,
    recorderFrameIndex: current.recorderFrameIndex,
    recorderGaps: current.recorderGaps,
    recorderPendingBlocks: current.recorderPendingBlocks,
    recorderQueuedBlocks: current.recorderQueuedBlocks ?? defaultCaptureStatus.recorderQueuedBlocks,
    recorderDurableAckSequence: current.recorderDurableAckSequence,
    recorderFinaliseStartAckSequence: current.recorderFinaliseStartAckSequence
      ?? defaultCaptureStatus.recorderFinaliseStartAckSequence,
    recorderFinaliseTargetSequence: current.recorderFinaliseTargetSequence
      ?? defaultCaptureStatus.recorderFinaliseTargetSequence,
  };
}

function isSafeStorageIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function configurationChecksum(configuration: CaptureConfiguration) {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function taskSpecificationHash(value: unknown) {
  return createHash("sha256").update(canonicalTaskSpecification(value), "utf8").digest("hex");
}

function validateEpisodeTaskSpecification(episode: Episode): string | null {
  if (!hasTaskSpecificationProvenance(episode)) return null;
  if (episode.taskSpecVersion !== CERES_TASK_SPEC_VERSION
    || typeof episode.taskSpecHash !== "string"
    || !/^[0-9a-f]{64}$/.test(episode.taskSpecHash)
    || episode.taskSpecification === undefined) {
    throw new RecorderStoreError("write-failed", "Episode task specification provenance is incomplete");
  }
  const canonical = canonicalTaskSpecification(episode.taskSpecification);
  if (taskSpecificationHash(episode.taskSpecification) !== episode.taskSpecHash) {
    throw new RecorderStoreError("write-failed", "Episode task specification hash is invalid");
  }
  return canonical;
}

function applyRuntimeFeaturePolicy(configuration: CaptureConfiguration, features: RuntimeFeatures): CaptureConfiguration {
  if (features.speech) return configuration;
  return {
    ...configuration,
    promptAudio: {
      ...configuration.promptAudio,
      required: configuration.promptAudio.required && configuration.promptAudio.enabled,
      useTextToSpeech: false,
    },
  };
}

function preserveDisabledSpeechSettings(
  configuration: CaptureConfiguration,
  current: CaptureConfiguration,
  features: RuntimeFeatures,
): CaptureConfiguration {
  if (features.speech) return configuration;
  return {
    ...configuration,
    sttProvider: current.sttProvider,
    promptAudio: {
      ...configuration.promptAudio,
      useTextToSpeech: current.promptAudio.useTextToSpeech,
      ttsProvider: current.promptAudio.ttsProvider,
    },
  };
}

function initialRunProgress(): RunProgress {
  return {
    status: "stopped",
    phase: null,
    recordingState: "idle",
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

function canonicalSensorFrame(
  frame: SensorFrame,
  timestampMs = frame.timestampMs,
  frameIndex = frame.frameIndex,
): SensorFrame {
  return {
    timestampMs,
    frameIndex,
    head: frame.head,
    ...(frame.cameraSide === undefined ? {} : { cameraSide: frame.cameraSide }),
    ...(frame.camera === undefined ? {} : { camera: frame.camera }),
    leftHand: frame.leftHand,
    rightHand: frame.rightHand,
    sceneStatus: frame.sceneStatus,
  };
}

function emptyQualitySummary(frameCount = 0, gapCount = 0): Episode["qualitySummary"] {
  return {
    decision: gapCount > 0 ? "caution" : "go",
    reasons: gapCount > 0 ? [`${gapCount} recorder gap${gapCount === 1 ? "" : "s"}`] : [],
    frameCount,
    gapCount,
    maxLeftHandSpeedMps: 0,
    maxRightHandSpeedMps: 0,
    slowHandEvents: 0,
    trackingLossEvents: 0,
  };
}

function mediaExtension(mimeType: string, fallback: string) {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("webm")) return "webm";
  return fallback;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function writeHandleFully(handle: FileHandle, data: Uint8Array) {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, null);
    if (result.bytesWritten === 0) throw new RecorderStoreError("write-failed", "Recorder media write made no progress");
    offset += result.bytesWritten;
  }
}

function validateEpisodeUploadCommit(requestId: string, episodeIds: string[], receipt: string): string[] {
  if (typeof requestId !== "string" || !/^hf_upload_[A-Za-z0-9_-]{24}$/.test(requestId)) {
    throw new Error("Hugging Face upload request identity is invalid");
  }
  if (!Array.isArray(episodeIds) || episodeIds.length === 0 || episodeIds.length > 100) {
    throw new Error("Hugging Face upload episode selection is invalid");
  }
  const ids = episodeIds.map((episodeId) => {
    if (typeof episodeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(episodeId)) {
      throw new Error("Hugging Face upload episode identity is invalid");
    }
    return episodeId;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Hugging Face upload episode selection contains duplicates");
  if (typeof receipt !== "string" || receipt.length < 32 || receipt.length > 8_192) {
    throw new Error("Hugging Face upload completion proof is invalid");
  }
  return ids.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function sameEpisodeSelection(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((episodeId, index) => episodeId === right[index]);
}
