import { applicationServices, mountUserIdentity, applicationHeaderMarkup, mountApplicationHeader, type UserIdentityState } from "./application-services.js";
import { defaultCaptureStatus, defaultConfiguration, isDirectBeamDeliveryId, isStateBoundRunControlAction, nextRunControlCursor, normaliseCaptureConfiguration, normaliseSessionTelemetryMode, webRtcSignalNegotiationId, type AsrStatusState, type CameraSide, type CaptureConfiguration, type CaptureStatus, type ConfigurationStatus, type DirectBeamDeliveryState, type Episode, type RuntimeFeatures, type SessionSnapshot, type VerifiedEpisodeHuggingFaceUpload, type WebRtcSignal } from "../shared/protocol.js";
import { captureHealthSummary, HAND_SPEED_CRITICAL_MPS } from "../shared/capture-quality.js";
import { cameraRegistrationKey, cameraRegistrationMatches, normaliseCameraRegistration, type CameraRegistration } from "../shared/camera-registration.js";
import { cameraCaptureFrameKey, cameraRegistrationForCaptureFrame } from "../shared/camera-capture-frame.js";
import { defaultHandDisplaySettings, handRenderModes, handShadingModes, handTrailModes, normaliseHandDisplaySettings, type HandDisplaySettings, type HandMeshStatus, type HandRenderMode, type HandShadingMode, type HandTrailMode } from "../shared/hand-display.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";
import { colourWithAlpha, semanticColours } from "../shared/semantic-colours.js";
import type { SensorFrame, ServerMessage } from "../shared/protocol.js";
import { calibrationCoverageGuidance, calibrationViewTarget, captureCalibrationObservation, isNovelCalibrationObservation, solveCameraIntrinsics, type CalibrationObservation, type CameraCalibrationResult } from "./camera-calibration.js";
import { cameraRegistrationFromCalibration, loadCameraRegistrationForCaptureFrame, storeCameraRegistration } from "./camera-registration-storage.js";




import { MonitorExportAdapter } from "./lerobot-export/monitor-export-adapter.js";
import type { MonitorExportWorkerEvent } from "./lerobot-export/types.js";
import {
  exportDestinationService,
  requireExportDestinationService,
  AccountExportRequestError,
  AccountUploadCancellationUnconfirmedError,
  sameAccountUploadEpisodeIds,
  verifiedEpisodeUploadFromAccountJob,
} from "./export-service.js";
import {
  isHuggingFaceAppendAllocation,
  matchesRetainedHuggingFaceAppendAllocation,
  sameHuggingFaceAppendAllocation,
  type AccountExportSession,
  type AccountUploadManifestArtefact,
  type HuggingFaceAppendAllocation,
} from "../shared/export-destination.js";
import { clearInterruptedBeamDeliveries, DirectSessionReducer, isCurrentTaskPresentation, type DirectCaptureCommand, type DirectRunControlAction, type DirectRunControlActor } from "./direct-session-reducer.js";
import { MonitorRecorder, MonitorRecorderFailureLatch, type MonitorRecorderEvent } from "./recorder/monitor-recorder.js";
import type { MonitorRecordingSummary } from "./recorder/monitor-recording-summary.js";
import { PeerRecorderAssembler } from "./recorder/peer-recorder-framing.js";
import { createSessionId, monitorSessionId } from "./session-client.js";

import { MonitorWorkerSession, type MonitorReadout } from "./monitor-worker-session.js";


import { applyConnectionProfile, connectionServerUrl, defaultCeresRelayUrl, isPeerConnectionMode, normaliseConnectionServer, rtcConfigurationForConnectionProfile, type ConnectionMode, type ConnectionProfile } from "./connection-profile.js";
import { containedVideoRect } from "./video-overlay.js";
import { recordingElapsedMs, runControls, sessionElapsedMs, takeElapsedMs, taskRemainingMs } from "./run-presentation.js";
import { TurnFallbackLease } from "./turn-lease.js";
import { WebRtcSignalClient, type InvitationPickedUp, type WebRtcSignalError } from "./webrtc-signal-client.js";
import { createPairingRoom, createPairingRoomCredentials, demonstratorInvite, monitorSignalCredentials, pairingInvitationLifetimeMs, pairingInviteUrl, shareablePairingInviteUrl, type PairingRoomCredentials } from "./pairing-invite.js";
import { clearStoredMonitorPairingInvitation, monitorPairingRetentionMs, storedMonitorPairingInvitation, storeMonitorPairingInvitation } from "./monitor-pairing-storage.js";

import { captureConnectionPresentation } from "./capture-connection-presentation.js";
import { loadRuntimeFeatures, RuntimeFeatureRecovery } from "./runtime-features-client.js";
import { episodeBlockPresentation } from "./monitor-episode-presentation.js";
import { episodeDisplayCycles } from "./monitor-episode-sequence.js";
import { episodeSelectionAvailable } from "./monitor-episode-review.js";
import { Bug, createIcons, Keyboard } from "lucide";
import { RunEditor } from "./run-editor.js";
import {
  clearMonitorSessionPersistence,
  deleteMonitorSessionRecordings,
  loadMonitorRunConfiguration,
  resolveMonitorConnectionPreference,
  storeMonitorConnectionPreference,
  type MonitorConnectionPanel,
  storeMonitorRunConfiguration,
} from "./monitor-session-persistence.js";

interface CeresBuildIdentity {
  version: string;
  branch: string | null;
  commit: string | null;
  shortCommit: string | null;
  channel: "release" | "preview" | "development";
  display: string;
}

declare const __CERES_BUILD_IDENTITY__: CeresBuildIdentity;
declare const __CERES_TEST_RECORDER_RATE_HZ__: number | null;

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!);
const directSessionRecorderRateHz = typeof __CERES_TEST_RECORDER_RATE_HZ__ === "number"
  ? __CERES_TEST_RECORDER_RATE_HZ__
  : undefined;
const monitorLiveSessionStorageKey = "ceres.monitor.live-session.v1";

const cameraRegistrationStatusKey = (
  cameraDeviceId: string,
  side: CameraSide,
  width: number,
  height: number,
  frame: CaptureStatus["selectedCameraFrame"],
) => JSON.stringify([
  cameraRegistrationKey(cameraDeviceId, side, width, height),
  frame ? cameraCaptureFrameKey(frame) : null,
]);

const statusLabel = (value: string) => ({
  active: "ACTIVE",
  connected: "UP",
  connecting: "SYNC",
  ended: "END",
  error: "ERR",
  failed: "FAIL",
  idle: "IDLE",
  ready: "READY",
  requesting: "REQ",
  unavailable: "N/A",
  waiting: "WAIT",
}[value] ?? value.replace(/-/g, " ").toUpperCase());

const formatDuration = (milliseconds: number) => {
  const deciseconds = Math.max(0, Math.floor(milliseconds / 100));
  const minutes = Math.floor(deciseconds / 600);
  const seconds = Math.floor(deciseconds / 10) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${deciseconds % 10}`;
};

const formatRateHz = (value: number) => value.toFixed(Number.isInteger(value) ? 0 : 1);

export function pendingRunConfigurationApplied(pendingRevision: number | null, status: ConfigurationStatus) {
  return pendingRevision !== null
    && status.state === "applied"
    && (status.appliedRevision ?? -1) >= pendingRevision;
}

const controlIcon = (slot: string, action: string) => {
  const body = slot === "run"
    ? action === "stop" ? "<rect x=\"7\" y=\"7\" width=\"10\" height=\"10\"/>" : "<path d=\"m9 7 8 5-8 5Z\"/>"
    : slot === "record"
      ? action === "pause" ? "<path d=\"M9 7v10M15 7v10\"/>" : "<circle cx=\"12\" cy=\"12\" r=\"5\"/>"
      : slot === "retry" ? "<path d=\"M7 8H3v-4M4 8a8 8 0 1 1-1 7\"/>"
        : slot === "next" ? "<path d=\"m7 6 7 6-7 6ZM17 6v12\"/>"
          : slot === "pass" ? "<path d=\"m6 12 4 4 8-9\"/>"
            : "<path d=\"m7 7 10 10M17 7 7 17\"/>";
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
};

const calibrationFrameTarget = calibrationViewTarget;
const calibrationCaptureIntervalMs = 1_000;
const monitorAccountUploadRecoveryRetryMs = 3_000;
const handEnergyDisplayMaxMps = 3;
const formatWristPose = (
  position: [number, number, number] | null,
  rotation: [number, number, number, number] | null,
) => position && rotation
  ? `P ${position.map((value) => value.toFixed(3)).join(" ")} / Q ${rotation.map((value) => value.toFixed(3)).join(" ")}`
  : "NO POSE";
const nextMode = <T extends string>(modes: readonly T[], current: T) => modes[(modes.indexOf(current) + 1) % modes.length];
const peerRunControlActions = new Set(["start-sequence", "start", "pause", "stop", "finish", "success", "fail", "retry", "resume", "next-task", "show-instructions"]);
type DirectorShortcutSlot = "run" | "next" | "pass" | "fail" | "retry";
const directorShortcutKeyBySlot: Record<DirectorShortcutSlot, string> = {
  run: "Space",
  next: "N",
  pass: "P",
  fail: "F",
  retry: "R",
};

export function directorShortcutSlot(key: string): DirectorShortcutSlot | null {
  if (key === " " || key === "Spacebar") return "run";
  return ({ n: "next", p: "pass", f: "fail", r: "retry" } as const)[key.toLowerCase() as "n" | "p" | "f" | "r"] ?? null;
}

function shortcutTypingTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']"));
}

interface BrowserExportJob {
  id: string;
  type: "export" | "upload";
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  detail: string;
  episodeIds: string[];
  lerobotStartedAtMs: number;
  deliveryStartedAtMs: number | null;
  activityStage?: "queued" | "exporting" | "uploading";
  accountUploadJobId?: string;
  backendUploadRecovery?: {
    artefacts: AccountUploadManifestArtefact[];
    options: BackendUploadOptions;
  };
}

type BrowserExportJourneyOutcome = "queued" | "completed" | "failed" | "cancelled";

function recordMonitorExportJourney(
  type: BrowserExportJob["type"],
  outcome: BrowserExportJourneyOutcome,
) {}

function browserExportJobIsTerminal(job: BrowserExportJob) {
  return job.state === "completed" || job.state === "failed" || job.state === "cancelled";
}

function monotonicElapsedMs(startedAtMs: number | null | undefined) {
  return typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
    ? Math.max(0, performance.now() - startedAtMs)
    : null;
}

interface BackendUploadOptions {
  expectedAccountSubject: string;
  expectedHuggingFaceSubject: string;
  repository: string;
  branch: string;
  visibility: "private" | "public";
  appendAllocation: HuggingFaceAppendAllocation;
}

function assertMonitorUploadArtefactAllocation(
  artefacts: readonly AccountUploadManifestArtefact[],
  allocation: HuggingFaceAppendAllocation,
) {
  const episodeIndices = [...new Set(artefacts.flatMap(({ path }) => {
    const match = /^shards\/episode-(\d{6,})\//.exec(path);
    if (!match) {
      if (path.startsWith("shards/episode-")) {
        throw new Error("The prepared export contains a non-canonical episode shard");
      }
      return [];
    }
    const episodeIndex = Number(match[1]);
    if (
      !Number.isSafeInteger(episodeIndex)
      || episodeIndex < 0
      || match[1] !== String(episodeIndex).padStart(6, "0")
    ) {
      throw new Error("The prepared export contains a non-canonical episode shard");
    }
    return [episodeIndex];
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

interface TaskImportWorkspaceHandle {
  open(): void;
  close(): void;
  requestClose(): void;
  dispose(): void;
}

class MonitorSnapshotCommitError extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : "Monitor recorder could not persist the session catalogue");
    this.name = "MonitorSnapshotCommitError";
  }
}

export function captureDirectorTelemetryIncognito(
  telemetryMode: unknown,
  authoritative: unknown,
) {
  return authoritative !== true
    || normaliseSessionTelemetryMode(telemetryMode, "disabled") === "disabled";
}

export class MonitorApp {
  private readonly sessionId = monitorSessionId();
  private readonly initialConnectionPreference = resolveMonitorConnectionPreference(this.sessionId);
  private connectionProfile: ConnectionProfile = this.initialConnectionPreference.profile;
  private readonly session = new MonitorWorkerSession(this.sessionId, null, !isPeerConnectionMode(this.connectionProfile));
  private webRtcSignal: WebRtcSignalClient | null = null;
  private pairingRoom: PairingRoomCredentials | null = null;
  private pairingLink: string | null = null;
  private pairingQrTarget: string | null = null;
  private pairingInvitationGeneration = 0;
  private pairingCopyOperation = 0;
  private activePairingCopyOperation: number | null = null;
  private pairingInitialising = false;
  private pairingRestoreAttempted = false;
  private pairingInvitationClaimed = false;
  private pairingInvitationPickedUpAt: string | null = null;
  private accountSignedIn = false;
  private get accountExportClient() { return requireExportDestinationService(); }
  private accountExportSession: AccountExportSession | null = null;
  private accountUploadAbort: AbortController | null = null;
  private accountUploadPlanning = false;
  private repositoryCatalogueAbort: AbortController | null = null;
  private repositoryCatalogueTimer: number | null = null;
  private readonly backendUploadOptions = new Map<string, BackendUploadOptions>();
  private readonly backendUploadCompletions = new Set<string>();
  private readonly backendUploadRecoveryControllers = new Map<string, AbortController>();
  private readonly backendUploadRecoveryTimers = new Map<string, number>();
  private readonly exporter = new MonitorExportAdapter();
  private readonly directSession = new DirectSessionReducer(this.sessionId, undefined, undefined, directSessionRecorderRateHz);
  private directSessionMutatedSinceOpen = false;
  private directCommitTail: Promise<void> = Promise.resolve();
  private runtimeFeatures: RuntimeFeatures = { speech: true };
  private runtimeFeaturesReady: Promise<void> = Promise.resolve();
  private runtimeFeaturesAvailable = false;
  private runtimeFeaturesPersistenceQueued = false;
  private readonly runtimeFeatureRecovery = new RuntimeFeatureRecovery();
  private readonly monitorRecorder = new MonitorRecorder((event) => this.handleMonitorRecorderEvent(event));
  private readonly monitorRecorderFailure = new MonitorRecorderFailureLatch();
  private monitorRecorderReady = false;
  private snapshot: SessionSnapshot | null = null;
  private peer: RTCPeerConnection | null = null;
  private webRtcJourneyOutcome: "connected" | "failed" | null = null;
  private rtcPeerId: string | null = null;
  private rtcNegotiationId: string | null = null;
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly remoteDescriptionReadyPeers = new Set<string>();
  private readonly pendingOutgoingIceCandidates = new WeakMap<RTCPeerConnection, RTCIceCandidateInit[]>();
  private readonly peerRecorderAssembler = new PeerRecorderAssembler();
  private peerControlChannel: RTCDataChannel | null = null;
  private readonly pendingBeamDeliveries = new Set<string>();
  private monitorRecorderNextSequence: number | null = null;
  private pendingDirectFinalisation: { episodeId: string; error?: string; captureFinalised: boolean } | null = null;
  private directFinalisationPublication: string | null = null;
  private directCaptureStatus: CaptureStatus | null = null;
  private directSignallingConnected = false;
  private readonly relayedTurnFallback = new TurnFallbackLease();
  private loadedConfigurationRevision: number | null = null;
  private configurationDraft = false;
  private configurationPending = false;
  private connectionPanel: MonitorConnectionPanel = this.initialConnectionPreference.panel;
  private restartHoldTimer: number | null = null;
  private restartInProgress = false;
  private pendingSessionReset: {
    resetId: string;
    timeoutId: number;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private pendingConfigurationRevision: number | null = null;
  private requestedFeed = false;
  private offerRequestRetryTimer: number | null = null;
  private offerRequestAttempt = 0;
  private turnFallbackWatchdogTimer: number | null = null;
  private timingTimer: number | null = null;
  private audioSpectrumContext: AudioContext | null = null;
  private audioSpectrumSource: MediaStreamAudioSourceNode | null = null;
  private audioSpectrumAnalyser: AnalyserNode | null = null;
  private audioSpectrumFrame: number | null = null;
  private readonly selectedEpisodeIds = new Set<string>();
  private episodeReplayController: AbortController | null = null;
  private replayedEpisodeId: string | null = null;
  private episodeReviewMode: "live" | "loading" | "replay" = "live";
  private episodeVideoUrl: string | null = null;
  private liveVideoStream: MediaStream | null = null;
  private advancingDirectRunClock = false;
  private pendingRunStartRevision: number | null = null;
  private runEditor: RunEditor | null = null;
  private taskImportWorkspace: TaskImportWorkspaceHandle | null = null;
  private lastVideoBytes = 0;
  private lastVideoStatsAt = 0;
  private videoStatsPending = false;
  private spatialOverlays = { ret: false, aid: false, trc: false };
  private activeSignals = new Set(["hxyz", "hrot", "lpos", "lrot", "lp", "rpos", "rrot", "rp"]);
  private handMode: HandRenderMode = defaultHandDisplaySettings.handMode;
  private handShading: HandShadingMode = defaultHandDisplaySettings.handShading;
  private handTrail: HandTrailMode = defaultHandDisplaySettings.handTrail;
  private handMeshStatus: HandMeshStatus = "outline-fallback";
  private socketConnected = false;
  private readonly displayedJobFailures = new Set<string>();
  private calibrationCaptureTimer: number | null = null;
  private calibrationCaptures = 0;
  private readonly calibrationObservations: CalibrationObservation[] = [];
  private calibrationCapturePending = false;
  private calibrationCameraDeviceId: string | null = null;
  private calibrationCameraLabel: string | null = null;
  private calibrationCameraSide: CameraSide = "unknown";
  private cameraCalibration: CameraCalibrationResult | null = null;
  private cameraRegistration: CameraRegistration | null = null;

  constructor() {  }
  private activeCameraRegistrationKey: string | null = null;
  private publishedCameraRegistration = "";
  private calibrationWidth: number | null = null;
  private calibrationHeight: number | null = null;
  private calibrationState: "NOT RUN" | "ACQUIRING" | "SOLVING" | "CALIBRATED" | "FAILED" = "NOT RUN";
  private latestReadout: MonitorReadout | null = null;
  private readonly browserJobs: BrowserExportJob[] = [];
  private readonly observedExportableEpisodes = new Set<string>();
  private readonly recordedQualityEpisodeIds = new Set<string>();
  private readonly pendingRecordingQualityEpisodes = new Map<string, Episode["qualitySummary"]>();
  private recordingQualityDelivery: Promise<void> | null = null;
  private readonly automaticUploadQueue = new Set<string>();
  private exportableEpisodesInitialised = false;
  private cameraOverlayObserver: ResizeObserver | null = null;
  private videoFrameCallback: number | null = null;
  private mountedRoot: HTMLElement | null = null;
  private directorKeydown: ((event: KeyboardEvent) => void) | null = null;
  private disposeAccountIdentity: (() => void) | null = null;
  private disposeSiteHeader: (() => void) | null = null;
  private disposeTurnFields: (() => void) | null = null;
  private readonly overlayReturnFocus = new Map<string, HTMLElement>();
  private readonly overlayBackgroundState = new Map<string, Array<[HTMLElement, boolean]>>();
  private readonly overlayStack: string[] = [];
  private disposed = false;

  mount(root: HTMLElement) {
    const shell = applicationServices();
    const fallbackRuntimeFeatures: RuntimeFeatures = {
      speech: shell.speech !== false,
      relayedConnection: Boolean(shell.turn),
    };
    this.runtimeFeatures = fallbackRuntimeFeatures;
    this.mountedRoot = root;
    root.dataset.episodeReviewMode = this.episodeReviewMode;
    this.storeConnectionPreference();
    root.innerHTML = `
      <div class="studio-shell">
        ${applicationHeaderMarkup("director", "monitor-account")}
        <section class="studio-topbar" aria-label="Capture director command bar">
          <section class="studio-run-centre" aria-label="Run and recording controls"><div id="top-run-controls" class="top-run-controls"></div></section>
          <div class="studio-timing"><div class="timing-metrics"><span>LEFT <b id="top-task-remaining">--:--.-</b></span><span>SESS <b id="top-session-elapsed">00:00.0</b></span><span>TAKE <b id="top-task-elapsed">00:00.0</b></span></div><div class="timing-clocks"><span>UTC <b id="top-utc">--:--:--</b></span><span>LOCT <b id="top-local-time">--:--:--</b></span></div></div>
        </section>
        <main class="studio-grid">
          <aside class="studio-pane stream-pane">
            <div class="pane-header session-pane-header"><span>SESSION</span><button id="restart-session" class="pane-action restart-session" type="button" aria-label="Hold for one second to restart the session">RESTART</button></div>
            <div class="recording-card">
              <div class="recording-card-copy"><div class="recording-card-title"><span><span class="signal-dot" id="capture-link-dot"></span><b id="capture-link">NO DEVICE</b></span></div><span id="capture-link-detail"></span></div>
              <img id="capture-headset-icon" class="capture-headset-icon" src="/assets/quest-3.svg" alt="Meta Quest 3" hidden>
            </div>
            <details class="tree-section stream-section setup-details" open><summary><span class="tree-title">STREAMS</span></summary><ul class="stream-tree" id="stream-tree"></ul></details>
            <div class="tree-section"><span class="tree-title">ACTIVITY</span><ol class="activity-list" id="activity-log" role="log" aria-label="Director activity" aria-live="polite"></ol></div>
            <section class="tree-section episode-history sidebar-episode-history"><span class="tree-title">EPS</span><ul id="episode-log" class="episode-log"></ul></section>
          </aside>
          <section class="studio-centre">
            <div class="view-grid">
              <section class="view-panel camera-panel">
                <div class="view-header"><span>CAM</span><span class="composite-view-controls"><span class="hand-mode-controls" aria-label="Hand visual controls"><button type="button" data-hand-control="render">OUTLINE</button><button type="button" data-hand-control="shading">SIDE</button><button type="button" data-hand-control="trail">OFF</button></span><span class="view-header-actions"><span id="video-transport">RTC OFF</span><button id="refresh-feed" class="pane-action">SYNC</button></span></span></div>
                <div class="camera-viewport">
                  <video id="live-video" autoplay playsinline muted></video>
                  <canvas id="pose-canvas" width="1280" height="720" aria-label="Hand tracking overlay"></canvas>
                  <div id="hand-projection-status" class="hand-projection-status is-unregistered" role="status">POSE UNREGISTERED</div>
                  <div id="left-hand-energy" class="hand-energy hand-energy-left is-idle" role="meter" aria-label="Left hand motion speed" aria-valuemin="0" aria-valuemax="3" aria-valuenow="0"><span class="hand-energy-marker"><b>L 0.00</b></span></div>
                  <div id="right-hand-energy" class="hand-energy hand-energy-right is-idle" role="meter" aria-label="Right hand motion speed" aria-valuemin="0" aria-valuemax="3" aria-valuenow="0"><span class="hand-energy-marker"><b>R 0.00</b></span></div>
                  <div id="video-empty" class="view-empty telemetry-empty video-empty"><span>NO VIDEO</span><small>CONNECT HEADSET / START XR</small></div>
                </div>
              </section>
            </div>
            <section class="time-panel">
              <div class="view-header signal-header"><span id="signal-source-label">SIGNALS</span><div class="signal-toggles" aria-label="Signal channels"><button type="button" data-signal="hxyz" class="is-active" aria-pressed="true">HXYZ</button><button type="button" data-signal="hrot" class="is-active" aria-pressed="true">HROT</button><button type="button" data-signal="lpos" class="is-active" aria-pressed="true">LPOS</button><button type="button" data-signal="lrot" class="is-active" aria-pressed="true">LROT</button><button type="button" data-signal="lp" class="is-active" aria-pressed="true">LP</button><button type="button" data-signal="rpos" class="is-active" aria-pressed="true">RPOS</button><button type="button" data-signal="rrot" class="is-active" aria-pressed="true">RROT</button><button type="button" data-signal="rp" class="is-active" aria-pressed="true">RP</button></div></div>
              <canvas id="signal-canvas" width="1400" height="170" aria-label="Sensor latency and pinch distance traces"></canvas>
              <div id="signal-empty" class="view-empty telemetry-empty signal-empty"><span>NO SENSOR FRAMES</span><small id="signal-empty-detail">CONNECT HEADSET / START XR</small></div>
              <div class="audio-spectrum-strip"><span class="audio-spectrum-label">AUDIO</span><canvas id="audio-spectrum-canvas" width="1400" height="56" aria-label="Live audio spectrum history"></canvas><span id="audio-spectrum-empty" class="audio-spectrum-empty">NO AUDIO</span></div>
              <div class="timeline-bar"><span class="timeline-origin">LIVE</span><div class="timeline-track"><i id="timeline-playhead"></i></div><span id="timeline-count">0 F</span></div>
            </section>
          </section>
          <aside class="studio-pane inspector-pane">
            <nav class="pane-header sidebar-selector" aria-label="Director sidebar">
              <button type="button" role="tab" data-sidebar-tab="connect" aria-controls="sidebar-connect" aria-selected="true">CONNECT</button>
              <button type="button" role="tab" data-sidebar-tab="run" aria-controls="sidebar-run" aria-selected="false">RUN</button>
              <button type="button" role="tab" data-sidebar-tab="export" aria-controls="sidebar-export" aria-selected="false">EXPORT</button>
              <button type="button" role="tab" data-sidebar-tab="settings" aria-controls="sidebar-settings" aria-selected="false">SETTINGS</button>
            </nav>
            <section id="sidebar-connect" class="sidebar-panel connection-inspector setup-details" role="tabpanel" data-sidebar-panel="connect">
              <div class="connection-method-control">
                <input hidden type="radio" name="connection-mode" value="local"${this.connectionProfile.mode === "local" ? " checked" : ""}>
                <input hidden type="radio" name="connection-mode" value="direct"${this.connectionProfile.mode === "direct" ? " checked" : ""}>
                <input hidden type="radio" name="connection-mode" value="relayed"${this.connectionProfile.mode === "relayed" ? " checked" : ""}>
                <label for="connection-method-selector">CONNECTION</label>
                <select id="connection-method-selector" aria-label="Connection method">
                  <option value="local"${this.connectionPanel === "local" ? " selected" : ""}>LOCAL</option>
                  <option value="direct"${this.connectionPanel === "direct" ? " selected" : ""}>DIRECT</option>
                  ${shell.invitations ? `<option value="invite"${this.connectionPanel === "invite" ? " selected" : ""}>INVITE</option>` : ""}
                  <option value="relay" disabled>RELAY - UNAVAILABLE</option>
                </select>
              </div>
              <label id="connection-server-field" hidden>SERVER<input id="connection-server" type="url" value="${escapeHtml(this.connectionProfile.relayUrl ?? "")}" placeholder="https://ceres.ceres-relay.workers.dev" autocomplete="url"></label>
${applicationServices().turn?.fields(this.sessionId) ?? ""}
            </section>
            <section id="sidebar-run" class="sidebar-panel run-panel" role="tabpanel" data-sidebar-panel="run" hidden>
              <header class="run-overview">
                <div><h2 id="run-display-title">${escapeHtml(defaultConfiguration.runTitle)}</h2><p id="run-display-description">${escapeHtml(defaultConfiguration.runDescription)}</p></div>
                <div class="run-overview-actions"><span id="configuration-state" role="status" aria-live="polite" hidden>SENT R1</span><button id="load-draft" class="toolbar-button" type="button">EDIT</button></div>
              </header>
              <div id="run-editor-home-slot" hidden><div id="run-editor-home"></div></div>
              <section class="inspector-section active-task-section run-transport-section"><div class="active-task-heading"><span id="inspector-task-id" class="inspector-task-id">NO TASK</span></div><p id="inspector-task-description" class="active-task-description">Open task</p></section>
              <section class="inspector-section setup-details beam-control run-transport-section"><div class="section-label">MESSAGE DEMONSTRATOR</div><div class="beam-entry"><input id="beam-text" type="text" autocomplete="off" placeholder="Message to demonstrator"><button id="beam-send" type="button" aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></button></div><div class="beam-options"><label data-speech-feature><input id="beam-tts" type="checkbox" checked>VOICE</label></div></section>
            </section>
            <section id="sidebar-export" class="sidebar-panel inspector-section setup-details export-inspector" role="tabpanel" data-sidebar-panel="export" hidden><div id="hf-account-state" class="import-source-status">CHECKING HUGGING FACE ACCOUNT</div><a id="hf-account-action" class="toolbar-button" href="/account">MANAGE ACCOUNT EXPORT</a><div class="export-field"><span class="export-field-label">HF REPO</span><div class="repository-entry"><select id="hf-organisation" aria-label="Hugging Face organisation" disabled><option value="">SELECT ORG</option></select><span>/</span><input id="hf-repository" list="hf-repository-options" aria-label="Hugging Face repository name" placeholder="capture-datetime-task" autocomplete="off"><datalist id="hf-repository-options"></datalist><button id="hf-private" class="repository-private-toggle" type="button" aria-pressed="true" aria-label="Private repository enabled" title="Private repository"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10"/><path class="private-lock-closed" d="M8 10V7a4 4 0 0 1 8 0v3"/><path class="private-lock-open" d="M16 10V7a4 4 0 0 0-7.6-1.7"/></svg></button></div></div><div class="export-upload-options"><label>BRANCH<input id="hf-branch" value="main" autocomplete="off"></label></div><div class="beam-options export-upload-option"><label><input id="hf-after-episode" type="checkbox">UPLOAD AFTER EACH EPISODE</label></div><div class="delivery-actions"><button id="export-data" class="toolbar-button" type="button" disabled>OPFS</button><button id="export-folder" class="toolbar-button" type="button" disabled>FOLDER</button><button id="upload-data" class="toolbar-button toolbar-primary" type="button" disabled>HF SYNC</button><button id="cancel-export" class="toolbar-button" type="button" disabled>CANCEL</button></div><progress id="export-progress" max="1" value="0" hidden></progress><ul id="job-log" class="job-log" aria-live="polite"></ul></section>
            <section id="sidebar-settings" class="sidebar-panel settings-inspector" role="tabpanel" data-sidebar-panel="settings" hidden>
              <section class="inspector-section setup-details"><div class="section-label">DIRECTOR</div><div class="settings-grid"><label class="setting-toggle"><span>Cue sounds</span><input id="setting-cue-sounds" type="checkbox" role="switch"><b aria-hidden="true"></b></label><label class="setting-toggle" data-speech-feature><span>Voice cues</span><input id="setting-voice-cues" type="checkbox" role="switch"><b aria-hidden="true"></b></label><label data-speech-feature><span>TTS provider</span><select id="setting-tts-provider"><option value="browser">Browser</option></select></label><label data-speech-feature><span>STT provider</span><select id="setting-stt-provider"><option value="gateway">ASR gateway</option></select></label></div></section>
              <section class="inspector-section setup-details camera-inspector"><div class="section-label">CAMERA CALIBRATION</div><div class="camera-device-summary"><div><b id="camera-device-name">NO CAMERA</b><span id="camera-resolution">-- x --</span></div></div><dl class="camera-calibration-grid"><div><dt>STATE</dt><dd id="camera-calibration-state">NOT RUN</dd></div><div><dt>ALIGN</dt><dd id="camera-alignment-state">UNREGISTERED</dd></div><div><dt>SAMPLES</dt><dd id="camera-calibration-samples">0/${calibrationFrameTarget}</dd></div><div><dt>MODEL</dt><dd>PINHOLE</dd></div><div><dt>FPS</dt><dd id="camera-frame-rate">--</dd></div><div><dt>FX / FY</dt><dd id="camera-intrinsics-focal">-- / --</dd></div><div><dt>CX / CY</dt><dd id="camera-intrinsics-centre">-- / --</dd></div><div><dt>DIST</dt><dd id="camera-intrinsics-distortion">--</dd></div><div><dt>RMS</dt><dd id="camera-intrinsics-rms">-- PX</dd></div><div><dt>L WRIST</dt><dd id="left-wrist-pose">NO POSE</dd></div><div><dt>R WRIST</dt><dd id="right-wrist-pose">NO POSE</dd></div><div class="camera-calibration-action"><dt>CALIBRATE</dt><dd><button id="calibrate-camera" class="toolbar-button calibration-action-chip" type="button" disabled>CAL</button></dd></div></dl></section>
            </section>
          </aside>
        </main>
        <footer class="monitor-status-bar">
          <section id="capture-health-summary" class="capture-health-summary is-stop" tabindex="0" aria-describedby="capture-health-detail"><span>STATUS:</span><b>STOP</b><aside id="capture-health-detail" class="status-detail-popover" role="tooltip"><small>Waiting for capture state</small></aside></section>
          <dl id="capture-health"></dl>
          <section class="status-version" aria-label="CERES ${escapeHtml(__CERES_BUILD_IDENTITY__.channel)} build"><span>VER</span><b${__CERES_BUILD_IDENTITY__.channel === "release" ? "" : ` title="Build ${escapeHtml(__CERES_BUILD_IDENTITY__.commit ?? "")}"`}>v${escapeHtml(__CERES_BUILD_IDENTITY__.display)}</b><a class="status-report" href="https://github.com/hcltech-robotics/ceres/issues/new?labels=bug" target="_blank" rel="noopener noreferrer" aria-label="Report a bug" title="Report a bug"><i data-lucide="bug" aria-hidden="true"></i></a><button id="director-shortcuts" class="status-report status-shortcuts" type="button" aria-label="Keyboard shortcuts" aria-keyshortcuts="?" title="Keyboard shortcuts (?)"><i data-lucide="keyboard" aria-hidden="true"></i></button></section>
          <section class="status-link"><span>LINK</span><b id="connection-state">WAIT</b></section>
          <section id="asr-state" class="status-service is-muted" data-state="checking" title="Checking the ASR gateway" data-speech-feature><span>ASR</span><b>WAIT</b></section>
          <button id="audio-toggle" class="status-audio" type="button" aria-pressed="false"><span>AUDIO</span><b>WAIT</b></button>
          <a class="status-github" href="https://github.com/hcltech-robotics/ceres" target="_blank" rel="noopener noreferrer" aria-label="View CERES source on GitHub" title="View CERES source on GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.89c-2.78.6-3.37-1.18-3.37-1.18-.45-1.17-1.11-1.48-1.11-1.48-.91-.63.07-.62.07-.62 1 .08 1.53 1.04 1.53 1.04.9 1.54 2.35 1.09 2.92.83.09-.66.35-1.1.64-1.35-2.22-.26-4.56-1.12-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.26-.45-1.29.1-2.65 0 0 .84-.27 2.75 1.03A9.45 9.45 0 0 1 12 6.76c.85 0 1.71.12 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.36.2 2.39.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.86v2.8c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg><span>GITHUB</span></a>
        </footer>
        <section id="job-error-modal" class="job-error-modal" role="alertdialog" aria-modal="true" aria-labelledby="job-error-title" hidden><div class="job-error-card"><div><span class="inspector-label">EXPORT ERROR</span><h2 id="job-error-title">Export failed</h2></div><p id="job-error-message"></p><button id="job-error-close" class="toolbar-button" type="button">CLOSE</button></div></section>
        <section id="calibration-modal" class="job-error-modal" role="dialog" aria-modal="true" aria-labelledby="calibration-title" hidden><div class="job-error-card calibration-card"><div><span class="inspector-label">CAMERA CALIBRATION</span><h2 id="calibration-title">Checkerboard</h2></div><canvas id="charuco-board" width="720" height="480" aria-label="Camera calibration checkerboard"></canvas><p id="calibration-status">Move and tilt the complete board through the centre and edges at near, middle and far working distances.</p><div class="calibration-actions"><button id="calibration-close" class="toolbar-button" type="button">CLOSE</button></div></div></section>
        <dialog id="director-shortcut-modal" class="director-shortcut-modal" aria-labelledby="director-shortcut-title"><form method="dialog" class="director-shortcut-dialog"><header><div><span class="inspector-label">CAPTURE DIRECTOR</span><h2 id="director-shortcut-title">Keyboard shortcuts</h2></div><button id="director-shortcut-close" class="toolbar-button" type="submit">CLOSE</button></header><p>Use these controls when focus is outside text entry. Pass and Fail annotate the segment. They do not gate Advance.</p><div class="director-keyboard-map" aria-label="Keyboard shortcut map"><div><kbd class="director-key-assigned">Esc<span>Close overlay</span></kbd><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd><kbd>5</kbd><kbd>6</kbd><kbd>7</kbd><kbd>8</kbd><kbd>9</kbd><kbd>0</kbd><kbd>-</kbd><kbd>=</kbd><kbd class="director-key-wide">Backspace</kbd></div><div><kbd class="director-key-tab">Tab</kbd><kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd class="director-key-assigned">R<span>Retry task</span></kbd><kbd>T</kbd><kbd>Y</kbd><kbd>U</kbd><kbd>I</kbd><kbd>O</kbd><kbd class="director-key-assigned">P<span>Pass annotation</span></kbd><kbd>[</kbd><kbd>]</kbd><kbd class="director-key-wide">Enter</kbd></div><div><kbd class="director-key-caps">Caps</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><kbd class="director-key-assigned">F<span>Fail annotation</span></kbd><kbd>G</kbd><kbd>H</kbd><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd><kbd>;</kbd><kbd>'</kbd><kbd class="director-key-wide">Enter</kbd></div><div><kbd class="director-key-shift">Shift</kbd><kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd><kbd>B</kbd><kbd class="director-key-assigned">N<span>Advance</span></kbd><kbd>M</kbd><kbd>,</kbd><kbd>.</kbd><kbd class="director-key-assigned">/?<span>Keyboard shortcuts</span></kbd><kbd class="director-key-shift">Shift</kbd></div><div><kbd class="director-key-control">Ctrl</kbd><kbd>Alt</kbd><kbd class="director-key-space director-key-assigned">Space<span>Readiness latch</span></kbd><kbd>Alt</kbd><kbd class="director-key-control">Ctrl</kbd></div></div></form></dialog>
        <div id="task-editor-mount"></div>
      </div>
    `;
    createIcons({
      icons: { Bug, Keyboard },
      root,
    });
    this.runEditor = new RunEditor({
      root: root.querySelector<HTMLElement>("#run-editor-home")!,
      configuration: defaultConfiguration,
      onConfigurationChange: () => {
        this.markConfigurationDraft(root);
        this.syncDraftTaskDisplay(root);
      },
      onSave: () => this.saveDraft(root),
      onActivity: (message) => this.showActivity(root, message.toUpperCase(), "system"),
    });
    this.runEditor.mount();
    this.mountDirectorShortcutDialog(root);
    this.mountPairingInvitationSurface(root);
    const storedConfiguration = loadMonitorRunConfiguration(this.sessionId);
    if (storedConfiguration) {
      this.directSession.configure(storedConfiguration);
      this.hydrateConfigurationDraft(root, storedConfiguration, this.directSession.snapshot.configurationStatus.revision);
    }
    this.syncDirectorAvailability(root, false);
    this.startTiming(root);
    this.wireUi(root);
    const disposeHeader = mountApplicationHeader(root);
    const disposeTurn = applicationServices().turn?.mount(root, this.sessionId);
    this.disposeSiteHeader = () => { disposeHeader(); disposeTurn?.(); };
    this.disposeAccountIdentity = mountUserIdentity(root.querySelector<HTMLElement>("#monitor-account")!, {
      ...shell,
      onStateChange: (state) => this.handleUserIdentityState(root, state),
    });
    this.wireSession(root);
    this.exporter.onEvent((event) => this.handleExportEvent(root, event));
    void this.refreshAccountExportSession(root);
    this.session.connect(
      root.querySelector<HTMLCanvasElement>("#pose-canvas")!,
      root.querySelector<HTMLCanvasElement>("#signal-canvas")!,
    );
    this.wireCameraOverlay(root);
    this.syncVisualSettings();
    this.renderHandControls(root);
    if (isPeerConnectionMode(this.connectionProfile)) {
      this.directSession.setRuntimeFeatures(this.runtimeFeatures);
      this.runtimeFeaturesReady = this.initialiseRuntimeFeatures(root, fallbackRuntimeFeatures);
      this.monitorRecorder.open(this.sessionId);
      this.renderSnapshot(root, this.directSession.snapshot);
      this.renderAsrStatus(root, "unavailable");
    }
    if (this.monitorRecorderFailure.current) this.showActivity(root, this.monitorRecorderFailure.current.toUpperCase(), "error");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeAccountIdentity?.();
    this.disposeAccountIdentity = null;
    this.disposeSiteHeader?.();
    this.disposeSiteHeader = null;
    this.socketConnected = false;
    this.updateLiveSessionMarker(false);
    const root = this.mountedRoot;
    this.mountedRoot = null;
    if (this.directorKeydown) window.removeEventListener("keydown", this.directorKeydown);
    this.directorKeydown = null;
    if (this.timingTimer !== null) window.clearInterval(this.timingTimer);
    this.timingTimer = null;
    if (this.restartHoldTimer !== null) window.clearTimeout(this.restartHoldTimer);
    this.restartHoldTimer = null;
    this.runtimeFeatureRecovery.reset(window);
    if (this.pendingSessionReset) {
      window.clearTimeout(this.pendingSessionReset.timeoutId);
      this.pendingSessionReset.reject(new Error("Reset cancelled"));
      this.pendingSessionReset = null;
    }
    this.clearOfferRequestRetry();
    this.clearTurnFallbackWatchdog();
    this.stopCalibrationCapture();
    this.cameraOverlayObserver?.disconnect();
    this.cameraOverlayObserver = null;
    this.revokePeerTelemetryAuthority();
    if (root) this.resetVideoPeer(root);
    else {
      this.clearPendingBeamDeliveries(null);
      this.peer?.close();
    }
    this.peer = null;
    this.pendingIceCandidates.clear();
    this.remoteDescriptionReadyPeers.clear();
    this.peerControlChannel = null;
    this.peerRecorderAssembler.reset();
    this.overlayReturnFocus.clear();
    this.overlayBackgroundState.clear();
    this.overlayStack.length = 0;
    this.taskImportWorkspace?.dispose();
    this.taskImportWorkspace = null;
    this.runEditor?.dispose();
    this.runEditor = null;
    this.automaticUploadQueue.clear();
    this.accountUploadAbort?.abort();
    this.accountUploadAbort = null;
    this.repositoryCatalogueAbort?.abort();
    this.repositoryCatalogueAbort = null;
    if (this.repositoryCatalogueTimer !== null) window.clearTimeout(this.repositoryCatalogueTimer);
    this.repositoryCatalogueTimer = null;
    this.backendUploadOptions.clear();
    this.backendUploadCompletions.clear();
    for (const controller of this.backendUploadRecoveryControllers.values()) controller.abort();
    this.backendUploadRecoveryControllers.clear();
    for (const timer of this.backendUploadRecoveryTimers.values()) window.clearTimeout(timer);
    this.backendUploadRecoveryTimers.clear();
    this.episodeReplayController?.abort();
    this.episodeReplayController = null;
    this.releaseEpisodeVideo();
    this.session.close();
    this.webRtcSignal?.dispose();
    this.monitorRecorder.close();
    this.exporter.close();
    root?.replaceChildren();
  }

  private wireUi(root: HTMLElement) {
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const control = target.closest<HTMLButtonElement>("[data-control]");
      const action = control?.dataset.control as "start-sequence" | "start" | "pause" | "stop" | "finish" | "success" | "fail" | "retry" | "resume" | "next" | "instructions" | undefined;
      if (action) this.handleRunControl(root, action, "director", control?.dataset.nextCursor);
    });
    root.querySelectorAll<HTMLButtonElement>("[data-sidebar-tab]").forEach((button) => button.addEventListener("click", () => {
      this.selectSidebarPanel(root, button.dataset.sidebarTab as "connect" | "run" | "export" | "settings");
    }));
    root.querySelectorAll<HTMLInputElement>('input[name="connection-mode"]').forEach((input) => input.addEventListener("change", () => {
      this.syncConnectionControls(root);
      this.commitConnectionSettings(root);
    }));
    root.querySelector<HTMLSelectElement>("#connection-method-selector")!.addEventListener("change", (event) => {
      void this.activateConnectionAction(
        root,
        (event.currentTarget as HTMLSelectElement).value as "local" | "direct" | "invite" | "relay",
      );
    });
    root.querySelectorAll<HTMLButtonElement>("[data-roll-pairing-invitation]").forEach((button) => button.addEventListener("click", () => {
      void this.renewPairingInvitation(root);
    }));
    this.wireRestartControl(root);
    root.querySelector<HTMLInputElement>("#connection-server")!.addEventListener("change", () => this.commitConnectionSettings(root));
    [
      "setting-cue-sounds", "setting-voice-cues", "setting-tts-provider", "setting-stt-provider",
      "hf-after-episode",
    ].forEach((id) => root.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener("input", () => this.markConfigurationDraft(root)));
    root.querySelector<HTMLSelectElement>("#hf-organisation")!.addEventListener("change", () => {
      this.markConfigurationDraft(root);
      this.scheduleRepositoryCatalogue(root);
    });
    root.querySelector<HTMLInputElement>("#hf-repository")!.addEventListener("input", () => {
      this.markConfigurationDraft(root);
      this.scheduleRepositoryCatalogue(root);
    });
    root.querySelector("#hf-private")!.addEventListener("click", () => {
      const button = root.querySelector<HTMLButtonElement>("#hf-private")!;
      this.setRepositoryPrivacy(root, button.getAttribute("aria-pressed") !== "true");
      this.markConfigurationDraft(root);
    });
    root.querySelector("#load-draft")!.addEventListener("click", () => void this.openTaskEditor(root));
    root.querySelector("#export-data")!.addEventListener("click", () => this.startBrowserExport(root));
    root.querySelector("#export-folder")!.addEventListener("click", () => void this.startFolderExport(root));
    root.querySelector("#upload-data")!.addEventListener("click", () => void this.startBrowserUpload(root));
    root.querySelector("#cancel-export")!.addEventListener("click", () => {
      this.exporter.cancel();
      this.accountUploadAbort?.abort();
    });
    root.querySelector("#episode-log")!.addEventListener("click", (event) => {
      const deleteButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-delete-episode-id]");
      if (deleteButton) {
        event.stopPropagation();
        void this.deleteEpisode(root, deleteButton.dataset.deleteEpisodeId!);
        return;
      }
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-episode-id]");
      if (button) void this.toggleEpisodeSelection(root, button.dataset.episodeId!);
    });
    root.querySelector("#refresh-feed")!.addEventListener("click", () => this.requestFeed(true));
    root.querySelector("#audio-toggle")!.addEventListener("click", () => this.toggleAudio(root));
    root.querySelector("#job-error-close")!.addEventListener("click", () => this.hideJobError(root));
    root.querySelector("#job-error-modal")!.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) this.hideJobError(root);
    });
    root.querySelector("#calibrate-camera")!.addEventListener("click", () => this.openCalibration(root));
    root.querySelector("#calibration-close")!.addEventListener("click", () => this.closeCalibration(root));
    root.querySelector("#beam-send")!.addEventListener("click", () => this.sendBeam(root));
    root.querySelector<HTMLInputElement>("#beam-text")!.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.sendBeam(root);
    });
    root.querySelectorAll<HTMLButtonElement>(".signal-toggles button").forEach((button) => button.addEventListener("click", () => {
      const channel = button.dataset.signal!;
      if (this.activeSignals.has(channel)) this.activeSignals.delete(channel);
      else this.activeSignals.add(channel);
      const active = this.activeSignals.has(channel);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      this.syncVisualSettings();
    }));
    root.querySelectorAll<HTMLButtonElement>(".hand-mode-controls button").forEach((button) => button.addEventListener("click", () => {
      if (!this.controlTransportConnected()) {
        this.showActivity(root, "CONNECT THE DEMONSTRATOR TO CHANGE HAND VISUALS", "error");
        return;
      }
      if (button.dataset.handControl === "render") this.handMode = nextMode(handRenderModes, this.handMode);
      if (button.dataset.handControl === "shading") this.handShading = nextMode(handShadingModes, this.handShading);
      if (button.dataset.handControl === "trail") this.handTrail = nextMode(handTrailModes, this.handTrail);
      this.renderHandControls(root);
      this.syncVisualSettings();
      this.setHandDisplay(root, this.handDisplaySettings());
    }));
    this.directorKeydown = (event) => {
      const overlayId = this.overlayStack.at(-1);
      if (overlayId) {
        if (event.key === "Tab") {
          this.containOverlayFocus(root, overlayId, event);
          return;
        }
        if (event.key !== "Escape") return;
        if (overlayId === "job-error-modal") this.hideJobError(root);
        else if (overlayId === "calibration-modal") this.closeCalibration(root);
        else if (overlayId === "pairing-qr-overlay") this.closePairingQr(root);
        else if (overlayId === "task-editor-modal") this.taskImportWorkspace?.requestClose();
        event.preventDefault();
        return;
      }
      this.handleDirectorShortcut(root, event);
    };
    window.addEventListener("keydown", this.directorKeydown);
    this.selectSidebarPanel(root, "connect");
    this.syncConnectionControls(root);
  }

  private selectSidebarPanel(root: HTMLElement, panel: "connect" | "run" | "export" | "settings") {
    root.querySelectorAll<HTMLButtonElement>("[data-sidebar-tab]").forEach((button) => {
      const selected = button.dataset.sidebarTab === panel;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    root.querySelectorAll<HTMLElement>("[data-sidebar-panel]").forEach((section) => {
      section.hidden = section.dataset.sidebarPanel !== panel;
    });
  }

  private handleDirectorShortcut(root: HTMLElement, event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (shortcutTypingTarget(event.target)) return;
    const shortcutDialog = root.querySelector<HTMLDialogElement>("#director-shortcut-modal")!;
    if (event.key === "Escape" && shortcutDialog.open) {
      shortcutDialog.close();
      event.preventDefault();
      return;
    }
    if (event.key === "?") {
      if (shortcutDialog.open) shortcutDialog.close();
      else shortcutDialog.showModal();
      event.preventDefault();
      return;
    }
    const slot = directorShortcutSlot(event.key);
    if (!slot) return;
    if (slot === "run"
      && event.target instanceof Element
      && event.target.closest("button, a, summary, [role='button']")) return;
    const button = root.querySelector<HTMLButtonElement>(`#top-run-controls button[data-slot="${slot}"]`);
    if (!button || button.disabled) return;
    if (slot === "run" && button.dataset.control !== "start-sequence") return;
    event.preventDefault();
    button.click();
  }

  private mountDirectorShortcutDialog(root: HTMLElement) {
    const launcher = root.querySelector<HTMLButtonElement>("#director-shortcuts")!;
    const dialog = root.querySelector<HTMLDialogElement>("#director-shortcut-modal")!;
    launcher.addEventListener("click", () => dialog.showModal());
    dialog.addEventListener("close", () => launcher.focus());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  private controlTransportConnected() {
    return isPeerConnectionMode(this.connectionProfile)
      ? this.peerControlChannel?.readyState === "open"
      : this.socketConnected;
  }

  private selectedConnectionMode(root: HTMLElement): ConnectionMode {
    const selected = root.querySelector<HTMLInputElement>('input[name="connection-mode"]:checked')?.value;
    return selected === "direct" || selected === "relayed" ? selected : "local";
  }

  private wireRestartControl(root: HTMLElement) {
    const button = root.querySelector<HTMLButtonElement>("#restart-session")!;
    const cancel = () => {
      if (this.restartHoldTimer !== null) window.clearTimeout(this.restartHoldTimer);
      this.restartHoldTimer = null;
      if (!this.restartInProgress) button.classList.remove("is-holding");
    };
    const start = () => {
      if (this.restartInProgress || this.restartHoldTimer !== null) return;
      button.classList.add("is-holding");
      this.restartHoldTimer = window.setTimeout(() => {
        this.restartHoldTimer = null;
        void this.restartSession(root);
      }, 1_000);
    };
    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", cancel);
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("pointerleave", cancel);
    button.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      start();
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") cancel();
    });
    button.addEventListener("blur", cancel);
  }

  private async restartSession(root: HTMLElement) {
    if (this.restartInProgress) return;
    const button = root.querySelector<HTMLButtonElement>("#restart-session")!;
    const run = this.snapshot?.run;
    if (run && (run.status === "running" || run.recordingState !== "idle")) {
      button.classList.remove("is-holding");
      this.showActivity(root, "STOP THE RUN BEFORE RESTARTING THE SESSION", "error");
      return;
    }
    this.restartInProgress = true;
    button.classList.remove("is-holding");
    button.classList.add("is-restarting");
    button.disabled = true;
    const configuration = this.readDraftConfiguration(root);
    const nextSessionId = createSessionId();
    this.showActivity(root, "RESTARTING SESSION", "system");
    try {
      await this.requestSessionReset();
    } catch (error) {
      this.restartInProgress = false;
      button.classList.remove("is-restarting");
      button.disabled = false;
      this.showError(root, error, "RESTART FAILED");
      return;
    }
    this.resetVideoPeer(root);
    this.resetPairingInvitation(root, "RESTARTING", false);
    this.webRtcSignal?.dispose();
    this.webRtcSignal = null;
    this.session.close();
    await this.monitorRecorder.close().catch(() => undefined);
    clearMonitorSessionPersistence(this.sessionId);
    await deleteMonitorSessionRecordings(this.sessionId).catch(() => undefined);
    storeMonitorRunConfiguration(nextSessionId, configuration);
    const nextUrl = new URL("/monitor/", location.origin);
    nextUrl.searchParams.set("session", nextSessionId);
    location.assign(nextUrl);
  }

  private requestSessionReset() {
    if (!this.controlTransportConnected() || !this.snapshot?.captureConnected) return Promise.resolve();
    const resetId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (this.pendingSessionReset?.resetId !== resetId) return;
        this.pendingSessionReset = null;
        reject(new Error("No demonstrator reset acknowledgement"));
      }, 3_000);
      this.pendingSessionReset = { resetId, timeoutId, resolve, reject };
      if (isPeerConnectionMode(this.connectionProfile)) {
        const channel = this.peerControlChannel;
        if (!channel || channel.readyState !== "open") {
          window.clearTimeout(timeoutId);
          this.pendingSessionReset = null;
          reject(new Error("Demonstrator control channel disconnected"));
          return;
        }
        channel.send(JSON.stringify({ type: "restart-session", resetId }));
      } else {
        this.session.restartSession(resetId);
      }
    });
  }

  private acknowledgeSessionReset(resetId: string) {
    const pending = this.pendingSessionReset;
    if (!pending || pending.resetId !== resetId) return;
    window.clearTimeout(pending.timeoutId);
    this.pendingSessionReset = null;
    pending.resolve();
  }

  private async activateConnectionAction(
    root: HTMLElement,
    action: "local" | "direct" | "invite" | "relay",
  ) {
    if (action === "relay") return;
    const mode: ConnectionMode = action === "local" ? "local" : "direct";
    this.connectionPanel = action;
    const input = root.querySelector<HTMLInputElement>(`input[name="connection-mode"][value="${mode}"]`)!;
    input.checked = true;
    this.syncConnectionControls(root);
    this.commitConnectionSettings(root);
    this.connectionPanel = action;
    this.storeConnectionPreference();
    await this.createPairingInvitation(root);
    this.syncConnectionControls(root);
    if (action === "invite") root.querySelector<HTMLInputElement>("#account-pairing-email")?.focus();
  }

  private handleUserIdentityState(root: HTMLElement, state: UserIdentityState) {
    this.accountSignedIn = state.status === "signed-in";
    this.syncRemoteActionAvailability(root);
    if (state.status !== "loading") void this.refreshAccountExportSession(root);
    if (state.status !== "loading" && this.monitorRecorderReady) void this.ensurePairingInvitation(root);
  }

  private async refreshAccountExportSession(root: HTMLElement) {
    const status = root.querySelector<HTMLElement>("#hf-account-state");
    const action = root.querySelector<HTMLAnchorElement>("#hf-account-action");
    if (!status || !action) return;
    if (!exportDestinationService()) {
      this.accountExportSession = null;
      status.textContent = "LOCAL EXPORT";
      action.hidden = true;
      root.querySelectorAll<HTMLElement>("#sidebar-export .export-field, #sidebar-export .export-upload-options, #sidebar-export .export-upload-option, #upload-data")
        .forEach(element => { element.hidden = true; });
      this.updateExportControls(root);
      return;
    }
    try {
      const session = await this.accountExportClient.session();
      if (this.disposed || this.mountedRoot !== root) return;
      this.accountExportSession = session;
      if (session.huggingFace.state === "ready") {
        status.textContent = `HUGGING FACE CONNECTED / ${session.huggingFace.username ?? "ACCOUNT"}`;
        status.className = "import-source-status is-success";
        action.textContent = "MANAGE ACCOUNT EXPORT";
        root.querySelector<HTMLSelectElement>("#hf-organisation")!.disabled = false;
        root.querySelector<HTMLInputElement>("#hf-repository")!.placeholder = `${session.defaults.repositoryPrefix || "ceres-"}capture`;
        this.setRepositoryPrivacy(root, session.defaults.visibility === "private");
        root.querySelector<HTMLButtonElement>("#hf-private")!.disabled = true;
        void this.refreshRepositoryCatalogue(root, session.defaults.organisation);
      } else if (session.huggingFace.state === "reauthentication_required") {
        status.textContent = "HUGGING FACE REAUTHENTICATION REQUIRED";
        status.className = "import-source-status is-error";
        action.textContent = "REAUTHENTICATE IN ACCOUNT";
      } else {
        status.textContent = session.signedIn ? "HUGGING FACE NOT CONNECTED" : "CERES SIGN-IN REQUIRED";
        status.className = "import-source-status";
        action.textContent = session.signedIn ? "CONNECT IN ACCOUNT" : "SIGN IN";
      }
    } catch {
      if (this.disposed || this.mountedRoot !== root) return;
      this.accountExportSession = null;
      status.textContent = "LOCAL EXPORT ONLY";
      status.className = "import-source-status";
      action.textContent = "ACCOUNT SERVICE UNAVAILABLE";
    }
    this.updateExportControls(root);
    this.drainAutomaticUpload(root);
  }

  private scheduleRepositoryCatalogue(root: HTMLElement) {
    if (this.repositoryCatalogueTimer !== null) window.clearTimeout(this.repositoryCatalogueTimer);
    this.repositoryCatalogueTimer = window.setTimeout(() => {
      this.repositoryCatalogueTimer = null;
      void this.refreshRepositoryCatalogue(root);
    }, 180);
  }

  private async refreshRepositoryCatalogue(root: HTMLElement, preferredOrganisation?: string) {
    if (this.accountExportSession?.huggingFace.state !== "ready") return;
    this.repositoryCatalogueAbort?.abort();
    const abort = new AbortController();
    this.repositoryCatalogueAbort = abort;
    const organisationSelect = root.querySelector<HTMLSelectElement>("#hf-organisation");
    const repository = root.querySelector<HTMLInputElement>("#hf-repository");
    const repositoryOptions = root.querySelector<HTMLDataListElement>("#hf-repository-options");
    if (!organisationSelect || !repository || !repositoryOptions) return;
    try {
      const initial = await this.accountExportClient.repositoryCatalogue(undefined, "", abort.signal);
      if (this.disposed || this.mountedRoot !== root || this.repositoryCatalogueAbort !== abort) return;
      const current = organisationSelect.value;
      const selected = initial.organisations.includes(current)
        ? current
        : initial.organisations.includes(preferredOrganisation ?? "")
          ? preferredOrganisation!
          : initial.organisations[0] ?? "";
      organisationSelect.replaceChildren(
        new Option("SELECT ORG", ""),
        ...initial.organisations.map((organisation) => new Option(organisation, organisation)),
      );
      organisationSelect.value = selected;
      const catalogue = selected === initial.organisations[0] && !repository.value.trim()
        ? initial
        : await this.accountExportClient.repositoryCatalogue(selected, repository.value.trim(), abort.signal);
      if (this.disposed || this.mountedRoot !== root || this.repositoryCatalogueAbort !== abort) return;
      repositoryOptions.replaceChildren(...catalogue.repositories.map((name) => new Option(name, name)));
    } catch (error) {
      if (abort.signal.aborted || this.disposed || this.mountedRoot !== root) return;
      repositoryOptions.replaceChildren();
    } finally {
      if (this.repositoryCatalogueAbort === abort) this.repositoryCatalogueAbort = null;
    }
  }

  private syncRemoteActionAvailability(root: HTMLElement) {
    const connectionLocked = !this.monitorRecorderReady
      || this.pairingInitialising
      || this.snapshot?.run.status === "running"
      || (this.snapshot?.run.recordingState ?? "idle") !== "idle";
    const local = root.querySelector<HTMLInputElement>('input[name="connection-mode"][value="local"]');
    const direct = root.querySelector<HTMLInputElement>('input[name="connection-mode"][value="direct"]');
    const relayed = root.querySelector<HTMLInputElement>('input[name="connection-mode"][value="relayed"]');
    if (local) local.disabled = connectionLocked;
    if (direct) direct.disabled = connectionLocked;
    if (relayed) relayed.disabled = true;
    const comingSoon = root.querySelector<HTMLElement>("#connection-relayed-coming-soon");
    if (comingSoon) comingSoon.hidden = this.runtimeFeatures.relayedConnection === true;
    const mode = this.selectedConnectionMode(root);
    const ready = root.querySelector<HTMLElement>("#pairing-invitation")?.dataset.ready === "true"
      && Boolean(this.pairingRoom && Date.parse(this.pairingRoom.expiresAt) > Date.now());
    const share = root.querySelector<HTMLButtonElement>("#share-pairing-invitation");
    const copy = root.querySelector<HTMLButtonElement>("#copy-pairing-invitation");
    const showQr = root.querySelector<HTMLButtonElement>("#show-pairing-qr");
    const renew = root.querySelector<HTMLButtonElement>("#renew-pairing-invitation");
    const send = root.querySelector<HTMLButtonElement>("#send-account-pairing-invitation");
    const email = root.querySelector<HTMLInputElement>("#account-pairing-email");
    if (share) share.disabled = !ready;
    if (copy) copy.disabled = !ready || this.activePairingCopyOperation !== null;
    if (showQr) showQr.disabled = !ready;
    if (renew) renew.disabled = connectionLocked;
    if (send) send.disabled = !ready || mode === "local";
    if (email) email.disabled = mode === "local";
    const selector = root.querySelector<HTMLSelectElement>("#connection-method-selector");
    if (selector) {
      if (this.connectionPanel) selector.value = this.connectionPanel;
      selector.disabled = connectionLocked;
    }
    root.querySelectorAll<HTMLButtonElement>("[data-roll-pairing-invitation]").forEach((roll) => {
      roll.disabled = connectionLocked;
    });
  }

  private syncConnectionControls(root: HTMLElement) {
    const mode = this.selectedConnectionMode(root);
    const server = root.querySelector<HTMLInputElement>("#connection-server")!;
    if (mode !== "local" && !server.value.trim()) server.value = defaultCeresRelayUrl;
    root.querySelector<HTMLElement>("#connection-server-field")!.hidden = true;
    const invitation = root.querySelector<HTMLElement>("#pairing-invitation");
    invitation?.setAttribute("data-mode", mode);
    root.querySelectorAll<HTMLElement>("[data-connection-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.connectionPanel !== this.connectionPanel;
    });
    root.querySelector<HTMLElement>("#account-pairing-invitation")!.hidden = this.connectionPanel !== "invite";
    this.syncRemoteActionAvailability(root);
  }

  private commitConnectionSettings(root: HTMLElement) {
    const mode = this.selectedConnectionMode(root);
    if (mode === "relayed" && this.runtimeFeatures.relayedConnection !== true) {
      this.showActivity(root, "RELAYED CONNECTION COMING SOON", "system");
      this.restoreConnectionControls(root);
      return;
    }
    const serverField = root.querySelector<HTMLInputElement>("#connection-server")!;
    const relayUrl = mode === "local" ? null : normaliseConnectionServer(serverField.value);
    if (mode !== "local" && !relayUrl) {
      this.showActivity(root, "ENTER A TRUSTED HTTPS SERVER", "error");
      this.restoreConnectionControls(root);
      serverField.focus();
      return;
    }
    if (mode === "relayed" && !applicationServices().directoryUrl) {
      this.showActivity(root, "TURN IS NOT CONFIGURED FOR THIS DEPLOYMENT", "error");
      this.restoreConnectionControls(root);
      return;
    }
    const profile = { mode, relayUrl };
    if (profile.mode === this.connectionProfile.mode && profile.relayUrl === this.connectionProfile.relayUrl) return;
    const run = this.snapshot?.run;
    if (run && (run.status === "running" || run.recordingState !== "idle")) {
      this.showActivity(root, "STOP THE RUN BEFORE CHANGING CONNECTION", "error");
      this.restoreConnectionControls(root);
      return;
    }    this.reinitialiseConnection(root, profile);
  }

  private restoreConnectionControls(root: HTMLElement) {
    const activeMode = root.querySelector<HTMLInputElement>(`input[name="connection-mode"][value="${this.connectionProfile.mode}"]`);
    if (activeMode) activeMode.checked = true;
    root.querySelector<HTMLInputElement>("#connection-server")!.value = this.connectionProfile.relayUrl ?? "";
    this.syncConnectionControls(root);
  }

  private reinitialiseConnection(root: HTMLElement, profile: ConnectionProfile, announce = true) {
    this.resetVideoPeer(root);
    this.session.setPeerConnected(false);
    this.directSession.setCaptureConnected(false);
    this.directSession.resetTelemetryModeAuthority();
    this.connectionProfile = profile;
    this.connectionPanel = profile.mode === "local" ? "local" : profile.mode === "direct" ? "direct" : null;
    this.pairingRestoreAttempted = false;
    this.resetPairingInvitation(root, "NO ACTIVE INVITE", true, "CREATE INVITE");
    const url = new URL(location.href);
    applyConnectionProfile(url.searchParams, profile);
    history.replaceState(null, "", url);
    this.storeConnectionPreference();
    this.syncConnectionControls(root);
    this.renderSnapshot(root, this.directSession.snapshot);
    if (announce) this.showActivity(root, `CONNECTION ${profile.mode.toUpperCase()} APPLIED`, "system");
  }

  private handleRunControl(
    root: HTMLElement,
    action: "start-sequence" | "start" | "pause" | "stop" | "finish" | "success" | "fail" | "retry" | "resume" | "next" | "instructions",
    actor: DirectRunControlActor = "director",
    nextCursor?: string,
  ) {
    if (action === "start-sequence" && this.configurationDraft) {
      if ((this.runEditor?.readConfiguration().tasks.length ?? 0) === 0) return;
      this.pendingRunStartRevision = (this.snapshot?.configurationStatus.revision ?? 0) + 1;
      this.saveConfiguration(root);
      return;
    }
    if (action === "start-sequence") this.pendingRunStartRevision = null;
    try {
      this.controlSession(root, action, actor, nextCursor);
    } catch (error) {
      this.showError(root, error, "DIRECT CONTROL FAILED");
    }
  }

  private configureSession(root: HTMLElement, configuration: CaptureConfiguration) {
    if (!isPeerConnectionMode(this.connectionProfile)) {
      this.session.configure(configuration);
      return;
    }
    const commands = this.directSession.configure(configuration);
    this.renderSnapshot(root, this.directSession.snapshot);
    if (this.controlTransportConnected()) {
      this.queueCommittedDirectCommands(root, commands, "DIRECT CONFIGURATION FAILED");
    } else {
      this.queueDirectSnapshotPersistence(root, "DIRECT CONFIGURATION SAVE FAILED");
    }
  }

  private controlSession(
    root: HTMLElement,
    action: "start-sequence" | "start" | "pause" | "stop" | "finish" | "success" | "fail" | "retry" | "resume" | "next" | "instructions",
    actor: DirectRunControlActor = "director",
    nextCursor?: string,
  ) {
    if (!isPeerConnectionMode(this.connectionProfile)) {
      this.session.control(action, nextCursor);
      return;
    }
    if (action === "instructions") throw new Error("Instructions are not available for this direct run state");
    const commands = this.directSession.control(action as DirectRunControlAction, actor, nextCursor);
    this.renderSnapshot(root, this.directSession.snapshot);
    this.queueCommittedDirectCommands(root, commands, "DIRECT CONTROL FAILED");
  }

  private setHandDisplay(root: HTMLElement, settings: HandDisplaySettings) {
    if (!isPeerConnectionMode(this.connectionProfile)) {
      this.session.setHandDisplay(settings);
      return;
    }
    const commands = this.directSession.setHandDisplay(settings);
    this.renderSnapshot(root, this.directSession.snapshot);
    this.queueCommittedDirectCommands(root, commands, "DIRECT HAND DISPLAY FAILED");
  }

  private sendDirectCommands(root: HTMLElement, commands: DirectCaptureCommand[]) {
    const control = this.peerControlChannel;
    if (!control || control.readyState !== "open") throw new Error("The direct control channel is not connected");
    for (const command of commands) control.send(JSON.stringify(command));
    if (commands.length > 0) this.showActivity(root, "DIRECT CONTROL SENT", "system");
  }

  private async commitDirectCommands(root: HTMLElement, commands: DirectCaptureCommand[]) {
    try {
      await this.persistDirectSnapshot();
    } catch (error) {
      throw new MonitorSnapshotCommitError(error);
    }
    if (this.monitorRecorderFailure.current) throw new MonitorSnapshotCommitError(this.monitorRecorderFailure.current);
    if (commands.length > 0) this.sendDirectCommands(root, commands);
  }

  private queueCommittedDirectCommands(root: HTMLElement, commands: DirectCaptureCommand[], fallback: string) {
    this.directSessionMutatedSinceOpen = true;
    const pending = this.directCommitTail.then(() => this.commitDirectCommands(root, commands));
    this.directCommitTail = pending.catch(() => undefined);
    void pending.catch((error) => {
      if (error instanceof MonitorSnapshotCommitError) {
        this.reportDirectPersistenceFailure(root, error.failure, fallback);
        return;
      }
      this.showError(root, error, fallback);
    });
  }

  private queueDirectSnapshotPersistence(root: HTMLElement, fallback = "DIRECT SESSION CATALOGUE FAILED") {
    this.directSessionMutatedSinceOpen = true;
    const pending = this.directCommitTail.then(() => this.persistDirectSnapshot());
    this.directCommitTail = pending.catch(() => undefined);
    void pending.catch((error) => this.reportDirectPersistenceFailure(root, error, fallback));
  }

  private queueDirectFinalisation(
    root: HTMLElement,
    episodeId: string,
    summary: MonitorRecordingSummary | undefined,
    error: string | undefined,
    fallback: string,
  ) {
    if (this.directFinalisationPublication !== null) return;
    this.directSessionMutatedSinceOpen = true;
    this.directFinalisationPublication = episodeId;
    const committing = this.directCommitTail.then(() => (
      this.commitDirectFinalisation(root, episodeId, summary, error)
    ));
    this.directCommitTail = committing.catch(() => undefined);
    void committing.catch((commitError) => {
      if (commitError instanceof MonitorSnapshotCommitError) {
        this.reportDirectPersistenceFailure(root, commitError.failure, fallback);
        return;
      }
      this.showError(root, commitError, fallback);
    });
  }

  private async commitDirectFinalisation(
    root: HTMLElement,
    episodeId: string,
    summary: MonitorRecordingSummary | undefined,
    error?: string,
  ) {
    const previousSnapshot = this.directSession.snapshot;
    let commands: DirectCaptureCommand[];
    try {
      commands = this.directSession.recordingFinalised(episodeId, summary, error);
      const finalisedSnapshot = this.directSession.snapshot;
      try {
        await this.monitorRecorder.saveSnapshot(finalisedSnapshot);
      } catch (persistenceError) {
        throw new MonitorSnapshotCommitError(persistenceError);
      }
      if (!error && this.monitorRecorderFailure.current) {
        throw new MonitorSnapshotCommitError(this.monitorRecorderFailure.current);
      }
    } catch (commitError) {
      this.directSession.restore(previousSnapshot, previousSnapshot.captureConnected);
      this.directFinalisationPublication = null;
      this.renderSnapshot(root, this.directSession.snapshot);
      throw commitError;
    }
    if (this.pendingDirectFinalisation?.episodeId === episodeId) this.pendingDirectFinalisation = null;
    this.directFinalisationPublication = null;
    this.renderSnapshot(root, this.directSession.snapshot);
    if (this.peerControlChannel?.readyState === "open" && commands.length > 0) {
      this.sendDirectCommands(root, commands);
    }
  }

  private persistDirectSnapshot() {
    if (!isPeerConnectionMode(this.connectionProfile) || !this.snapshot) return Promise.resolve();
    return this.monitorRecorder.saveSnapshot(this.snapshot);
  }

  private reportDirectPersistenceFailure(root: HTMLElement, error: unknown, fallback: string) {
    if (this.monitorRecorderFailure.current) return;
    const message = this.monitorRecorderFailure.remember(error instanceof Error ? error.message : fallback);
    this.showActivity(root, message.toUpperCase(), "error");
    const control = this.peerControlChannel;
    const controlMessage = this.monitorRecorderFailure.controlMessage;
    if (control?.readyState === "open" && controlMessage) control.send(JSON.stringify(controlMessage));
  }

  private renderHandControls(root: HTMLElement) {
    const labels = { render: this.handMode, shading: this.handShading, trail: this.handTrail } as const;
    for (const [control, label] of Object.entries(labels)) {
      const button = root.querySelector<HTMLButtonElement>(`[data-hand-control="${control}"]`);
      if (!button) continue;
      const outlineFallback = control === "render"
        && this.handMode === "mesh"
        && this.handMeshStatus === "outline-fallback";
      button.textContent = outlineFallback ? "OUTLINE FALLBACK" : label.toUpperCase();
      const accessibleLabel = outlineFallback
        ? "render mode: mesh; outline fallback because MANO assets are unavailable"
        : `${control} mode: ${label}`;
      button.setAttribute("aria-label", accessibleLabel);
      button.dataset.meshStatus = control === "render" ? this.handMeshStatus : "not-applicable";
      button.disabled = !this.controlTransportConnected();
      button.title = this.controlTransportConnected() ? accessibleLabel : "Connect the demonstrator to change hand visuals";
    }
    root.dataset.handMeshStatus = this.handMeshStatus;
  }

  private applyHandMeshStatus(root: HTMLElement, status: HandMeshStatus) {
    if (this.handMeshStatus === status) {
      root.dataset.handMeshStatus = status;
      return;
    }
    this.handMeshStatus = status;
    this.renderHandControls(root);
  }

  private handDisplaySettings(): HandDisplaySettings {
    return {
      handMode: this.handMode,
      handShading: this.handShading,
      handTrail: this.handTrail,
    };
  }

  private applyHandDisplay(root: HTMLElement, settings: HandDisplaySettings) {
    const next = normaliseHandDisplaySettings(settings);
    if (this.handMode === next.handMode
      && this.handShading === next.handShading
      && this.handTrail === next.handTrail) return;
    this.handMode = next.handMode;
    this.handShading = next.handShading;
    this.handTrail = next.handTrail;
    this.renderHandControls(root);
    this.syncVisualSettings();
  }

  private syncVisualSettings() {
    this.session.setVisualSettings({
      signals: [...this.activeSignals],
      handMode: this.handMode,
      handShading: this.handShading,
      handTrail: this.handTrail,
      cameraProjection: this.cameraCalibration,
      reticle: this.spatialOverlays.ret,
      aid: this.spatialOverlays.aid,
      trails: this.spatialOverlays.trc,
    });
  }

  private syncCameraRegistration(root: HTMLElement, status: CaptureStatus) {
    const cameraDeviceId = status.selectedCameraDeviceId;
    const width = status.selectedCameraWidth;
    const height = status.selectedCameraHeight;
    const side = status.selectedCameraSide ?? "unknown";
    if (status.camera !== "ready" || !cameraDeviceId || !width || !height) return;
    const key = cameraRegistrationStatusKey(cameraDeviceId, side, width, height, status.selectedCameraFrame);
    if (key === this.activeCameraRegistrationKey) {
      this.publishCameraRegistration(root, this.cameraRegistration);
      return;
    }
    this.activeCameraRegistrationKey = key;
    this.activateCameraRegistration(
      root,
      loadCameraRegistrationForCaptureFrame(
        localStorage,
        cameraDeviceId,
        side,
        width,
        height,
        status.selectedCameraFrame,
      ),
      width,
      height,
    );
    this.publishCameraRegistration(root, this.cameraRegistration);
  }

  private activateCameraRegistration(
    root: HTMLElement,
    registration: CameraRegistration | null,
    width: number,
    height: number,
  ) {
    this.cameraRegistration = registration;
    this.cameraCalibration = registration
      ? {
          width: registration.width,
          height: registration.height,
          fx: registration.fx,
          fy: registration.fy,
          cx: registration.cx,
          cy: registration.cy,
          distortion: [...registration.distortion],
          rms: registration.rms,
          sampleCount: registration.sampleCount,
          reprojection: structuredClone(registration.reprojection),
        }
      : null;
    this.calibrationWidth = width;
    this.calibrationHeight = height;
    this.calibrationCaptures = registration?.sampleCount ?? 0;
    this.calibrationState = registration ? "CALIBRATED" : "NOT RUN";
    this.renderCalibrationProgress(root);
    this.syncVisualSettings();
  }

  private adoptCameraRegistrationFromSnapshot(root: HTMLElement, snapshot: SessionSnapshot) {
    const status = snapshot.captureStatus;
    const width = status.selectedCameraWidth;
    const height = status.selectedCameraHeight;
    let registration: CameraRegistration | null;
    try {
      registration = normaliseCameraRegistration(snapshot.cameraRegistration ?? null);
    } catch {
      return;
    }
    const outputRegistration = status.selectedCameraFrame
      ? cameraRegistrationForCaptureFrame(registration, status.selectedCameraFrame)
      : registration?.captureFrameKey ? null : registration;
    if (!outputRegistration || !cameraRegistrationMatches(
      outputRegistration,
      status.selectedCameraDeviceId,
      status.selectedCameraSide ?? "unknown",
      width,
      height,
    ) || !width || !height) return;
    const key = cameraRegistrationStatusKey(
      outputRegistration.cameraDeviceId,
      outputRegistration.side,
      width,
      height,
      status.selectedCameraFrame,
    );
    if (key === this.activeCameraRegistrationKey
      && JSON.stringify(outputRegistration) === JSON.stringify(this.cameraRegistration)) return;
    storeCameraRegistration(localStorage, outputRegistration);
    this.activeCameraRegistrationKey = key;
    this.activateCameraRegistration(root, outputRegistration, width, height);
  }

  private publishCameraRegistration(root: HTMLElement, registration: CameraRegistration | null) {
    const signature = JSON.stringify(registration);
    if (signature === this.publishedCameraRegistration) return;
    this.publishedCameraRegistration = signature;
    if (!isPeerConnectionMode(this.connectionProfile)) {
      this.session.setCameraRegistration(registration);
      return;
    }
    const commands = this.directSession.setCameraRegistration(registration);
    if (this.peerControlChannel?.readyState === "open") {
      this.queueCommittedDirectCommands(root, commands, "CAMERA REGISTRATION FAILED");
    }
  }

  private wireSession(root: HTMLElement) {
    this.session.on<{ kind: string; crossOriginIsolated: boolean; handMeshStatus: HandMeshStatus }>("monitor-renderer", (status) => {
      root.dataset.monitorRenderer = status.kind;
      root.dataset.crossOriginIsolated = String(status.crossOriginIsolated);
      this.applyHandMeshStatus(root, status.handMeshStatus);
    });
    this.session.on<boolean>("connection", (connected) => {
      this.socketConnected = connected;
      if (connected) this.publishedCameraRegistration = "";
      if (!connected && !isPeerConnectionMode(this.connectionProfile)) this.resetVideoPeer(root);
      if (this.snapshot) this.renderCaptureStatus(root, this.snapshot.captureStatus);
      else this.renderConnectionState(root);
      if (this.snapshot) this.setClockConnection(root, this.controlTransportConnected() && this.snapshot.captureConnected);
      if (connected && this.snapshot?.captureConnected) this.requestFeed();
      if (connected && this.snapshot) this.syncCameraRegistration(root, this.snapshot.captureStatus);
    });
    this.session.on<{ resetId: string }>("session-restarted", ({ resetId }) => this.acknowledgeSessionReset(resetId));
    this.session.on<SessionSnapshot>("snapshot", (snapshot) => {
      if (!isPeerConnectionMode(this.connectionProfile)) this.renderSnapshot(root, snapshot);
    });
    this.session.on<MonitorReadout>("monitor-readout", (readout) => this.renderMonitorReadout(root, readout));
    this.session.on<{ state: AsrStatusState }>("asr-status", ({ state }) => {
      if (this.speechEnabled()) this.renderAsrStatus(root, state);
    });
    this.session.on<{ settings: HandDisplaySettings }>("hand-display", (message) => this.applyHandDisplay(root, message.settings));
    this.session.on<any>("capture-status", (message) => {
      if (this.snapshot) this.snapshot.captureStatus = message.status;
      if (isPeerConnectionMode(this.connectionProfile)) {
        this.directCaptureStatus = message.status;
        this.directSession.setCaptureStatus(message.status);
        this.renderSnapshot(root, this.directSession.snapshot);
      }
      this.renderCaptureStatus(root, message.status);
      const video = root.querySelector<HTMLVideoElement>("#live-video")!;
      if (message.status.camera === "ready" && !video.srcObject) this.requestFeed();
    });
    this.session.on<any>("transcript", (message) => {
      if (this.speechEnabled()) this.showActivity(root, `ASR ${message.text}`, "voice");
    });
    this.session.on<any>("voice-command", (message) => {
      if (this.speechEnabled()) this.showActivity(root, `CMD ${message.command}`, "command");
    });
    this.session.on<any>("control", (message) => {
      if (message.action === "show-instructions") this.showActivity(root, `INSTR ${message.instructions || "--"}`, "command");
    });
    this.session.on<any>("error", (message) => this.showActivity(root, message.message || "Server error", "error"));
    this.session.on<any>("webrtc-signal", (message) => {
      if (!this.webRtcSignal) void this.acceptSignal(root, message.peerId, message.signal);
    });
  }

  private wireWebRtcSignal(root: HTMLElement) {
    const signal = this.webRtcSignal;
    if (!signal) return;
    signal.on<boolean>("connection", (connected) => {
      this.directSignallingConnected = connected;
      if (!connected) {
        this.requestedFeed = false;
        this.clearOfferRequestRetry();
      }
      this.renderConnectionState(root);
      if (connected) this.requestFeed(true);
    });
    signal.on<InvitationPickedUp>("invitation-picked-up", (pickup) => {
      this.recordPairingPickup(root, pickup.pickedUpAt);
    });
    signal.on<{ peerId: string; signal: WebRtcSignal }>("webrtc-signal", (message) => {
      void this.acceptSignal(root, message.peerId, message.signal).catch((error) => {
        this.showActivity(root, error instanceof Error ? error.message : "The demonstrator signal could not be applied", "error");
      });
    });
    signal.on<WebRtcSignalError>("error", (message) => {
      if (message.message === "Pairing invitation expired") {
        this.expirePairingInvitation(root, message.terminal === true && this.pairingInvitationClaimed);
        return;
      }
      this.showActivity(root, message.message, message.retrying ? "system" : "error");
    });
    signal.connect();
  }

  private mountPairingInvitationSurface(root: HTMLElement) {
    const connectionInspector = root.querySelector<HTMLElement>(".connection-inspector");
    if (!connectionInspector) return;
    const surface = document.createElement("section");
    surface.id = "pairing-invitation";
    surface.className = "pairing-invitation";
    surface.dataset.ready = "false";
    surface.hidden = true;
    surface.innerHTML = `<b id="pairing-invitation-state" role="status" aria-live="polite">NO ACTIVE INVITE</b><time id="pairing-invitation-expiry">--:--</time><output id="pairing-invitation-pickup" aria-live="polite">CREATE AN INVITE TO PAIR</output><button id="renew-pairing-invitation" type="button" hidden>CREATE INVITE</button>`;
    connectionInspector.append(surface);
    const localPanel = document.createElement("section");
    localPanel.className = "connection-panel";
    localPanel.dataset.connectionPanel = "local";
    localPanel.hidden = true;
    localPanel.innerHTML = `<div class="connection-inline-row connection-local-row"><output id="local-pairing-code" aria-label="Local join code"><span class="local-pairing-code-value">NO CODE</span><small id="local-pairing-expiry">--:--</small></output><button id="roll-pairing-invitation" class="connection-icon-button connection-roll" type="button" data-roll-pairing-invitation aria-label="Roll a fresh local invitation" title="Roll a fresh invitation" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/></svg></button></div><button id="show-pairing-qr" class="pairing-inline-qr-trigger" type="button" aria-label="Open pairing QR code full screen" title="Open QR code full screen" hidden disabled><img id="pairing-inline-qr" alt="" width="144" height="144"></button>`;
    connectionInspector.append(localPanel);
    const directPanel = document.createElement("label");
    directPanel.id = "pairing-invitation-link-field";
    directPanel.className = "connection-panel";
    directPanel.dataset.connectionPanel = "direct";
    directPanel.hidden = true;
    directPanel.innerHTML = `<span class="sr-only">Join URL</span><div class="connection-inline-row"><input id="pairing-invitation-link" type="url" readonly spellcheck="false" aria-label="Invitation link"><button id="copy-pairing-invitation" class="connection-icon-button pairing-copy-trigger" type="button" aria-label="Copy pairing invitation link" title="Copy invitation link" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/></svg></button><button id="share-pairing-invitation" class="connection-icon-button pairing-share-trigger" type="button" aria-label="Share pairing invitation" title="Share invitation" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg></button><button id="roll-direct-pairing-invitation" class="connection-icon-button connection-roll" type="button" data-roll-pairing-invitation aria-label="Roll a fresh direct invitation" title="Roll a fresh invitation" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/></svg></button></div>`;
    connectionInspector.append(directPanel);
    const accountPanel = document.createElement("section");
    accountPanel.id = "account-pairing-invitation";
    accountPanel.className = "connection-panel account-pairing-invitation";
    accountPanel.dataset.connectionPanel = "invite";
    accountPanel.hidden = true;
    accountPanel.innerHTML = `<div class="connection-invite-row"><input id="account-pairing-email" type="email" autocomplete="email" aria-label="Demonstrator email" placeholder="demonstrator@example.com"><button id="send-account-pairing-invitation" class="toolbar-button" type="button" disabled>SEND</button></div><output id="account-pairing-state" aria-live="polite"></output>`;
    connectionInspector.append(accountPanel);
    const overlay = document.createElement("section");
    overlay.id = "pairing-qr-overlay";
    overlay.className = "pairing-qr-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "pairing-qr-title");
    overlay.innerHTML = `<div class="pairing-qr-stage"><header><div><span>PAIRING INVITATION</span><b id="pairing-qr-title">Scan on the demonstrator headset</b></div><button id="close-pairing-qr" type="button" aria-label="Close pairing QR">CLOSE</button></header><img id="pairing-invitation-qr" alt="Pairing invitation QR code" width="720" height="720"><footer><code id="pairing-qr-code"></code><time id="pairing-qr-expiry">--:--</time></footer></div>`;
    root.querySelector<HTMLElement>(".studio-shell")!.append(overlay);
    root.querySelector<HTMLButtonElement>("#share-pairing-invitation")!.addEventListener("click", () => {
      void this.sharePairingInvitation(root);
    });
    root.querySelector<HTMLButtonElement>("#copy-pairing-invitation")!.addEventListener("click", () => {
      void this.copyPairingInvitation(root);
    });
    root.querySelector<HTMLButtonElement>("#send-account-pairing-invitation")!.addEventListener("click", () => {
      void this.sendAccountPairingInvitation(root);
    });
    root.querySelector<HTMLButtonElement>("#show-pairing-qr")!.addEventListener("click", () => {
      void this.showPairingQr(root);
    });
    root.querySelector<HTMLButtonElement>("#renew-pairing-invitation")!.addEventListener("click", () => {
      void this.renewPairingInvitation(root);
    });
    root.querySelector<HTMLButtonElement>("#close-pairing-qr")!.addEventListener("click", () => this.closePairingQr(root));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.closePairingQr(root);
    });
  }

  private async ensurePairingInvitation(root: HTMLElement) {
    if (this.pairingRoom || this.pairingInitialising || this.pairingRestoreAttempted) return;
    this.pairingInitialising = true;
    this.syncRemoteActionAvailability(root);
    try {
      if (!this.pairingRestoreAttempted) {
        this.pairingRestoreAttempted = true;
        if (await this.restorePairingInvitation(root)) return;
      }
      this.renderPairingInvitationIdle(root);
    } finally {
      this.pairingInitialising = false;
      this.syncRemoteActionAvailability(root);
    }
  }

  private renderPairingInvitationIdle(root: HTMLElement) {
    this.renderPairingInvitationState(root, "NO ACTIVE INVITE");
    const pickup = root.querySelector<HTMLOutputElement>("#pairing-invitation-pickup");
    if (pickup) pickup.textContent = "CREATE AN INVITE TO PAIR";
    const renew = root.querySelector<HTMLButtonElement>("#renew-pairing-invitation");
    if (renew) {
      renew.hidden = false;
      renew.textContent = "CREATE INVITE";
    }
  }

  private async createPairingInvitation(root: HTMLElement) {
    if (this.pairingRoom || this.pairingInitialising) return;
    this.pairingRestoreAttempted = true;
    this.pairingInitialising = true;
    this.syncRemoteActionAvailability(root);
    try {
      await this.initialisePairingInvitation(root);
    } finally {
      this.pairingInitialising = false;
      this.syncRemoteActionAvailability(root);
    }
  }

  private async restorePairingInvitation(root: HTMLElement) {
    const restored = storedMonitorPairingInvitation(this.sessionId, this.connectionProfile);
    if (!restored) return false;
    const relayUrl = connectionServerUrl(this.connectionProfile);
    if (!relayUrl) {
      clearStoredMonitorPairingInvitation();
      return false;
    }
    this.pairingRoom = restored.room;
    this.setPairingLink(restored.shareLink);
    this.pairingQrTarget = restored.qrTarget;
    this.connectPairingSignal(root, relayUrl, restored.room, restored.pickedUpAt ?? null);
    try {
      await this.renderPairingInvitation(root, restored.shareLink, restored.pickedUpAt ?? null);
    } catch (error) {
      this.webRtcSignal?.dispose();
      this.webRtcSignal = null;
      this.directSignallingConnected = false;
      this.renderConnectionState(root);
      throw error;
    }
    if (restored.pickedUpAt && Date.parse(restored.room.expiresAt) <= Date.now()) {
      this.renderClaimedPairingExpiry(root, false);
    }
    return true;
  }

  private async initialisePairingInvitation(root: HTMLElement) {
    const relayUrl = connectionServerUrl(this.connectionProfile);
    if (!relayUrl) {
      this.renderPairingInvitationState(root, this.pairingRelayUnavailableLabel());
      return;
    }
    const room = createPairingRoomCredentials(this.sessionId);
    const invitation = demonstratorInvite(room);
    const target = pairingInviteUrl(invitation, undefined, this.connectionProfile);
    const link = shareablePairingInviteUrl(invitation, undefined, this.connectionProfile);
    this.renderPairingInvitationState(root, "CREATING INVITE");
    try {
      await createPairingRoom(relayUrl, room, target);
      if (this.disposed) return;
      this.pairingRoom = room;
      this.setPairingLink(link);
      this.pairingQrTarget = target;
      this.connectPairingSignal(root, relayUrl, room, null);
      await this.renderPairingInvitation(root, link, null);
      this.persistPairingInvitation();
    } catch {
      if (!this.disposed) {
        this.webRtcSignal?.dispose();
        this.webRtcSignal = null;
        this.directSignallingConnected = false;
        this.renderConnectionState(root);
        this.renderPairingInvitationState(root, this.pairingRelayUnavailableLabel());
        const renew = root.querySelector<HTMLButtonElement>("#renew-pairing-invitation");
        if (renew) {
          renew.hidden = false;
          renew.textContent = "RETRY INVITE";
        }
      }
    }
  }

  private pairingRelayUnavailableLabel() {
    return this.connectionProfile.mode === "local" ? "LOCAL RELAY" : "PAIRING RELAY UNAVAILABLE";
  }

  private connectPairingSignal(root: HTMLElement, relayUrl: string, room: PairingRoomCredentials, pickedUpAt: string | null) {
    const signal = new WebRtcSignalClient(this.sessionId, "monitor", relayUrl, null, {
      ...monitorSignalCredentials(room),
      expiresAt: room.expiresAt,
      bound: pickedUpAt !== null,
      ...(pickedUpAt ? { boundAt: pickedUpAt } : {}),
    });
    this.webRtcSignal = signal;
    this.wireWebRtcSignal(root);
  }

  private async renderPairingInvitation(root: HTMLElement, link: string, pickedUpAt: string | null) {
    const field = root.querySelector<HTMLInputElement>("#pairing-invitation-link");
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    if (!field || !surface) return;
    field.value = link;
    this.renderLocalPairingCode(root, this.pairingRoom?.roomId ?? null);
    this.pairingInvitationClaimed = Boolean(pickedUpAt);
    this.pairingInvitationPickedUpAt = pickedUpAt;
    surface.dataset.ready = "true";
    surface.dataset.expired = "false";
    surface.dataset.pickedUp = String(Boolean(pickedUpAt));
    const pickup = root.querySelector<HTMLOutputElement>("#pairing-invitation-pickup");
    if (pickup) {
      pickup.textContent = pickedUpAt ? "INVITATION PICKED UP" : "WAITING FOR DEMONSTRATOR";
      if (pickedUpAt) pickup.setAttribute("datetime", pickedUpAt);
      else pickup.removeAttribute("datetime");
    }
    this.renderPairingInvitationState(root, "READY TO PAIR");
    const renew = root.querySelector<HTMLButtonElement>("#renew-pairing-invitation");
    if (renew) {
      renew.hidden = true;
      renew.textContent = "NEW INVITE";
    }
    try {
      await this.renderPairingQrImages(root);
    } catch (error) {
      const trigger = root.querySelector<HTMLButtonElement>("#show-pairing-qr");
      if (trigger) {
        trigger.hidden = true;
        trigger.disabled = true;
      }
      console.warn("Pairing QR rendering failed; use the join code or link.", error);
    }
    this.syncRemoteActionAvailability(root);
  }

  private recordPairingPickup(root: HTMLElement, pickedUpAt: string) {
    if (Number.isNaN(Date.parse(pickedUpAt))) return;
    const newlyPickedUp = !this.pairingInvitationClaimed;
    const retentionOrigin = this.pairingInvitationPickedUpAt ?? pickedUpAt;
    this.pairingInvitationClaimed = true;
    this.pairingInvitationPickedUpAt = retentionOrigin;
    this.closePairingQr(root);
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    const state = root.querySelector<HTMLOutputElement>("#pairing-invitation-pickup");
    if (surface) surface.dataset.pickedUp = "true";
    if (state) {
      state.textContent = "INVITATION PICKED UP";
      state.setAttribute("datetime", retentionOrigin);
    }
    this.persistPairingInvitation();
    if (newlyPickedUp) {}
  }

  private persistPairingInvitation() {
    if (!this.pairingRoom || !this.pairingLink || !this.pairingQrTarget) return false;
    return storeMonitorPairingInvitation({
      room: this.pairingRoom,
      connectionProfile: this.connectionProfile,
      shareLink: this.pairingLink,
      qrTarget: this.pairingQrTarget,
      ...(this.pairingInvitationPickedUpAt ? { pickedUpAt: this.pairingInvitationPickedUpAt } : {}),
    });
  }

  private async sharePairingInvitation(root: HTMLElement) {
    const link = this.pairingLink;
    if (!link) return;
    const generation = this.pairingInvitationGeneration;
    const isCurrent = () => !this.disposed
      && this.pairingInvitationGeneration === generation
      && this.pairingLink === link;
    try {
      if (navigator.share) {
        await navigator.share({ url: link });
        if (!isCurrent()) return;
        this.renderPairingInvitationState(root, "INVITATION SHARED");
      } else {
        await navigator.clipboard.writeText(link);
        if (!isCurrent()) return;
        this.renderPairingInvitationState(root, "LINK COPIED");
      }
    } catch {
      if (!isCurrent()) return;
      root.querySelector<HTMLInputElement>("#pairing-invitation-link")?.focus();
      this.renderPairingInvitationState(root, "SHARE CANCELLED");
    }
  }

  private async copyPairingInvitation(root: HTMLElement) {
    const link = this.pairingLink;
    if (!link || this.activePairingCopyOperation !== null) return;
    const generation = this.pairingInvitationGeneration;
    const operation = ++this.pairingCopyOperation;
    this.activePairingCopyOperation = operation;
    this.syncRemoteActionAvailability(root);
    const field = root.querySelector<HTMLInputElement>("#pairing-invitation-link")!;
    const isCurrent = () => !this.disposed
      && this.activePairingCopyOperation === operation
      && this.pairingInvitationGeneration === generation
      && this.pairingLink === link;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      if (!isCurrent()) return;
      this.renderPairingInvitationState(root, "LINK COPIED");
    } catch {
      if (!isCurrent()) return;
      field.focus();
      field.select();
      try {
        if (document.execCommand("copy")) {
          if (!isCurrent()) return;
          this.renderPairingInvitationState(root, "LINK COPIED");
          return;
        }
      } catch {
        // Keep the complete link selected for manual copying.
      }
      this.renderPairingInvitationState(root, "LINK SELECTED - COPY MANUALLY");
    } finally {
      if (this.activePairingCopyOperation === operation) {
        this.activePairingCopyOperation = null;
        this.syncRemoteActionAvailability(root);
      }
    }
  }

  private setPairingLink(link: string | null) {
    this.pairingLink = link;
    this.invalidatePairingCopy();
  }

  private invalidatePairingCopy() {
    this.pairingInvitationGeneration += 1;
    this.activePairingCopyOperation = null;
  }

  private async showPairingQr(root: HTMLElement) {
    if (!this.pairingQrTarget || !this.pairingRoom || Date.parse(this.pairingRoom.expiresAt) <= Date.now()) return;
    await this.renderPairingQrImages(root);
    root.querySelector<HTMLElement>("#pairing-qr-code")!.textContent = this.pairingRoom.roomId;
    this.openOverlay(root, "pairing-qr-overlay", "#close-pairing-qr");
  }

  private async renderPairingQrImages(root: HTMLElement) {
    if (!this.pairingQrTarget || !this.pairingRoom || Date.parse(this.pairingRoom.expiresAt) <= Date.now()) return;
    const target = this.pairingQrTarget;
    const overlayImage = root.querySelector<HTMLImageElement>("#pairing-invitation-qr");
    const inlineImage = root.querySelector<HTMLImageElement>("#pairing-inline-qr");
    const trigger = root.querySelector<HTMLButtonElement>("#show-pairing-qr");
    if (!overlayImage || !inlineImage || !trigger) return;
    let source = overlayImage.dataset.link === target ? overlayImage.src : "";
    if (!source) {
      const { toDataURL } = await import("qrcode");
      source = await toDataURL(target, {
        width: 720,
        margin: 4,
        errorCorrectionLevel: "H",
        color: { dark: semanticColours.qrForeground, light: semanticColours.qrBackground },
      });
    }
    if (this.pairingQrTarget !== target) return;
    for (const image of [overlayImage, inlineImage]) {
      image.src = source;
      image.dataset.link = target;
    }
    trigger.hidden = false;
  }

  private closePairingQr(root: HTMLElement) {
    this.closeOverlay(root, "pairing-qr-overlay");
  }

  private async renewPairingInvitation(root: HTMLElement) {
    if (this.pairingInvitationClaimed || this.peer || this.rtcPeerId || this.peerControlChannel) {
      this.resetVideoPeer(root);
    }
    this.resetPairingInvitation(root, "CREATING INVITE", false);
    await this.createPairingInvitation(root);
  }

  private expirePairingInvitation(root: HTMLElement, terminalRetention = false) {
    if (!this.pairingRoom && !this.pairingLink && !this.webRtcSignal) return;
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    const claimed = this.pairingInvitationClaimed
      || Boolean(this.peer || this.rtcPeerId || this.peerControlChannel);
    if (claimed && (terminalRetention || this.pairingRetentionEnded())) {
      this.resetVideoPeer(root);
      this.resetPairingInvitation(root, "PAIRING RETENTION ENDED", true, "NEW INVITE");
      this.showActivity(root, "Pairing retention ended; create a new invitation when ready", "error");
      return;
    }
    if (surface?.dataset.expired === "true") return;
    if (claimed) {
      this.renderClaimedPairingExpiry(root, Boolean(this.peer || this.rtcPeerId || this.peerControlChannel));
      return;
    }
    this.resetPairingInvitation(root, "PAIRING INVITATION EXPIRED", true, "NEW INVITE");
    this.showActivity(root, "Pairing invitation expired", "error");
  }

  private pairingRetentionEnded(now = Date.now()) {
    return Boolean(this.pairingInvitationPickedUpAt
      && Date.parse(this.pairingInvitationPickedUpAt) + monitorPairingRetentionMs <= now);
  }

  private renderClaimedPairingExpiry(root: HTMLElement, peerBound: boolean) {
    this.invalidatePairingCopy();
    this.pairingInvitationClaimed = true;
    this.closePairingQr(root);
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    if (surface) {
      surface.dataset.ready = "false";
      surface.dataset.expired = "true";
      surface.dataset.pickedUp = "true";
    }
    const pickup = root.querySelector<HTMLOutputElement>("#pairing-invitation-pickup");
    if (pickup) pickup.textContent = peerBound ? "DEMONSTRATOR REMAINS PAIRED" : "CAPTURE IDENTITY RESERVED";
    const link = root.querySelector<HTMLInputElement>("#pairing-invitation-link");
    if (link) link.value = "";
    this.renderLocalPairingCode(root, null);
    const image = root.querySelector<HTMLImageElement>("#pairing-invitation-qr");
    if (image) {
      image.removeAttribute("src");
      delete image.dataset.link;
    }
    this.clearInlinePairingQr(root);
    const code = root.querySelector<HTMLElement>("#pairing-qr-code");
    if (code) code.textContent = "";
    root.querySelectorAll<HTMLElement>("#pairing-invitation-expiry, #pairing-qr-expiry")
      .forEach((element) => { element.textContent = "00:00"; });
    const renew = root.querySelector<HTMLButtonElement>("#renew-pairing-invitation");
    if (renew) {
      renew.hidden = false;
      renew.textContent = "RESET PAIRING";
    }
    this.renderPairingInvitationState(root, peerBound ? "PAIRED - INVITE EXPIRED" : "CLAIMED - INVITE EXPIRED");
    this.showActivity(root, peerBound
      ? "Pairing invitation expired; the demonstrator remains paired"
      : "Claimed pairing invitation expired; reset pairing to invite another demonstrator", peerBound ? "system" : "error");
    this.syncRemoteActionAvailability(root);
    this.renderConnectionState(root);
  }

  private resetPairingInvitation(root: HTMLElement, state: string, renewalVisible: boolean, renewalLabel = "NEW INVITE") {
    this.closePairingQr(root);
    this.webRtcSignal?.dispose();
    this.webRtcSignal = null;
    this.pairingRoom = null;
    this.setPairingLink(null);
    this.pairingQrTarget = null;
    this.pairingInvitationClaimed = false;
    this.pairingInvitationPickedUpAt = null;
    this.directSignallingConnected = false;
    clearStoredMonitorPairingInvitation();
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    if (surface) {
      surface.dataset.ready = "false";
      surface.dataset.expired = state === "PAIRING INVITATION EXPIRED" ? "true" : "false";
      surface.dataset.pickedUp = "false";
    }
    const pickup = root.querySelector<HTMLOutputElement>("#pairing-invitation-pickup");
    if (pickup) {
      pickup.textContent = "WAITING FOR DEMONSTRATOR";
      pickup.removeAttribute("datetime");
    }
    const link = root.querySelector<HTMLInputElement>("#pairing-invitation-link");
    if (link) link.value = "";
    this.renderLocalPairingCode(root, null, state === "CREATING INVITE");
    const image = root.querySelector<HTMLImageElement>("#pairing-invitation-qr");
    if (image) {
      image.removeAttribute("src");
      delete image.dataset.link;
    }
    this.clearInlinePairingQr(root);
    const code = root.querySelector<HTMLElement>("#pairing-qr-code");
    if (code) code.textContent = "";
    root.querySelectorAll<HTMLElement>("#pairing-invitation-expiry, #pairing-qr-expiry")
      .forEach((element) => { element.textContent = "--:--"; });
    const renew = root.querySelector<HTMLButtonElement>("#renew-pairing-invitation");
    if (renew) {
      renew.hidden = !renewalVisible;
      renew.textContent = renewalLabel;
    }
    this.renderPairingInvitationState(root, state);
    this.syncRemoteActionAvailability(root);
    this.renderConnectionState(root);
  }

  private async sendAccountPairingInvitation(root: HTMLElement) {
    if (!this.pairingLink || !this.pairingRoom) return;
    const accountUrl = applicationServices().directoryUrl;
    const email = root.querySelector<HTMLInputElement>("#account-pairing-email")!;
    const button = root.querySelector<HTMLButtonElement>("#send-account-pairing-invitation")!;
    const state = root.querySelector<HTMLOutputElement>("#account-pairing-state")!;
    if (!accountUrl) {
      state.textContent = "ACCOUNT SERVICE UNAVAILABLE";
      return;
    }
    if (!email.validity.valid || !email.value.trim()) {
      state.textContent = "ENTER AN ACCOUNT EMAIL";
      email.focus();
      return;
    }
    const mode = this.selectedConnectionMode(root);
    if (mode === "local") return;
    button.disabled = true;
    state.textContent = "SENDING";
    try {
      const recipient = await applicationServices().invitations!.send({
        email: email.value.trim(), sessionId: this.sessionId, mode,
        joinUrl: this.pairingLink, expiresAt: this.pairingRoom.expiresAt,
      });
      state.textContent = `SENT TO ${recipient}`;
    } catch (error) {
      state.textContent = error instanceof Error ? error.message.toUpperCase() : "INVITE FAILED";
    } finally {
      this.syncRemoteActionAvailability(root);
    }
  }

  private renderPairingInvitationState(root: HTMLElement, value: string) {
    const state = root.querySelector<HTMLElement>("#pairing-invitation-state");
    if (state) state.textContent = value;
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    const busy = value === "CREATING INVITE";
    if (surface) surface.dataset.busy = String(busy);
    if (surface?.dataset.ready !== "true") this.renderLocalPairingCode(root, null, busy);
  }

  private renderLocalPairingCode(root: HTMLElement, code: string | null, busy = false) {
    const output = root.querySelector<HTMLOutputElement>("#local-pairing-code");
    if (!output) return;
    output.replaceChildren();
    output.dataset.busy = String(busy);
    output.setAttribute("aria-busy", String(busy));
    const value = document.createElement("span");
    value.className = "local-pairing-code-value";
    if (busy) {
      const spinner = document.createElement("span");
      spinner.className = "pairing-code-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = "CREATING";
      value.append(spinner, label);
    } else {
      value.textContent = code ?? "NO CODE";
    }
    const expiry = document.createElement("small");
    expiry.id = "local-pairing-expiry";
    expiry.textContent = this.pairingRoom ? "--:--" : "";
    output.append(value, expiry);
  }

  private clearInlinePairingQr(root: HTMLElement) {
    const image = root.querySelector<HTMLImageElement>("#pairing-inline-qr");
    if (image) {
      image.removeAttribute("src");
      delete image.dataset.link;
    }
    const trigger = root.querySelector<HTMLButtonElement>("#show-pairing-qr");
    if (trigger) {
      trigger.hidden = true;
      trigger.disabled = true;
    }
    const output = root.querySelector<HTMLOutputElement>("#local-pairing-code");
    output?.style.setProperty("--pairing-expiry-progress", "0%");
  }

  private startTiming(root: HTMLElement) {
    if (this.timingTimer !== null) window.clearInterval(this.timingTimer);
    this.renderTiming(root);
    this.timingTimer = window.setInterval(() => this.renderTiming(root), 100);
  }

  private renderTiming(root: HTMLElement) {
    this.advanceDirectRunClock(root);
    const now = Date.now();
    const run = this.snapshot?.run;
    root.querySelector("#top-utc")!.textContent = new Date(now).toISOString().slice(11, 19);
    root.querySelector("#top-local-time")!.textContent = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    root.querySelector("#top-session-elapsed")!.textContent = formatDuration(run ? sessionElapsedMs(run, now) : 0);
    root.querySelector("#top-task-elapsed")!.textContent = formatDuration(run ? takeElapsedMs(run, now) : 0);
    const recording = root.querySelector("#recording-elapsed");
    if (recording) recording.textContent = formatDuration(run ? recordingElapsedMs(run, now) : 0);
    const remaining = this.snapshot ? taskRemainingMs(this.snapshot, now) : null;
    root.querySelector("#top-task-remaining")!.textContent = remaining === null ? "--:--.-" : formatDuration(remaining);
    this.renderActiveTaskProgress(root, remaining);
    this.renderPairingCountdown(root, now);
    this.renderRunPresentation(root);
  }

  private renderActiveTaskProgress(root: HTMLElement, remainingMs: number | null) {
    root.querySelectorAll<HTMLElement>(".task-slice").forEach((slice) => {
      slice.classList.remove("is-running");
      slice.style.removeProperty("--task-remaining");
      delete slice.dataset.remainingPercent;
    });
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.run.status !== "running" || snapshot.run.phase !== "active-task") return;
    const task = snapshot.configuration.tasks[snapshot.run.activeTaskIndex];
    const slice = root.querySelector<HTMLElement>(`.task-slice[data-index="${snapshot.run.activeTaskIndex}"]`);
    if (!task || !slice) return;
    const fraction = task.type === "open" || remainingMs === null || task.durationS <= 0
      ? 1
      : Math.max(0, Math.min(1, remainingMs / (task.durationS * 1_000)));
    slice.classList.add("is-running");
    slice.style.setProperty("--task-remaining", `${(fraction * 100).toFixed(2)}%`);
    slice.dataset.remainingPercent = String(Math.round(fraction * 100));
  }

  private advanceDirectRunClock(root: HTMLElement) {
    if (this.advancingDirectRunClock || !isPeerConnectionMode(this.connectionProfile) || !this.controlTransportConnected()) return;
    this.advancingDirectRunClock = true;
    try {
      const commands = this.directSession.advanceTime();
      if (commands.length === 0) return;
      this.renderSnapshot(root, this.directSession.snapshot);
      this.queueCommittedDirectCommands(root, commands, "DIRECT RUN TIMER FAILED");
    } catch (error) {
      this.showError(root, error, "DIRECT RUN TIMER FAILED");
    } finally {
      this.advancingDirectRunClock = false;
    }
  }

  private renderPairingCountdown(root: HTMLElement, now: number) {
    const expiresAt = this.pairingRoom ? Date.parse(this.pairingRoom.expiresAt) : Number.NaN;
    const seconds = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / 1_000)) : null;
    const label = seconds === null ? "--:--" : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    root.querySelectorAll<HTMLElement>("#pairing-invitation-expiry, #pairing-qr-expiry, #local-pairing-expiry").forEach((element) => { element.textContent = label; });
    const output = root.querySelector<HTMLOutputElement>("#local-pairing-code");
    const elapsedFraction = Number.isFinite(expiresAt)
      ? Math.min(1, Math.max(0, 1 - ((expiresAt - now) / pairingInvitationLifetimeMs)))
      : 0;
    output?.style.setProperty("--pairing-expiry-progress", `${(elapsedFraction * 100).toFixed(2)}%`);
    const surface = root.querySelector<HTMLElement>("#pairing-invitation");
    if (!surface || seconds !== 0 || surface.dataset.expired === "true") return;
    this.expirePairingInvitation(root);
  }

  private renderRunPresentation(root: HTMLElement) {
    const controlsRoot = root.querySelector<HTMLElement>("#top-run-controls")!;
    const snapshot = this.snapshot;
    const visibleTasks = root.querySelectorAll(".task-slice").length;
    const transportConnected = this.controlTransportConnected();
    const controls = runControls(snapshot, transportConnected).map((control) => {
      const enabled = control.action === "start-sequence"
        ? control.enabled && !this.configurationPending && (!this.configurationDraft || visibleTasks > 0)
        : control.enabled;
      return { ...control, enabled };
    });
    controlsRoot.dataset.runStatus = snapshot?.run.status ?? "stopped";
    controlsRoot.dataset.runPhase = snapshot?.run.phase ?? "none";
    controlsRoot.dataset.recordingState = snapshot?.run.recordingState ?? "idle";
    if (controlsRoot.dataset.initialised !== "true") {
      controlsRoot.innerHTML = controls.map((control) => {
        const separator = control.slot === "pass" ? "<span class=\"hud-flex-gap\" aria-hidden=\"true\"></span>" : "";
        const timer = control.slot === "record" ? `<output id="recording-elapsed" class="recording-elapsed" aria-label="Recording elapsed time">${formatDuration(snapshot ? recordingElapsedMs(snapshot.run) : 0)}</output>` : "";
        return `${separator}<button type="button" data-slot="${control.slot}"></button>${timer}`;
      }).join("");
      controlsRoot.dataset.initialised = "true";
    }
    for (const control of controls) {
      const button = controlsRoot.querySelector<HTMLButtonElement>(`button[data-slot="${control.slot}"]`)!;
      const normalisedAction = control.action === "next" ? "next-task" : control.action;
      button.dataset.nextCursor = snapshot && isStateBoundRunControlAction(normalisedAction)
        ? nextRunControlCursor(snapshot, normalisedAction)
        : "";
      const unavailable = transportConnected ? "" : "Monitor link unavailable";
      const blockers = control.slot === "record" && !control.enabled
        ? snapshot?.recordingReadiness.blockers.map((blocker) => blocker.message).join(" / ")
        : "";
      const shortcutKey = control.slot in directorShortcutKeyBySlot
        ? directorShortcutKeyBySlot[control.slot as DirectorShortcutSlot]
        : null;
      const activeShortcutKey = control.slot === "run" && control.action !== "start-sequence" ? null : shortcutKey;
      if (activeShortcutKey) button.setAttribute("aria-keyshortcuts", activeShortcutKey);
      else button.removeAttribute("aria-keyshortcuts");
      const title = unavailable || blockers || `${control.label}${activeShortcutKey ? ` (${activeShortcutKey})` : ""}`;
      const signature = JSON.stringify({ ...control, title });
      if (button.dataset.presentationSignature === signature) continue;
      button.dataset.presentationSignature = signature;
      button.className = `top-run-control control-${control.slot} tone-${control.tone}`;
      button.dataset.control = control.action;
      button.dataset.controlState = control.state;
      button.setAttribute("aria-label", control.label);
      if (control.pressed) button.setAttribute("aria-pressed", "true");
      else button.removeAttribute("aria-pressed");
      button.title = title;
      button.disabled = !control.enabled;
      if (control.enabled) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
      button.innerHTML = control.slot === "run"
        ? `<span class="run-control-label">${escapeHtml(control.label.toUpperCase())}</span>`
        : `${controlIcon(control.slot, control.action)}<span class="sr-only">${escapeHtml(control.label)}</span>`;
    }
  }

  private renderConnectionState(root: HTMLElement) {
    const transportConnected = this.controlTransportConnected();
    const deviceConnected = transportConnected && Boolean(this.snapshot?.captureConnected);
    this.updateLiveSessionMarker(deviceConnected);
    if (deviceConnected) this.closePairingQr(root);
    const run = this.snapshot?.run;
    const sequenceActive = run?.status === "running";
    const configurationEditable = !sequenceActive;
    this.syncDirectorAvailability(root, transportConnected);
    this.runEditor?.setLocked(sequenceActive);
    root.querySelector<HTMLButtonElement>("#load-draft")!.disabled = !configurationEditable;
    root.querySelectorAll<HTMLButtonElement>(".hand-mode-controls button").forEach((control) => {
      control.disabled = !transportConnected;
      control.title = transportConnected ? control.getAttribute("aria-label") ?? "" : "Connect the demonstrator to change hand visuals";
    });
    root.querySelector("#capture-link-dot")?.classList.toggle("is-live", deviceConnected);
    if (this.episodeReviewMode === "live") {
      const hasFrame = deviceConnected && Boolean(this.latestReadout || this.snapshot?.lastFrame);
      root.querySelector("#signal-empty")?.classList.toggle("is-hidden", hasFrame);
      const waitingDetail = deviceConnected ? "START XR / MOVE HANDS" : "CONNECT HEADSET / START XR";
      root.querySelector("#signal-empty-detail")!.textContent = waitingDetail;
    }
    if (!deviceConnected && this.episodeReviewMode === "live") {
      this.renderHandEnergy(root, "left", 0, false, false);
      this.renderHandEnergy(root, "right", 0, false, false);
      root.querySelector(".camera-viewport")?.classList.remove("has-hand-detections");
      if (!this.peer) {
        root.querySelector(".camera-viewport")?.classList.remove("has-video");
        root.querySelector<HTMLVideoElement>("#live-video")!.srcObject = null;
        root.querySelector("#video-empty")!.classList.remove("is-hidden");
      }
    }
    this.renderRunPresentation(root);
    this.syncRemoteActionAvailability(root);
  }

  private syncDirectorAvailability(root: HTMLElement, connected: boolean) {
    const inspector = root.querySelector<HTMLElement>(".inspector-pane")!;
    const connection = inspector.querySelector<HTMLElement>(".connection-inspector")!;
    root.dataset.directorConnected = String(connected);
    connection.classList.toggle("is-connected", connected);
    const exportPanel = inspector.querySelector<HTMLElement>('[data-sidebar-panel="export"]')!;
    exportPanel.inert = false;
    exportPanel.classList.remove("director-unavailable");
    exportPanel.setAttribute("aria-disabled", "false");
    const exportTab = inspector.querySelector<HTMLButtonElement>('[data-sidebar-tab="export"]')!;
    exportTab.disabled = false;
    exportTab.setAttribute("aria-disabled", "false");
    inspector.querySelectorAll<HTMLElement>(".run-transport-section").forEach((section) => {
      section.inert = !connected;
      section.classList.toggle("director-unavailable", !connected);
      section.setAttribute("aria-disabled", String(!connected));
    });
  }

  private storeConnectionPreference() {
    storeMonitorConnectionPreference(this.sessionId, {
      profile: this.connectionProfile,
      panel: this.connectionPanel,
    });
  }

  private setClockConnection(root: HTMLElement, connected: boolean) {
    const state = root.querySelector<HTMLElement>("#connection-state")!;
    state.textContent = connected ? "LINKED" : "LOST";
    state.classList.toggle("is-lost", !connected);
  }

  private requestFeed(force = false) {
    if (this.disposed) return;
    if (this.requestedFeed && !force) return;
    if (this.webRtcSignal) {
      this.requestedFeed = this.webRtcSignal.requestOffer();
      this.scheduleOfferRequestRetry();
      return;
    }
    if (!this.socketConnected || !this.snapshot?.captureConnected) return;
    this.requestedFeed = true;
    this.session.send({ type: "webrtc-request-offer" });
  }

  private scheduleOfferRequestRetry() {
    if (this.disposed
      || !this.webRtcSignal
      || !this.directSignallingConnected
      || this.peer
      || this.peerControlChannel?.readyState === "open") {
      this.clearOfferRequestRetry(false);
      return;
    }
    if (this.offerRequestRetryTimer !== null) return;
    const delay = Math.min(5_000, 500 * 2 ** Math.min(this.offerRequestAttempt, 4));
    this.offerRequestAttempt += 1;
    this.offerRequestRetryTimer = window.setTimeout(() => {
      this.offerRequestRetryTimer = null;
      if (this.disposed
        || !this.webRtcSignal
        || !this.directSignallingConnected
        || this.peer
        || this.peerControlChannel?.readyState === "open") {
        this.clearOfferRequestRetry(false);
        return;
      }
      this.requestedFeed = false;
      this.requestFeed(true);
    }, delay);
  }

  private clearOfferRequestRetry(resetAttempt = true) {
    if (this.offerRequestRetryTimer !== null) window.clearTimeout(this.offerRequestRetryTimer);
    this.offerRequestRetryTimer = null;
    if (resetAttempt) this.offerRequestAttempt = 0;
  }

  private activeRelayedIceServers() {
    return this.relayedTurnFallback.activePermit()?.iceServers ?? null;
  }

  private resetTurnFallback() {
    this.relayedTurnFallback.reset();
  }

  private clearTurnFallbackWatchdog() {
    if (this.turnFallbackWatchdogTimer !== null) window.clearTimeout(this.turnFallbackWatchdogTimer);
    this.turnFallbackWatchdogTimer = null;
  }

  private scheduleTurnFallbackWatchdog(root: HTMLElement, generation: number) {
    this.clearTurnFallbackWatchdog();
    this.turnFallbackWatchdogTimer = window.setTimeout(() => {
      this.turnFallbackWatchdogTimer = null;
      if (this.disposed || !this.relayedTurnFallback.isCurrent(generation)) return;
      if (this.peer?.connectionState === "connected") {
        this.relayedTurnFallback.fail(generation);
        return;
      }
      this.resetVideoPeer(root);
      this.directSession.setCaptureConnected(false);
      this.renderSnapshot(root, this.directSession.snapshot);
      this.showActivity(root, "TURN RESTART TIMED OUT; RETRYING WITH A FRESH PERMIT", "system");
      if (this.webRtcSignal && this.directSignallingConnected) this.scheduleOfferRequestRetry();
    }, 8_000);
  }

  private resetVideoPeer(root: HTMLElement) {
    this.revokePeerTelemetryAuthority();
    const peer = this.peer;
    this.stopAudioSpectrum(root);
    this.clearPendingBeamDeliveries(root);
    this.peer = null;
    this.webRtcJourneyOutcome = null;
    this.rtcPeerId = null;
    this.rtcNegotiationId = null;
    this.requestedFeed = false;
    this.clearOfferRequestRetry();
    this.pendingIceCandidates.clear();
    this.remoteDescriptionReadyPeers.clear();
    this.peerControlChannel = null;
    this.peerRecorderAssembler.reset();
    this.clearTurnFallbackWatchdog();
    this.resetTurnFallback();
    peer?.close();
    this.liveVideoStream = null;
    if (this.episodeReviewMode === "live") root.querySelector(".camera-viewport")?.classList.remove("has-video", "has-hand-detections");
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    if (this.episodeReviewMode === "live" && this.videoFrameCallback !== null && "cancelVideoFrameCallback" in video) {
      video.cancelVideoFrameCallback(this.videoFrameCallback);
      this.videoFrameCallback = null;
    }
    if (this.episodeReviewMode === "live") video.srcObject = null;
    this.syncCameraOverlay(root);
    if (this.episodeReviewMode === "live") root.querySelector("#video-empty")!.classList.remove("is-hidden");
  }

  private revokePeerTelemetryAuthority() {
    this.directSession.resetTelemetryModeAuthority();  }

  private updateLiveSessionMarker(connected: boolean) {
    try {
      const stored = localStorage.getItem(monitorLiveSessionStorageKey);
      const current = stored ? JSON.parse(stored) as { sessionId?: unknown; connectedAtMs?: unknown } : null;
      if (!connected) {
        if (current?.sessionId === this.sessionId) localStorage.removeItem(monitorLiveSessionStorageKey);
        return;
      }
      const connectedAtMs = current?.sessionId === this.sessionId && typeof current.connectedAtMs === "number"
        ? current.connectedAtMs
        : Date.now();
      localStorage.setItem(monitorLiveSessionStorageKey, JSON.stringify({
        sessionId: this.sessionId,
        connectedAtMs,
        mode: this.connectionProfile.mode,
      }));
    } catch {
      // Account usage remains server-derived when browser storage is unavailable.
    }
  }

  private startAudioSpectrum(root: HTMLElement, track: MediaStreamTrack) {
    this.stopAudioSpectrum(root);
    const canvas = root.querySelector<HTMLCanvasElement>("#audio-spectrum-canvas");
    const empty = root.querySelector<HTMLElement>("#audio-spectrum-empty");
    const context2d = canvas?.getContext("2d");
    if (!canvas || !context2d || typeof AudioContext === "undefined") {
      if (empty) empty.textContent = "AUDIO UNAVAILABLE";
      return;
    }
    const audioContext = new AudioContext({ latencyHint: "interactive" });
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = .72;
    source.connect(analyser);
    this.audioSpectrumContext = audioContext;
    this.audioSpectrumSource = source;
    this.audioSpectrumAnalyser = analyser;
    const samples = new Uint8Array(analyser.frequencyBinCount);
    context2d.fillStyle = semanticColours.surface;
    context2d.fillRect(0, 0, canvas.width, canvas.height);
    if (empty) empty.classList.add("is-hidden");
    const draw = () => {
      if (this.disposed || this.audioSpectrumAnalyser !== analyser || track.readyState === "ended") return;
      analyser.getByteFrequencyData(samples);
      context2d.globalAlpha = 1;
      context2d.drawImage(canvas, -2, 0);
      context2d.fillStyle = semanticColours.surface;
      context2d.fillRect(canvas.width - 2, 0, 2, canvas.height);
      for (let y = 0; y < canvas.height; y += 1) {
        const index = Math.min(samples.length - 1, Math.floor((1 - y / Math.max(1, canvas.height - 1)) * samples.length));
        const strength = samples[index] ?? 0;
        context2d.globalAlpha = Math.max(.06, strength / 255);
        context2d.fillStyle = strength > 205 ? semanticColours.warning : semanticColours.action;
        context2d.fillRect(canvas.width - 2, y, 2, 1);
      }
      context2d.globalAlpha = 1;
      this.audioSpectrumFrame = window.requestAnimationFrame(draw);
    };
    this.audioSpectrumFrame = window.requestAnimationFrame(draw);
    const resume = () => {
      if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined);
    };
    resume();
    root.addEventListener("pointerdown", resume, { once: true });
    track.addEventListener("ended", () => {
      if (this.audioSpectrumAnalyser === analyser) this.stopAudioSpectrum(root);
    }, { once: true });
  }

  private stopAudioSpectrum(root: HTMLElement) {
    if (this.audioSpectrumFrame !== null && typeof window !== "undefined") window.cancelAnimationFrame(this.audioSpectrumFrame);
    this.audioSpectrumFrame = null;
    this.audioSpectrumSource?.disconnect();
    this.audioSpectrumAnalyser?.disconnect();
    this.audioSpectrumSource = null;
    this.audioSpectrumAnalyser = null;
    if (this.audioSpectrumContext) void this.audioSpectrumContext.close().catch(() => undefined);
    this.audioSpectrumContext = null;
    const canvas = root.querySelector<HTMLCanvasElement>("#audio-spectrum-canvas");
    const context2d = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (canvas && context2d) {
      context2d.fillStyle = colourWithAlpha(semanticColours.surface, 1);
      context2d.fillRect(0, 0, canvas.width, canvas.height);
    }
    const empty = root.querySelector<HTMLElement>("#audio-spectrum-empty");
    if (empty) {
      empty.textContent = "NO AUDIO";
      empty.classList.remove("is-hidden");
    }
  }

  private clearPendingBeamDeliveries(root: HTMLElement | null) {
    const result = clearInterruptedBeamDeliveries(
      this.pendingBeamDeliveries,
      root?.dataset.lastBeamDeliveryId ?? null,
    );
    if (!result.hadPending || !root) return;
    if (result.displayedDeliveryInterrupted) root.dataset.lastBeamDeliveryState = "interrupted";
    this.showActivity(root, "BEAM DELIVERY INTERRUPTED", "error");
  }

  private wireCameraOverlay(root: HTMLElement) {
    const viewport = root.querySelector<HTMLElement>(".camera-viewport")!;
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    const sync = () => this.syncCameraOverlay(root);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("resize", sync);
    this.cameraOverlayObserver?.disconnect();
    this.cameraOverlayObserver = new ResizeObserver(sync);
    this.cameraOverlayObserver.observe(viewport);
    sync();
  }

  private syncCameraOverlay(root: HTMLElement) {
    const viewport = root.querySelector<HTMLElement>(".camera-viewport")!;
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    const canvas = root.querySelector<HTMLCanvasElement>("#pose-canvas")!;
    const rect = containedVideoRect(viewport.clientWidth, viewport.clientHeight, video.videoWidth, video.videoHeight);
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }

  private startVideoFrameSync(video: HTMLVideoElement) {
    if (!("requestVideoFrameCallback" in video)) return;
    const present = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      const captureTime = Number((metadata as VideoFrameCallbackMetadata & { captureTime?: number }).captureTime);
      this.session.presentVideoFrame(Number.isFinite(captureTime) ? performance.timeOrigin + captureTime : Date.now() - 100);
      this.videoFrameCallback = video.requestVideoFrameCallback(present);
    };
    if (this.videoFrameCallback !== null) video.cancelVideoFrameCallback(this.videoFrameCallback);
    this.videoFrameCallback = video.requestVideoFrameCallback(present);
  }

  private saveConfiguration(root: HTMLElement) {
    const configuration = this.readDraftConfiguration(root);
    storeMonitorRunConfiguration(this.sessionId, configuration);
    const connected = this.controlTransportConnected();
    const revision = (this.snapshot?.configurationStatus.revision ?? 0) + 1;
    this.configurationDraft = false;
    this.configurationPending = connected;
    this.pendingConfigurationRevision = connected ? revision : null;
    this.renderConfigurationState(root);
    try {
      this.configureSession(root, configuration);
      this.showActivity(root, connected ? "RUN SENT" : "RUN SET LOCALLY", "system");
    } catch (error) {
      this.configurationDraft = true;
      this.configurationPending = false;
      this.pendingConfigurationRevision = null;
      this.renderConfigurationState(root);
      this.showError(root, error, "RUN APPLY FAILED");
    }
  }

  private readDraftConfiguration(root: HTMLElement): CaptureConfiguration {
    const current = this.snapshot?.configuration ?? defaultConfiguration;
    const editor = this.runEditor?.readConfiguration() ?? current;
    return {
      ...current,
      runTitle: editor.runTitle,
      runDescription: editor.runDescription,
      totalCycles: editor.totalCycles,
      tasks: editor.tasks,
      recordAudio: editor.recordAudio,
      studyMetadata: editor.studyMetadata,
      sttProvider: root.querySelector<HTMLSelectElement>("#setting-stt-provider")!.value as CaptureConfiguration["sttProvider"],
      uploadAfterEpisode: root.querySelector<HTMLInputElement>("#hf-after-episode")!.checked,
      hfRepository: this.repositoryName(root),
      hfPrivate: root.querySelector<HTMLButtonElement>("#hf-private")!.getAttribute("aria-pressed") === "true",
      promptAudio: {
        ...current.promptAudio,
        enabled: root.querySelector<HTMLInputElement>("#setting-cue-sounds")!.checked,
        useTextToSpeech: root.querySelector<HTMLInputElement>("#setting-voice-cues")!.checked,
        ttsProvider: root.querySelector<HTMLSelectElement>("#setting-tts-provider")!.value as CaptureConfiguration["promptAudio"]["ttsProvider"],
      },
    };
  }

  private repositoryName(root: HTMLElement) {
    const organisation = root.querySelector<HTMLSelectElement>("#hf-organisation")!.value.trim().replace(/\/+$/g, "");
    const requestedName = root.querySelector<HTMLInputElement>("#hf-repository")!.value.trim();
    const active = this.snapshot?.configuration.tasks[this.snapshot.run.activeTaskIndex];
    const task = (active?.label ?? "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task";
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
    const name = requestedName || `capture-${timestamp}-${task}`;
    return organisation ? `${organisation}/${name}` : name;
  }

  private materialiseRepositoryName(root: HTMLElement) {
    const input = root.querySelector<HTMLInputElement>("#hf-repository")!;
    const repository = this.repositoryName(root);
    if (!input.value.trim()) this.setRepositoryFields(root, repository);
    return repository;
  }

  private setRepositoryFields(root: HTMLElement, repository: string) {
    const separator = repository.indexOf("/");
    root.querySelector<HTMLSelectElement>("#hf-organisation")!.value = separator >= 0 ? repository.slice(0, separator) : "";
    root.querySelector<HTMLInputElement>("#hf-repository")!.value = separator >= 0 ? repository.slice(separator + 1) : repository;
  }

  private setDeliveryFields(root: HTMLElement, configuration: CaptureConfiguration) {
    root.querySelector<HTMLInputElement>("#hf-after-episode")!.checked = configuration.uploadAfterEpisode;
    this.setRepositoryPrivacy(root, configuration.hfPrivate);
    root.querySelector<HTMLInputElement>("#setting-cue-sounds")!.checked = configuration.promptAudio.enabled;
    root.querySelector<HTMLInputElement>("#setting-voice-cues")!.checked = configuration.promptAudio.useTextToSpeech;
    root.querySelector<HTMLSelectElement>("#setting-tts-provider")!.value = configuration.promptAudio.ttsProvider;
    root.querySelector<HTMLSelectElement>("#setting-stt-provider")!.value = configuration.sttProvider;
  }

  private setRepositoryPrivacy(root: HTMLElement, isPrivate: boolean) {
    const button = root.querySelector<HTMLButtonElement>("#hf-private")!;
    button.setAttribute("aria-pressed", String(isPrivate));
    button.setAttribute("aria-label", isPrivate ? "Private repository enabled" : "Private repository disabled");
    button.title = isPrivate ? "Private repository" : "Public repository";
  }

  private saveDraft(root: HTMLElement) {
    try {
      const serialised = JSON.stringify({ schema: "ceres-run-v5", configuration: this.readDraftConfiguration(root) }, null, 2);
      const url = URL.createObjectURL(new Blob([serialised], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `ceres-run-${this.session.sessionId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      this.showActivity(root, "RUN SAVED", "system");
    } catch {
      this.showActivity(root, "SAVE FAILED", "error");
    }
  }

  private async openTaskEditor(root: HTMLElement) {
    try {
      const { TaskImportWorkspace } = await import("./task-import-browser.js");
      this.taskImportWorkspace ??= new TaskImportWorkspace({
        root,
        readConfiguration: () => this.readDraftConfiguration(root),
        applyConfiguration: (configuration) => {
          this.runEditor?.applyConfiguration(configuration);
        },
        hasUnsavedChanges: () => this.configurationDraft,
        openOverlay: () => this.openOverlay(root, "task-editor-modal", "#task-editor-close"),
        closeOverlay: () => {
          this.saveConfiguration(root);
          this.closeOverlay(root, "task-editor-modal");
        },
      });
      this.taskImportWorkspace.open();
    } catch {
      this.showActivity(root, "TASK EDITOR UNAVAILABLE", "error");
    }
  }

  private openCalibration(root: HTMLElement) {
    if (!this.controlTransportConnected() || !this.snapshot?.captureConnected || this.snapshot.captureStatus.camera !== "ready") return;
    const status = this.snapshot.captureStatus;
    if (!status.selectedCameraDeviceId || !status.selectedCameraLabel || !status.selectedCameraWidth || !status.selectedCameraHeight) {
      this.showActivity(root, "CAMERA IDENTITY UNAVAILABLE", "error");
      return;
    }
    this.stopCalibrationCapture();
    this.drawCharuco(root.querySelector<HTMLCanvasElement>("#charuco-board")!);
    this.calibrationCaptures = 0;
    this.calibrationObservations.length = 0;
    this.calibrationCapturePending = false;
    this.calibrationCameraDeviceId = status.selectedCameraDeviceId;
    this.calibrationCameraLabel = status.selectedCameraLabel;
    this.calibrationCameraSide = status.selectedCameraSide ?? "unknown";
    this.calibrationWidth = status.selectedCameraWidth;
    this.calibrationHeight = status.selectedCameraHeight;
    this.calibrationState = "ACQUIRING";
    this.renderCalibrationProgress(root);
    this.openOverlay(root, "calibration-modal", "#calibration-close");
    root.querySelector("#calibration-status")!.textContent = `Acquiring ${calibrationFrameTarget} views from ${status.selectedCameraLabel}. Cover the centre and every edge at near, middle and far distances, with board rotation and tilt.`;
    void this.captureCalibrationFrame(root);
    this.calibrationCaptureTimer = window.setInterval(() => void this.captureCalibrationFrame(root), calibrationCaptureIntervalMs);
  }

  private closeCalibration(root: HTMLElement) {
    this.stopCalibrationCapture();
    this.closeOverlay(root, "calibration-modal");
  }

  private async captureCalibrationFrame(root: HTMLElement) {
    const modal = root.querySelector<HTMLElement>("#calibration-modal")!;
    if (modal.hidden) return this.stopCalibrationCapture();
    if (this.calibrationCapturePending || this.calibrationState !== "ACQUIRING") return;
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    if (!video.videoWidth || !video.videoHeight) {
      root.querySelector("#calibration-status")!.textContent = "Waiting for a live camera frame.";
      return;
    }
    this.calibrationCapturePending = true;
    try {
      const status = this.snapshot?.captureStatus;
      if (!status?.selectedCameraDeviceId || status.selectedCameraDeviceId !== this.calibrationCameraDeviceId) {
        throw new Error("The selected camera changed during calibration. Retry with one outward camera selected.");
      }
      if (video.videoWidth !== this.calibrationWidth || video.videoHeight !== this.calibrationHeight) {
        throw new Error("The camera capture dimensions changed during calibration. Retry after the camera stream is stable.");
      }
      const observation = await captureCalibrationObservation(video);
      if (!observation) {
        root.querySelector("#calibration-status")!.textContent = "Board not detected. Keep the complete board in the camera view.";
        return;
      }
      if (!isNovelCalibrationObservation(observation, this.calibrationObservations, video.videoWidth, video.videoHeight)) {
        const guidance = calibrationCoverageGuidance(this.calibrationObservations, video.videoWidth, video.videoHeight);
        root.querySelector("#calibration-status")!.textContent = `${this.calibrationCaptures}/${calibrationFrameTarget} views accepted. Next capture needs ${guidance}.`;
        return;
      }
      this.calibrationObservations.push(observation);
      this.calibrationCaptures = this.calibrationObservations.length;
      this.renderCalibrationProgress(root);
      if (this.calibrationCaptures < calibrationFrameTarget) {
        const guidance = calibrationCoverageGuidance(this.calibrationObservations, video.videoWidth, video.videoHeight);
        root.querySelector("#calibration-status")!.textContent = `${this.calibrationCaptures}/${calibrationFrameTarget} views accepted from ${video.videoWidth} x ${video.videoHeight}. Next capture needs ${guidance}.`;
        return;
      }
      this.stopCalibrationCapture();
      this.calibrationState = "SOLVING";
      this.renderCalibrationProgress(root);
      root.querySelector("#calibration-status")!.textContent = "Solving pinhole intrinsics and lens distortion.";
      this.cameraCalibration = await solveCameraIntrinsics(this.calibrationObservations, video.videoWidth, video.videoHeight);
      if (!this.calibrationCameraDeviceId || !this.calibrationCameraLabel) throw new Error("The selected camera identity is unavailable");
      this.cameraRegistration = cameraRegistrationFromCalibration(
        this.cameraCalibration,
        this.calibrationCameraDeviceId,
        this.calibrationCameraLabel,
        this.calibrationCameraSide,
        Date.now(),
        status.selectedCameraFrame,
      );
      storeCameraRegistration(localStorage, this.cameraRegistration);
      this.activeCameraRegistrationKey = cameraRegistrationStatusKey(
        this.cameraRegistration.cameraDeviceId,
        this.cameraRegistration.side,
        this.cameraRegistration.width,
        this.cameraRegistration.height,
        status.selectedCameraFrame,
      );
      this.calibrationState = "CALIBRATED";
      this.renderCalibrationProgress(root);
      this.syncVisualSettings();
      this.publishCameraRegistration(root, this.cameraRegistration);
      root.querySelector("#calibration-status")!.textContent = `Calibration complete. RMS ${this.cameraCalibration.rms.toFixed(2)} px overall, ${this.cameraCalibration.reprojection.maximumRms.toFixed(2)} px worst region.`;
    } catch (error) {
      this.stopCalibrationCapture();
      this.calibrationState = "FAILED";
      this.renderCalibrationProgress(root);
      root.querySelector("#calibration-status")!.textContent = error instanceof Error ? error.message : "Camera calibration failed.";
    } finally {
      this.calibrationCapturePending = false;
    }
  }

  private renderCalibrationProgress(root: HTMLElement) {
    root.querySelector("#camera-calibration-state")!.textContent = this.calibrationState;
    root.querySelector("#camera-calibration-samples")!.textContent = `${this.calibrationCaptures}/${calibrationFrameTarget}`;
    if (this.calibrationWidth && this.calibrationHeight) root.querySelector("#camera-resolution")!.textContent = `${this.calibrationWidth} x ${this.calibrationHeight}`;
    const calibration = this.cameraCalibration;
    root.querySelector("#camera-intrinsics-focal")!.textContent = calibration ? `${calibration.fx.toFixed(1)} / ${calibration.fy.toFixed(1)}` : "-- / --";
    root.querySelector("#camera-intrinsics-centre")!.textContent = calibration ? `${calibration.cx.toFixed(1)} / ${calibration.cy.toFixed(1)}` : "-- / --";
    root.querySelector("#camera-intrinsics-distortion")!.textContent = calibration ? calibration.distortion.map((value) => value.toFixed(4)).join(" ") : "--";
    root.querySelector("#camera-intrinsics-rms")!.textContent = calibration ? `${calibration.rms.toFixed(2)} PX` : "-- PX";
  }

  private renderCameraInspector(root: HTMLElement, status: CaptureStatus) {
    const cameraReady = Boolean(this.snapshot?.captureConnected && status.camera === "ready");
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    const width = status.selectedCameraWidth ?? (video.videoWidth || this.calibrationWidth);
    const height = status.selectedCameraHeight ?? (video.videoHeight || this.calibrationHeight);
    const side = status.selectedCameraSide === "unknown" ? "" : ` / ${status.selectedCameraSide.toUpperCase()}`;
    const outputRegistration = status.selectedCameraFrame
      ? cameraRegistrationForCaptureFrame(this.cameraRegistration, status.selectedCameraFrame)
      : this.cameraRegistration?.captureFrameKey ? null : this.cameraRegistration;
    const registered = cameraReady && cameraRegistrationMatches(
      outputRegistration,
      status.selectedCameraDeviceId,
      status.selectedCameraSide ?? "unknown",
      width,
      height,
    );
    root.querySelector("#camera-device-name")!.textContent = cameraReady ? `${status.selectedCameraLabel ?? "OUTWARD CAMERA"}${side}` : "NO CAMERA";
    root.querySelector("#camera-resolution")!.textContent = cameraReady && width && height ? `${width} x ${height}` : "-- x --";
    root.querySelector("#camera-frame-rate")!.textContent = cameraReady && status.selectedCameraFrameRate ? `${status.selectedCameraFrameRate.toFixed(1)} HZ` : "--";
    root.querySelector("#camera-alignment-state")!.textContent = registered ? "REGISTERED" : "UNREGISTERED";
    const projectionStatus = root.querySelector<HTMLElement>("#hand-projection-status")!;
    projectionStatus.textContent = registered ? "POSE REGISTERED" : "POSE UNREGISTERED";
    projectionStatus.classList.toggle("is-unregistered", !registered);
  }

  private stopCalibrationCapture() {
    if (this.calibrationCaptureTimer === null) return;
    window.clearInterval(this.calibrationCaptureTimer);
    this.calibrationCaptureTimer = null;
  }

  private drawCharuco(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d")!;
    const cell = 48;
    context.fillStyle = semanticColours.qrBackground;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 12; x += 1) {
      context.fillStyle = (x + y) % 2 ? semanticColours.qrForeground : semanticColours.qrBackground;
      context.fillRect(72 + x * cell, 48 + y * cell, cell, cell);
    }
  }

  private activeDraftTask() {
    const index = this.snapshot?.run.activeTaskIndex ?? 0;
    return this.runEditor?.readConfiguration().tasks[index]
      ?? this.snapshot?.configuration.tasks[index];
  }

  private syncDraftTaskDisplay(root: HTMLElement) {
    const editor = this.runEditor?.readConfiguration() ?? this.snapshot?.configuration ?? defaultConfiguration;
    const task = this.activeDraftTask();
    const taskDescription = task?.instructions.trim();
    const runDescription = editor.runDescription.trim() || editor.runTitle.trim();
    const runTitle = editor.runTitle.trim() || defaultConfiguration.runTitle;
    const runDescriptionText = editor.runDescription.trim();
    root.querySelector("#run-display-title")!.textContent = runTitle;
    root.querySelector("#run-display-description")!.textContent = runDescriptionText || "No run description";
    root.querySelector("#inspector-task-id")!.textContent = task?.label ?? "NO TASK";
    root.querySelector("#inspector-task-description")!.textContent = taskDescription && taskDescription !== "--"
      ? taskDescription
      : runDescription && runDescription !== "--"
        ? runDescription
        : "Open task";
    this.renderTiming(root);
  }

  private markConfigurationDraft(root: HTMLElement) {
    this.configurationDraft = true;
    this.configurationPending = false;
    storeMonitorRunConfiguration(this.sessionId, this.readDraftConfiguration(root));
    this.renderConfigurationState(root);
  }

  private renderConfigurationState(root: HTMLElement) {
    const element = root.querySelector<HTMLElement>("#configuration-state");
    if (!element) return;
    const status = this.snapshot?.configurationStatus;
    const state = this.configurationDraft ? "draft" : this.configurationPending ? "sent" : status?.state ?? "sent";
    const revision = status?.revision ?? 1;
    element.textContent = `${state.toUpperCase()} R${revision}`;
    element.classList.remove("is-draft", "is-sent", "is-applied", "is-error");
    element.classList.add(`is-${state}`);
    element.title = status?.error ?? (status?.checksum ? `Configuration ${status.checksum}` : "Configuration is waiting for capture acknowledgement");
    this.renderRunPresentation(root);
  }

  private toggleAudio(root: HTMLElement) {
    if (!this.snapshot || !this.controlTransportConnected()) {
      this.showActivity(root, "CONNECT THE DEMONSTRATOR TO CHANGE AUDIO CAPTURE", "error");
      return;
    }
    if (this.snapshot.run.status === "running") return;
    const configuration = { ...this.snapshot.configuration, recordAudio: !this.snapshot.configuration.recordAudio };
    this.runEditor?.applyConfiguration(configuration, false);
    this.configureSession(root, configuration);
    this.renderAudioToggle(root, configuration.recordAudio);
  }

  private renderAudioToggle(root: HTMLElement, enabled: boolean) {
    const button = root.querySelector<HTMLButtonElement>("#audio-toggle")!;
    button.querySelector("b")!.textContent = enabled ? "ON" : "OFF";
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("is-enabled", enabled);
    button.disabled = !this.controlTransportConnected() || this.snapshot?.run.status === "running";
    button.title = !this.controlTransportConnected()
      ? "Connect the demonstrator to change audio capture"
      : this.snapshot?.run.status === "running"
        ? "Audio capture is locked while the run is active"
        : enabled ? "Stop storing raw microphone audio. The microphone remains live for ASR." : "Store raw microphone audio. The microphone remains live for ASR.";
  }

  private renderAsrStatus(root: HTMLElement, state: AsrStatusState) {
    if (!this.speechEnabled()) return;
    const status = root.querySelector<HTMLElement>("#asr-state")!;
    status.dataset.state = state;
    status.querySelector("b")!.textContent = state === "ready" ? "READY" : state === "unavailable" ? "DOWN" : "ERR";
    status.title = state === "ready" ? "ASR gateway ready" : state === "unavailable" ? "ASR gateway unavailable" : "ASR gateway returned an invalid status";
  }

  private sendBeam(root: HTMLElement) {
    const input = root.querySelector<HTMLInputElement>("#beam-text")!;
    const text = input.value.trim();
    if (!text) return;
    const speak = this.speechEnabled() && root.querySelector<HTMLInputElement>("#beam-tts")!.checked;
    const visual = true;
    if (isPeerConnectionMode(this.connectionProfile)) {
      const deliveryId = crypto.randomUUID();
      this.pendingBeamDeliveries.add(deliveryId);
      root.dataset.lastBeamDeliveryId = deliveryId;
      root.dataset.lastBeamDeliveryState = "pending";
      try {
        this.sendDirectCommands(root, [{ type: "beam", deliveryId, text, speak, visual }]);
      } catch (error) {
        this.pendingBeamDeliveries.delete(deliveryId);
        root.dataset.lastBeamDeliveryState = "failed";
        this.showError(root, error, "BEAM DELIVERY FAILED");
        return;
      }
    } else {
      this.session.send({ type: "beam", text, speak, visual });
    }
    this.showActivity(root, `${isPeerConnectionMode(this.connectionProfile) ? "BEAM SENT" : "BEAM"} ${text}`, "system");
    input.value = "";
  }

  private async startBrowserUpload(root: HTMLElement) {
    let episodes: Episode[] | null = null;
    try {
      if (this.accountUploadPlanning) throw new Error("A Hugging Face destination inspection is already running");
      this.accountUploadPlanning = true;
      this.updateExportControls(root);
      episodes = this.selectedExportEpisodes();
      if (!episodes) throw new Error("Session episodes are not available");
      for (const episode of episodes) {      }
      this.materialiseRepositoryName(root);
      this.saveConfiguration(root);
      const upload = await this.prepareAccountUploadOptions(root);
      this.startBrowserExport(root, upload, episodes, true);
    } catch (error) {
      for (const episode of episodes ?? []) {}
      recordMonitorExportJourney("upload", "failed");
      this.reportExportStartError(root, error);
    } finally {
      this.accountUploadPlanning = false;
      this.updateExportControls(root);
    }
  }

  private startBrowserExport(
    root: HTMLElement,
    upload?: BackendUploadOptions,
    episodes?: Episode[],
    workflowStarted = false,
  ) {
    let queued = false;
    let exportEpisodes: Episode[] | null = null;
    try {
      exportEpisodes = episodes ?? this.selectedExportEpisodes();
      if (!exportEpisodes) throw new Error("Session episodes are not available");
      const catalogue = this.exportEpisodeCatalogue();
      if (!catalogue) throw new Error("Session episodes are not available");
      const lerobotStartedAtMs = performance.now();
      const requestId = this.exporter.start({
        sessionId: this.session.sessionId,
        episodes: catalogue,
        episodeIds: exportEpisodes.map((episode) => episode.id),
        exportCapability: this.session.exportCapability ?? undefined,
        source: isPeerConnectionMode(this.connectionProfile) ? "monitor-opfs" : "server",
        recorderRateHz: this.snapshot?.configuration.recorderRateHz,
        ...(upload
          ? {
              episodeIndexBase: upload.appendAllocation.nextEpisodeIndex,
              globalFrameIndexBase: upload.appendAllocation.nextGlobalFrameIndex,
            }
          : {}),
      });
      if (upload) this.backendUploadOptions.set(requestId, upload);
      this.browserJobs.unshift({
        id: requestId,
        type: upload ? "upload" : "export",
        state: "queued",
        detail: upload ? `Queued browser sync to ${upload.repository}@${upload.branch}` : "Queued browser export to OPFS",
        episodeIds: exportEpisodes.map((episode) => episode.id),
        lerobotStartedAtMs,
        deliveryStartedAtMs: upload ? lerobotStartedAtMs : null,
        ...(upload ? { activityStage: "queued" as const } : {}),
      });
      if (upload && !workflowStarted) {
        for (const episode of exportEpisodes) {}
      }
      recordMonitorExportJourney(upload ? "upload" : "export", "queued");
      queued = true;
      this.browserJobs.splice(8);
      this.updateExportControls(root);
      this.renderJobs(root);
      if (upload) this.showActivity(root, `HF QUEUED ${exportEpisodes.length} EPISODE${exportEpisodes.length === 1 ? "" : "S"} FOR ${upload.repository}@${upload.branch}`, "system");
    } catch (error) {
      if (upload) {
        for (const episode of exportEpisodes ?? []) {}
      }
      if (!queued) recordMonitorExportJourney(upload ? "upload" : "export", "failed");
      this.reportExportStartError(root, error);
    }
  }

  private async startFolderExport(root: HTMLElement) {
    let queued = false;
    try {
      const snapshot = this.snapshot;
      if (!snapshot) throw new Error("Session episodes are not available");
      const picker = (window as typeof window & {
        showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      if (!picker) throw new Error("File System Access directory selection is unavailable in this browser");
      const directoryHandle = await picker.call(window, { mode: "readwrite" });
      const episodes = this.selectedExportEpisodes();
      if (!episodes) throw new Error("Session episodes are not available");
      const catalogue = this.exportEpisodeCatalogue();
      if (!catalogue) throw new Error("Session episodes are not available");
      const lerobotStartedAtMs = performance.now();
      const requestId = this.exporter.start({
        sessionId: this.session.sessionId,
        episodes: catalogue,
        episodeIds: episodes.map((episode) => episode.id),
        exportCapability: this.session.exportCapability ?? undefined,
        source: isPeerConnectionMode(this.connectionProfile) ? "monitor-opfs" : "server",
        recorderRateHz: snapshot.configuration.recorderRateHz,
        directoryHandle,
      });
      this.browserJobs.unshift({
        id: requestId,
        type: "export",
        state: "queued",
        detail: `Queued folder export to ${directoryHandle.name}`,
        episodeIds: episodes.map((episode) => episode.id),
        lerobotStartedAtMs,
        deliveryStartedAtMs: null,
      });
      recordMonitorExportJourney("export", "queued");
      queued = true;
      this.browserJobs.splice(8);
      this.updateExportControls(root);
      this.renderJobs(root);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        recordMonitorExportJourney("export", "cancelled");
        return;
      }
      if (!queued) recordMonitorExportJourney("export", "failed");
      this.reportExportStartError(root, error);
    }
  }

  private selectedExportEpisodes() {
    const episodes = this.exportEpisodeCatalogue();
    if (!episodes) return null;
    const eligible = episodes.filter(isExportableEpisode);
    if (this.selectedEpisodeIds.size === 0) return eligible;
    return eligible.filter((episode) => this.selectedEpisodeIds.has(episode.id));
  }

  private exportEpisodeCatalogue() {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    return [...snapshot.episodes, ...snapshot.attempts]
      .filter((episode, index, entries) => entries.findIndex((candidate) => candidate.id === episode.id) === index);
  }

  private async toggleEpisodeSelection(root: HTMLElement, episodeId: string) {
    if (!this.snapshot || !episodeSelectionAvailable(this.snapshot.run.recordingState)) return;
    if (this.selectedEpisodeIds.has(episodeId)) this.selectedEpisodeIds.delete(episodeId);
    else this.selectedEpisodeIds.add(episodeId);
    root.querySelectorAll<HTMLButtonElement>("[data-episode-id]").forEach((button) => {
      const selected = this.selectedEpisodeIds.has(button.dataset.episodeId!);
      button.setAttribute("aria-pressed", String(selected));
      button.closest(".episode-block")?.classList.toggle("is-selected", selected);
    });
    this.updateExportControls(root);
    await this.renderSelectedEpisodeSignals(root);
  }

  private async deleteEpisode(root: HTMLElement, episodeId: string) {
    const episode = [...(this.snapshot?.episodes ?? []), ...(this.snapshot?.attempts ?? [])]
      .find((entry) => entry.id === episodeId);
    if (!episode) return;
    if (!window.confirm(`Delete episode ${episodeId}? This cannot be undone.`)) return;
    try {
      if (this.selectedEpisodeIds.delete(episodeId) || this.replayedEpisodeId === episodeId) this.clearEpisodeReplay(root);
      if (isPeerConnectionMode(this.connectionProfile)) {
        const previousSnapshot = this.directSession.snapshot;
        this.directSession.deleteEpisode(episodeId);
        try {
          await this.monitorRecorder.saveSnapshot(this.directSession.snapshot);
        } catch (error) {
          this.directSession.restore(previousSnapshot, previousSnapshot.captureConnected);
          throw error;
        }
        this.renderSnapshot(root, this.directSession.snapshot);
      } else this.session.send({ type: "delete-episode", episodeId });
      this.automaticUploadQueue.delete(episodeId);
      this.observedExportableEpisodes.delete(episodeId);
      this.showActivity(root, `EPISODE DELETED ${episodeId}`, "system");
    } catch (error) {
      this.showError(root, error, "EPISODE DELETE FAILED");
    }
  }

  private async renderSelectedEpisodeSignals(root: HTMLElement) {
    if (!this.snapshot || !episodeSelectionAvailable(this.snapshot.run.recordingState)) {
      this.clearEpisodeReplay(root);
      return;
    }
    if (this.selectedEpisodeIds.size !== 1) {
      this.clearEpisodeReplay(root);
      if (this.selectedEpisodeIds.size > 1) {
        root.querySelector("#signal-empty")!.classList.remove("is-hidden");
        root.querySelector("#signal-empty span")!.textContent = `${this.selectedEpisodeIds.size} EPISODES SELECTED`;
        root.querySelector("#signal-empty-detail")!.textContent = "EXPORT WILL INCLUDE ONLY THIS SELECTION";
      }
      return;
    }
    const episodeId = [...this.selectedEpisodeIds][0];
    if (episodeId === this.replayedEpisodeId) return;
    const episode = this.snapshot.episodes.find((entry) => entry.id === episodeId)
      ?? this.snapshot.attempts.find((entry) => entry.id === episodeId);
    if (!episode) return;
    this.clearEpisodeReplay(root);
    const controller = new AbortController();
    this.episodeReplayController = controller;
    const button = root.querySelector<HTMLButtonElement>(`[data-episode-id="${CSS.escape(episodeId)}"]`);
    const label = `${button?.querySelector("b")?.textContent ?? "EP"} ${button?.querySelector("span")?.textContent ?? ""}`.trim();
    this.episodeReviewMode = "loading";
    root.dataset.episodeReviewMode = "loading";
    this.suspendLiveVideo(root, "LOADING EPISODE", label);
    root.querySelector("#signal-source-label")!.textContent = "SIGNALS / LOADING";
    root.querySelector("#signal-empty")!.classList.remove("is-hidden");
    root.querySelector("#signal-empty span")!.textContent = "LOADING EPISODE";
    root.querySelector("#signal-empty-detail")!.textContent = label;
    try {
      const {
        fetchEpisodeExportManifest,
        isSensorFrameRow,
        loadMonitorOpfsEpisodeExportManifest,
        readEpisodeVideo,
        streamSensorRows,
      } = await import("./lerobot-export/episode-source.js");
      const manifest = isPeerConnectionMode(this.connectionProfile)
        ? await loadMonitorOpfsEpisodeExportManifest({
          sessionId: this.session.sessionId,
          episodes: this.exportEpisodeCatalogue() ?? [],
          recorderRateHz: this.snapshot.configuration.recorderRateHz,
        }, episodeId, controller.signal)
        : await fetchEpisodeExportManifest(
          this.session.sessionId,
          episodeId,
          controller.signal,
          this.session.exportCapability ?? undefined,
        );
      const framesPromise = (async () => {
        const frames: SensorFrame[] = [];
        for await (const line of streamSensorRows(manifest, controller.signal, () => undefined, this.session.exportCapability ?? undefined)) {
          if (!isSensorFrameRow(line)) continue;
          frames.push(JSON.parse(line) as SensorFrame);
          if (frames.length > 240) frames.shift();
        }
        if (frames.length === 0) throw new Error("Episode has no durable sensor frames");
        return frames;
      })();
      const [frames, video] = await Promise.all([
        framesPromise,
        readEpisodeVideo(manifest, controller.signal, this.session.exportCapability ?? undefined),
      ]);
      controller.signal.throwIfAborted();
      await this.presentEpisodeVideo(root, video, label, controller.signal);
      controller.signal.throwIfAborted();
      this.episodeReviewMode = "replay";
      root.dataset.episodeReviewMode = "replay";
      this.session.presentEpisodeFrames(frames);
      this.replayedEpisodeId = episodeId;
      root.querySelector("#signal-source-label")!.textContent = `SIGNALS / ${label}`;
      root.querySelector("#signal-empty")!.classList.add("is-hidden");
    } catch (error) {
      if (controller.signal.aborted) return;
      this.clearEpisodeReplay(root);
      root.querySelector("#signal-empty span")!.textContent = "EPISODE REVIEW UNAVAILABLE";
      root.querySelector("#signal-empty-detail")!.textContent = error instanceof Error ? error.message.toUpperCase().slice(0, 96) : label;
    } finally {
      if (this.episodeReplayController === controller) this.episodeReplayController = null;
    }
  }

  private clearEpisodeReplay(root: HTMLElement) {
    this.episodeReplayController?.abort();
    this.episodeReplayController = null;
    if (this.replayedEpisodeId !== null) this.session.clearEpisodeReplay();
    this.replayedEpisodeId = null;
    const restoreVideo = this.episodeReviewMode !== "live" || this.episodeVideoUrl !== null;
    this.episodeReviewMode = "live";
    root.dataset.episodeReviewMode = "live";
    root.dataset.monitorFrameSource = "live";
    if (restoreVideo) this.restoreLiveVideo(root);
    root.querySelector("#signal-source-label")!.textContent = "SIGNALS";
    if (this.selectedEpisodeIds.size <= 1) {
      root.querySelector("#signal-empty span")!.textContent = "NO SENSOR FRAMES";
      root.querySelector("#signal-empty-detail")!.textContent = this.snapshot?.captureConnected ? "WAITING FOR SENSOR FRAMES" : "CONNECT HEADSET / START XR";
      const hasLiveFrames = Boolean(this.latestReadout?.traceCount);
      root.querySelector("#signal-empty")!.classList.toggle("is-hidden", hasLiveFrames);
    }
  }

  private suspendLiveVideo(root: HTMLElement, state: string, detail: string) {
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    if (this.videoFrameCallback !== null && "cancelVideoFrameCallback" in video) {
      video.cancelVideoFrameCallback(this.videoFrameCallback);
      this.videoFrameCallback = null;
    }
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.loop = false;
    video.load();
    this.releaseEpisodeVideo();
    root.querySelector(".camera-viewport")?.classList.remove("has-video", "has-hand-detections");
    const empty = root.querySelector<HTMLElement>("#video-empty")!;
    empty.classList.remove("is-hidden");
    empty.querySelector("span")!.textContent = state;
    empty.querySelector("small")!.textContent = detail;
  }

  private async presentEpisodeVideo(root: HTMLElement, blob: Blob | null, label: string, signal: AbortSignal) {
    const empty = root.querySelector<HTMLElement>("#video-empty")!;
    if (!blob) {
      empty.classList.remove("is-hidden");
      empty.querySelector("span")!.textContent = "NO RECORDED VIDEO";
      empty.querySelector("small")!.textContent = label;
      return;
    }
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    const url = URL.createObjectURL(blob);
    this.episodeVideoUrl = url;
    video.srcObject = null;
    video.src = url;
    video.loop = true;
    const ready = this.waitForVideoData(video, signal);
    video.load();
    await ready;
    signal.throwIfAborted();
    root.querySelector(".camera-viewport")?.classList.add("has-video");
    empty.classList.add("is-hidden");
    await video.play().catch(() => undefined);
  }

  private waitForVideoData(video: HTMLVideoElement, signal: AbortSignal) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Episode video could not be decoded"));
      };
      const aborted = () => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("Episode review cancelled", "AbortError"));
      };
      video.addEventListener("loadeddata", loaded);
      video.addEventListener("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private restoreLiveVideo(root: HTMLElement) {
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.loop = false;
    video.load();
    this.releaseEpisodeVideo();
    const empty = root.querySelector<HTMLElement>("#video-empty")!;
    empty.querySelector("span")!.textContent = "NO VIDEO";
    empty.querySelector("small")!.textContent = this.snapshot?.captureConnected ? "WAITING FOR VIDEO" : "CONNECT HEADSET / START XR";
    const liveTrack = this.liveVideoStream?.getVideoTracks().find((track) => track.readyState === "live");
    if (!this.liveVideoStream || !liveTrack) {
      root.querySelector(".camera-viewport")?.classList.remove("has-video");
      empty.classList.remove("is-hidden");
      this.syncCameraOverlay(root);
      return;
    }
    video.srcObject = this.liveVideoStream;
    const showVideo = () => {
      if (this.episodeReviewMode !== "live" || video.srcObject !== this.liveVideoStream) return;
      root.querySelector(".camera-viewport")?.classList.add("has-video");
      empty.classList.add("is-hidden");
      this.syncCameraOverlay(root);
      this.startVideoFrameSync(video);
    };
    if (!liveTrack.muted) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) showVideo();
      else video.addEventListener("loadeddata", showVideo, { once: true });
    }
    void video.play().then(showVideo).catch(() => undefined);
  }

  private releaseEpisodeVideo() {
    if (this.episodeVideoUrl === null) return;
    URL.revokeObjectURL(this.episodeVideoUrl);
    this.episodeVideoUrl = null;
  }

  private accountUploadOptions(root: HTMLElement): Omit<BackendUploadOptions, "appendAllocation"> {
    const account = this.accountExportSession;
    if (
      !account?.signedIn
      || !account.subject
      || account.huggingFace.state !== "ready"
      || !account.huggingFace.subject
    ) {
      throw new Error("Connect Hugging Face through the CERES account before syncing");
    }
    const repository = this.materialiseRepositoryName(root);
    const branch = root.querySelector<HTMLInputElement>("#hf-branch")!.value.trim() || "main";
    if (!repository.includes("/")) throw new Error("Set the Hugging Face dataset repository before syncing");
    return {
      expectedAccountSubject: account.subject,
      expectedHuggingFaceSubject: account.huggingFace.subject,
      repository,
      branch,
      visibility: account.defaults.visibility,
    };
  }

  private async prepareAccountUploadOptions(root: HTMLElement, signal?: AbortSignal) {
    const options = this.accountUploadOptions(root);
    const [organisation = "", repository = "", ...remainder] = options.repository.split("/");
    if (remainder.length > 0 || !organisation || !repository) {
      throw new Error("Set a valid Hugging Face dataset repository before syncing");
    }
    const result = await this.accountExportClient.validateDestination({
      organisation,
      repository,
      branch: options.branch,
      visibility: options.visibility,
      missingRepositoryBehaviour: options.visibility,
    }, signal);
    if (
      result.version !== 1
      || result.repository !== options.repository
      || result.branch !== options.branch
      || result.visibility !== options.visibility
      || (result.availability !== "existing" && result.availability !== "creatable")
      || !isHuggingFaceAppendAllocation(result.append)
    ) {
      throw new Error("The account service returned an invalid Hugging Face destination");
    }
    return {
      ...options,
      repository: result.repository,
      branch: result.branch,
      visibility: result.visibility,
      appendAllocation: result.append,
    } satisfies BackendUploadOptions;
  }

  private handleExportEvent(root: HTMLElement, event: MonitorExportWorkerEvent) {
    const job = this.browserJobs.find((entry) => entry.id === event.requestId);
    if (!job || browserExportJobIsTerminal(job)) return;
    if (event.type === "media-profile") { return; }
    if (event.type === "progress") {
      job.state = "running";
      const percent = event.total > 0 ? Math.min(100, Math.floor(event.completed / event.total * 100)) : 0;
      job.detail = `${event.detail} ${percent}%${event.backend ? ` / ${event.backend}` : ""}`;
      const progress = root.querySelector<HTMLProgressElement>("#export-progress")!;
      progress.hidden = false;
      progress.value = percent / 100;
      if (job.type === "upload") {        const activityStage = event.stage === "uploading" ? "uploading" : event.stage === "queued" ? "queued" : "exporting";
        if (job.activityStage !== activityStage) {
          job.activityStage = activityStage;
          const context = event.episodeId ? ` ${event.episodeId}` : ` ${job.episodeIds.length} EPISODE${job.episodeIds.length === 1 ? "" : "S"}`;
          this.showActivity(root, `HF ${activityStage.toUpperCase()}${context}: ${event.detail.toUpperCase()}`, "system");
        }
      }
    } else if (event.type === "complete") {      const upload = this.backendUploadOptions.get(event.requestId);
      if (upload) {
        job.deliveryStartedAtMs ??= performance.now();        job.state = "running";
        job.activityStage = "uploading";
        job.detail = `${event.episodeCount} episodes / ${event.artifactCount} artefacts / requesting backend upload`;
        void this.completeBackendUpload(root, event.requestId, event.episodeIds, event.artefacts, upload);
      } else {
        job.state = "completed";
        job.detail = `${event.episodeCount} episodes / ${event.artifactCount} artefacts`;
        recordMonitorExportJourney(job.type, "completed");
      }
    } else {
      this.backendUploadOptions.delete(event.requestId);
      job.state = event.cancelled ? "cancelled" : "failed";
      job.detail = event.error;      if (job.type === "upload") {      }
      recordMonitorExportJourney(job.type, event.cancelled ? "cancelled" : "failed");
      if (!event.cancelled) {        if (job.type === "upload") this.showActivity(root, `HF UPLOAD FAILED ${event.error.toUpperCase()}`, "error");
        this.showJobError(root, event.error);
      }
    }
    if ((event.type === "complete" && !this.backendUploadOptions.has(event.requestId)) || event.type === "error") {
      root.querySelector<HTMLProgressElement>("#export-progress")!.hidden = true;
    }
    this.updateExportControls(root);
    this.renderJobs(root);
    if ((event.type === "complete" && !this.backendUploadOptions.has(event.requestId)) || event.type === "error") {
      this.drainAutomaticUpload(root);
    }
  }

  private async completeBackendUpload(
    root: HTMLElement,
    requestId: string,
    episodeIds: string[],
    artefacts: AccountUploadManifestArtefact[],
    options: BackendUploadOptions,
  ) {
    const job = this.browserJobs.find((entry) => entry.id === requestId);
    if (!job || browserExportJobIsTerminal(job) || this.backendUploadCompletions.has(requestId)) return;
    this.backendUploadCompletions.add(requestId);
    job.backendUploadRecovery = {
      artefacts: artefacts.map((artefact) => ({ ...artefact })),
      options: {
        ...options,
        appendAllocation: { ...options.appendAllocation },
      },
    };
    const abort = new AbortController();
    this.accountUploadAbort = abort;
    try {
      const currentDestination = await this.prepareAccountUploadOptions(root, abort.signal);
      if (
        currentDestination.expectedAccountSubject !== options.expectedAccountSubject
        || currentDestination.expectedHuggingFaceSubject !== options.expectedHuggingFaceSubject
        || currentDestination.repository !== options.repository
        || currentDestination.branch !== options.branch
        || currentDestination.visibility !== options.visibility
        || !sameHuggingFaceAppendAllocation(
          options.appendAllocation,
          currentDestination.appendAllocation,
        )
      ) {
        throw new Error("The Hugging Face dataset changed while the export was being prepared");
      }
      assertMonitorUploadArtefactAllocation(artefacts, currentDestination.appendAllocation);
      const accountJob = await this.accountExportClient.syncBrowserExport({
        expectedAccountSubject: options.expectedAccountSubject,
        expectedHuggingFaceSubject: options.expectedHuggingFaceSubject,
        sessionId: this.session.sessionId,
        repository: options.repository,
        branch: options.branch,
        appendAllocation: options.appendAllocation,
        visibility: options.visibility,
        episodeIds,
        artefacts,
        signal: abort.signal,
        onProgress: (progress) => {          job.state = progress.stage === "completed" ? "completed" : "running";
          job.detail = progress.detail;
          const value = progress.total > 0 ? Math.min(1, progress.completed / progress.total) : 0;
          const progressNode = root.querySelector<HTMLProgressElement>("#export-progress")!;
          progressNode.hidden = false;
          progressNode.value = value;
          this.renderJobs(root);
        },
      });
      const upload = verifiedEpisodeUploadFromAccountJob(
        accountJob,
        this.session.sessionId,
        episodeIds,
      );      job.accountUploadJobId = accountJob.id;
      job.state = "completed";
      job.detail = `Verified Hugging Face commit ${accountJob.finalCommit!.oid}`;
      delete job.backendUploadRecovery;
      recordMonitorExportJourney("upload", "completed");
      this.showActivity(
        root,
        `HF UPLOAD COMPLETED ${episodeIds.length} EPISODE${episodeIds.length === 1 ? "" : "S"} TO ${accountJob.repository}@${accountJob.branch}`,
        "system",
      );
      try {
        await this.persistBrowserUploadOutcome(root, episodeIds, upload);
      } catch (error) {
        job.detail = `Verified Hugging Face commit ${accountJob.finalCommit!.oid} / local receipt not saved`;        this.showActivity(root, "HF UPLOAD COMPLETED. LOCAL RECEIPT SAVE FAILED.", "error");
        this.showJobError(root, "The Hugging Face upload completed, but its local completion receipt could not be saved");
      }
    } catch (error) {
      if (error instanceof AccountUploadCancellationUnconfirmedError) {
        job.state = "running";
        job.detail = error.message;
        if (error.jobId) {
          job.accountUploadJobId = error.jobId;
        }
        this.startBackendUploadReconciliation(root, requestId, episodeIds, error.jobId);
        this.showActivity(
          root,
          "HF CANCELLATION UNCONFIRMED. RECONCILING THE EXISTING BACKEND UPLOAD.",
          "system",
        );
      } else {
        job.state = abort.signal.aborted ? "cancelled" : "failed";
        job.detail = abort.signal.aborted
          ? "Hugging Face upload cancelled"
          : error instanceof Error ? error.message : "Hugging Face upload failed";
        delete job.backendUploadRecovery;        recordMonitorExportJourney("upload", abort.signal.aborted ? "cancelled" : "failed");
      }
      if (!abort.signal.aborted && !(error instanceof AccountUploadCancellationUnconfirmedError)) {        this.showActivity(root, `HF UPLOAD FAILED ${job.detail.toUpperCase()}`, "error");
        this.showJobError(root, job.detail);
      }
    } finally {
      this.backendUploadOptions.delete(requestId);
      this.backendUploadCompletions.delete(requestId);
      if (this.accountUploadAbort === abort) this.accountUploadAbort = null;
      root.querySelector<HTMLProgressElement>("#export-progress")!.hidden = true;
      this.updateExportControls(root);
      this.renderJobs(root);
      this.drainAutomaticUpload(root);
    }
  }

  private startBackendUploadReconciliation(
    root: HTMLElement,
    requestId: string,
    episodeIds: readonly string[],
    accountUploadJobId: string | null,
  ) {
    if (
      this.disposed
      || this.backendUploadRecoveryControllers.has(requestId)
      || this.backendUploadRecoveryTimers.has(requestId)
    ) return;
    const abort = new AbortController();
    this.backendUploadRecoveryControllers.set(requestId, abort);
    void this.reconcileBackendUpload(
      root,
      requestId,
      episodeIds,
      accountUploadJobId,
      abort.signal,
    ).then((retry) => {
      if (this.backendUploadRecoveryControllers.get(requestId) === abort) {
        this.backendUploadRecoveryControllers.delete(requestId);
      }
      if (this.disposed) return;
      if (!retry) {
        this.updateExportControls(root);
        this.renderJobs(root);
        this.drainAutomaticUpload(root);
        return;
      }
      const timer = window.setTimeout(() => {
        this.backendUploadRecoveryTimers.delete(requestId);
        const latestJobId = this.browserJobs.find((entry) => entry.id === requestId)
          ?.accountUploadJobId ?? accountUploadJobId;
        this.startBackendUploadReconciliation(root, requestId, episodeIds, latestJobId);
      }, monitorAccountUploadRecoveryRetryMs);
      this.backendUploadRecoveryTimers.set(requestId, timer);
      this.updateExportControls(root);
    }).catch(() => {
      if (this.backendUploadRecoveryControllers.get(requestId) === abort) {
        this.backendUploadRecoveryControllers.delete(requestId);
      }
    });
  }

  private async reconcileBackendUpload(
    root: HTMLElement,
    requestId: string,
    episodeIds: readonly string[],
    accountUploadJobId: string | null,
    signal: AbortSignal,
  ) {
    const job = this.browserJobs.find((entry) => entry.id === requestId);
    if (!job || browserExportJobIsTerminal(job)) return false;
    const recovery = job.backendUploadRecovery;
    let retry = false;
    try {
      let accountJob = accountUploadJobId
        ? await this.accountExportClient.uploadStatus(accountUploadJobId, signal)
        : null;
      if (accountJob && accountJob.id !== accountUploadJobId) {
        throw new Error("The account service returned a different Hugging Face upload job");
      }
      if (!accountJob) {
        if (!recovery) {
          throw new Error("The retained Hugging Face upload inputs are unavailable");
        }
        const retainedManifest = [...recovery.artefacts]
          .sort((left, right) => left.path.localeCompare(right.path));
        let created;
        try {
          created = await this.accountExportClient.reacquireUpload({
            expectedAccountSubject: recovery.options.expectedAccountSubject,
            expectedHuggingFaceSubject: recovery.options.expectedHuggingFaceSubject,
            captureSessionId: this.session.sessionId,
            repository: recovery.options.repository,
            branch: recovery.options.branch,
            appendAllocation: recovery.options.appendAllocation,
            visibility: recovery.options.visibility,
            episodeIds: [...episodeIds],
            artefacts: retainedManifest,
          }, signal);
        } catch (error) {
          if (!(error instanceof AccountExportRequestError) || error.status !== 404) throw error;
          job.state = "running";
          job.detail = "Hugging Face upload identity is not visible yet; cancellation recovery will retry automatically";
          this.updateExportControls(root);
          this.renderJobs(root);
          return true;
        }
        accountJob = created.job;
        const returnedManifest = [...accountJob.artefacts]
          .sort((left, right) => left.path.localeCompare(right.path));
        if (
          accountJob.accountSubject !== recovery.options.expectedAccountSubject
          || accountJob.huggingFaceSubject !== recovery.options.expectedHuggingFaceSubject
          || accountJob.captureSessionId !== this.session.sessionId
          || accountJob.repository !== recovery.options.repository
          || accountJob.branch !== recovery.options.branch
          || accountJob.visibility !== recovery.options.visibility
          || accountJob.missingRepositoryBehaviour !== recovery.options.visibility
          || !matchesRetainedHuggingFaceAppendAllocation(
            accountJob.appendAllocation,
            recovery.options.appendAllocation,
          )
          || !sameAccountUploadEpisodeIds(accountJob.episodeIds, episodeIds)
          || returnedManifest.length !== retainedManifest.length
          || returnedManifest.some((artefact, index) => {
            const expected = retainedManifest[index];
            return !expected
              || artefact.path !== expected.path
              || artefact.sha256 !== expected.sha256
              || artefact.byteLength !== expected.byteLength
              || artefact.mediaType !== expected.mediaType;
          })
        ) {
          throw new Error("The reacquired Hugging Face upload job does not match the retained cancellation identity");
        }
        job.accountUploadJobId = accountJob.id;
      }
      if (
        accountJob.status === "pending"
        || accountJob.status === "preparing"
        || accountJob.status === "uploading"
      ) {
        try {
          const cancelled = await this.accountExportClient.cancelUpload(accountJob.id, signal);
          if (cancelled.job.id !== accountJob.id || cancelled.job.status !== "cancelled") {
            throw new AccountUploadCancellationUnconfirmedError(
              accountJob.id,
              new Error("The backend did not acknowledge the upload as cancelled"),
            );
          }
          accountJob = cancelled.job;
        } catch (error) {
          if (!(error instanceof AccountExportRequestError) || error.status !== 409) throw error;
          const racedJob = await this.accountExportClient.uploadStatus(accountJob.id, signal);
          if (racedJob.id !== accountJob.id) {
            throw new Error("The account service returned a different Hugging Face upload job");
          }
          if (
            racedJob.status === "pending"
            || racedJob.status === "preparing"
            || racedJob.status === "uploading"
          ) {
            throw new AccountUploadCancellationUnconfirmedError(
              accountJob.id,
              error,
            );
          }
          accountJob = racedJob;
        }
      }
      if (accountJob.status === "finalising") {        accountJob = await this.accountExportClient.reconcileUpload(accountJob, signal);
      }
      signal.throwIfAborted();
      if (accountJob.status === "completed") {
        const upload = verifiedEpisodeUploadFromAccountJob(
          accountJob,
          this.session.sessionId,
          episodeIds,
        );        job.accountUploadJobId = accountJob.id;
        job.state = "completed";
        job.detail = `Verified Hugging Face commit ${accountJob.finalCommit!.oid}`;
        delete job.backendUploadRecovery;
        recordMonitorExportJourney("upload", "completed");
        this.showActivity(
          root,
          `HF UPLOAD COMPLETED ${episodeIds.length} EPISODE${episodeIds.length === 1 ? "" : "S"} TO ${accountJob.repository}@${accountJob.branch}`,
          "system",
        );
        try {
          await this.persistBrowserUploadOutcome(root, [...episodeIds], upload);
        } catch (error) {
          job.detail = `Verified Hugging Face commit ${accountJob.finalCommit!.oid} / local receipt not saved`;          this.showActivity(root, "HF UPLOAD COMPLETED. LOCAL RECEIPT SAVE FAILED.", "error");
          this.showJobError(root, "The Hugging Face upload completed, but its local completion receipt could not be saved");
        }
      } else if (accountJob.status === "failed" || accountJob.status === "cancelled") {
        const cancelled = accountJob.status === "cancelled";
        job.state = cancelled ? "cancelled" : "failed";
        job.detail = cancelled
          ? "Hugging Face upload cancellation confirmed"
          : accountJob.error || "Hugging Face backend upload failed";
        delete job.backendUploadRecovery;        recordMonitorExportJourney("upload", cancelled ? "cancelled" : "failed");
        if (!cancelled) this.showActivity(root, `HF UPLOAD FAILED ${job.detail.toUpperCase()}`, "error");
      } else {
        job.state = "running";
        job.detail = "Hugging Face cancellation is unconfirmed; backend recovery is still running";
        retry = true;
      }
    } catch (error) {
      if (signal.aborted || this.disposed) return false;
      if (error instanceof AccountUploadCancellationUnconfirmedError && error.jobId) {
        job.accountUploadJobId = error.jobId;
      }
      job.state = "running";
      job.detail = "Hugging Face backend status is unavailable; recovery will retry automatically";
      retry = true;
    }
    this.updateExportControls(root);
    this.renderJobs(root);
    return retry;
  }

  private async persistBrowserUploadOutcome(
    root: HTMLElement,
    episodeIds: string[],
    upload: VerifiedEpisodeHuggingFaceUpload,
  ) {
    if (isPeerConnectionMode(this.connectionProfile)) {
      const previousSnapshot = this.directSession.snapshot;
      this.directSession.recordEpisodeUpload(episodeIds, upload);
      try {
        await this.monitorRecorder.saveSnapshot(this.directSession.snapshot);
      } catch (error) {
        this.directSession.restore(previousSnapshot, previousSnapshot.captureConnected);
        throw error;
      }
      this.renderSnapshot(root, this.directSession.snapshot);
      return;
    }
    await this.session.commitEpisodeUpload({
      type: "episode-upload-commit",
      requestId: upload.requestId,
      episodeIds,
      receipt: upload.completionReceipt,
    });
  }

  private renderJobs(root: HTMLElement) {
    const jobs = [
      ...this.browserJobs,
      ...(this.snapshot?.jobs ?? []).map((job) => ({ id: job.id, type: job.type, state: job.state, detail: job.detail })),
    ];
    root.querySelector("#job-log")!.innerHTML = jobs.length
      ? jobs.slice(0, 8).map((job) => `<li><b>${escapeHtml(job.type)}</b><span>${escapeHtml(this.jobSummary(job.detail, job.state))}</span><small class="job-${job.state}">${escapeHtml(job.state)}</small></li>`).join("")
      : "<li class=\"empty-row\">NO EXPORTS</li>";
  }





  private updateAutomaticUploadQueue(root: HTMLElement, snapshot: SessionSnapshot) {
    const exportable = [...snapshot.episodes, ...snapshot.attempts].filter(isExportableEpisode);
    if (!this.exportableEpisodesInitialised) {
      exportable.forEach((episode) => this.observedExportableEpisodes.add(episode.id));
      this.exportableEpisodesInitialised = true;
      return;
    }
    for (const episode of exportable) {
      if (this.observedExportableEpisodes.has(episode.id)) continue;
      this.observedExportableEpisodes.add(episode.id);
      if (snapshot.configuration.uploadAfterEpisode) this.automaticUploadQueue.add(episode.id);
    }
    this.drainAutomaticUpload(root);
  }

  private drainAutomaticUpload(root: HTMLElement) {
    if (
      this.exporter.isRunning()
      || this.accountUploadAbort
      || this.backendUploadRecoveryControllers.size > 0
      || this.backendUploadRecoveryTimers.size > 0
      || this.accountUploadPlanning
      || this.automaticUploadQueue.size === 0
      || !this.snapshot
    ) return;
    const episodeId = this.automaticUploadQueue.values().next().value as string | undefined;
    const episode = this.snapshot.episodes.find((entry) => entry.id === episodeId)
      ?? this.snapshot.attempts.find((entry) => entry.id === episodeId);
    if (!episode) {
      if (episodeId) this.automaticUploadQueue.delete(episodeId);
      this.drainAutomaticUpload(root);
      return;
    }
    this.accountUploadPlanning = true;
    this.updateExportControls(root);    void this.prepareAccountUploadOptions(root).then((upload) => {
      if (this.disposed || this.mountedRoot !== root || this.exporter.isRunning()) return;
      this.automaticUploadQueue.delete(episode.id);
      this.startBrowserExport(root, upload, [episode], true);
    }).catch(() => {      // The queued episode remains pending until repository credentials are supplied.
    }).finally(() => {
      this.accountUploadPlanning = false;
      if (!this.disposed && this.mountedRoot === root) this.updateExportControls(root);
    });
  }

  private reportExportStartError(root: HTMLElement, error: unknown) {
    const message = error instanceof Error ? error.message : "Browser export could not start";    this.showActivity(root, message.toUpperCase(), "error");
    this.showJobError(root, message);
  }

  private renderSnapshot(root: HTMLElement, snapshot: SessionSnapshot) {    if (this.directFinalisationPublication !== null) return;
    const captureWasConnected = Boolean(this.snapshot?.captureConnected);
    const previousSnapshot = this.snapshot;
    const startPendingRun = pendingRunConfigurationApplied(this.pendingRunStartRevision, snapshot.configurationStatus);
    if (snapshot.configurationStatus.state === "error") this.pendingRunStartRevision = null;
    this.adoptCameraRegistrationFromSnapshot(root, snapshot);    this.snapshot = snapshot;    const reviewAvailable = episodeSelectionAvailable(snapshot.run.recordingState);
    root.dataset.episodeSelectionAvailable = String(reviewAvailable);
    if (!reviewAvailable && (
      this.selectedEpisodeIds.size > 0
      || this.replayedEpisodeId !== null
      || this.episodeReplayController !== null
      || this.episodeReviewMode !== "live"
    )) {
      this.selectedEpisodeIds.clear();
      this.clearEpisodeReplay(root);
    }
    this.applyHandDisplay(root, snapshot.handDisplay);
    this.renderSpeechFeature(root);
    const pendingRevision = this.pendingConfigurationRevision;
    if (pendingRevision !== null
      && snapshot.configurationStatus.state === "applied"
      && (snapshot.configurationStatus.appliedRevision ?? -1) >= pendingRevision) {
      this.pendingConfigurationRevision = null;
      this.configurationPending = false;
      this.showActivity(root, `RUN APPLIED R${snapshot.configurationStatus.appliedRevision}`, "system");
    } else if (pendingRevision !== null
      && snapshot.configurationStatus.state === "error"
      && snapshot.configurationStatus.revision >= pendingRevision) {
      this.pendingConfigurationRevision = null;
      this.configurationPending = false;
      this.showActivity(root, snapshot.configurationStatus.error?.toUpperCase() || "RUN APPLY FAILED", "error");
    }
    this.renderConfigurationState(root);
    const appliedRevision = snapshot.configurationStatus.state === "applied"
      ? snapshot.configurationStatus.appliedRevision ?? snapshot.configurationStatus.revision
      : null;
    if (!this.configurationDraft
      && !this.configurationPending
      && appliedRevision !== null
      && appliedRevision !== this.loadedConfigurationRevision) {
      this.hydrateConfigurationDraft(root, normaliseCaptureConfiguration(snapshot.configuration), appliedRevision);
    }
    storeMonitorRunConfiguration(this.sessionId, normaliseCaptureConfiguration(snapshot.configuration));
    if (!snapshot.captureConnected && (captureWasConnected || this.peer || this.requestedFeed)) this.resetVideoPeer(root);
    const active = snapshot.configuration.tasks[snapshot.run.activeTaskIndex];
    this.renderConnectionState(root);
    this.setClockConnection(root, this.controlTransportConnected() && snapshot.captureConnected);
    this.renderTiming(root);
    if (snapshot.captureConnected) this.requestFeed();
    const writingEpisodes = snapshot.run.recordingState === "stopping"
      ? [snapshot.pendingEpisode, snapshot.currentEpisode]
      : [];
    const episodeCandidates = [...writingEpisodes, ...snapshot.episodes, ...snapshot.attempts]
      .filter((episode): episode is Episode => Boolean(episode))
      .filter((episode, index, entries) => entries.findIndex((candidate) => candidate.id === episode.id) === index)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .slice(-12);
    const knownEpisodeIds = new Set(episodeCandidates.map((episode) => episode.id));
    for (const episodeId of this.selectedEpisodeIds) {
      if (!knownEpisodeIds.has(episodeId)) this.selectedEpisodeIds.delete(episodeId);
    }
    const episodeTaskIndices = episodeCandidates.map((episode) => Math.max(0, snapshot.configuration.tasks.findIndex((task) => task.id === episode.taskId)));
    const displayCycles = episodeDisplayCycles(episodeCandidates.map((episode, index) => ({
      cycle: episode.cycle,
      taskIndex: episodeTaskIndices[index],
      repetition: episode.repetition,
    })));
    const episodePresentations = episodeCandidates.map((episode, index) => {
      const taskIndex = episodeTaskIndices[index];
      const relatedAttempts = snapshot.attempts.filter((attempt) => attempt.cycle === episode.cycle && attempt.taskId === episode.taskId);
      return {
        episode,
        presentation: episodeBlockPresentation({ ...episode, cycle: displayCycles[index] }, taskIndex, relatedAttempts),
      };
    });
    root.querySelector("#episode-log")!.innerHTML = episodePresentations.map(({ episode, presentation }) => {
      const selected = this.selectedEpisodeIds.has(episode.id);
      const uploaded = presentation.uploaded ? " is-uploaded" : "";
      const disabled = reviewAvailable ? "" : " disabled aria-disabled=\"true\"";
      return `<li class="episode-block episode-${presentation.state}${uploaded}${selected ? " is-selected" : ""}" title="${escapeHtml(presentation.detail)}"><button type="button" data-episode-id="${escapeHtml(episode.id)}" aria-pressed="${selected}" aria-label="${escapeHtml(`${presentation.cycleLabel} ${presentation.taskLabel}. ${presentation.detail}`)}"${disabled}><b>${presentation.cycleLabel}</b><span>${presentation.taskLabel}</span></button><button class="episode-delete" type="button" data-delete-episode-id="${escapeHtml(episode.id)}" aria-label="Delete episode ${escapeHtml(episode.id)}" title="Delete episode">DEL</button></li>`;
    }).join("");
    this.renderJobs(root);
    const promptLocked = snapshot.run.recordingState !== "idle";
    ["setting-cue-sounds", "setting-voice-cues", "setting-tts-provider", "setting-stt-provider"]
      .forEach((id) => { root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.disabled = promptLocked; });
    const failedJob = snapshot.jobs.find((job) => job.state === "failed");
    if (failedJob && !this.displayedJobFailures.has(failedJob.id)) {
      this.displayedJobFailures.add(failedJob.id);
      this.showJobError(root, failedJob.detail);
    }
    this.syncDraftTaskDisplay(root);
    this.renderCaptureStatus(root, snapshot.captureStatus);
    this.renderAudioToggle(root, snapshot.configuration.recordAudio);
    this.updateAutomaticUploadQueue(root, snapshot);
    this.updateExportControls(root);
    if (startPendingRun) {
      this.pendingRunStartRevision = null;
      this.controlSession(root, "start-sequence");
    }
  }





  private updateExportControls(root: HTMLElement) {
    const selected = this.selectedExportEpisodes();
    const eligible = Boolean(selected?.length);
    const running = this.exporter.isRunning() || this.accountUploadAbort !== null;
    const recovering = this.backendUploadRecoveryControllers.size > 0
      || this.backendUploadRecoveryTimers.size > 0;
    const busy = running || recovering || this.accountUploadPlanning;
    const reviewAvailable = Boolean(this.snapshot && episodeSelectionAvailable(this.snapshot.run.recordingState));
    root.querySelector<HTMLButtonElement>("#export-data")!.disabled = !reviewAvailable || !eligible || busy;
    root.querySelector<HTMLButtonElement>("#export-folder")!.disabled = !reviewAvailable || !eligible || busy;
    root.querySelector<HTMLButtonElement>("#upload-data")!.disabled = !reviewAvailable
      || !eligible
      || busy
      || this.accountExportSession?.huggingFace.state !== "ready";
    root.querySelector<HTMLButtonElement>("#cancel-export")!.disabled = !running;
    root.dataset.exportEligibleEpisodes = String(selected?.length ?? 0);
    root.dataset.selectedEpisodes = String(this.selectedEpisodeIds.size);
  }

  private jobSummary(detail: string, state: string) {
    return state === "failed" && detail.length > 90 ? `${detail.slice(0, 87)}...` : detail;
  }

  private showJobError(root: HTMLElement, detail: string) {
    const message = detail.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
    root.querySelector("#job-error-message")!.textContent = message.slice(0, 900);
    this.openOverlay(root, "job-error-modal", "#job-error-close");
  }

  private hideJobError(root: HTMLElement) {
    this.closeOverlay(root, "job-error-modal");
  }

  private openOverlay(root: HTMLElement, id: string, focusTarget: string) {
    const overlay = root.querySelector<HTMLElement>(`#${id}`)!;
    if (!overlay.hidden) return;
    if (document.activeElement instanceof HTMLElement) this.overlayReturnFocus.set(id, document.activeElement);
    const background = [...(overlay.parentElement?.children ?? [])]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      .map((element) => [element, element.inert] as [HTMLElement, boolean]);
    this.overlayBackgroundState.set(id, background);
    background.forEach(([element]) => { element.inert = true; });
    overlay.inert = false;
    overlay.hidden = false;
    this.overlayStack.push(id);
    root.querySelector<HTMLElement>(focusTarget)?.focus();
  }

  private closeOverlay(root: HTMLElement, id: string) {
    const overlay = root.querySelector<HTMLElement>(`#${id}`)!;
    if (overlay.hidden) return;
    overlay.hidden = true;
    const stackIndex = this.overlayStack.lastIndexOf(id);
    if (stackIndex >= 0) this.overlayStack.splice(stackIndex, 1);
    for (const [element, inert] of this.overlayBackgroundState.get(id) ?? []) element.inert = inert;
    this.overlayBackgroundState.delete(id);
    const returnFocus = this.overlayReturnFocus.get(id);
    this.overlayReturnFocus.delete(id);
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  private containOverlayFocus(root: HTMLElement, id: string, event: KeyboardEvent) {
    const overlay = root.querySelector<HTMLElement>(`#${id}`)!;
    const focusable = [...overlay.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.closest("[hidden]") && !element.inert);
    if (focusable.length === 0) {
      overlay.tabIndex = -1;
      overlay.focus();
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!overlay.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      (event.shiftKey ? last : first).focus();
      event.preventDefault();
    }
  }

  private renderCaptureStatus(root: HTMLElement, status: CaptureStatus) {
    this.renderConnectionState(root);
    const captureConnected = this.controlTransportConnected() && Boolean(this.snapshot?.captureConnected);
    const displayedStatus = captureConnected
      ? status
      : {
          ...defaultCaptureStatus,
          recorderRateHz: this.snapshot?.configuration.recorderRateHz ?? defaultCaptureStatus.recorderRateHz,
        };
    root.dataset.recorderFrameIndex = String(displayedStatus.recorderFrameIndex);
    root.dataset.recorderGapCount = String(displayedStatus.recorderGaps);
    if (__CERES_TEST_RECORDER_RATE_HZ__ !== null) {
      root.dataset.recorderPendingBlocks = String(displayedStatus.recorderPendingBlocks);
      root.dataset.recorderDurableAckSequence = String(displayedStatus.recorderDurableAckSequence);
    }
    const cameraReady = captureConnected && displayedStatus.camera === "ready";
    root.querySelector<HTMLButtonElement>("#calibrate-camera")!.disabled = !cameraReady;
    if (cameraReady) this.syncCameraRegistration(root, displayedStatus);
    this.renderCameraInspector(root, displayedStatus);
    const captureConnection = captureConnectionPresentation(captureConnected, displayedStatus);
    const showQuest3 = captureConnected && displayedStatus.headsetModel === "Quest 3";
    root.querySelector<HTMLImageElement>("#capture-headset-icon")!.hidden = !showQuest3;
    root.querySelector(".recording-card")!.classList.toggle("has-headset-icon", showQuest3);
    root.querySelector("#capture-link")!.textContent = captureConnection.label;
    root.querySelector("#capture-link-dot")!.classList.toggle("is-live", captureConnected);
    root.querySelector("#capture-link-detail")!.textContent = captureConnection.detail;
    root.querySelector("#video-transport")!.textContent = displayedStatus.transport === "connected" ? "RTC UP" : displayedStatus.transport === "connecting" ? "RTC SYNC" : "RTC OFF";
    const streamRows: Array<[string, string, boolean, boolean?]> = [
      ["CAM", statusLabel(displayedStatus.camera), displayedStatus.camera === "ready"],
      ["XR", statusLabel(displayedStatus.xr), displayedStatus.xr === "active"],
      ["HAND", statusLabel(displayedStatus.handTracking), displayedStatus.handTracking === "active"],
      ["REC", statusLabel(displayedStatus.recorder ?? "idle"), displayedStatus.recorder === "armed" || displayedStatus.recorder === "recording"],
    ];
    if (this.speechEnabled()) {
      streamRows.push(["ASR", captureConnected ? "ARMED" : "OFF", false, true]);
    }
    root.querySelector("#stream-tree")!.innerHTML = streamRows
      .map(([name, label, active, muted]) => `<li class="${active ? "is-live" : ""}${muted ? " is-muted" : ""}"><i></i><span>${escapeHtml(String(name))}</span><b${name === "CAM" ? " id=\"stream-camera-value\"" : ""}>${escapeHtml(String(label))}</b></li>`).join("");
    void this.updateStreamBandwidth(root, displayedStatus);
    root.querySelector("#capture-health")!.innerHTML = [
      ["CAM", statusLabel(displayedStatus.camera)],
      ["XR", statusLabel(displayedStatus.xr)],
      ["RTC", statusLabel(displayedStatus.transport)],
      ["HAND", statusLabel(displayedStatus.handTracking)],
      ["RATE", `${formatRateHz(displayedStatus.sensorRateHz)}/${formatRateHz(displayedStatus.recorderRateHz)} HZ`],
      ["REC", statusLabel(displayedStatus.recorder ?? "idle")],
      ["ERR", displayedStatus.lastError ?? "NONE"],
    ].map(([name, value]) => `<div><dt>${escapeHtml(String(name))}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("");
    this.renderCaptureHealthSummary(root, displayedStatus);
  }

  private speechEnabled() {
    return this.snapshot?.features?.speech !== false;
  }

  private async initialiseRuntimeFeatures(
    root: HTMLElement,
    fallback: RuntimeFeatures,
    reportUnavailable = true,
  ) {
    const result = await loadRuntimeFeatures(fallback);
    if (this.disposed || this.mountedRoot !== root) return;
    const featuresChanged = this.runtimeFeatures.speech !== result.features.speech
      || this.runtimeFeatures.relayedConnection !== result.features.relayedConnection;
    this.runtimeFeatures = result.features;
    this.runtimeFeaturesAvailable = result.available;
    const commands = featuresChanged
      ? this.directSession.setRuntimeFeatures(this.runtimeFeatures)
      : [];
    if (result.available) {
      this.runtimeFeatureRecovery.reset(window);
    } else {
      this.runtimeFeatureRecovery.schedule(window, () => {
        void this.initialiseRuntimeFeatures(root, fallback, false);
      });
    }
    if (this.runtimeFeatures.relayedConnection !== true && this.selectedConnectionMode(root) === "relayed") {
      root.querySelector<HTMLInputElement>('input[name="connection-mode"][value="local"]')!.checked = true;
      if (this.connectionProfile.mode === "relayed") {
        this.reinitialiseConnection(root, { mode: "local", relayUrl: null }, false);
      } else {
        this.syncConnectionControls(root);
      }
      this.showActivity(root, "RELAYED CONNECTION COMING SOON", "system");
    } else {
      this.syncConnectionControls(root);
    }
    this.renderSnapshot(root, this.directSession.snapshot);
    if (result.available) {
      if (commands.length > 0 && this.controlTransportConnected()) {
        this.runtimeFeaturesPersistenceQueued = true;
        this.queueCommittedDirectCommands(root, commands, "FEATURE UPDATE FAILED");
      } else {
        this.persistRuntimeFeaturesWhenReady(root);
      }
    } else if (reportUnavailable) {
      this.showActivity(root, "FEATURE STATUS UNAVAILABLE", "system");
    }
  }

  private persistRuntimeFeaturesWhenReady(root: HTMLElement) {
    if (!this.runtimeFeaturesAvailable || !this.monitorRecorderReady || this.runtimeFeaturesPersistenceQueued) return;
    this.runtimeFeaturesPersistenceQueued = true;
    this.queueDirectSnapshotPersistence(root, "FEATURE SAVE FAILED");
  }

  private renderSpeechFeature(root: HTMLElement) {
    const enabled = this.speechEnabled();
    root.dataset.speechEnabled = String(enabled);
    root.querySelectorAll<HTMLElement>("[data-speech-feature]").forEach((element) => { element.hidden = !enabled; });
  }

  private renderMonitorReadout(root: HTMLElement, readout: MonitorReadout) {
    if (readout.source === "live") {
      this.latestReadout = readout;
      this.applyHandMeshStatus(root, readout.handMeshStatus);
    }
    root.dataset.monitorFrameSource = readout.source;
    root.dataset.monitorFrameIndex = String(readout.frameIndex);
    root.dataset.monitorRenderMs = readout.renderDurationMs.toFixed(3);
    root.dataset.monitorGpuMs = readout.gpuDurationMs === null ? "unavailable" : readout.gpuDurationMs.toFixed(6);
    root.dataset.monitorInboundKbps = readout.inboundKbps.toFixed(3);
    root.dataset.monitorDroppedFrames = String(readout.droppedRenderFrames);
    root.dataset.handProjectionRegistered = String(readout.handProjectionRegistered);
    root.dataset.leftProjectedJointCount = String(readout.leftProjectedJointCount);
    root.dataset.rightProjectedJointCount = String(readout.rightProjectedJointCount);
    root.querySelector("#left-wrist-pose")!.textContent = formatWristPose(readout.leftWristPosition, readout.leftWristRotation);
    root.querySelector("#right-wrist-pose")!.textContent = formatWristPose(readout.rightWristPosition, readout.rightWristRotation);
    const hasTrackedHand = readout.leftHandTracked || readout.rightHandTracked;
    const projectionStatus = root.querySelector<HTMLElement>("#hand-projection-status")!;
    projectionStatus.textContent = readout.handProjectionRegistered
      ? `POSE REGISTERED / L${readout.leftProjectedJointCount} R${readout.rightProjectedJointCount}`
      : hasTrackedHand ? "POSE UNREGISTERED" : "NO HAND POSE";
    projectionStatus.classList.toggle("is-unregistered", !readout.handProjectionRegistered);
    if (readout.source === "episode") {
      root.querySelector(".camera-viewport")?.classList.remove("has-hand-detections");
      root.querySelector("#signal-empty")!.classList.toggle("is-hidden", readout.traceCount > 0);
      root.querySelector("#timeline-count")!.textContent = `${readout.traceCount} F`;
      return;
    }
    const captureConnected = this.controlTransportConnected() && Boolean(this.snapshot?.captureConnected);
    root.querySelector(".camera-viewport")?.classList.toggle("has-hand-detections", captureConnected && hasTrackedHand);
    if (!captureConnected) return;
    this.renderHandEnergy(root, "left", readout.leftHandEnergyMps, readout.leftHandTracked, readout.leftHandWarning);
    this.renderHandEnergy(root, "right", readout.rightHandEnergyMps, readout.rightHandTracked, readout.rightHandWarning);
    root.querySelector("#signal-empty")!.classList.toggle("is-hidden", readout.traceCount > 0 && Boolean(readout.headPosition || hasTrackedHand));
    root.querySelector("#timeline-count")!.textContent = `${readout.traceCount} F`;
    if (this.snapshot) void this.updateStreamBandwidth(root, this.snapshot.captureStatus);
    if (this.snapshot) this.renderCaptureHealthSummary(root, this.snapshot.captureStatus);
  }

  private renderHandEnergy(root: HTMLElement, handedness: "left" | "right", speedMps: number, tracked: boolean, warning: boolean) {
    const meter = root.querySelector<HTMLElement>(`#${handedness}-hand-energy`)!;
    const safeSpeed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
    const critical = tracked && safeSpeed >= HAND_SPEED_CRITICAL_MPS;
    meter.style.setProperty("--energy-position", `${(Math.min(1, safeSpeed / handEnergyDisplayMaxMps) * 100).toFixed(1)}%`);
    meter.style.setProperty("--pulse-duration", `${Math.max(.18, .86 - Math.max(0, safeSpeed - HAND_SPEED_CRITICAL_MPS) * .24).toFixed(2)}s`);
    meter.classList.toggle("is-idle", !tracked);
    meter.classList.toggle("is-warning", tracked && warning);
    meter.classList.toggle("is-critical", critical);
    meter.setAttribute("aria-valuenow", safeSpeed.toFixed(2));
    meter.querySelector("b")!.textContent = `${handedness === "left" ? "L" : "R"} ${safeSpeed.toFixed(2)}`;
  }

  private renderCaptureHealthSummary(root: HTMLElement, status: CaptureStatus) {
    const readout = this.latestReadout;
    const summary = captureHealthSummary({
      captureConnected: this.controlTransportConnected() && Boolean(this.snapshot?.captureConnected),
      cameraReady: status.camera === "ready",
      xrActive: status.xr === "active",
      handTracking: status.handTracking,
      recorder: status.recorder,
      sensorRateHz: status.sensorRateHz,
      targetRateHz: this.snapshot?.configuration.recorderRateHz ?? status.recorderRateHz,
      gapCount: status.recorderGaps,
      droppedFrameCount: readout?.droppedRenderFrames ?? 0,
      leftHandSpeedMps: readout?.leftHandEnergyMps ?? 0,
      rightHandSpeedMps: readout?.rightHandEnergyMps ?? 0,
      leftHandWarning: readout?.leftHandWarning ?? false,
      rightHandWarning: readout?.rightHandWarning ?? false,
    });
    const element = root.querySelector<HTMLElement>("#capture-health-summary")!;
    element.classList.remove("is-go", "is-caution", "is-stop");
    element.classList.add(`is-${summary.decision}`);
    element.querySelector("b")!.textContent = summary.decision.toUpperCase();
    const reason = summary.reasons.join(" / ") || "Capture signals are within configured limits";
    element.querySelector("small")!.textContent = reason;
    element.setAttribute("aria-label", `Status ${summary.decision}. ${reason}`);
  }

  private async updateStreamBandwidth(root: HTMLElement, status: CaptureStatus) {
    const label = root.querySelector<HTMLElement>("#stream-camera-value");
    if (!label) return;
    if (status.camera === "idle" || status.camera === "error") {
      label.textContent = statusLabel(status.camera);
      return;
    }
    const peer = this.peer;
    if (!peer) {
      label.textContent = status.transport === "failed" ? "VIDEO ERR" : "VIDEO WAIT";
      return;
    }
    const now = performance.now();
    if (this.videoStatsPending || now - this.lastVideoStatsAt < 900) return;
    this.videoStatsPending = true;
    try {
      const previousStatsAt = this.lastVideoStatsAt;
      this.lastVideoStatsAt = now;
      const reports = await peer.getStats();
      if (this.peer !== peer || !this.controlTransportConnected() || !this.snapshot?.captureConnected) {
        label.textContent = statusLabel(defaultCaptureStatus.camera);
        return;
      }
      for (const report of reports.values()) {
        if (report.type !== "inbound-rtp" || report.kind !== "video") continue;
        const kilobitsPerSecond = previousStatsAt ? Math.max(0, (report.bytesReceived - this.lastVideoBytes) * 8 / (now - previousStatsAt)) : 0;
        this.lastVideoBytes = report.bytesReceived;
        label.textContent = kilobitsPerSecond ? `${kilobitsPerSecond.toFixed(0)} KB/S` : "VIDEO WAIT";
        return;
      }
    } finally {
      this.videoStatsPending = false;
    }
  }

  private async acceptSignal(root: HTMLElement, peerId: string, signal: WebRtcSignal) {
    if (this.disposed || !peerId) return;
    const negotiationId = signal.negotiationId === undefined
      ? this.rtcNegotiationId ?? webRtcSignalNegotiationId(undefined, peerId)
      : webRtcSignalNegotiationId(signal.negotiationId, peerId);
    if (!negotiationId) return;
    if (signal.description?.type === "offer") {
      this.clearOfferRequestRetry();
      this.requestedFeed = true;
      if (!this.pairingInvitationClaimed) this.recordPairingPickup(root, new Date().toISOString());
      await this.answerWebRtcOffer(root, peerId, negotiationId, signal.description as RTCSessionDescriptionInit);
    }
    if (!signal.candidate) return;
    if (this.rtcPeerId === peerId && this.rtcNegotiationId && this.rtcNegotiationId !== negotiationId) return;
    const candidate = signal.candidate as RTCIceCandidateInit;
    if (this.rtcPeerId === peerId && this.rtcNegotiationId === negotiationId && this.peer && this.remoteDescriptionReadyPeers.has(negotiationId)) await this.peer.addIceCandidate(candidate);
    else {
      const pending = this.pendingIceCandidates.get(negotiationId) ?? [];
      pending.push(candidate);
      this.pendingIceCandidates.set(negotiationId, pending);
    }
  }

  private async answerWebRtcOffer(root: HTMLElement, peerId: string, negotiationId: string, description: RTCSessionDescriptionInit, attempt = 0): Promise<void> {
    const previousPeer = this.peer;
    this.revokePeerTelemetryAuthority();
    const peer = new RTCPeerConnection(rtcConfigurationForConnectionProfile(this.connectionProfile, this.activeRelayedIceServers()));
    this.peer = peer;
    this.webRtcJourneyOutcome = null;
    this.rtcPeerId = peerId;
    this.rtcNegotiationId = negotiationId;
    this.remoteDescriptionReadyPeers.clear();
    for (const pendingNegotiationId of this.pendingIceCandidates.keys()) {
      if (pendingNegotiationId !== negotiationId) this.pendingIceCandidates.delete(pendingNegotiationId);
    }
    previousPeer?.close();
    this.wireMonitorPeer(root, peerId, negotiationId, peer);
    try {
      await peer.setRemoteDescription(description);
      if (this.disposed || this.peer !== peer) {
        peer.close();
        return;
      }
      await this.setMonitorLocalDescription(peer);
      if (this.disposed || this.peer !== peer) {
        peer.close();
        return;
      }
      const answer = peer.localDescription;
      if (!answer || answer.type !== "answer" || !answer.sdp) throw new Error("The browser did not create a WebRTC answer");
      this.sendWebRtcSignal(peerId, { negotiationId, description: { type: answer.type, sdp: answer.sdp } });
      this.remoteDescriptionReadyPeers.add(negotiationId);
      for (const candidate of this.pendingOutgoingIceCandidates.get(peer) ?? []) {
        this.sendWebRtcSignal(peerId, { negotiationId, candidate });
      }
      this.pendingOutgoingIceCandidates.delete(peer);
      const pendingCandidates = this.pendingIceCandidates.get(negotiationId)?.splice(0) ?? [];
      this.pendingIceCandidates.delete(negotiationId);
      for (const candidate of pendingCandidates) {
        if (this.disposed || this.peer !== peer) return;
        await peer.addIceCandidate(candidate);
      }
    } catch (error) {
      if (this.disposed || this.peer !== peer) return;
      if (attempt < 2) {
        await this.answerWebRtcOffer(root, peerId, negotiationId, description, attempt + 1);
        return;
      }
      this.resetVideoPeer(root);
      this.recordWebRtcJourneyOutcome("failed");
      const message = error instanceof Error ? error.message : "WebRTC negotiation failed";
      this.showActivity(root, message.toUpperCase(), "error");
      this.scheduleOfferRequestRetry();
    }
  }

  private async setMonitorLocalDescription(peer: RTCPeerConnection) {
    let timeoutId: number | null = null;
    let removeGatheringListener: () => void = () => undefined;
    const gatheringStarted = new Promise<void>((resolve) => {
      if (peer.iceGatheringState !== "new") {
        resolve();
        return;
      }
      const handleGatheringState = () => {
        if (peer.iceGatheringState === "new") return;
        peer.removeEventListener("icegatheringstatechange", handleGatheringState);
        resolve();
      };
      removeGatheringListener = () => peer.removeEventListener("icegatheringstatechange", handleGatheringState);
      peer.addEventListener("icegatheringstatechange", handleGatheringState);
    });
    try {
      await Promise.race([
        (async () => {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await gatheringStarted;
        })(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("WebRTC answer negotiation timed out")), 2_000);
        }),
      ]);
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      removeGatheringListener();
    }
  }

  private sendWebRtcSignal(peerId: string, signal: WebRtcSignal) {
    if (this.webRtcSignal) return this.webRtcSignal.signal(peerId, signal);
    if (this.connectionProfile.mode === "local") return false;
    return this.session.send({ type: "webrtc-signal", peerId, signal });
  }

  private wireMonitorPeer(root: HTMLElement, peerId: string, negotiationId: string, peer: RTCPeerConnection) {
    const inboundStream = new MediaStream();
    this.liveVideoStream = inboundStream;
    const video = root.querySelector<HTMLVideoElement>("#live-video")!;
    const showVideo = () => {
      const liveTrack = inboundStream.getVideoTracks().find((track) => track.readyState === "live" && !track.muted);
      if (this.peer !== peer
        || this.episodeReviewMode !== "live"
        || video.srcObject !== inboundStream
        || !liveTrack
        || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      root.querySelector(".camera-viewport")?.classList.add("has-video");
      root.querySelector("#video-empty")!.classList.add("is-hidden");
      this.syncCameraOverlay(root);
      this.startVideoFrameSync(video);
    };
    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate && this.webRtcSignal && this.peer === peer && this.rtcNegotiationId === negotiationId) {
        const candidate = event.candidate.toJSON();
        if (this.remoteDescriptionReadyPeers.has(negotiationId)) this.sendWebRtcSignal(peerId, { negotiationId, candidate });
        else {
          const pending = this.pendingOutgoingIceCandidates.get(peer) ?? [];
          pending.push(candidate);
          this.pendingOutgoingIceCandidates.set(peer, pending);
        }
      }
    });
    peer.addEventListener("track", (event) => {
      if (!inboundStream.getTracks().some((track) => track.id === event.track.id)) inboundStream.addTrack(event.track);
      if (event.track.kind === "audio") {
        this.startAudioSpectrum(root, event.track);
        return;
      }
      if (event.track.kind !== "video") return;
      if (this.episodeReviewMode === "live" && video.srcObject !== inboundStream) video.srcObject = inboundStream;
      event.track.addEventListener("unmute", showVideo);
      event.track.addEventListener("ended", () => {
        if (this.peer !== peer
          || this.episodeReviewMode !== "live"
          || inboundStream.getVideoTracks().some((track) => track.readyState === "live")) return;
        root.querySelector(".camera-viewport")?.classList.remove("has-video");
        root.querySelector("#video-empty")!.classList.remove("is-hidden");
      });
      video.addEventListener("loadeddata", showVideo, { once: true });
      void video.play().then(showVideo).catch(() => undefined);
    });
    peer.addEventListener("datachannel", (event) => {
      if (event.channel.label === "ceres-telemetry") this.wirePeerTelemetry(root, peer, event.channel);
      if (event.channel.label === "ceres-control") this.wirePeerControl(root, peer, event.channel);
      if (event.channel.label === "ceres-recorder") this.wirePeerRecorder(root, peer, event.channel);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.peer !== peer) return;
      const state = peer.connectionState;
      if (state === "connected" || state === "failed") {
        this.recordWebRtcJourneyOutcome(state);
      }
      if (state === "failed") {
        this.showActivity(root, "VIDEO TRANSPORT FAILED", "error");
        if (this.connectionProfile.mode === "relayed" && this.accountSignedIn && this.relayedTurnFallback.state === "idle") {
          void this.activateTurnFallback(root, peerId, peer);
          return;
        }
      }
      if (state === "connected") {
        this.showActivity(root, "VIDEO TRANSPORT UP", "system");
        this.session.setPeerConnected(true);
        if (isPeerConnectionMode(this.connectionProfile)) {
          this.directSession.setCaptureConnected(true);
          this.renderSnapshot(root, this.directSession.snapshot);
        }
      }
      if (["failed", "closed"].includes(state)) {
        this.session.setPeerConnected(false);
        if (isPeerConnectionMode(this.connectionProfile)) {
          this.directSession.setCaptureConnected(false);
          this.renderSnapshot(root, this.directSession.snapshot);
        }
        this.resetVideoPeer(root);
        if (this.webRtcSignal || (this.socketConnected && this.snapshot?.captureConnected)) window.setTimeout(() => this.requestFeed(), 500);
      }
    });
  }

  private recordWebRtcJourneyOutcome(outcome: "connected" | "failed") {
    if (this.webRtcJourneyOutcome === outcome) return;
    this.webRtcJourneyOutcome = outcome;  }

  private async activateTurnFallback(root: HTMLElement, peerId: string, peer: RTCPeerConnection) {
    if (this.connectionProfile.mode !== "relayed" || !applicationServices().turn) return;
    this.revokePeerTelemetryAuthority();
    const generation = this.relayedTurnFallback.beginRequest();
    if (generation === null) return;
    let signallingInterrupted = false;
    try {
      const provider = applicationServices().turn;
      if (!provider) throw new Error("TURN is not configured for this deployment");
      this.showActivity(root, "DIRECT ICE FAILED, REQUESTING TURN", "system");
      const permit = await provider.request(this.sessionId);
      if (!this.relayedTurnFallback.isCurrent(generation)) return;
      if (this.disposed || this.peer !== peer || peer.connectionState === "connected") {
        this.relayedTurnFallback.fail(generation);
        return;
      }
      const activePermit = this.relayedTurnFallback.accept(generation, permit);
      if (!activePermit) throw new Error("TURN service returned a TURN permit that expires too soon");
      peer.setConfiguration(rtcConfigurationForConnectionProfile(this.connectionProfile, activePermit.iceServers));
      if (!this.sendWebRtcSignal(peerId, {
        ...(this.rtcNegotiationId ? { negotiationId: this.rtcNegotiationId } : {}),
        turnPermit: activePermit,
      })) {
        signallingInterrupted = true;
        throw new Error("Signalling was interrupted while applying TURN; recovery will retry");
      }
      this.showActivity(root, "TURN PERMIT ISSUED, RESTARTING ICE", "system");
      this.scheduleTurnFallbackWatchdog(root, generation);
    } catch (error) {
      if (!this.relayedTurnFallback.isCurrent(generation)) return;
      this.relayedTurnFallback.reset();
      const message = error instanceof Error ? error.message : "TURN service could not issue a TURN permit";
      this.showActivity(root, message.toUpperCase(), signallingInterrupted ? "system" : "error");
      if (this.peer === peer) this.resetVideoPeer(root);
      this.directSession.setCaptureConnected(false);
      this.renderSnapshot(root, this.directSession.snapshot);
      if (this.webRtcSignal && this.directSignallingConnected) this.scheduleOfferRequestRetry();
    }
  }

  private hydrateConfigurationDraft(root: HTMLElement, configuration: CaptureConfiguration, revision: number) {
    this.runEditor?.applyConfiguration(configuration, false);
    this.syncDraftTaskDisplay(root);
    this.setRepositoryFields(root, configuration.hfRepository);
    this.setDeliveryFields(root, configuration);
    this.loadedConfigurationRevision = revision;
  }

  private wirePeerTelemetry(root: HTMLElement, peer: RTCPeerConnection, channel: RTCDataChannel) {
    channel.addEventListener("message", (event) => {
      if (this.disposed || this.peer !== peer || typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as { type?: unknown; frame?: unknown; status?: unknown };
        if ((message.type !== "sensor-frame" || !message.frame || typeof message.frame !== "object")
          && (message.type !== "capture-status" || !message.status || typeof message.status !== "object")) return;
        this.session.receivePeerMessage(message as Extract<ServerMessage, { type: "capture-status" | "sensor-frame" }>);
      } catch {
        this.showActivity(root, "DIRECT TELEMETRY MESSAGE REJECTED", "error");
      }
    });
  }

  private wirePeerControl(root: HTMLElement, peer: RTCPeerConnection, channel: RTCDataChannel) {
    channel.addEventListener("open", () => {
      this.revokePeerTelemetryAuthority();
      this.renderSnapshot(root, this.directSession.snapshot);
      void this.openPeerControl(root, peer, channel);
    });
    channel.addEventListener("close", () => {
      if (this.peerControlChannel !== channel) return;
      this.revokePeerTelemetryAuthority();
      this.peerControlChannel = null;
      this.clearPendingBeamDeliveries(root);
      this.directSession.setCaptureConnected(false);
      this.renderSnapshot(root, this.directSession.snapshot);
      this.queueDirectSnapshotPersistence(root);
      this.renderConnectionState(root);
    });
    channel.addEventListener("message", (event) => {
      if (!isPeerConnectionMode(this.connectionProfile) || this.peer !== peer || typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as unknown;
        if (!parsed || typeof parsed !== "object") throw new Error("Direct control message must be an object");
        const message = parsed as { type?: unknown; action?: unknown; nextCursor?: unknown; settings?: unknown; revision?: unknown; checksum?: unknown; episodeId?: unknown; error?: unknown; deliveryId?: unknown; resetId?: unknown; state?: unknown; taskId?: unknown; telemetryMode?: unknown };
        if (this.handleCaptureControlMessage(root, message)) return;
        const revision = typeof message.revision === "number" ? message.revision : Number.NaN;
        if (message.type === "set-telemetry-mode") {
          this.directSession.setTelemetryMode(message.telemetryMode);
          this.renderSnapshot(root, this.directSession.snapshot);
          this.queueDirectSnapshotPersistence(root, "DIRECT PRIVACY PREFERENCE SAVE FAILED");
        } else if (message.type === "session-restarted" && typeof message.resetId === "string") {
          this.acknowledgeSessionReset(message.resetId);
        } else if (message.type === "configuration-applied" && Number.isSafeInteger(revision) && typeof message.checksum === "string") {
          this.directSession.configurationApplied(revision, message.checksum);
          this.renderSnapshot(root, this.directSession.snapshot);
          this.queueDirectSnapshotPersistence(root, "DIRECT CONFIGURATION ACKNOWLEDGEMENT FAILED");
        } else if (message.type === "recording-accepted" && typeof message.episodeId === "string") {
          const commands = this.directSession.recordingAccepted(message.episodeId);
          this.renderSnapshot(root, this.directSession.snapshot);
          this.queueCommittedDirectCommands(root, commands, "DIRECT RECORDER ACCEPTANCE FAILED");
        } else if (message.type === "recording-rejected" && typeof message.episodeId === "string") {
          const commands = this.directSession.recordingRejected(
            message.episodeId,
            typeof message.error === "string" ? message.error : "Demonstrator recorder could not arm",
          );
          this.renderSnapshot(root, this.directSession.snapshot);
          this.queueCommittedDirectCommands(root, commands, "DIRECT RECORDER REJECTION FAILED");
        } else if (message.type === "recording-finalised" && typeof message.episodeId === "string") {
          this.pendingDirectFinalisation = {
            episodeId: message.episodeId,
            error: typeof message.error === "string" ? message.error : undefined,
            captureFinalised: true,
          };
          this.monitorRecorder.summarise(message.episodeId);
        }
      } catch (error) {
        this.showError(root, error, "DIRECT CONTROL MESSAGE REJECTED");
      }
    });
  }

  private async openPeerControl(root: HTMLElement, peer: RTCPeerConnection, channel: RTCDataChannel) {
    await this.runtimeFeaturesReady;
    if (this.disposed || this.peer !== peer || channel.readyState !== "open") return;
    this.peerControlChannel = channel;
    this.directSession.setCaptureConnected(true);
    const recoveredFinalisation = this.directSession.pendingFinalisation();
    if (recoveredFinalisation && this.pendingDirectFinalisation?.episodeId !== recoveredFinalisation.episodeId) {
      this.pendingDirectFinalisation = { ...recoveredFinalisation, captureFinalised: false };
    }
    const recorderFailure = this.monitorRecorderFailure.controlMessage;
    this.renderSnapshot(root, this.directSession.snapshot);
    if (recorderFailure) {
      channel.send(JSON.stringify(recorderFailure));
    } else {
      try {
        await this.commitDirectCommands(root, this.directSession.synchronise());
        if (this.peerControlChannel === channel && channel.readyState === "open" && this.monitorRecorderNextSequence !== null) {
          channel.send(JSON.stringify({ type: "recorder-ready", sessionId: this.sessionId, nextSequence: this.monitorRecorderNextSequence }));
        }
      } catch (error) {
        if (error instanceof MonitorSnapshotCommitError) {
          this.reportDirectPersistenceFailure(root, error.failure, "DIRECT PEER SYNCHRONISATION FAILED");
        } else {
          this.showError(root, error, "DIRECT PEER SYNCHRONISATION FAILED");
        }
      }
    }
    this.renderConnectionState(root);
  }

  private handleCaptureControlMessage(root: HTMLElement, message: { type?: unknown; action?: unknown; nextCursor?: unknown; settings?: unknown; deliveryId?: unknown; state?: unknown; revision?: unknown; taskId?: unknown }) {
    if (message.type === "beam-ack") {
      if (!isDirectBeamDeliveryId(message.deliveryId)
        || (message.state !== "received" && message.state !== "visual-presented")) {
        throw new Error("Invalid Beam acknowledgement");
      }
      if (!this.pendingBeamDeliveries.delete(message.deliveryId)) return true;
      const state = message.state as DirectBeamDeliveryState;
      root.dataset.lastBeamDeliveryId = message.deliveryId;
      root.dataset.lastBeamDeliveryState = state;
      this.showActivity(root, state === "visual-presented" ? "BEAM SHOWN IN XR" : "BEAM DELIVERED", "system");
      return true;
    }
    if (message.type === "task-presented") {
      const revision = typeof message.revision === "number" ? message.revision : Number.NaN;
      if (!Number.isSafeInteger(revision)
        || typeof message.taskId !== "string"
        || (message.state !== "assigned" && message.state !== "active")) {
        throw new Error("Invalid task presentation acknowledgement");
      }
      const snapshot = this.directSession.snapshot;
      if (!isCurrentTaskPresentation(snapshot, {
        type: "task-presented",
        revision,
        taskId: message.taskId,
        state: message.state,
      })) return true;
      root.dataset.lastTaskPresentationRevision = String(revision);
      root.dataset.lastTaskPresentationId = message.taskId;
      root.dataset.lastTaskPresentationState = message.state;
      this.showActivity(root, message.state === "active" ? "TASK ACTIVE IN XR" : "TASK SHOWN IN XR", "system");
      return true;
    }
    if (message.type === "control") {
      if (typeof message.action !== "string" || !peerRunControlActions.has(message.action)) {
        throw new Error("Unsupported demonstrator control action");
      }
      const action = message.action === "next-task"
        ? "next"
        : message.action === "show-instructions"
          ? "instructions"
          : message.action as DirectRunControlAction;
      const nextCursor = isStateBoundRunControlAction(message.action) && typeof message.nextCursor === "string"
        ? message.nextCursor
        : undefined;
      if (isStateBoundRunControlAction(message.action) && !nextCursor) {
        throw new Error("Demonstrator state-bound control is missing its run cursor");
      }
      this.handleRunControl(root, action, "demonstrator", nextCursor);
      return true;
    }
    if (message.type !== "set-hand-display") return false;
    const raw = message.settings;
    if (!raw || typeof raw !== "object") throw new Error("Invalid demonstrator hand display settings");
    const candidate = raw as Partial<HandDisplaySettings>;
    if (!handRenderModes.includes(candidate.handMode as HandRenderMode)
      || !handShadingModes.includes(candidate.handShading as HandShadingMode)
      || !handTrailModes.includes(candidate.handTrail as HandTrailMode)) {
      throw new Error("Invalid demonstrator hand display settings");
    }
    const settings = normaliseHandDisplaySettings(candidate);
    this.applyHandDisplay(root, settings);
    this.setHandDisplay(root, settings);
    return true;
  }

  private wirePeerRecorder(root: HTMLElement, peer: RTCPeerConnection, channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", (event) => {
      if (this.disposed || this.peer !== peer || !(event.data instanceof ArrayBuffer)) return;
      try {
        const complete = this.peerRecorderAssembler.accept(event.data);
        if (complete) this.monitorRecorder.append(complete.block.slice().buffer);
      } catch (error) {
        this.peerRecorderAssembler.reset();
        this.showError(root, error, "DIRECT RECORDER MESSAGE REJECTED");
      }
    });
  }

  private handleMonitorRecorderEvent(event: MonitorRecorderEvent) {
    const root = this.mountedRoot;
    if (event.type === "error") {
      const message = this.monitorRecorderFailure.remember(event.message);
      if (root) this.showActivity(root, message.toUpperCase(), "error");
      const pending = this.pendingDirectFinalisation;
      if (pending?.captureFinalised && root) {
        this.queueDirectFinalisation(
          root,
          pending.episodeId,
          undefined,
          message,
          "DIRECT RECORDER FINALISATION FAILED",
        );
      }
      const control = this.peerControlChannel;
      if (control?.readyState === "open") control.send(JSON.stringify(this.monitorRecorderFailure.controlMessage));
      return;
    }
    if (event.type === "snapshot" && event.sessionId === this.sessionId && event.snapshot && root && isPeerConnectionMode(this.connectionProfile)) {
      if (this.directSessionMutatedSinceOpen) return;
      try {
        const captureConnected = this.controlTransportConnected();
        this.directSession.restore(event.snapshot, captureConnected);
        const recoveredFinalisation = this.directSession.pendingFinalisation();
        this.pendingDirectFinalisation = recoveredFinalisation
          && this.pendingDirectFinalisation?.episodeId === recoveredFinalisation.episodeId
          ? this.pendingDirectFinalisation
          : recoveredFinalisation
            ? { ...recoveredFinalisation, captureFinalised: false }
            : null;
        this.directSession.setRuntimeFeatures(this.runtimeFeatures);
        if (this.directCaptureStatus) this.directSession.setCaptureStatus(this.directCaptureStatus);
        const commands = captureConnected && this.peerControlChannel ? this.directSession.synchronise() : [];
        this.renderSnapshot(root, this.directSession.snapshot);
        if (commands.length > 0) {
          this.queueCommittedDirectCommands(root, commands, "DIRECT SESSION RECOVERY FAILED");
        }
      } catch (error) {
        this.showError(root, error, "DIRECT SESSION CATALOGUE REJECTED");
      }
      return;
    }
    if (event.type === "summary" && event.sessionId === this.sessionId && event.episodeId && event.summary && root) {
      const pending = this.pendingDirectFinalisation;
      if (!pending?.captureFinalised || pending.episodeId !== event.episodeId) return;
      this.queueDirectFinalisation(
        root,
        event.episodeId,
        event.summary,
        pending.error,
        "DIRECT RECORDER FINALISATION REJECTED",
      );
      return;
    }
    const nextSequence = typeof event.nextSequence === "number" ? event.nextSequence : Number.NaN;
    if (event.type === "ready" && event.sessionId === this.sessionId && Number.isSafeInteger(nextSequence)) {
      this.monitorRecorderReady = true;
      this.monitorRecorderNextSequence = nextSequence;
      if (root) this.persistRuntimeFeaturesWhenReady(root);
      if (root) void this.ensurePairingInvitation(root);
      const control = this.peerControlChannel;
      if (!this.monitorRecorderFailure.current && control?.readyState === "open" && root) {
        void this.persistDirectSnapshot().then(() => {
          if (this.monitorRecorderFailure.current || this.peerControlChannel !== control || control.readyState !== "open") return;
          control.send(JSON.stringify({ type: "recorder-ready", sessionId: this.sessionId, nextSequence }));
        }).catch((error) => this.reportDirectPersistenceFailure(root, error, "DIRECT RECORDER READINESS FAILED"));
      }
      return;
    }
    if (this.monitorRecorderFailure.current) return;
    const control = this.peerControlChannel;
    if (!control || control.readyState !== "open") return;
    const sequence = typeof event.sequence === "number" ? event.sequence : Number.NaN;
    if (event.type === "ack" && event.sessionId === this.sessionId && Number.isSafeInteger(sequence)) {
      this.monitorRecorderNextSequence = Math.max(this.monitorRecorderNextSequence ?? 0, sequence + 1);
      control.send(JSON.stringify({ type: "recorder-ack", sessionId: this.sessionId, sequence, status: event.status }));
      return;
    }
  }

  private showError(root: HTMLElement, error: unknown, fallback: string) {
    this.showActivity(root, error instanceof Error ? error.message.toUpperCase() : fallback, "error");
  }

  private showActivity(root: HTMLElement, text: string, kind: string) {
    const log = root.querySelector("#activity-log")!;
    const row = document.createElement("li");
    row.innerHTML = `<span class="activity-${escapeHtml(kind)}"></span><time>${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time><p>${escapeHtml(text)}</p>`;
    log.prepend(row);
    while (log.children.length > 7) log.lastElementChild?.remove();
  }
}
