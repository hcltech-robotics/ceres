import { applicationServices, mountUserIdentity, applicationHeaderMarkup, mountApplicationHeader, type UserIdentityState, type DirectoryInvitation } from "./application-services.js";
import { World } from "@iwsdk/core/dist/ecs/world.js";
import { pairingCodeInputError } from "../shared/pairing-code.js";

import { RayInteractable } from "@iwsdk/core/dist/input/state-tags.js";
import { BrowserQRCodeReader } from "@zxing/browser";
import jsQR from "jsqr";
import { CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from "three";
import { HandSpeedTracker, type HandSpeedSample } from "../shared/capture-quality.js";
import { localVoiceCommandContext } from "./local-voice-command-context.js";
import { cameraRegistrationMatches, normaliseCameraRegistration, type CameraRegistration } from "../shared/camera-registration.js";
import { defaultHandDisplaySettings, normaliseHandDisplaySettings, type HandDisplaySettings } from "../shared/hand-display.js";
import { classifyCaptureSensorSource, defaultCaptureStatus, defaultConfiguration, isDirectBeamDeliveryId, isRepetitionTask, isStateBoundRunControlAction, nextRunControlCursor, webRtcSignalNegotiationId, type CaptureConfiguration, type CaptureStatus, type ClientMessage, type DirectBeamAcknowledgement, type DirectBeamDeliveryState, type DirectRunState, type DirectTaskPresentationAcknowledgement, type Episode, type HandState, type PromptDelivery, type RecorderRunEvent, type RecordingReadiness, type RuntimeFeatures, type SensorFrame, type SequenceReadiness, type ServerMessage, type SessionSnapshot, type SessionTelemetryMode, type Transform, type WebRtcSignal } from "../shared/protocol.js";
import { colourWithAlpha, mixHexColours, semanticColours } from "../shared/semantic-colours.js";
import { taskResetDurationMs } from "../shared/run-sequencing.js";
import { DemonstratorAudioCuePlayer, DemonstratorAudioCueScheduler } from "./demonstrator-audio-cues.js";
import { readDemonstratorAudioCuePreference, writeDemonstratorAudioCuePreference } from "./demonstrator-audio-cue-preference.js";
import {
  LocalVoiceCommandController,
  LocalVoiceCommandRecovery,
  localVoiceCommandAction,
  localVoiceCommandHandDisplayControl,
  localVoiceCommandHandDisplaySettings,
  localVoiceCommandFailureKind,
  localVoiceCommandOverlay,
  localVoiceCommandRecognitionEnabled,
  localVoiceCommandStartupFailureRetryable,
  microphoneCaptureRequired,
  type LocalVoiceCommand,
  type LocalVoiceCommandFailure,
  type LocalVoiceCommandFailureKind,
  type LocalVoiceCommandStatus,
} from "./local-voice-command.js";
import { cameraViewPoseFromViewerPose, projectHandsToRegisteredCamera } from "./camera-projection.js";
import { cameraAccessCapability, enumerateOutwardCameras, isQuestBrowser, openMicrophone, openSelectedCamera, stopStream, type CameraChoice } from "./quest-camera.js";
import { releaseCaptureMediaResources } from "./capture-media-authority.js";
import { CameraCaptureComposer, cameraCaptureFrame, cameraCaptureFrameKey, cameraRegistrationForCaptureFrame } from "./camera-capture-frame.js";

import { withErrorContext, workerErrorFromEvent } from "./worker-errors.js";



import { connectionProfileFromSearch, connectionServerUrl, defaultConnectionProfile, isPeerConnectionMode, rtcConfigurationForConnectionProfile, sessionSocketBlocksMonitorFrame, type ConnectionProfile } from "./connection-profile.js";

import { activeTurnLease, normaliseTurnLease, type TurnLease } from "./turn-lease.js";
import { capturePairingId, SessionClient, suppliedSessionId, type TerminalCapturePairing } from "./session-client.js";
import { WebRtcSignalClient, type WebRtcSignalError } from "./webrtc-signal-client.js";
import { clearStoredPairingInvitationTarget, demonstratorSignalCredentials, isPairingSessionId, markStoredPairingInvitationTargetBound, normaliseShortPairingCode, pairingInvitationIdentityFromUrl, pairingInvitationTargetFromUrl, resolvePairingInvitationTarget, storedPairingInvitationTarget, storePairingInvitationTarget, type DemonstratorPairingInvite, type PairingInvitationTarget } from "./pairing-invite.js";
import { canvasFont } from "./typography.js";
import { CaptureRecorder, type DurableRecorderStatus } from "./recorder/capture-recorder.js";
import type { BridgeSender } from "./bridge/sender.js";
import type { BridgeCamera } from "./bridge/camera.js";
import { configureBridgeVideo } from "./bridge/video-quality.js";
import { DirectedCaptureDepth } from "./directed-capture-depth.js";
import { DEPTH_CHANNEL } from "../shared/bridge-depth.js";
import { bridgeSelectedCameraChoice, openBridgeCamera } from "./bridge-camera-selection.js";
import { installCaptureSetup, renderCaptureSetup } from "./capture-setup.js";
import { drawXrBridgeAttitude, drawXrBridgeReticle, drawXrVoiceIndicator } from "./xr-task-hud.js";
import { fragmentPeerRecorderBlock } from "./recorder/peer-recorder-framing.js";
import { advanceXrHudPress, clampXrTaskHudDragPosition, cycleXrHandDisplaySetting, drawXrCameraEdgeIndicators, drawXrCameraEdges, drawXrProgressReticle, isXrTaskHudAnchor, nearestXrTaskHudAnchor, xrCameraEdgesPresentation, xrCameraVoiceIndicatorState, xrCaptureControlColours, xrCaptureHudColours, xrCompletedTaskLabel, xrHandDisplayControlAtLocalX, xrHandDisplayHudOpacity, xrHandDisplayValue, xrHandSpeedAlertLabel, xrTaskHudChangeSignature, xrTaskHudControls, xrTaskHudReadinessPresentation, xrTaskHudRunPresentation, xrTaskHudTiming, xrTaskProgress, xrTrackingAlertPresentation, XR_CAMERA_EDGES_CANVAS_SIZE, XR_CAMERA_EDGES_DISTANCE_M, XR_CAMERA_EDGES_PLANE_SIZE_M, XR_CAPTURE_CENTRE_Y_M, XR_CAPTURE_CONTROL_PRESSED, XR_HAND_DISPLAY_CONTROLS, XR_HAND_DISPLAY_HUD_HEIGHT_M, XR_HAND_DISPLAY_HUD_IDLE_OPACITY, XR_HAND_DISPLAY_HUD_POSITION, XR_HAND_DISPLAY_HUD_WIDTH_M, XR_TASK_HUD_ANCHORS, XR_TASK_HUD_CONTROL_BOTTOM_INSET_M, XR_TASK_HUD_CONTROL_CENTRE_Y_M, XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M, XR_TASK_HUD_HEIGHT_M, XR_TASK_HUD_PANEL_OPACITY, XR_TASK_HUD_WIDTH_M, XR_TRACKING_ALERT_HEIGHT_M, XR_TRACKING_ALERT_POSITION, XR_TRACKING_ALERT_WIDTH_M, type XrHandDisplayControlKey, type XrTaskHudAnchor, type XrTaskHudControl, type XrTaskHudControlAction } from "./xr-task-hud.js";
import { runControls, runStatePresentation } from "./run-presentation.js";
import { loadRuntimeFeatures, RuntimeFeatureRecovery } from "./runtime-features-client.js";
import { iwerRuntimeDetected, syntheticSensorSourceRequested } from "./sensor-source.js";

import { alignManagedSimulatorHandState } from "./simulator-hand-visual-alignment.js";
import { XrHandVisualisation } from "./xr-hand-visualisation.js";
import {
  CERES_BRIDGE_XR_SESSION_OPTIONS,
  CERES_DIRECTED_XR_SESSION_OPTIONS,
  CERES_SOLO_XR_SESSION_OPTIONS,
  captureIgnoresControllers,
  configureCaptureControllerInputPolicy,
  configureCaptureHandRayVisuals,
  recogniseXrControllers,
  recogniseXrHands,
  soloSuppressesHandTrackingAlerts,
  type CaptureControllerInputPolicy,
  type XrControllerRecognition,
  type XrHandRecognition,
} from "./xr-session-options.js";
import { cycleWorkProgress, HandTrackingAlertTracker, recorderWriteIndicatorVisible } from "./xr-recorder-feedback.js";
import { CERES_HORIZON_UI_KIT } from "./xr-horizon-kit.js";
import {
  XrCaptureHorizonHud,
  xrCaptureHorizonAppearanceFramePosition,
  type XrCaptureHorizonHudPresentation,
} from "./xr-capture-horizon-hud.js";
import {
  XR_HAND_SPEED_WARNING_PRESENTATION,
  xrCaptureHorizonRunControlPresentation,
} from "./xr-capture-horizon-presentation.js";
import { XrStartupIntro } from "./xr-startup-intro.js";
import { guardImmersiveRendererResize } from "./xr-renderer-resize-guard.js";
import { launchIwsdkXrSession } from "./iwsdk-xr-launch.js";
import { XrLaunchSingleFlight, type XrLaunchAttempt } from "./xr-launch-single-flight.js";
import {
  XrPostAcquisitionQualityHud,
  type XrPostAcquisitionQualityPresentation,
} from "./xr-post-acquisition-quality-hud.js";
import type { SoloXrConsolePage } from "./solo-xr-console-presentation.js";
import type { SoloXrConsoleState } from "./solo-xr-workspace.js";
import {
  DirectRecorderCommandBoundary,
  directRecorderError,
  type DirectRecorderCommandAction,
  type DirectRecorderCommandResult,
} from "./direct-recorder-command-boundary.js";
import type {
  CaptureAuthorityControlAction,
  CaptureAuthorityControlMessage,
  CaptureAuthorityPort,
} from "./capture-authority.js";
import { SessionClientCaptureAuthority } from "./session-client-capture-authority.js";


export {
  DirectRecorderCommandBoundary,
  type DirectRecorderCommandResult,
} from "./direct-recorder-command-boundary.js";

export interface CaptureXrWorkspace {
  mount(world: any): void;
  unmount(): void;
  show(): void;
  setSessionActive(active: boolean): void;
  update(state: SoloXrConsoleState): void;
  restorePage(page: SoloXrConsolePage): void;
  dispose(): void;
}

export interface CaptureAppOptions {
  bridge?: BridgeSender;
  authority?: CaptureAuthorityPort | null;
  xrWorkspace?: CaptureXrWorkspace | null;
  onSoloStartRun?: () => void | Promise<void>;
  onSoloReconfigure?: () => void | Promise<void>;
  onSoloRetread?: () => void | Promise<void>;
  onAudioRecordingChange?: (enabled: boolean) => void | Promise<void>;
  isXrLaunchAllowed?: () => boolean;
  onLaunchStateChange?: (state: CaptureLaunchPresentationState) => void;
}

declare const __CERES_TEST_HEADLESS_RENDERING__: boolean;
declare const __CERES_BROWSER_TESTS__: boolean;
declare const __CERES_BUILD_IDENTITY__: {
  version: string;
  codename: string;
  shortCommit: string | null;
};

const SENSOR_INTERVAL_MS = 33;
const HEADLESS_TEST_MONITOR_INTERVAL_MS = 200;
const BEAM_DISPLAY_MS = 8_000;
const BEAM_HUD_DISTANCE_M = .82;
const BEAM_HUD_VERTICAL_OFFSET_M = .02;
const TASK_HUD_REFRESH_MS = 100;
const TASK_HUD_TYPE_INTERVAL_MS = 28;
const TASK_HUD_BLINK_MS = 840;
const TASK_COMPLETION_OVERLAY_MS = 1_600;
const TASK_HUD_CONTROL_INSET_PX = 48;
const TASK_HUD_CONTROL_GAP_PX = 14;
const NOUN_PROJECT_CASSETTE_ICON = "/assets/noun-cassette-tape-1077670.svg";

type DemonstratorControlAction = CaptureAuthorityControlAction;
type CapturePeerControlMessage = Extract<ClientMessage, { type: "control" | "set-hand-display" | "set-telemetry-mode" }>;
type CapturePeerControlChannel = Pick<RTCDataChannel, "readyState" | "send">;

export function directCaptureReadiness(
  state: DirectRunState,
  configuration: CaptureConfiguration,
  controlConnected: boolean,
  configurationApplied: boolean,
  recorder: CaptureStatus["recorder"],
): { sequenceReadiness: SequenceReadiness; recordingReadiness: RecordingReadiness } {
  const sequenceBlockers: SequenceReadiness["blockers"] = [];
  if (state.run.status === "running") sequenceBlockers.push({ code: "sequence-active", message: "The direct sequence is already active" });
  if (configuration.tasks.length === 0) sequenceBlockers.push({ code: "no-task", message: "Configure at least one task" });
  if (!controlConnected) sequenceBlockers.push({ code: "capture-disconnected", message: "The capture director is not connected" });
  if (!configurationApplied) sequenceBlockers.push({ code: "configuration-not-applied", message: "The current configuration has not been applied" });
  if (recorder === "failed") sequenceBlockers.push({ code: "recorder-failed", message: "The durable recorder failed" });
  else if (recorder !== "armed") sequenceBlockers.push({ code: "recorder-not-armed", message: "The durable recorder is not armed" });

  const recordingBlockers: RecordingReadiness["blockers"] = [];
  const task = configuration.tasks[state.run.activeTaskIndex];
  if (state.run.status !== "running") recordingBlockers.push({ code: "sequence-not-started", message: "Start the sequence before recording" });
  if (state.run.phase !== "active-task") recordingBlockers.push({ code: "run-not-ready", message: "Recording is only available during an active task" });
  if (!controlConnected) recordingBlockers.push({ code: "capture-disconnected", message: "The capture director is not connected" });
  if (!configurationApplied) recordingBlockers.push({ code: "configuration-not-applied", message: "The current configuration has not been applied" });
  if (!task) recordingBlockers.push({ code: "no-task", message: "There is no active task" });
  else if (task.type === "pause") recordingBlockers.push({ code: "task-not-recordable", message: "The active task is a pause" });
  if (recorder === "failed") recordingBlockers.push({ code: "recorder-failed", message: "The durable recorder failed" });
  else if (recorder !== "armed") recordingBlockers.push({ code: "recorder-not-armed", message: "The durable recorder is not armed" });
  if (state.currentEpisode || state.pendingEpisode || state.run.recordingState !== "idle") {
    recordingBlockers.push({ code: "recording-active", message: "A recording transition is already active" });
  }
  return {
    sequenceReadiness: { ready: sequenceBlockers.length === 0, blockers: sequenceBlockers },
    recordingReadiness: { ready: recordingBlockers.length === 0, blockers: recordingBlockers },
  };
}

export interface CaptureXrLaunchState {
  invitation: boolean;
  intentGranted: boolean;
  controlConnected: boolean;
  recorder: CaptureStatus["recorder"];
  xr: CaptureStatus["xr"];
  secureContext: boolean;
  authorityRevoked: boolean;
}

export interface CaptureLaunchPresentationState {
  camera: CaptureStatus["camera"];
  recorder: CaptureStatus["recorder"];
  xr: CaptureStatus["xr"];
  xrLaunchReady: boolean;
  leftHandRecognition: "waiting" | "recognised" | "missing";
  rightHandRecognition: "waiting" | "recognised" | "missing";
}

export function captureXrLaunchReady(state: CaptureXrLaunchState) {
  return state.invitation
    && state.intentGranted
    && state.controlConnected
    && (state.recorder === "armed" || state.recorder === "paused")
    && state.secureContext
    && !state.authorityRevoked
    && state.xr !== "requesting"
    && state.xr !== "active";
}

export function pairingInvitationTargetsMatch(first: PairingInvitationTarget, second: PairingInvitationTarget) {
  return first.invite.version === second.invite.version
    && first.invite.sessionId === second.invite.sessionId
    && first.invite.roomId === second.invite.roomId
    && first.invite.demonstratorCapability === second.invite.demonstratorCapability
    && first.invite.expiresAt === second.invite.expiresAt
    && first.connectionProfile.mode === second.connectionProfile.mode
    && first.connectionProfile.relayUrl === second.connectionProfile.relayUrl;
}

export const capturePeerControlChannelOptions: RTCDataChannelInit = { ordered: true };

export function captureControlMessage(action: DemonstratorControlAction, nextCursor?: string): Extract<ClientMessage, { type: "control" }> {
  const normalisedAction = action === "next"
    ? "next-task"
    : action === "instructions"
      ? "show-instructions"
      : action;
  if (isStateBoundRunControlAction(normalisedAction)) {
    if (!nextCursor) throw new Error("The state-bound control requires the current run cursor");
    return { type: "control", action: normalisedAction, nextCursor };
  }
  return { type: "control", action: normalisedAction };
}

export function captureTelemetryModeMessage(telemetryMode: SessionTelemetryMode): Extract<ClientMessage, { type: "set-telemetry-mode" }> {
  return { type: "set-telemetry-mode", telemetryMode };
}

export function sendCapturePeerControlMessage(
  channels: Iterable<CapturePeerControlChannel>,
  message: CapturePeerControlMessage,
) {
  const encoded = JSON.stringify(message);
  let sent = false;
  for (const channel of channels) {
    if (channel.readyState !== "open") continue;
    try {
      channel.send(encoded);
      sent = true;
    } catch {
      // A second paired channel may still be able to carry the control message.
    }
  }
  return sent;
}

export type CaptureRecorderTransportMode = "local" | "peer" | "session";

export function captureRecorderTransportMode(
  authority: Pick<CaptureAuthorityPort, "recorderTransport" | "supportsPeerMedia">,
  connectionProfile: ConnectionProfile,
): CaptureRecorderTransportMode {
  if (authority.recorderTransport) return "local";
  if (authority.supportsPeerMedia && isPeerConnectionMode(connectionProfile)) return "peer";
  return "session";
}

export function captureModeNavigationLocked(
  snapshot: SessionSnapshot | null,
  xr: CaptureStatus["xr"],
  xrSessionActive: boolean,
  recordingFinalising: boolean,
) {
  return xrSessionActive
    || xr === "requesting"
    || xr === "active"
    || recordingFinalising
    || snapshot?.solo?.startCountdownDeadlineMs != null
    || snapshot?.run.recordingState !== undefined && snapshot.run.recordingState !== "idle"
    || Boolean(snapshot?.currentEpisode)
    || Boolean(snapshot?.pendingEpisode);
}

export function xrSessionSurfaceVisible(
  session: Pick<XRSession, "visibilityState"> | { visibilityState?: undefined } | null,
) {
  return session !== null
    && (session.visibilityState === undefined || session.visibilityState === "visible");
}

export function captureShouldPauseOnXrExit(
  snapshot: Pick<SessionSnapshot, "run" | "currentEpisode"> | null,
) {
  return snapshot?.run.status === "running"
    && snapshot.run.recordingState === "recording"
    && snapshot.currentEpisode !== null;
}

export type RecorderFinalisationStage = "closing-media" | "saving" | "validating";

export const RECORDER_MEDIA_STOP_TIMEOUT_MS = 10_000;
export const RECORDER_MEDIA_TAIL_TIMEOUT_MS = 10_000;

class RecorderFinalisationTimeoutError extends Error {
  readonly name = "RecorderFinalisationTimeoutError";

  constructor(
    readonly finalisationStage: RecorderFinalisationStage,
    message: string,
  ) {
    super(message);
  }
}

function promiseWithinRecorderFinalisationDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: RecorderFinalisationStage,
  message: string,
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new RecorderFinalisationTimeoutError(stage, message));
    }, Math.max(1, timeoutMs));
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function stopMediaRecorderWithinDeadline(
  recorder: MediaRecorder,
  label: "audio" | "video",
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      recorder.removeEventListener?.("stop", stopped);
      if (error) reject(error);
      else resolve();
    };
    const stopped = () => finish();
    const timeout = globalThis.setTimeout(() => {
      finish(new RecorderFinalisationTimeoutError(
        "closing-media",
        `Recorder finalisation timed out while stopping the ${label} recorder`,
      ));
    }, Math.max(1, timeoutMs));
    recorder.addEventListener("stop", stopped, { once: true });
    try {
      recorder.stop();
    } catch (error) {
      const detail = error instanceof Error && error.message.trim()
        ? `: ${error.message.trim()}`
        : "";
      finish(new Error(`The ${label} recorder could not stop${detail}`));
    }
  });
}

function combinedRecorderFinalisationFailure(failures: readonly Error[]) {
  const unique = failures.filter((failure, index) => (
    failures.findIndex((candidate) => candidate === failure || candidate.message === failure.message) === index
  ));
  if (unique.length === 1) return unique[0];
  return new Error(unique.map((failure) => failure.message).join("; "));
}

function recorderFinalisationTimedOut(error: unknown) {
  return error instanceof RecorderFinalisationTimeoutError
    || (error instanceof Error && /finalisation[^;]*timed out|timed out[^;]*finalis/i.test(error.message));
}

export interface RecorderFinalisationProgress {
  stage: RecorderFinalisationStage;
  label: string;
  value: number | null;
  completed: number;
  total: number;
  signature: string;
}

export function recorderFinalisationProgress(
  status: Pick<
    CaptureStatus,
    | "recorderDurableAckSequence"
    | "recorderFinaliseStartAckSequence"
    | "recorderFinaliseTargetSequence"
    | "recorderQueuedBlocks"
  >,
  finalising: boolean,
): RecorderFinalisationProgress | null {
  if (!finalising) return null;
  const start = status.recorderFinaliseStartAckSequence;
  const target = status.recorderFinaliseTargetSequence;
  const acknowledgement = status.recorderDurableAckSequence;
  const queued = Math.max(0, status.recorderQueuedBlocks);
  const signature = [start ?? "open", target ?? "open", acknowledgement, queued].join(":");
  if (start === null || target === null) {
    return {
      stage: "closing-media",
      label: queued > 0 ? `CLOSING MEDIA/${queued} QUEUED` : "CLOSING MEDIA",
      value: null,
      completed: 0,
      total: queued,
      signature: `closing-media:${signature}`,
    };
  }
  const total = Math.max(0, target - start);
  const completed = Math.max(0, Math.min(total, acknowledgement - start));
  if (acknowledgement >= target) {
    return {
      stage: "validating",
      label: "VALIDATING CAPTURE",
      value: 1,
      completed: total,
      total,
      signature: `validating:${signature}`,
    };
  }
  return {
    stage: "saving",
    label: `SAVING ${completed}/${total}`,
    value: total === 0 ? 0 : completed / total,
    completed,
    total,
    signature: `saving:${signature}`,
  };
}

export function applyDirectRecorderTransition(
  action: "recording-paused" | "recording-resumed",
  pause: () => void,
  resume: () => void,
) {
  if (action === "recording-paused") pause();
  else resume();
}

export function normaliseCaptureSessionId(value: unknown) {
  return isPairingSessionId(value) ? value : "";
}

function headsetModelFromUserAgent(userAgent: string) {
  const matchers: Array<[RegExp, string]> = [
    [/Quest 3S/i, "Quest 3S"],
    [/Quest 3/i, "Quest 3"],
    [/Quest Pro/i, "Quest Pro"],
    [/Quest 2/i, "Quest 2"],
    [/Oculus Quest/i, "Meta Quest"],
  ];
  return matchers.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "WebXR headset";
}

const TASK_HUD_ANCHOR_STORAGE_KEY = "ceres.xr-task-hud-anchor";
const XR_HUD_ACCENT = semanticColours.accent;
const XR_HUD_COLOURS = xrCaptureHudColours;
const XR_CONTROL_COLOURS = xrCaptureControlColours;
const XR_CONTROL_PRESSED = XR_CAPTURE_CONTROL_PRESSED;

type IwerWindow = Window & {
  IWER?: unknown;
  IWER_DEVICE?: unknown;
  __IWER_MCP_MANAGED?: boolean;
};

const currentIwerWindow = () => window as IwerWindow;
const isMetaManagedXr = () => Boolean(currentIwerWindow().__IWER_MCP_MANAGED);
const browserTestRuntime = () => typeof __CERES_BROWSER_TESTS__ !== "undefined"
  && __CERES_BROWSER_TESTS__;
const usesSyntheticSensorSource = () => syntheticSensorSourceRequested(
  location.search,
  browserTestRuntime(),
);
const currentCaptureSensorSource = (nativeWebXr: boolean) => classifyCaptureSensorSource({
  synthetic: usesSyntheticSensorSource(),
  iwerDevice: iwerRuntimeDetected(currentIwerWindow()),
  metaManagedXr: false,
  nativeWebXr,
});
const usesHeadlessTestRendering = () => typeof __CERES_TEST_HEADLESS_RENDERING__ !== "undefined"
  && __CERES_TEST_HEADLESS_RENDERING__;

type QrDetector = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};

type QrDetectorConstructor = new (options?: { formats?: string[] }) => QrDetector;

type XrCanvasHud = {
  group: Group;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  material: MeshBasicMaterial;
};

export type SoloPostAcquisitionQualityPresentation =
  XrPostAcquisitionQualityPresentation;

export interface SoloUploadHudStatus {
  stage: "preparing" | "uploading" | "finalising";
  label: string;
  detail: string;
  progress: number | null;
}

type XrTaskHud = XrCanvasHud & {
  anchor: XrTaskHudAnchor;
  drag: { pointerId: number; offsetX: number; offsetY: number } | null;
  frameMaterial: MeshBasicMaterial;
  hoveredControl: XrTaskHudControlAction | null;
  pressedControl: XrTaskHudControlAction | null;
  interacting: boolean;
};

type XrHandDisplayHud = XrCanvasHud & {
  hoveredControl: XrHandDisplayControlKey | null;
  pressedControl: XrHandDisplayControlKey | null;
};

type XrHandsReadResult = {
  left: HandState;
  right: HandState;
  leftJointPoseCount: number;
  rightJointPoseCount: number;
};

type SpatialPointerEvent = {
  button?: number;
  currentTarget: { setPointerCapture: (pointerId: number) => void };
  point: Vector3;
  pointerId: number;
  stopPropagation: () => void;
};

type XrTrackingVisuals = {
  reticle: Group;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  cameraEdges: {
    canvas: HTMLCanvasElement;
    texture: CanvasTexture;
  };
  alert: {
    group: Group;
    canvas: HTMLCanvasElement;
    texture: CanvasTexture;
  };
  hands: XrHandVisualisation | null;
};

type XrWarningTapePresentation = {
  label: string;
  dangerRatio: number;
  tapeOpacity: number;
  pulseIntervalMs: number;
};

type LocalVoiceCommandOverlayNotice = {
  expiresAtMs: number;
  presentation: XrWarningTapePresentation;
};

const PASS_FAIL_REVIEW_NOTICE = "Pass and fail are only available during the task reset";

const emptyHand = (): HandState => ({ tracked: false, pinch: 0, joints: {} });

const disposeObject3DResources = (root: Object3D) => {
  const geometries = new Set<{ dispose: () => void }>();
  const materials = new Set<{ dispose: () => void }>();
  const textures = new Set<{ dispose: () => void }>();
  root.traverse((object) => {
    const renderable = object as Object3D & {
      geometry?: { dispose: () => void };
      material?: { dispose: () => void } | Array<{ dispose: () => void }>;
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    const entries = Array.isArray(renderable.material) ? renderable.material : renderable.material ? [renderable.material] : [];
    for (const material of entries) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && "isTexture" in value && "dispose" in value) {
          textures.add(value as { dispose: () => void });
        }
      }
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  root.removeFromParent();
};

const toTransform = (transform: any): Transform => ({
  position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
  rotation: { x: transform.orientation.x, y: transform.orientation.y, z: transform.orientation.z, w: transform.orientation.w },
});

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!);

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const xrAlertLabel = (value: string | null) => {
  const label = value?.replace(/\s+/g, " ").trim() ?? "";
  if (label.length <= 72) return label || null;
  return `${label.slice(0, 69).trimEnd()}...`;
};

export class CaptureApp {
  private disposed = false;
  private captureAuthorityRevoked = false;
  private readonly pairingId: string;
  private connectionProfile: ConnectionProfile;
  private pairingInvite: DemonstratorPairingInvite | null = null;
  private pairingInvitationBound = false;
  private pairingInvitationBoundAt: string | null = null;
  private sessionKey: string;
  private authority: CaptureAuthorityPort;
  private webRtcSignal: WebRtcSignalClient | null = null;
  private captureIntentGranted = false;
  private captureAuthorityGranted = false;
  private captureXrAuthorityRequested = false;
  private readonly bridge: BridgeSender | null;
  private bridgePitch = 0;
  private bridgeRoll = 0;
  private recordingRecorder: CaptureRecorder | null = null;
  private get recorder(): CaptureRecorder {
    if (!this.recordingRecorder) throw new Error("Recording is unavailable in Bridge mode");
    return this.recordingRecorder;
  }
  private readonly directRecorderBoundary: DirectRecorderCommandBoundary;
  private readonly recorderRunEvents = new Set<string>();
  private readonly pendingRecorderRunEvents: Array<{ episodeId: string; event: RecorderRunEvent; key: string }> = [];
  private activeRecorderEpisode: Episode | null = null;
  private activeRecorderDurableAckBaseline: number | null = null;
  private recorderWorkflowFailureOutcomeHint: { episodeId: string; timedOut: boolean } | null = null;
  private recorderWorkflowTerminalEpisodeId: string | null = null;
  private mountedRoot: HTMLElement | null = null;
  private armedRecorderSession = "";
  private armedRecorderRate = 0;
  private configuration: CaptureConfiguration = structuredClone(defaultConfiguration);
  private runtimeFeatures: RuntimeFeatures = { speech: true };
  private runtimeFeaturesLoaded = false;
  private runtimeFeaturesAvailable = false;
  private readonly runtimeFeatureRecovery = new RuntimeFeatureRecovery();
  private demonstratorAudioCuePreference = true;
  private handDisplaySettings: HandDisplaySettings = { ...defaultHandDisplaySettings };
  private appliedConfigurationRevision = -1;
  private captureStatus: CaptureStatus = structuredClone(defaultCaptureStatus);
  private world: any | null = null;
  private xrSession: any | null = null;
  private xrReferenceSpace: any | null = null;
  private cameraChoices: CameraChoice[] = [];
  private selectedCamera: CameraChoice | null = null;
  private cameraRegistration: CameraRegistration | null = null;
  private cameraStream: MediaStream | null = null;
  private bridgeCamera: BridgeCamera | null = null;
  private bridgeCameraAcquisition: AbortController | null = null;
  private cameraCaptureComposer: CameraCaptureComposer | null = null;
  private cameraSelectionGeneration = 0;
  private microphoneStream: MediaStream | null = null;
  private microphoneAcquisition: Promise<MediaStream | null> | null = null;
  private localVoiceCommands: LocalVoiceCommandController | null = null;
  private localVoiceCommandStatus: LocalVoiceCommandStatus = "loading";
  private localVoiceCommandErrorDetail: string | null = null;
  private localVoiceCommandErrorKind: LocalVoiceCommandFailureKind | null = null;
  private localVoiceCommandRecognitionStartedAt: number | null = null;
  private localVoiceStartPending: { context: string; expiresAt: number } | null = null;
  private localVoiceSoloStartPending = false;
  private localVoiceCommandResult: { matched: boolean; receivedAtMs: number } | null = null;
  private readonly localVoiceCommandRecovery = new LocalVoiceCommandRecovery();
  private localVoiceCommandOverlayNotice: LocalVoiceCommandOverlayNotice | null = null;
  private localVoiceCommandOverlayPending = false;
  private runControlNotice: (LocalVoiceCommandOverlayNotice & { message: string }) | null = null;
  private runControlNoticeTimer: number | null = null;
  private soloUploadStatus: SoloUploadHudStatus | null = null;
  private captureStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioRecorder: MediaRecorder | null = null;
  private mediaSequence = 0;
  private audioSequence = 0;
  private mediaChunkTail: Promise<void> = Promise.resolve();
  private audioChunkTail: Promise<void> = Promise.resolve();
  private mediaChunkFailure: Error | null = null;
  private audioChunkFailure: Error | null = null;
  private recordingFinalise: Promise<void> = Promise.resolve();
  private recordingFinalising = false;
  private recorderMediaStopTimeoutMs = RECORDER_MEDIA_STOP_TIMEOUT_MS;
  private recorderMediaTailTimeoutMs = RECORDER_MEDIA_TAIL_TIMEOUT_MS;
  private recorderFinalisationStartedAt: number | null = null;
  private recorderFinalisationTelemetrySignatures = new Set<string>();
  private recorderFinalisationTerminalReported = false;
  private frameIndex = 0;
  private lastSensorAt = 0;
  private sensorWindowStart = 0;
  private sensorWindowFrames = 0;
  private sensorLoopRunning = false;
  private sensorLoopFailureReported = false;
  private recorderFinalisationFailureReported = false;
  private simulatedSensorFrame: number | null = null;
  private lastSimulatedRecorderAt = Number.NEGATIVE_INFINITY;
  private xrSensorFrame: number | null = null;
  private xrStartupIntroFrame: number | null = null;
  private xrSoloPostAcquisitionFrame: number | null = null;
  private xrSoloPostAcquisitionFrameSession: XRSession | null = null;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly peerNegotiationIds = new Map<string, string>();
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly remoteDescriptionReadyPeers = new Set<string>();
  private readonly pendingOutgoingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly signalledLocalDescriptions = new Set<string>();
  private readonly peerTelemetryChannels = new Map<string, RTCDataChannel>();
  private readonly peerControlChannels = new Map<string, RTCDataChannel>();
  private readonly directedDepth = new DirectedCaptureDepth();
  private readonly taskPresentationByChannel = new WeakMap<RTCDataChannel, string>();
  private readonly pendingTaskPresentationByChannel = new Map<RTCDataChannel, {
    acknowledgement: DirectTaskPresentationAcknowledgement;
    frame: number;
    signature: string;
  }>();
  private readonly pendingBeamPresentationByChannel = new Map<RTCDataChannel, { deliveryId: string; frame: number }>();
  private readonly peerRecorderChannels = new Map<string, RTCDataChannel>();
  private relayedTurnPermit: TurnLease | null = null;
  private transientSignalIssue: string | null = null;
  private pairingJourneyKey: string | null = null;
  private connected = false;
  private qrScanning = false;
  private readonly qrFallbackReader = new BrowserQRCodeReader();
  private snapshot: SessionSnapshot | null = null;
  private xrCaptureHorizonHud: XrCaptureHorizonHud | null = null;
  private xrStartupIntro: XrStartupIntro | null = null;
  private xrTrackingAlertText: string | null = null;
  private xrTaskHud: XrTaskHud | null = null;
  private xrHandDisplayHud: XrHandDisplayHud | null = null;
  private xrBeamHud: XrCanvasHud | null = null;
  private xrSoloPostAcquisitionHud: XrPostAcquisitionQualityHud | null = null;
  private soloPostAcquisitionPresentation: SoloPostAcquisitionQualityPresentation | null = null;
  private xrTrackingVisuals: XrTrackingVisuals | null = null;
  private taskHudTimer: number | null = null;
  private taskHudRevealFrame: number | null = null;
  private taskHudRevealStartedAt: number | null = null;
  private lastTaskHudAnimationStep = "";
  private lastXrTaskSignature = "";
  private lastBeamText = "";
  private xrPresentationGeneration = 0;
  private xrPresentationFrameCount = 0;
  private beamHudTimeout: number | null = null;
  private reviewTimer: number | null = null;
  private xrEventSource: any | null = null;
  private xrSessionStartHandler: (() => void) | null = null;
  private xrSessionEndHandler: (() => void) | null = null;
  private xrSessionVisibilityChangeHandler: (() => void) | null = null;
  private xrSessionVisibilityEventSource: XRSession | null = null;
  private xrInputSourcesChangeHandler: (() => void) | null = null;
  private readonly xrLaunch = new XrLaunchSingleFlight();
  private soloHandRecognition: XrHandRecognition = { left: false, right: false };
  private soloControllerRecognition: XrControllerRecognition = { left: false, right: false };
  private captureControllerInputPolicy: CaptureControllerInputPolicy | null = null;
  private restoreXrRendererResize: (() => void) | null = null;
  private readonly handSpeedTracker = new HandSpeedTracker();
  private readonly handTrackingAlert = new HandTrackingAlertTracker();
  private readonly demonstratorAudioCueScheduler = new DemonstratorAudioCueScheduler();
  private readonly demonstratorAudioCuePlayer = new DemonstratorAudioCuePlayer();
  private readonly simulatedHeadPosition = new Vector3();
  private readonly simulatedHeadRotation = new Quaternion();
  private latestHandSpeed: HandSpeedSample | null = null;
  private taskCompletionOverlay: { label: string; startedAt: number } | null = null;
  private previousRecorderPendingBlocks = 0;
  private recorderQueueDrainedAt: number | null = null;
  private lastXrReticleRenderAt = Number.NEGATIVE_INFINITY;
  private xrCameraEdgesShownAt: number | null = null;
  private readonly recordingIcon = new Image();
  private promptAudioContext: AudioContext | null = null;
  private promptAudioReady = false;
  private readonly promptAssets = new Map<string, HTMLAudioElement>();
  private disposeAccountIdentity: (() => void) | null = null;
  private disposeSiteHeader: (() => void) | null = null;
  private accountInviteTimer: number | null = null;
  private readonly xrWorkspace: CaptureXrWorkspace | null;
  private readonly onSoloStartRun: (() => void | Promise<void>) | null;
  private readonly onSoloReconfigure: (() => void | Promise<void>) | null;
  private readonly onSoloRetread: (() => void | Promise<void>) | null;
  private readonly onAudioRecordingChange: ((enabled: boolean) => void | Promise<void>) | null;
  private readonly isXrLaunchAllowed: (() => boolean) | null;
  private readonly onLaunchStateChange: ((state: CaptureLaunchPresentationState) => void) | null;
  private launchPresentationState: CaptureLaunchPresentationState | null = null;
  private audioRecordingChangePending = false;
  private xrOperationsMenuOpen = false;
  private disposeRecorderTransportControl: (() => void) | null = null;
  private xrExitPauseRetryTimer: number | null = null;
  private xrExitPausePending = false;
  private xrExitRecorderPaused = false;

  constructor(options: CaptureAppOptions = {}) {
    this.bridge = options.bridge ?? null;
    this.xrWorkspace = options.xrWorkspace ?? null;
    this.onSoloStartRun = options.onSoloStartRun ?? null;
    this.onSoloReconfigure = options.onSoloReconfigure ?? null;
    this.onSoloRetread = options.onSoloRetread ?? null;
    this.onAudioRecordingChange = options.onAudioRecordingChange ?? null;
    this.isXrLaunchAllowed = options.isXrLaunchAllowed ?? null;
    this.onLaunchStateChange = options.onLaunchStateChange ?? null;
    if (this.bridge) {
      this.authority = this.bridge;
      this.pairingId = "";
      this.sessionKey = "";
      this.connectionProfile = { ...defaultConnectionProfile };
      this.configuration.recordAudio = false;
      this.configuration.tasks = [];
      this.directRecorderBoundary = this.createDirectRecorderBoundary();
      return;
    }
    this.recordingIcon.src = NOUN_PROJECT_CASSETTE_ICON;
    if (options.authority) {
      this.authority = options.authority;
      this.pairingId = options.authority.pairingId;
      this.connectionProfile = { ...defaultConnectionProfile };
      this.sessionKey = options.authority.sessionId;
      this.recordingRecorder = new CaptureRecorder(
        (status) => this.receiveRecorderStatus(status),
        options.authority.kind === "solo" ? { storageRootName: "ceres-solo-recordings" } : {},
      );
      this.attachAuthorityRecorderTransport();
      this.directRecorderBoundary = this.createDirectRecorderBoundary();
      return;
    }
    this.pairingId = capturePairingId();
    const suppliedSession = suppliedSessionId();
    const locationTarget = pairingInvitationTargetFromUrl(location.href);
    const hasInvitationFragment = new URLSearchParams(location.hash.slice(1)).has("invite");
    const locationIdentity = hasInvitationFragment ? pairingInvitationIdentityFromUrl(location.href) : null;
    const storedTarget = storedPairingInvitationTarget();
    const matchingStoredTarget = locationIdentity && storedTarget && pairingInvitationTargetsMatch(locationIdentity, storedTarget)
      ? storedTarget
      : null;
    const restoredTarget = matchingStoredTarget
      ?? locationTarget
      ?? (!hasInvitationFragment && !suppliedSession && storedTarget?.boundAt ? storedTarget : null);
    this.connectionProfile = restoredTarget?.connectionProfile ?? connectionProfileFromSearch();
    this.pairingInvite = restoredTarget?.invite ?? null;
    this.pairingInvitationBound = Boolean(restoredTarget?.boundAt);
    this.pairingInvitationBoundAt = restoredTarget?.boundAt ?? null;
    this.sessionKey = normaliseCaptureSessionId(this.pairingInvite?.sessionId ?? (hasInvitationFragment ? null : suppliedSession));
    if (hasInvitationFragment && !restoredTarget) {
      this.beginPairingJourney("invitation");
      this.finishPairingJourney("failed");
    }
    if (locationTarget && !matchingStoredTarget) storePairingInvitationTarget(locationTarget);
    this.authority = new SessionClientCaptureAuthority(
      new SessionClient(this.sessionKey, "capture", this.pairingId),
    );
    this.recordingRecorder = new CaptureRecorder((status) => this.receiveRecorderStatus(status));
    this.directRecorderBoundary = this.createDirectRecorderBoundary();
  }

  private attachAuthorityRecorderTransport() {
    const transport = this.authority.recorderTransport;
    if (!transport) return;
    this.recorder.setPeerBlockSender((sequence, block) => transport.sendBlock(sequence, block));
    this.disposeRecorderTransportControl = transport.onControl(
      (message) => this.recorder.receivePeerControl(message),
    );
  }

  private createDirectRecorderBoundary() {
    return new DirectRecorderCommandBoundary(
      async (episodeId, episode) => {
        const root = this.mountedRoot;
        if (!root) return { accepted: false, error: "The demonstrator capture surface is unavailable" };
        const accepted = await this.startRecorders(root, episodeId, false, episode);
        if (accepted && usesSyntheticSensorSource()) {
          const hold = (window as typeof window & { __ceresRecordingAcceptanceHold?: Promise<void> })
            .__ceresRecordingAcceptanceHold;
          if (hold) await hold;
        }
        return {
          accepted,
          ...(accepted ? {} : {
            error: this.recorder.failureReason
              ? `Durable recorder failed: ${this.recorder.failureReason}`
              : "The durable recorder did not arm",
          }),
        };
      },
      async () => {
        const root = this.mountedRoot;
        if (!root) return { error: "The demonstrator capture surface is unavailable" };
        try {
          await this.stopRecorders(root);
          if (usesSyntheticSensorSource()) {
            const hold = (window as typeof window & { __ceresRecordingFinalisationHold?: Promise<void> })
              .__ceresRecordingFinalisationHold;
            if (hold) await hold;
          }
          return {};
        } catch (error) {
          return { error: this.failRecorderFinalisation(root, error) };
        }
      },
    );
  }

  mount(root: HTMLElement) {
    if (this.disposed) throw new Error("A disposed capture application cannot be mounted");
    this.mountedRoot = root;
    this.captureStatus = {
      ...this.captureStatus,
      headsetModel: headsetModelFromUserAgent(navigator.userAgent),
      sensorSource: currentCaptureSensorSource(false),
      questBrowser: isQuestBrowser(),
    };
    const shell = applicationServices();
    this.runtimeFeatures = { speech: !this.bridge };
    this.runtimeFeaturesLoaded = false;
    this.runtimeFeaturesAvailable = false;
    this.demonstratorAudioCuePreference = !this.bridge && readDemonstratorAudioCuePreference(this.localStorage());
    const invitationExpired = new URLSearchParams(location.search).get("invitation") === "expired";
    const soloMode = this.authority.kind === "solo";
    const joiningControls = soloMode
      ? `
              <div hidden>
                <form id="join-code-form"><input id="join-code"><button id="join-code-submit" type="submit">Join</button></form>
                <button id="scan-qr" type="button">Scan QR</button>
                <section id="capture-invitations"><b id="capture-invitation-count">0</b><div id="capture-invitation-list"></div></section>
                <b id="pairing-invitation-status">LOCAL</b>
              </div>
        `
      : `
              <form id="join-code-form" class="join-code-form">
                <label for="join-code">Join code</label>
                <div class="join-code-controls"><input id="join-code" class="join-code-input" type="text" maxlength="128" autocomplete="one-time-code" autocapitalize="characters" enterkeyhint="go" spellcheck="false" placeholder="9-letter code" aria-describedby="capture-status"><button id="join-code-submit" class="join-code-submit" type="submit" aria-label="Join with code">Join</button></div>
              </form>
              <button id="scan-qr" class="qr-button" type="button" aria-label="Scan pairing invitation from QR code"><svg class="qr-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 7h.01"/><path d="M17 7h.01"/><path d="M17 17h.01"/><path d="M12 12h.01"/></svg><small>Scan QR</small></button>
              <section id="capture-invitations"${shell.invitations ? "" : " hidden"} class="capture-invitations" aria-label="Invitations"><header><span>Invitations</span><b id="capture-invitation-count">--</b></header><div id="capture-invitation-list" class="capture-invitation-list"><span>${shell.directoryUrl ? "Checking account" : "Account unavailable"}</span></div><b id="pairing-invitation-status" class="sr-only">${this.pairingInvite ? "READY" : invitationExpired ? "EXPIRED" : "WAITING"}</b></section>
        `;
    document.body.classList.add("capture-join-page");
    root.innerHTML = `
      <div class="capture-page-shell">
        ${applicationHeaderMarkup(this.bridge ? "bridge" : soloMode ? "solo" : "capture", "capture-account")}
        <main class="join-shell">
        <section class="join-card" aria-labelledby="join-title">
          <section class="camera-column" aria-label="Camera setup">
            <div class="join-video-frame">
              <video id="camera-preview" autoplay playsinline muted></video>
              <div class="capture-video-empty"><span id="camera-field-status" hidden></span><button id="prepare-camera" class="camera-enable-button" type="button">Enable camera</button></div>
            </div>
            <div class="camera-settings">
              <label for="camera-select">${this.bridge ? "Camera to stream" : "Current camera"}</label>
              <select id="camera-select" disabled><option>No camera available</option></select>
            </div>
            ${this.bridge ? `<div class="camera-settings"><label for="bridge-video-quality">Video quality</label>
              <select id="bridge-video-quality"><option value="balanced">Balanced</option><option value="high">High detail</option><option value="maximum">Maximum detail</option></select></div>
              <p id="bridge-video-status" class="capture-status" role="status"></p>
              <p id="bridge-camera-preview-detail" class="capture-status" role="status" hidden></p>` : ""}
            <div class="launch-audio-preferences${soloMode ? "" : " is-single"}"${this.bridge ? " hidden" : ""}>
              <div class="launch-audio-preference launch-audio-cue-preference">
                <span>Audio cues</span>
                <button id="demonstrator-audio-cues" type="button" role="switch" aria-label="Audio cues" aria-checked="true">On</button>
              </div>
              ${soloMode ? `
              <div class="launch-audio-preference launch-audio-recording-preference">
                <span>Audio recording</span>
                <button id="demonstrator-audio-recording" type="button" role="switch" aria-label="Audio recording" aria-checked="false">Off</button>
              </div>` : ""}
            </div>
          </section>

          <section class="join-column">
            <div class="capture-mode-privacy-controls">
              <nav class="pane-header sidebar-selector capture-mode-selector" role="tablist" aria-label="Capture mode">
                <button type="button" role="tab" data-capture-mode="duet" data-capture-mode-target="/launch/capture/" aria-selected="${String(!soloMode && !this.bridge)}">DUET</button>
                <button type="button" role="tab" data-capture-mode="solo" data-capture-mode-target="/launch/capture/?mode=solo" aria-selected="${String(soloMode)}">SOLO</button>
                <button type="button" role="tab" data-capture-mode="bridge" data-capture-mode-target="/bridge/" aria-selected="${String(Boolean(this.bridge))}">BRIDGE</button>
              </nav>
            </div>
            <header class="join-heading">
              <span class="eyebrow">CERES XR</span>
              <h1 id="join-title">${this.bridge ? "Bridge" : "Demonstrator capture"}</h1>
              <p>${this.bridge ? "Pair your receiver before entering XR. Camera video is optional." : soloMode
                ? "Enable the camera and configure the run before entering XR. Hugging Face is optional until upload."
                : "Enter the capture director's join code, scan their QR code or open their invitation link."}</p>
            </header>
            ${soloMode ? joiningControls : `<section class="join-key-area" aria-label="Pairing invitation">${joiningControls}</section>`}
            ${this.bridge ? `<p id="bridge-receiver" class="capture-status">No receiver paired</p><button id="bridge-forget" type="button" class="prompt-audio-button" hidden>Forget receiver</button>` : ""}
            <ul class="join-checklist" aria-label="Joining status">
              <li><span>${this.bridge ? "Receiver" : soloMode ? "Local session" : "Matchmaking"}</span><b id="join-key-state" class="status-pill is-auth">${soloMode ? "WAIT" : this.pairingInvite ? "READY" : invitationExpired ? "EXPIRED" : "WAIT"}</b></li>
              <li><span>Camera</span><b id="join-camera-state" class="status-pill">IDLE</b></li>
              <li><span>${this.bridge ? "Stream" : soloMode ? "Local recorder" : "Session link"}</span><b id="join-session-state" class="status-pill">WAIT</b></li>
              <li><span>XR</span><b id="join-xr-state" class="status-pill">IDLE</b></li>
              <li data-speech-feature><span>Prompt audio</span><b id="join-prompt-state" class="status-pill">LOCKED</b></li>
            </ul>
            <p id="capture-status" class="capture-status" role="status" aria-live="polite"${soloMode ? " hidden" : ""}>${soloMode ? "Preparing headset-local capture" : this.pairingInvite ? "Pairing invitation ready" : "Waiting for a pairing invitation"}</p>
            <p id="local-voice-status" class="capture-status" role="status" aria-live="polite" hidden></p>
            <section id="task-setup" class="task-row" aria-live="polite"${soloMode ? " hidden" : ""}>
              <span id="task-setup-label">${soloMode ? "Solo task" : "Assigned task"}</span>
              <strong id="task-setup-title">${soloMode ? "Preparing local task workspace" : "Waiting for the capture director"}</strong>
              <p id="task-setup-description">${soloMode
                ? "Load or edit a task in the headset before recording."
                : "Connect to the capture director to receive the active run and instructions."}</p>
            </section>
            <section id="take-review" class="take-review" aria-live="polite" hidden>
              <span id="take-review-state">Task reset</span>
              <strong id="take-review-title">Completed task</strong>
              <p id="take-review-detail">Annotations are optional and the reset timer continues.</p>
              <div class="take-review-actions">
                <button type="button" data-review-control="success">Pass</button>
                <button type="button" data-review-control="fail">Fail</button>
                <button type="button" data-review-control="retry">Retry</button>
                <button type="button" data-review-control="next">Next</button>
                <button type="button" data-review-control="finish">Finish</button>
              </div>
            </section>
            <button id="prepare-prompts" class="prompt-audio-button" type="button" data-speech-feature>Enable prompt audio</button>
            ${soloMode ? "" : `<div class="capture-launch-actions">`}
              <button id="enter-xr" class="join-xr-button" type="button">Join XR</button>
              ${this.bridge ? `<button id="bridge-audio" class="bridge-audio-button" type="button" role="switch" aria-label="Stream microphone audio" aria-checked="false" title="Stream microphone audio. Voice control stays available."><img src="/assets/bridge/mic-off.svg" width="20" height="20" alt=""></button>` : ""}
            ${soloMode ? "" : "</div>"}
          </section>
        </section>
        <div id="xr-stage" class="xr-stage"></div>
        </main>
      </div>
    `;
    root.dataset.captureMode = this.bridge ? "bridge" : soloMode ? "solo" : "duet";
    if (!soloMode) installCaptureSetup(root, Boolean(this.bridge));
    if (this.pairingInvite) root.dataset.pairingRoomId = this.pairingInvite.roomId;
    else delete root.dataset.pairingRoomId;
    this.disposeSiteHeader = mountApplicationHeader(root);
    if (this.bridge) {
      root.querySelector<HTMLElement>("#capture-account")!.hidden = true;
      root.querySelector<HTMLElement>("#capture-invitations")!.hidden = true;
      root.querySelector<HTMLElement>("#task-setup")!.hidden = true;
      root.querySelector<HTMLElement>("label[for='join-code']")!.textContent = "Receiver code";
      root.querySelector<HTMLElement>("#join-code-submit")!.textContent = "Pair";
      root.querySelector<HTMLElement>("#enter-xr")!.textContent = "Start streaming";
      this.wireUi(root);
      this.renderBridgeAudio(root);
      this.renderSpeechFeature(root);
      this.renderCameraCapability(root);
      this.bridge.mount(root, () => {
        this.connected = this.bridge!.ready;
        this.captureIntentGranted = this.connected;
        this.setStatus(root, this.bridge!.status);
        this.renderBridgeAudio(root);
        this.renderCaptureDiagnostics(root);
        this.renderXrTaskHud();
      }, async () => {
        if (this.captureStatus.camera !== "ready") await this.prepareCamera(root);
      });
      return;
    }
    this.disposeAccountIdentity = mountUserIdentity(root.querySelector<HTMLElement>("#capture-account")!, {
      ...shell,
      onStateChange: (state) => this.handleCaptureAccountState(root, shell.directoryUrl ?? null, state),
    });
    this.wireUi(root);
    this.renderCaptureModeSelector(root);
    this.renderDemonstratorAudioCuePreference(root);
    this.renderAudioRecordingPreference(root);
    this.renderJoinCode(root);
    this.renderSpeechFeature(root);
    void this.initialiseRuntimeFeatures(root);
    this.renderCaptureDiagnostics(root);
    this.renderCameraCapability(root);
    this.startReviewClock(root);
    if (soloMode) {
      this.wireAuthority(root, this.authority);
      void Promise.resolve(this.authority.connect()).catch((error) => {
        if (!this.disposed) {
          this.reportError(root, directRecorderError(error, "Solo capture could not start"));
        }
      });
    } else if (this.sessionKey) {
      this.joinSession(root, this.sessionKey, { syncLocation: !this.pairingInvite });
    }
  }

  updateXrConsoleState(state: SoloXrConsoleState) {
    this.xrWorkspace?.update(state);
  }

  setSoloUploadStatus(status: SoloUploadHudStatus | null) {
    if (
      this.soloUploadStatus?.stage === status?.stage
      && this.soloUploadStatus?.label === status?.label
      && this.soloUploadStatus?.detail === status?.detail
      && this.soloUploadStatus?.progress === status?.progress
    ) return;
    this.soloUploadStatus = status ? { ...status } : null;
    this.renderXrTaskHud();
  }

  restoreXrConsolePage(page: SoloXrConsolePage) {
    this.xrWorkspace?.restorePage(page);
  }

  setXrOperationsMenuOpen(open: boolean) {
    if (this.xrOperationsMenuOpen === open) return;
    this.xrOperationsMenuOpen = open;
    if (this.mountedRoot) {
      this.mountedRoot.dataset.xrSurface = open ? "menu" : "capture";
    }
    this.applyXrSurfaceVisibility();
  }

  async exitXrForSystemTransition() {
    const session = this.xrSession ?? this.world?.renderer.xr.getSession();
    if (session) await session.end();
    this.xrWorkspace?.setSessionActive(false);
  }

  async requestXrReentryFromUserGesture() {
    const root = this.mountedRoot;
    if (!root) throw new Error("The demonstrator capture surface is unavailable");
    if (!await this.enterXr(root)) {
      throw new Error(this.captureStatus.lastError ?? "Solo XR could not be reopened");
    }
  }

  dispose() {
    if (this.disposed) return;
    const root = this.mountedRoot;
    this.pauseActiveCaptureForXrExit(root);
    this.disposed = true;
    this.xrLaunch.cancel();
    this.clearXrExitPauseRetry();
    this.mountedRoot = null;
    this.connected = false;
    this.qrScanning = false;
    this.stopSensorLoop();
    this.stopXrStartupIntroClock();
    this.stopXrSoloPostAcquisitionClock();
    this.stopXrTaskHudClock();
    this.handTrackingAlert.reset();
    this.demonstratorAudioCueScheduler?.reset();
    this.demonstratorAudioCuePlayer?.dispose();
    this.runtimeFeatureRecovery.reset(window);
    this.localVoiceCommandRecovery.reset(window);
    this.localVoiceCommandRecognitionStartedAt = null;
    this.localVoiceCommandResult = null;
    this.clearRunControlNotice();
    this.localVoiceCommands?.dispose();
    this.localVoiceCommands = null;
    this.clearXrBeamPresentation();
    if (this.reviewTimer !== null) window.clearInterval(this.reviewTimer);
    this.reviewTimer = null;
    if (this.accountInviteTimer !== null) window.clearInterval(this.accountInviteTimer);
    this.accountInviteTimer = null;
    this.disposeAccountIdentity?.();
    this.disposeAccountIdentity = null;
    this.disposeSiteHeader?.();
    this.disposeSiteHeader = null;
    this.disposeRecorderTransportControl?.();
    this.disposeRecorderTransportControl = null;
    void this.authority.dispose();
    this.webRtcSignal?.dispose();
    this.webRtcSignal = null;
    this.closeVideoPeers();

    for (const mediaRecorder of [this.mediaRecorder, this.audioRecorder]) {
      if (!mediaRecorder || mediaRecorder.state === "inactive") continue;
      try {
        mediaRecorder.stop();
      } catch {
        // The media stream is torn down below even if its recorder already stopped.
      }
    }
    this.mediaRecorder = null;
    this.audioRecorder = null;
    this.recordingRecorder?.dispose();
    this.cameraSelectionGeneration += 1;
    this.releaseBridgeCamera(root);
    this.cameraCaptureComposer?.dispose();
    this.cameraCaptureComposer = null;
    if (root) {
      delete root.dataset.cameraCaptureFrame;
      delete root.dataset.cameraCaptureOutput;
    }

    const releasedMedia = releaseCaptureMediaResources({
      cameraStream: this.cameraStream,
      captureStream: this.captureStream,
      microphoneStream: this.microphoneStream,
    }, root?.querySelector<HTMLVideoElement>("#camera-preview"));
    this.cameraStream = releasedMedia.cameraStream;
    this.captureStream = releasedMedia.captureStream;
    this.microphoneStream = releasedMedia.microphoneStream;

    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    for (const audio of this.promptAssets.values()) {
      audio.pause();
      audio.oncanplaythrough = null;
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
    }
    this.promptAssets.clear();
    const promptAudioContext = this.promptAudioContext;
    this.promptAudioContext = null;
    if (promptAudioContext && promptAudioContext.state !== "closed") void promptAudioContext.close().catch(() => undefined);

    const xrSession = this.xrSession ?? this.world?.renderer.xr.getSession();
    this.unbindXrEvents();
    this.captureControllerInputPolicy?.dispose();
    this.captureControllerInputPolicy = null;
    this.xrSession = null;
    this.xrReferenceSpace = null;
    if (xrSession) void xrSession.end().catch(() => undefined);
    this.xrTrackingVisuals?.hands?.dispose();
    this.xrTrackingVisuals = null;
    this.xrWorkspace?.dispose();
    this.xrCaptureHorizonHud?.dispose();
    this.xrCaptureHorizonHud = null;
    this.xrStartupIntro?.dispose();
    this.xrStartupIntro = null;
    this.xrTaskHud = null;
    this.xrHandDisplayHud = null;
    this.xrBeamHud = null;
    this.xrSoloPostAcquisitionHud?.dispose();
    this.xrSoloPostAcquisitionHud = null;
    this.soloPostAcquisitionPresentation = null;
    this.restoreXrRendererResize?.();
    this.restoreXrRendererResize = null;
    const world = this.world;
    this.world = null;
    if (world) this.disposeXrWorld(world);

    root?.replaceChildren();
    document.body.classList.remove("capture-join-page");
  }

  private wireUi(root: HTMLElement) {
    const prepare = root.querySelector<HTMLButtonElement>("#prepare-camera")!;
    const enterXr = root.querySelector<HTMLButtonElement>("#enter-xr")!;
    const qrButton = root.querySelector<HTMLButtonElement>("#scan-qr")!;
    const joinCodeForm = root.querySelector<HTMLFormElement>("#join-code-form")!;
    const joinCodeInput = root.querySelector<HTMLInputElement>("#join-code")!;
    const promptButton = root.querySelector<HTMLButtonElement>("#prepare-prompts")!;
    const audioCuePreference = root.querySelector<HTMLButtonElement>("#demonstrator-audio-cues")!;
    const audioRecordingPreference = root.querySelector<HTMLButtonElement>("#demonstrator-audio-recording");
    root.querySelectorAll<HTMLButtonElement>("[data-capture-mode-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.captureModeTarget;
        const currentMode = this.bridge ? "bridge" : this.authority.kind === "solo" ? "solo" : "duet";
        if (!target || button.dataset.captureMode === currentMode) return;
        if (this.captureModeNavigationLocked()) {
          this.setStatus(root, "Finish the active XR or recording transition before changing capture mode", true);
          this.renderCaptureModeSelector(root);
          return;
        }
        const navigation = new CustomEvent("ceres:capture-mode", { bubbles: true, cancelable: true, detail: { target } });
        if (root.dispatchEvent(navigation)) location.assign(target);
      });
    });
    audioCuePreference.addEventListener("click", () => {
      this.setDemonstratorAudioCuePreference(root, !this.demonstratorAudioCuePreference);
    });
    audioRecordingPreference?.addEventListener("click", () => {
      void this.setAudioRecordingPreference(root, !this.configuration.recordAudio);
    });
    root.querySelector("#bridge-audio")?.addEventListener("click", () => {
      void this.toggleBridgeAudio(root);
    });
    prepare.addEventListener("click", () => { void this.prepareCamera(root); });
    if (!this.bridge) qrButton.addEventListener("click", () => { void this.scanQr(root); });
    joinCodeInput.addEventListener("input", () => {
      joinCodeInput.value = joinCodeInput.value.replace(/[a-z]/g, character => character.toUpperCase());
      joinCodeInput.setCustomValidity("");
    });
    joinCodeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.bridge) void this.joinWithCode(root);
    });
    promptButton.addEventListener("click", () => { void this.preparePromptAudio(root); });
    enterXr.addEventListener("click", () => { void this.enterXr(root); });
    root.querySelector("#take-review")!.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-review-control]")?.dataset.reviewControl;
      if (action === "success" || action === "fail" || action === "finish" || action === "retry" || action === "next") this.sendDemonstratorControl(root, action);
    });
    if (usesSyntheticSensorSource()) {
      root.addEventListener("ceres-simulator-control", (event) => {
        const action = (event as CustomEvent<DemonstratorControlAction>).detail;
        if (action) this.sendDemonstratorControl(root, action);
      });
    }
  }

  private captureModeNavigationLocked() {
    return captureModeNavigationLocked(
      this.snapshot,
      this.captureStatus.xr,
      Boolean(this.xrSession),
      this.recordingFinalising,
    );
  }

  private renderCaptureModeSelector(root: HTMLElement) {
    const locked = this.captureModeNavigationLocked();
    const currentMode = this.bridge ? "bridge" : this.authority.kind === "solo" ? "solo" : "duet";
    root.querySelectorAll<HTMLButtonElement>("[data-capture-mode-target]").forEach((button) => {
      button.disabled = locked;
      button.setAttribute("aria-disabled", String(locked));
      button.title = locked
        ? "Capture mode is locked while XR, countdown, recording or finalisation is active"
        : button.dataset.captureMode === currentMode
          ? `${button.textContent?.trim() ?? "Capture"} mode is active`
          : `Switch to ${button.textContent?.trim() ?? "the other"} mode`;
    });
    if (!this.bridge) void false;
  }





  private publishTelemetryMode() {
    const telemetryMode = "disabled" as const;
    this.authority.publishTelemetryMode?.(telemetryMode);
    if (captureRecorderTransportMode(this.authority, this.connectionProfile) === "peer") {
      sendCapturePeerControlMessage(
        this.peerControlChannels.values(),
        captureTelemetryModeMessage(telemetryMode),
      );
    }
  }

  private sendDemonstratorControl(root: HTMLElement | null, action: DemonstratorControlAction) {
    const normalisedAction = action === "next" ? "next-task" : action;
    const nextCursor = isStateBoundRunControlAction(normalisedAction) && this.snapshot
      ? nextRunControlCursor(this.snapshot, normalisedAction)
      : undefined;
    if (isStateBoundRunControlAction(normalisedAction) && !nextCursor) return false;
    if (captureRecorderTransportMode(this.authority, this.connectionProfile) !== "peer") {
      return this.authority.control(action, nextCursor);
    }
    const sent = sendCapturePeerControlMessage(this.peerControlChannels.values(), captureControlMessage(action, nextCursor));
    if (root) this.setStatus(root, sent ? `${action.replace(/-/g, " ")} sent to the capture director` : "The capture director control link is not ready", !sent);
    return sent;
  }

  private pauseActiveCaptureForXrExit(root: HTMLElement | null) {
    if (this.xrExitPausePending) return true;
    if (!captureShouldPauseOnXrExit(this.snapshot)) {
      this.clearXrExitPauseRetry();
      return false;
    }
    if (root && !this.xrExitRecorderPaused) {
      try {
        this.pauseRecorders(root);
        this.xrExitRecorderPaused = true;
      } catch (error) {
        this.reportError(root, error instanceof Error ? error.message : "Recorder pause failed");
      }
    }
    this.xrExitPausePending = true;
    const sent = this.sendDemonstratorControl(null, "pause");
    this.scheduleXrExitPauseRetry();
    return sent;
  }

  private scheduleXrExitPauseRetry() {
    if (this.disposed || !this.xrExitPausePending || this.xrExitPauseRetryTimer !== null) return;
    this.xrExitPauseRetryTimer = window.setTimeout(() => {
      this.xrExitPauseRetryTimer = null;
      if (this.disposed || !this.xrExitPausePending) return;
      if (!captureShouldPauseOnXrExit(this.snapshot)) {
        this.clearXrExitPauseRetry();
        return;
      }
      this.sendDemonstratorControl(null, "pause");
      this.scheduleXrExitPauseRetry();
    }, 1_000);
  }

  private clearXrExitPauseRetry() {
    if (this.xrExitPauseRetryTimer !== null) window.clearTimeout(this.xrExitPauseRetryTimer);
    this.xrExitPauseRetryTimer = null;
    this.xrExitPausePending = false;
  }

  private reconcileXrExitPause(snapshot: SessionSnapshot) {
    if (snapshot.run.recordingState === "paused") {
      this.clearXrExitPauseRetry();
      return;
    }
    if (captureShouldPauseOnXrExit(snapshot)) return;
    this.clearXrExitPauseRetry();
    if (snapshot.run.recordingState === "idle" || snapshot.run.recordingState === "stopping") {
      this.xrExitRecorderPaused = false;
    }
  }

  private applyRecorderPauseTransition(
    root: HTMLElement,
    action: "recording-paused" | "recording-resumed",
  ) {
    if (action === "recording-paused") {
      this.clearXrExitPauseRetry();
      if (this.xrExitRecorderPaused) {
        this.setStatus(root, "Recording paused");
        return;
      }
      this.pauseRecorders(root);
      return;
    }
    this.resumeRecorders(root);
    this.xrExitRecorderPaused = false;
  }

  private sendDemonstratorHandDisplay(root: HTMLElement | null) {
    if (captureRecorderTransportMode(this.authority, this.connectionProfile) !== "peer") {
      return this.authority.setHandDisplay(this.handDisplaySettings);
    }
    const sent = sendCapturePeerControlMessage(this.peerControlChannels.values(), {
      type: "set-hand-display",
      settings: this.handDisplaySettings,
    });
    if (root) this.setStatus(root, sent ? "Hand display settings sent to the capture director" : "The capture director control link is not ready", !sent);
    return sent;
  }

  private applyConfiguration(configuration: CaptureConfiguration) {
    this.configuration = structuredClone(configuration);
    if (this.snapshot) this.snapshot = { ...this.snapshot, configuration: this.configuration };
  }

  private applyHandDisplaySettings(settings: HandDisplaySettings) {
    this.handDisplaySettings = normaliseHandDisplaySettings(settings);
    if (this.snapshot) this.snapshot = { ...this.snapshot, handDisplay: this.handDisplaySettings };
    this.renderXrTaskHud();
  }

  private applySnapshot(snapshot: SessionSnapshot) {
    this.configuration = structuredClone(snapshot.configuration);
    this.handDisplaySettings = normaliseHandDisplaySettings(snapshot.handDisplay);
    this.snapshot = {
      ...snapshot,
      configuration: this.configuration,
      handDisplay: this.handDisplaySettings,
    };
    this.reconcileXrExitPause(this.snapshot);
    this.syncCaptureControllerInputPolicy();
    this.reconcileLocalVoiceCommands();
  }

  private async prepareCamera(root: HTMLElement) {
    if (this.disposed || this.captureAuthorityRevoked) return;
    if (this.bridge && (this.xrSession || this.captureStatus.xr === "requesting")) return;
    let generation = ++this.cameraSelectionGeneration;
    this.releaseBridgeCamera(root);
    this.requestCaptureIntent();
    delete root.dataset.cameraCaptureFrame;
    delete root.dataset.cameraCaptureOutput;
    const prepare = root.querySelector<HTMLButtonElement>("#prepare-camera")!;
    this.selectedCamera = null;
    this.updateCaptureStatus(root, {
      camera: "requesting",
      selectedCameraDeviceId: null,
      selectedCameraLabel: null,
      selectedCameraWidth: null,
      selectedCameraHeight: null,
      selectedCameraFrame: null,
      selectedCameraFrameRate: null,
      selectedCameraSide: "unknown",
      lastError: null,
    });
    this.setStatus(root, "Requesting camera access");
    prepare.disabled = true;
    try {
      const cameraChoices = await enumerateOutwardCameras();
      if (this.disposed || this.captureAuthorityRevoked || generation !== this.cameraSelectionGeneration) return;
      this.cameraChoices = cameraChoices;
      if (!this.cameraChoices.length) {
        throw withErrorContext(new Error("No outward video input is available"), {
          stage: "device_enumeration",
        });
      }
      const select = root.querySelector<HTMLSelectElement>("#camera-select")!;
      select.disabled = false;
      select.innerHTML = this.cameraChoices.map((camera) => {
        const side = camera.side === "unknown" ? "" : `/${camera.side}`;
        return `<option value="${escapeHtml(camera.deviceId)}">${escapeHtml(camera.label + side)}</option>`;
      }).join("");
      select.onchange = () => {
        void this.selectCamera(root, select.value).catch((error) => {
          this.reportError(
            root,
            error instanceof Error ? error.message : "The selected camera could not be opened",
          );
        });
      };
      const selection = this.selectCamera(root, this.cameraChoices[0].deviceId);
      generation = this.cameraSelectionGeneration;
      await selection;
      if (this.disposed || this.captureAuthorityRevoked || generation !== this.cameraSelectionGeneration) return;
      this.renderCaptureDiagnostics(root);
      this.setStatus(root, "Camera ready");
    } catch (error) {
      if (this.disposed || this.captureAuthorityRevoked || generation !== this.cameraSelectionGeneration) return;
      this.reportError(root, error instanceof Error ? error.message : "Camera permission was not granted");
    } finally {
      if (!this.disposed && generation === this.cameraSelectionGeneration) {
        prepare.disabled = this.captureAuthorityRevoked
          || !cameraAccessCapability().available
          || (this.authority.kind === "solo" && this.captureStatus.camera === "ready");
        this.renderCaptureDiagnostics(root);
      }
    }
  }

  private renderCameraCapability(root: HTMLElement) {
    const capability = cameraAccessCapability();
    if (capability.available) return;
    const prepare = root.querySelector<HTMLButtonElement>("#prepare-camera")!;
    const qrButton = root.querySelector<HTMLButtonElement>("#scan-qr")!;
    prepare.disabled = true;
    prepare.textContent = "HTTPS required";
    qrButton.disabled = true;
    this.captureStatus = { ...this.captureStatus, camera: "error", lastError: capability.message };
    this.showCameraError(root, capability.message!);
    this.setStatus(root, capability.message!, true);
    this.renderCaptureDiagnostics(root);
  }

  private wireAuthority(root: HTMLElement, source: CaptureAuthorityPort) {
    source.on<TerminalCapturePairing>("pairing-terminal", (failure) => {
      if (source !== this.authority || !source.supportsPairing) return;
      this.revokeCaptureAuthority(root, failure);
      if (failure.code === "capture-session-restarted") this.returnToCaptureEntry();
    });
    source.on<boolean>("connection", (connected) => {
      if (source !== this.authority) return;
      this.connected = connected;
      if (!connected) {
        this.captureIntentGranted = false;
        this.recorder.setCaptureRegistered(false);
        if (source.supportsPeerMedia && !isPeerConnectionMode(this.connectionProfile)) {
          this.closeVideoPeers();
          this.captureStatus = { ...this.captureStatus, transport: "idle" };
        }
        this.renderOfflineTaskSetup(root);
      } else {
        this.appliedConfigurationRevision = -1;
        this.publishTelemetryMode();
        this.publishCaptureStatus();
        this.recorder.setCaptureRegistered(this.captureIntentGranted);
        if (this.captureIntentGranted) this.armRecorder();
        if (this.snapshot) this.renderTaskSetup(root, this.snapshot);
      }
      this.renderTakeReview(root);
      this.renderAudioRecordingPreference(root);
      this.renderCaptureDiagnostics(root);
      this.renderXrTaskHud();
    });
    source.on("capture-intent-granted", () => {
      if (source !== this.authority) return;
      this.captureIntentGranted = true;
      root.dataset.captureIntent = "granted";
      this.recorder.setCaptureRegistered(true);
      this.armRecorder();
      if (this.xrSession && this.captureStatus.xr === "requesting") this.markCaptureXrActive();
      this.publishCaptureStatus();
      this.renderCaptureDiagnostics(root);
    });
    source.on("capture-intent-suspended", () => {
      if (source !== this.authority) return;
      this.captureIntentGranted = false;
      this.captureAuthorityGranted = false;
      this.captureXrAuthorityRequested = false;
      root.dataset.captureIntent = "waiting";
      this.stopSensorLoop();
      if (this.xrSession) this.captureStatus = { ...this.captureStatus, xr: "requesting", sensorSource: "none" };
      this.armedRecorderSession = "";
      this.armedRecorderRate = 0;
      this.recorder.setCaptureRegistered(false);
      this.closeVideoPeers();
      this.setStatus(root, "Another capture tab is preparing. Enable camera to use this tab.");
      this.renderCaptureDiagnostics(root);
    });
    source.on("capture-authority-granted", () => {
      if (source !== this.authority) return;
      this.acceptCaptureXrAuthority(root);
    });
    source.on<{ configuration: CaptureConfiguration; revision: number; checksum: string }>("configuration", (message) => {
      if (source !== this.authority || message.revision === this.appliedConfigurationRevision) return;
      const audioChanged = this.configuration.recordAudio !== message.configuration.recordAudio;
      const promptChanged = JSON.stringify(this.configuration.promptAudio) !== JSON.stringify(message.configuration.promptAudio);
      this.applyConfiguration(message.configuration);
      this.renderAudioRecordingPreference(root);
      if (promptChanged) {
        this.promptAudioReady = false;
        this.promptAssets.clear();
      }
      this.appliedConfigurationRevision = message.revision;
      this.armRecorder();
      this.publishCaptureStatus();
      if (this.snapshot) {
        this.renderTaskSetup(root, this.snapshot);
      }
      this.renderXrTaskHud();
      source.configurationApplied(message.revision, message.checksum);
      source.publishPromptAudioStatus(
        message.configuration.promptAudio.enabled || message.configuration.promptAudio.useTextToSpeech
          ? { state: this.promptAudioReady ? "ready" : "locked", detail: this.promptAudioReady ? "Prompt audio ready" : "Enable prompt audio on this device" }
          : { state: "unavailable", detail: "Prompt audio is disabled for this run" },
      );
      if (audioChanged && this.cameraStream) void this.composeCaptureStream();
    });
    source.on<SessionSnapshot>("snapshot", (snapshot) => {
      if (source !== this.authority) return;
      const previousSnapshot = this.snapshot;
      this.applySnapshot(snapshot);
      const currentSnapshot = this.snapshot!;
      this.cameraRegistration = normaliseCameraRegistration(currentSnapshot.cameraRegistration ?? null);
      this.captureTaskCompletion(previousSnapshot, currentSnapshot);
      this.playDemonstratorAudioCues(this.demonstratorAudioCueScheduler?.observeRunTransition(previousSnapshot, currentSnapshot) ?? []);
      const taskSignature = xrTaskHudChangeSignature(currentSnapshot);
      const taskChanged = Boolean(taskSignature && taskSignature !== this.lastXrTaskSignature);
      this.lastXrTaskSignature = taskSignature;
      this.renderXrHandDisplayHud();
      this.renderAudioRecordingPreference(root);
      root.dataset.speechEnabled = String(this.speechEnabled());
      if (!this.speechEnabled() && "speechSynthesis" in window) window.speechSynthesis.cancel();
      this.armRecorder();
      this.renderTaskSetup(root, currentSnapshot);
      this.renderTakeReview(root);
      this.renderPromptAudioState(root, currentSnapshot);
      this.renderCaptureModeSelector(root);
      if (taskChanged) this.announceXrTaskChange();
      else this.renderXrTaskHud();
    });
    source.on<{ settings: HandDisplaySettings }>("hand-display", (message) => {
      if (source !== this.authority) return;
      this.applyHandDisplaySettings(message.settings);
      this.renderXrHandDisplayHud();
    });
    source.on<{ registration: CameraRegistration | null }>("camera-registration", (message) => {
      if (source !== this.authority) return;
      this.cameraRegistration = normaliseCameraRegistration(message.registration);
    });
    source.on<CaptureAuthorityControlMessage>("control", (message) => {
      if (source !== this.authority) return;
      if ((message.action === "recording-arming" || message.action === "recording-recover-arming") && message.episode) {
        this.beginRecorderWorkflow(message.episode);
        this.receiveAuthorityRecorderCommand(root, source, message.action, message.episode);
      }
      if (message.action === "recording-started") {
        if (this.snapshot) {
          this.snapshot.recording = true;
          this.snapshot.currentEpisode = message.episode ?? this.snapshot.currentEpisode;
        }
      }
      if (message.action === "recording-paused") {
        try {
          this.applyRecorderPauseTransition(root, message.action);
        } catch (error) {
          this.reportError(root, error instanceof Error ? error.message : "Recorder pause failed");
          this.sendDemonstratorControl(root, "stop");
        }
      }
      if (message.action === "recording-resumed") {
        try {
          this.applyRecorderPauseTransition(root, message.action);
        } catch (error) {
          this.reportError(root, error instanceof Error ? error.message : "Recorder resume failed");
          this.sendDemonstratorControl(root, "stop");
        }
      }
      if ((message.action === "recording-stopping" || message.action === "recording-recover-stopping") && message.episode) {
        this.receiveAuthorityRecorderCommand(root, source, message.action, message.episode);
      }
      if (message.action === "recording-stopped") {
        this.completeRecorderWorkflow(message.episode);
        this.clearXrExitPauseRetry();
        this.xrExitRecorderPaused = false;
        if (this.snapshot) {
          this.snapshot.recording = false;
          this.snapshot.currentEpisode = null;
        }
      }
      if (message.action === "recording-event" && "event" in message && message.event) {
        try {
          this.enqueueRecorderRunEvent(message.episode, message.event);
        } catch (error) {
          this.reportError(root, error instanceof Error ? error.message : "Recorder annotation failed");
          this.sendDemonstratorControl(root, "stop");
        }
      }
      if (message.action === "show-instructions") {
        this.setStatus(
          root,
          "instructions" in message && message.instructions
            ? message.instructions
            : "No instructions supplied",
        );
      }
      this.renderXrTaskHud();
    });
    source.on<any>("beam", (message) => {
      if (source === this.authority) this.receiveBeam(root, message);
    });
    source.on<{ delivery: PromptDelivery; useTextToSpeech: boolean }>("prompt", (message) => {
      if (source === this.authority) void this.playPromptDelivery(root, message.delivery, message.useTextToSpeech);
    });
    source.on<any>("webrtc-request-offer", (message) => {
      if (source.supportsPeerMedia && !this.webRtcSignal && source === this.authority) void this.createOffer(root, message.peerId);
    });
    source.on<any>("webrtc-signal", (message) => {
      if (source.supportsPeerMedia && !this.webRtcSignal && source === this.authority) void this.acceptSignal(message.peerId, message.signal);
    });
    source.on<any>("voice-command", (message) => {
      if (source === this.authority && this.speechEnabled()) this.setStatus(root, `Command: ${message.command}`);
    });
    source.on<any>("error", (message) => {
      if (source !== this.authority) return;
      this.audioRecordingChangePending = false;
      this.renderAudioRecordingPreference(root);
      this.reportError(root, message.message || "Capture authority error");
    });
  }

  private receiveBeam(root: HTMLElement, message: { text?: string; speak?: boolean; visual?: boolean }): DirectBeamDeliveryState | "visual-pending" | null {
    const text = message.text?.trim();
    if (!text) return null;
    root.dataset.lastBeam = text;
    if (message.visual) {
      this.lastBeamText = text;
      if (this.presentXrBeamHud(text)) {
        if (message.speak && this.speechEnabled()) this.speakBeam(root, text);
        this.setStatus(root, `Beam: ${text}`);
        return "visual-pending";
      }
    }
    if (message.speak && this.speechEnabled()) this.speakBeam(root, text);
    this.setStatus(root, `Beam: ${text}`);
    return "received";
  }

  private speakBeam(root: HTMLElement, text: string) {
    if (!this.speechEnabled()) return;
    if (!("speechSynthesis" in window)) {
      this.reportError(root, "Text to speech is unavailable in this browser");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-GB";
    utterance.onerror = () => {
      const error = new Error("Text to speech could not play this beam");
      this.reportError(root, error.message);
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  }

  private async preparePromptAudio(root: HTMLElement) {
    if (this.captureAuthorityRevoked) return;
    const configuration = this.configuration.promptAudio;
    const usesTextToSpeech = this.speechEnabled() && configuration.useTextToSpeech;
    if (!configuration.enabled && !usesTextToSpeech) {
      this.authority.publishPromptAudioStatus({
        state: "unavailable",
        detail: "Prompt audio is disabled for this run",
      });
      return;
    }
    const button = root.querySelector<HTMLButtonElement>("#prepare-prompts")!;
    button.disabled = true;
    try {
      this.promptAudioContext ??= new AudioContext();
      await this.promptAudioContext.resume();
      if (this.disposed || this.captureAuthorityRevoked) return;
      const oscillator = this.promptAudioContext.createOscillator();
      const gain = this.promptAudioContext.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain).connect(this.promptAudioContext.destination);
      oscillator.start();
      oscillator.stop(this.promptAudioContext.currentTime + .01);
      if (configuration.enabled) await this.preloadPromptAssets(configuration);
      if (usesTextToSpeech && !await this.hasSpeechVoice()) throw new Error("No text-to-speech voice is available");
      this.promptAudioReady = true;
      this.authority.publishPromptAudioStatus({ state: "ready", detail: "Prompt audio ready" });
      this.setStatus(root, "Prompt audio ready");
    } catch (error) {
      this.promptAudioReady = false;
      const detail = error instanceof Error ? error.message : "Prompt audio setup failed";
      this.authority.publishPromptAudioStatus({ state: "error", detail });
      this.reportError(root, detail);
    } finally {
      button.disabled = this.captureAuthorityRevoked;
    }
  }

  private async preloadPromptAssets(configuration: CaptureConfiguration["promptAudio"]) {
    const urls = [configuration.taskStartAssetUrl, configuration.resetAssetUrl, configuration.completionAssetUrl].filter(Boolean);
    await Promise.all(urls.map(async (url) => {
      if (this.promptAssets.has(url)) return;
      const audio = new Audio(url);
      audio.preload = "auto";
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`Prompt asset timed out: ${url}`)), 8_000);
        const finish = (error?: Error) => {
          window.clearTimeout(timeout);
          audio.oncanplaythrough = null;
          audio.onerror = null;
          if (error) reject(error);
          else resolve();
        };
        audio.oncanplaythrough = () => finish();
        audio.onerror = () => finish(new Error(`Prompt asset failed to load: ${url}`));
        audio.load();
      });
      if (this.disposed) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        return;
      }
      this.promptAssets.set(url, audio);
    }));
  }

  private async hasSpeechVoice() {
    if (!this.speechEnabled()) return false;
    if (!("speechSynthesis" in window)) return false;
    if (window.speechSynthesis.getVoices().length > 0) return true;
    await new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timeout);
        window.speechSynthesis.removeEventListener("voiceschanged", finish);
        resolve();
      };
      const timeout = window.setTimeout(finish, 1_000);
      window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    });
    return window.speechSynthesis.getVoices().length > 0;
  }

  private async playPromptDelivery(root: HTMLElement, delivery: PromptDelivery, useTextToSpeech: boolean) {
    this.authority.acknowledgePrompt(delivery.id, "queued");
    try {
      if (!this.promptAudioReady) throw new Error("Prompt audio has not been enabled on this device");
      this.authority.acknowledgePrompt(delivery.id, "started");
      if (delivery.assetUrl) await this.playPromptAsset(delivery.assetUrl);
      if (this.speechEnabled() && useTextToSpeech && delivery.text) await this.speakPrompt(delivery.text);
      this.authority.acknowledgePrompt(delivery.id, "completed");
      this.setStatus(root, `Prompt played: ${delivery.transition}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Prompt playback failed";
      this.authority.acknowledgePrompt(delivery.id, "failed", detail);
      this.reportError(root, detail);
    }
  }

  private async playPromptAsset(url: string) {
    const audio = this.promptAssets.get(url);
    if (!audio) throw new Error(`Prompt asset was not preloaded: ${url}`);
    audio.currentTime = 0;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error(`Prompt asset failed during playback: ${url}`));
      void audio.play().catch(reject);
    });
  }

  private speakPrompt(text: string) {
    return new Promise<void>((resolve, reject) => {
      if (!this.speechEnabled()) return resolve();
      if (!("speechSynthesis" in window)) return reject(new Error("Text to speech is unavailable"));
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "en-GB";
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("Text to speech playback failed"));
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    });
  }

  private renderPromptAudioState(root: HTMLElement, snapshot: SessionSnapshot) {
    const speechEnabled = this.speechEnabled();
    root.querySelectorAll<HTMLElement>("[data-speech-feature]").forEach((element) => { element.hidden = !speechEnabled; });
    const status = snapshot.promptAudioStatus;
    const badge = root.querySelector<HTMLElement>("#join-prompt-state")!;
    badge.textContent = status.state.toUpperCase();
    badge.title = status.detail;
    badge.classList.toggle("is-ok", status.state === "ready");
    badge.classList.toggle("is-auth", status.state === "locked");
    const button = root.querySelector<HTMLButtonElement>("#prepare-prompts")!;
    button.hidden = !speechEnabled || (!this.configuration.promptAudio.enabled
      && !this.configuration.promptAudio.useTextToSpeech);
    button.disabled = snapshot.run.recordingState !== "idle";
    button.textContent = status.state === "ready" ? "Prompt audio ready" : "Enable prompt audio";
  }

  private speechEnabled() {
    return this.runtimeFeaturesLoaded
      && this.runtimeFeatures.speech
      && this.snapshot?.features?.speech !== false;
  }

  private localVoiceCommandRecognitionEnabled() {
    if (this.bridge) return true;
    return localVoiceCommandRecognitionEnabled(
      this.runtimeFeaturesLoaded,
      this.runtimeFeaturesAvailable,
    );
  }

  private demonstratorAudioCuesEnabled() {
    return this.demonstratorAudioCuePreference;
  }

  private localStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  private setDemonstratorAudioCuePreference(root: HTMLElement, enabled: boolean) {
    if (this.demonstratorAudioCuePreference === enabled) return;
    this.demonstratorAudioCuePreference = enabled;
    writeDemonstratorAudioCuePreference(this.localStorage(), enabled);
    this.demonstratorAudioCueScheduler.reset();
    if (enabled) this.demonstratorAudioCuePlayer.prepare();
    else this.demonstratorAudioCuePlayer.dispose();
    this.renderDemonstratorAudioCuePreference(root);
  }

  private renderDemonstratorAudioCuePreference(root: HTMLElement) {
    const button = root.querySelector<HTMLButtonElement>("#demonstrator-audio-cues");
    if (!button) return;
    button.setAttribute("aria-checked", String(this.demonstratorAudioCuePreference));
    button.textContent = this.demonstratorAudioCuePreference ? "On" : "Off";
    button.title = this.demonstratorAudioCuePreference
      ? "Turn demonstrator audio cues off"
      : "Turn demonstrator audio cues on";
  }

  private async setAudioRecordingPreference(root: HTMLElement, enabled: boolean) {
    if (!this.onAudioRecordingChange
      || !this.connected
      || this.audioRecordingChangePending
      || this.snapshot?.run.status === "running"
      || this.snapshot?.run.status === "complete"
      || this.snapshot?.run.recordingState !== "idle"
      || this.snapshot?.currentEpisode !== null
      || this.snapshot?.pendingEpisode !== null) return;
    this.audioRecordingChangePending = true;
    this.renderAudioRecordingPreference(root);
    try {
      await this.onAudioRecordingChange(enabled);
    } catch (error) {
      this.reportError(root, error instanceof Error ? error.message : "Audio recording could not be changed");
    } finally {
      this.audioRecordingChangePending = false;
      this.renderAudioRecordingPreference(root);
    }
  }

  private renderAudioRecordingPreference(root: HTMLElement) {
    const button = root.querySelector<HTMLButtonElement>("#demonstrator-audio-recording");
    if (!button) return;
    const locked = this.snapshot?.run.status === "running"
      || this.snapshot?.run.status === "complete"
      || this.snapshot?.run.recordingState !== "idle"
      || this.snapshot?.currentEpisode !== null
      || this.snapshot?.pendingEpisode !== null;
    const enabled = this.configuration.recordAudio;
    button.setAttribute("aria-checked", String(enabled));
    button.setAttribute("aria-busy", String(this.audioRecordingChangePending));
    button.textContent = enabled ? "On" : "Off";
    button.disabled = !this.connected || locked || this.audioRecordingChangePending;
    button.title = !this.connected
      ? "Wait for the Solo session to connect"
      : locked
        ? "Reset the completed run or wait for the active run to finish"
        : this.audioRecordingChangePending
          ? "Applying the audio recording setting"
          : enabled
            ? "Stop storing raw microphone audio"
            : "Store raw microphone audio";
  }

  private async toggleBridgeAudio(root: HTMLElement) {
    const bridge = this.bridge;
    if (!bridge || this.audioRecordingChangePending) return;
    this.audioRecordingChangePending = true;
    this.renderBridgeAudio(root);
    try {
      const track = bridge.audioEnabled ? null : (await this.acquireMicrophoneStream())?.getAudioTracks()[0];
      if (this.disposed) return;
      if (track === undefined || (track && track.readyState !== "live")) throw new Error("Microphone access is unavailable");
      await bridge.setAudioTrack(track);
    } catch (error) {
      this.setStatus(root, error instanceof Error ? error.message : "Microphone audio could not be changed", true);
    } finally {
      this.audioRecordingChangePending = false;
      if (!this.disposed) this.renderBridgeAudio(root);
    }
  }

  private renderBridgeAudio(root: HTMLElement) {
    const button = root.querySelector<HTMLButtonElement>("#bridge-audio");
    if (!button || !this.bridge) return;
    const enabled = this.bridge.audioEnabled;
    button.setAttribute("aria-checked", String(enabled));
    button.setAttribute("aria-busy", String(this.audioRecordingChangePending));
    button.disabled = this.audioRecordingChangePending;
    button.title = `${enabled ? "Stop streaming" : "Stream"} microphone audio. Voice control stays available.`;
    button.querySelector<HTMLImageElement>("img")!.src = `/assets/bridge/${enabled ? "mic" : "mic-off"}.svg`;
  }

  private playDemonstratorAudioCues(cues: Parameters<DemonstratorAudioCuePlayer["play"]>[0], urgency = 0) {
    if (!this.demonstratorAudioCuesEnabled()) return;
    this.demonstratorAudioCuePlayer?.play(cues, urgency);
  }

  private async initialiseRuntimeFeatures(root: HTMLElement, fallback = this.runtimeFeatures) {
    const result = await loadRuntimeFeatures(fallback);
    if (this.disposed || this.mountedRoot !== root) return;
    const recognitionWasEnabled = this.localVoiceCommandRecognitionEnabled();
    this.runtimeFeatures = {
      ...result.features,
      speech: result.available && result.features.speech,
    };
    this.runtimeFeaturesAvailable = result.available;
    this.runtimeFeaturesLoaded = true;
    if (result.available) {
      this.runtimeFeatureRecovery.reset(window);
    } else {
      this.runtimeFeatureRecovery.schedule(window, () => {
        void this.initialiseRuntimeFeatures(root, fallback);
      });
    }
    const recognitionEnabled = this.localVoiceCommandRecognitionEnabled();
    if (!this.speechEnabled() && "speechSynthesis" in window) window.speechSynthesis.cancel();
    if (recognitionEnabled !== recognitionWasEnabled) {
      this.reconcileLocalVoiceCommands();
      if (this.cameraStream || this.microphoneStream) await this.composeCaptureStream();
    }
    if (this.disposed || this.mountedRoot !== root) return;
    this.renderSpeechFeature(root);
    if (this.snapshot) this.renderPromptAudioState(root, this.snapshot);
  }

  private renderSpeechFeature(root: HTMLElement) {
    const enabled = this.speechEnabled();
    root.dataset.speechEnabled = String(enabled);
    root.querySelectorAll<HTMLElement>("[data-speech-feature]").forEach((element) => { element.hidden = !enabled; });
  }

  private beginPairingJourney(key: string) {
    if (this.pairingJourneyKey === key) return;
    this.pairingJourneyKey = key;
  }

  private finishPairingJourney(outcome: "succeeded" | "failed") {
    if (!this.pairingJourneyKey) return;
    this.pairingJourneyKey = null;
  }

  private joinSession(root: HTMLElement, rawKey: string, options: { syncLocation?: boolean; force?: boolean } = {}) {
    if (this.disposed || this.captureAuthorityRevoked || !this.authority.supportsPairing) return;
    const key = normaliseCaptureSessionId(rawKey);
    if (!key) return;
    if (!options.force && key === this.sessionKey && this.connected) return;
    if (this.pairingInvite && !this.pairingInvitationBound) {
      this.beginPairingJourney(this.pairingInvite.roomId);
    }
    this.closeVideoPeers();
    this.recorder.setCaptureRegistered(false);
    void this.authority.dispose();
    this.sessionKey = key;
    this.appliedConfigurationRevision = -1;
    this.armedRecorderSession = "";
    this.armedRecorderRate = 0;
    this.webRtcSignal?.dispose();
    this.webRtcSignal = null;
    this.captureIntentGranted = false;
    this.captureAuthorityGranted = false;
    this.captureXrAuthorityRequested = false;
    const session = new SessionClient(key, "capture", this.pairingId);
    const authority = new SessionClientCaptureAuthority(session);
    this.authority = authority;
    this.connected = false;
    if (options.syncLocation !== false) {
      const params = new URLSearchParams(location.search);
      params.set("session", key);
      const invitationFragment = this.pairingInvite ? location.hash : "";
      history.replaceState(null, "", `${location.pathname}?${params.toString()}${invitationFragment}`);
    }
    root.querySelector<HTMLElement>("#pairing-invitation-status")!.textContent = this.pairingInvite ? "PAIRING" : "LEGACY";
    this.renderCaptureDiagnostics(root);
    this.setStatus(root, isPeerConnectionMode(this.connectionProfile) ? "Awaiting peer pairing" : "Connecting to session");
    this.wireAuthority(root, authority);
    this.wireWebRtcSignal(root);
    if (!isPeerConnectionMode(this.connectionProfile)) authority.connect();
  }

  private applyPairingInvitation(root: HTMLElement, target: PairingInvitationTarget) {
    if (!this.authority.supportsPairing) return;
    this.pairingInvite = target.invite;
    this.connectionProfile = target.connectionProfile;
    this.pairingInvitationBound = false;
    this.pairingInvitationBoundAt = null;
    storePairingInvitationTarget(target);
    root.dataset.pairingRoomId = target.invite.roomId;
    this.renderJoinCode(root);
    root.querySelector<HTMLElement>("#pairing-invitation-status")!.textContent = "PAIRING";
    this.joinSession(root, target.invite.sessionId, { syncLocation: false, force: true });
    this.renderCaptureDiagnostics(root);
    this.setStatus(root, `Join code ${target.invite.roomId} accepted. Preparing XR.`);
  }

  private renderJoinCode(root: HTMLElement) {
    const input = root.querySelector<HTMLInputElement>("#join-code");
    if (!input) return;
    input.value = this.pairingInvite?.roomId ?? "";
    input.setCustomValidity("");
  }

  private async joinWithCode(root: HTMLElement) {
    if (this.disposed || this.captureAuthorityRevoked || !this.authority.supportsPairing) return;
    const input = root.querySelector<HTMLInputElement>("#join-code")!;
    const button = root.querySelector<HTMLButtonElement>("#join-code-submit")!;
    if (button.disabled) return;
    const code = normaliseShortPairingCode(input.value);
    if (!code) {
      input.setCustomValidity(pairingCodeInputError);
      input.reportValidity();
      this.setStatus(root, pairingCodeInputError, true);
      return;
    }
    input.setCustomValidity("");
    input.value = code;
    input.readOnly = true;
    button.disabled = true;
    root.querySelector<HTMLFormElement>("#join-code-form")!.setAttribute("aria-busy", "true");
    this.setStatus(root, "Checking join code");
    this.beginPairingJourney(code);
    try {
      const target = await resolvePairingInvitationTarget(
        new URL(`/j/${code}`, location.origin).toString(),
        connectionServerUrl(this.connectionProfile),
      );
      if (!target) throw new Error("The join code is invalid");
      if (this.disposed || this.captureAuthorityRevoked) return;
      this.applyPairingInvitation(root, target);
    } catch (error) {
      if (this.disposed || this.captureAuthorityRevoked) return;
      this.finishPairingJourney("failed");
      const detail = error instanceof Error ? error.message : "The join code could not be checked";
      this.setStatus(root, detail, true);
      input.select();
    } finally {
      if (!this.disposed) {
        input.readOnly = false;
        button.disabled = this.captureAuthorityRevoked;
        root.querySelector<HTMLFormElement>("#join-code-form")?.removeAttribute("aria-busy");
      }
    }
  }

  private resetJoin(root: HTMLElement) {
    if (this.disposed || this.captureAuthorityRevoked || !this.authority.supportsPairing) return;
    if (!this.sessionKey && !this.connected) return;
    this.closeVideoPeers();
    this.recorder.setCaptureRegistered(false);
    void this.authority.dispose();
    this.sessionKey = "";
    this.pairingInvite = null;
    this.pairingJourneyKey = null;
    this.renderJoinCode(root);
    this.pairingInvitationBound = false;
    this.pairingInvitationBoundAt = null;
    clearStoredPairingInvitationTarget();
    this.webRtcSignal?.dispose();
    this.webRtcSignal = null;
    this.captureIntentGranted = false;
    this.captureAuthorityGranted = false;
    this.captureXrAuthorityRequested = false;
    this.authority = new SessionClientCaptureAuthority(
      new SessionClient("", "capture", this.pairingId),
    );
    this.connected = false;
    this.snapshot = null;
    this.applyConfiguration(defaultConfiguration);
    const params = new URLSearchParams(location.search);
    params.delete("session");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
    this.renderOfflineTaskSetup(root);
    root.querySelector<HTMLElement>("#take-review")!.hidden = true;
    this.renderCaptureDiagnostics(root);
    root.querySelector<HTMLElement>("#pairing-invitation-status")!.textContent = "WAITING";
    this.setStatus(root, "Enter a join code or scan a pairing invitation to continue");
  }

  private async scanQr(root: HTMLElement) {
    if (this.captureAuthorityRevoked || this.qrScanning || !this.authority.supportsPairing) return;
    const button = root.querySelector<HTMLButtonElement>("#scan-qr")!;
    if (!this.cameraStream) {
      this.setQrScanState(button, "Camera unavailable");
      return;
    }
    const Detector = (window as unknown as { BarcodeDetector?: QrDetectorConstructor }).BarcodeDetector;
    const preview = root.querySelector<HTMLVideoElement>("#camera-preview")!;
    let detector: QrDetector | null = null;
    let fallbackCanvas: HTMLCanvasElement | null = null;
    if (Detector) {
      try {
        detector = new Detector({ formats: ["qr_code"] });
      } catch {
        fallbackCanvas = document.createElement("canvas");
      }
    } else {
      fallbackCanvas = document.createElement("canvas");
    }
    this.qrScanning = true;
    button.classList.add("is-scanning");
    button.disabled = true;
    this.setQrScanState(button, "Scanning");
    this.setStatus(root, "Scan armed. The next valid QR code will replace the current invitation.");
    try {
      const maximumAttempts = this.connectionProfile.mode === "local" ? 240 : 30;
      for (let attempt = 0; attempt < maximumAttempts && !this.disposed; attempt += 1) {
        let values: string[];
        if (detector) {
          try {
            values = (await detector.detect(preview)).map((code) => code.rawValue ?? "");
          } catch {
            detector = null;
            fallbackCanvas ??= document.createElement("canvas");
            values = this.decodeQrFrame(preview, fallbackCanvas);
          }
        } else {
          values = this.decodeQrFrame(preview, fallbackCanvas!);
        }
        for (const value of values) {
          const target = await resolvePairingInvitationTarget(
            value,
            connectionServerUrl(this.connectionProfile),
          );
          if (!target) continue;
          this.applyPairingInvitation(root, target);
          this.setQrScanState(button, "Code accepted");
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
      }
      if (this.disposed) return;
      this.setQrScanState(button, "No code found");
    } catch (error) {
      this.setQrScanState(button, "Scan failed");
      this.showCameraError(root, error instanceof Error ? error.message : "QR reading failed");
    } finally {
      this.qrScanning = false;
      if (this.disposed) return;
      button.classList.remove("is-scanning");
      button.disabled = this.captureAuthorityRevoked;
    }
  }

  private decodeQrFrame(preview: HTMLVideoElement, canvas: HTMLCanvasElement) {
    if (preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !preview.videoWidth || !preview.videoHeight) return [];
    const longestEdge = Math.max(preview.videoWidth, preview.videoHeight);
    const scale = Math.min(1, 1280 / longestEdge);
    canvas.width = Math.max(1, Math.round(preview.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(preview.videoHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(preview, 0, 0, canvas.width, canvas.height);
    try {
      return [this.qrFallbackReader.decodeFromCanvas(canvas).getText()];
    } catch {
      // The lightweight decoder remains useful for small or low-contrast codes.
    }
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
    return code ? [code.data] : [];
  }

  private setQrScanState(button: HTMLButtonElement, label: string) {
    const text = button.querySelector<HTMLElement>("small");
    if (text) text.textContent = label;
    button.setAttribute("aria-label", label === "Scan QR" ? "Scan pairing invitation from QR code" : label);
  }

  private renderTaskSetup(root: HTMLElement, snapshot: SessionSnapshot) {
    if (!this.connected) {
      this.renderOfflineTaskSetup(root);
      return;
    }
    const section = root.querySelector<HTMLElement>("#task-setup")!;
    const taskIndex = Math.min(snapshot.run.activeTaskIndex, Math.max(0, this.configuration.tasks.length - 1));
    const task = this.configuration.tasks[taskIndex];
    const isPlaceholder = !this.hasConfiguredTask(task);
    const repetitions = task && isRepetitionTask(task) ? Math.max(1, task.repeatCount) : 1;
    root.querySelector("#task-setup-label")!.textContent = isPlaceholder
      ? this.authority.kind === "solo" ? "Solo task" : "Assigned task"
      : snapshot.run.status === "complete"
        ? `Sequence complete - ${this.configuration.totalCycles} cycle${this.configuration.totalCycles === 1 ? "" : "s"}`
      : task.type === "pause"
        ? `Cycle ${snapshot.run.cycle}/${this.configuration.totalCycles} - pause ${taskIndex + 1}/${this.configuration.tasks.length}`
        : `Cycle ${snapshot.run.cycle}/${this.configuration.totalCycles} - task ${taskIndex + 1}/${this.configuration.tasks.length} - rep ${snapshot.run.repetition}/${repetitions} - attempt ${snapshot.run.take}`;
    root.querySelector("#task-setup-title")!.textContent = isPlaceholder
      ? this.authority.kind === "solo" ? "Preparing local task workspace" : "Waiting for the capture director"
      : task.label;
    root.querySelector("#task-setup-description")!.textContent = isPlaceholder
      ? this.authority.kind === "solo"
        ? "Load or edit a task in the headset before recording."
        : "The capture director has not configured a task yet."
      : task.instructions === "--" ? this.configuration.runDescription || this.configuration.runTitle : task.instructions;
    section.classList.toggle("is-ready", !isPlaceholder);
  }

  private renderOfflineTaskSetup(root: HTMLElement) {
    const section = root.querySelector<HTMLElement>("#task-setup")!;
    const run = this.snapshot?.run;
    const activeRun = run?.status === "running";
    const task = activeRun ? this.configuration.tasks[run.activeTaskIndex] : undefined;
    const recordingState = run?.recordingState;
    if (this.authority.kind === "solo") {
      root.querySelector("#task-setup-label")!.textContent = "Solo task";
      root.querySelector("#task-setup-title")!.textContent = task?.label ?? "Preparing local task workspace";
      root.querySelector("#task-setup-description")!.textContent = recordingState === "recording"
        ? "Recording is continuing in headset-local storage."
        : recordingState === "paused"
          ? "Recording remains paused in headset-local storage."
          : activeRun
            ? "The active run remains loaded on this headset."
            : "Load or edit a task in the headset before recording.";
      section.classList.toggle("is-ready", Boolean(activeRun && task));
      this.renderXrTaskHud();
      return;
    }
    root.querySelector("#task-setup-label")!.textContent = activeRun ? "Capture director offline" : "Assigned task";
    root.querySelector("#task-setup-title")!.textContent = task?.label ?? (activeRun ? this.configuration.runTitle : "Waiting for the capture director");
    root.querySelector("#task-setup-description")!.textContent = recordingState === "recording"
      ? "Recording is continuing locally. Reconnect the capture director to restore run controls."
      : recordingState === "paused"
        ? "Recording remains paused locally. Reconnect the capture director to restore run controls."
        : activeRun
          ? "The active run remains loaded locally. Reconnect the capture director to restore run controls."
          : "Connect to the capture director to receive the active run and instructions.";
    section.classList.toggle("is-ready", Boolean(activeRun && task));
    this.renderXrTaskHud();
  }

  private startReviewClock(root: HTMLElement) {
    if (this.reviewTimer !== null) window.clearInterval(this.reviewTimer);
    this.reviewTimer = window.setInterval(() => this.renderTakeReview(root), 250);
  }

  private renderTakeReview(root: HTMLElement) {
    const panel = root.querySelector<HTMLElement>("#take-review");
    const snapshot = this.snapshot;
    const run = snapshot?.run;
    const actionable = run?.status === "running"
      && (run.phase === "active-task" || run.phase === "post-task-pause" || run.phase === "task-pause" || run.phase === "cycle-pause");
    if (!panel || !snapshot || !run || !actionable) {
      if (panel) panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const remainingMs = run.resetDeadlineMs === null ? null : Math.max(0, run.resetDeadlineMs - Date.now());
    const presentation = runStatePresentation(snapshot, this.connected);
    panel.dataset.state = run.phase ?? "";
    root.querySelector("#take-review-state")!.textContent = remainingMs === null
      ? presentation.stateLabel
      : `${presentation.stateLabel} - ${formatDuration(remainingMs)}`;
    root.querySelector("#take-review-title")!.textContent = presentation.title;
    root.querySelector("#take-review-detail")!.textContent = presentation.detail;
    const actor = this.authority.kind === "solo" ? "solo" : "demonstrator";
    const controls = new Map(runControls(snapshot, this.connected, actor).map((control) => [control.action, control]));
    panel.querySelectorAll<HTMLButtonElement>("[data-review-control]").forEach((button) => {
      const action = button.dataset.reviewControl;
      const control = controls.get(action as "success" | "fail" | "finish" | "retry" | "next");
      button.hidden = !control?.enabled;
      button.disabled = !control?.enabled;
    });
  }

  private hasConfiguredTask(task: CaptureConfiguration["tasks"][number] | undefined) {
    return Boolean(task);
  }

  private captureTaskCompletion(previous: SessionSnapshot | null, next: SessionSnapshot) {
    const label = xrCompletedTaskLabel(previous, next);
    if (!label) return;
    this.playDemonstratorAudioCues(["task-end"]);
    this.taskCompletionOverlay = {
      label,
      startedAt: performance.now(),
    };
  }

  private bridgeCameraReady() {
    const camera = this.bridgeCamera;
    return Boolean(camera && camera.track.readyState === "live"
        && Number.isFinite(camera.width) && camera.width > 0
        && Number.isFinite(camera.height) && camera.height > 0);
  }

  private releaseBridgeCamera(root: HTMLElement | null) {
    if (!this.bridge) return;
    this.bridgeCameraAcquisition?.abort();
    this.bridgeCameraAcquisition = null;
    const camera = this.bridgeCamera;
    this.bridgeCamera = null;
    this.bridge.setCamera(null);
    if (camera) stopStream(camera.stream);
    if (camera?.stream === this.cameraStream) this.cameraStream = null;
    const preview = root?.querySelector<HTMLVideoElement>("#camera-preview");
    if (preview && camera?.stream === preview.srcObject) preview.srcObject = null;
    const detail = root?.querySelector<HTMLElement>("#bridge-camera-preview-detail");
    if (detail) detail.hidden = true;
    if (root) root.dataset.bridgeCameraCount = "0";
  }

  private async selectBridgeCamera(root: HTMLElement, selection: string) {
    const generation = ++this.cameraSelectionGeneration;
    this.releaseBridgeCamera(root);
    const acquisition = new AbortController();
    this.bridgeCameraAcquisition = acquisition;
    const current = () => !this.disposed && !this.captureAuthorityRevoked
      && generation === this.cameraSelectionGeneration && !acquisition.signal.aborted;
    this.selectedCamera = null;
    this.captureStream = null;
    this.xrCameraEdgesShownAt = null;
    root.dataset.xrCameraEdgesPhase = "hidden";
    this.updateCaptureStatus(root, {
      camera: "requesting",
      selectedCameraDeviceId: null,
      selectedCameraLabel: null,
      selectedCameraWidth: null,
      selectedCameraHeight: null,
      selectedCameraFrame: null,
      selectedCameraFrameRate: null,
      selectedCameraSide: "unknown",
      lastError: null,
    });
    this.setStatus(root, "Opening camera");
    const preview = root.querySelector<HTMLVideoElement>("#camera-preview")!;
    try {
      const choice = bridgeSelectedCameraChoice(this.cameraChoices, selection);
      const select = root.querySelector<HTMLSelectElement>("#camera-select");
      if (select) select.value = choice.deviceId;
      const acquired = await openBridgeCamera(choice, acquisition.signal);
      if (!acquired || !current()) {
        if (acquired) stopStream(acquired.stream);
        return;
      }
      try { await configureBridgeVideo(acquired.track, this.bridge!.videoQuality); }
      catch (error) { stopStream(acquired.stream); throw error; }
      if (!current()) { stopStream(acquired.stream); return; }
      const camera = this.bridgeCamera = {
        stream: acquired.stream,
        track: acquired.track,
        side: acquired.choice.side,
        width: acquired.track.getSettings().width ?? 0,
        height: acquired.track.getSettings().height ?? 0,
      };
      this.cameraStream = camera.stream;
      this.selectedCamera = acquired.choice;
      preview.srcObject = camera.stream;
      await preview.play();
      if (!current()) return;
      camera.width ||= preview.videoWidth;
      camera.height ||= preview.videoHeight;
      if (!this.bridgeCameraReady()) throw new Error("The selected camera must provide live video and camera geometry");
      camera.track.addEventListener("ended", () => {
        if (!current() || this.bridgeCamera !== camera) return;
        this.releaseBridgeCamera(root);
        this.selectedCamera = null;
        const message = `The ${camera.side === "unknown" ? "selected" : camera.side} camera stopped. Enable the camera to reconnect.`;
        this.updateCaptureStatus(root, { camera: "error", lastError: message });
        this.reportError(root, message);
      }, { once: true });
      this.bridge!.setCamera(camera);
      root.dataset.bridgeCameraCount = "1";
      const detail = root.querySelector<HTMLElement>("#bridge-camera-preview-detail")!;
      detail.textContent = camera.side === "unknown" ? "One camera selected." : `${camera.side === "right" ? "Right" : "Left"} camera selected.`;
      detail.hidden = false;
      root.querySelector(".capture-video-empty")!.classList.add("is-hidden");
      root.querySelector(".capture-video-empty")!.classList.remove("has-error");
      root.querySelector<HTMLElement>("#camera-field-status")!.hidden = true;
      this.updateCaptureStatus(root, {
        camera: "ready",
        selectedCameraDeviceId: this.selectedCamera.deviceId,
        selectedCameraLabel: this.selectedCamera.label,
        selectedCameraWidth: camera.width,
        selectedCameraHeight: camera.height,
        selectedCameraFrame: null,
        selectedCameraFrameRate: camera.track.getSettings().frameRate ?? null,
        selectedCameraSide: camera.side,
        lastError: null,
      });
      this.setStatus(root, "Camera ready");
      void this.composeCaptureStream();
    } catch (error) {
      if (!current()) return;
      this.releaseBridgeCamera(root);
      this.selectedCamera = null;
      this.updateCaptureStatus(root, {
        camera: "error",
        lastError: error instanceof Error ? error.message : "The selected camera could not be opened",
      });
      throw error;
    } finally {
      if (!this.disposed && generation === this.cameraSelectionGeneration) this.renderCaptureDiagnostics(root);
    }
  }

  private async selectCamera(root: HTMLElement, deviceId: string) {
    if (this.disposed || this.captureAuthorityRevoked) return;
    if (this.bridge) {
      if (this.xrSession || this.captureStatus.xr === "requesting") throw new Error("Exit XR before changing the camera");
      return this.selectBridgeCamera(root, deviceId);
    }
    if ((this.mediaRecorder && this.mediaRecorder.state !== "inactive")
      || (this.snapshot?.run.recordingState !== undefined && this.snapshot.run.recordingState !== "idle")
      || this.recordingFinalising) {
      throw new Error("The camera cannot be changed while a recording is active");
    }
    const generation = ++this.cameraSelectionGeneration;
    const select = root.querySelector<HTMLSelectElement>("#camera-select");
    if (select) select.disabled = true;
    this.cameraCaptureComposer?.dispose();
    this.cameraCaptureComposer = null;
    stopStream(this.cameraStream);
    this.cameraStream = null;
    this.captureStream = null;
    this.selectedCamera = null;
    delete root.dataset.cameraCaptureFrame;
    delete root.dataset.cameraCaptureOutput;
    this.xrCameraEdgesShownAt = null;
    root.dataset.xrCameraEdgesPhase = "hidden";
    this.lastXrReticleRenderAt = Number.NEGATIVE_INFINITY;
    this.renderXrReticleOverlay();
    this.updateCaptureStatus(root, {
      camera: "requesting",
      selectedCameraDeviceId: null,
      selectedCameraLabel: null,
      selectedCameraWidth: null,
      selectedCameraHeight: null,
      selectedCameraFrame: null,
      selectedCameraFrameRate: null,
      selectedCameraSide: "unknown",
      lastError: null,
    });
    const preview = root.querySelector<HTMLVideoElement>("#camera-preview")!;
    let cameraStream: MediaStream | null = null;
    let stage: "device_selection" | "preview_playback" | "capture_composition" = "device_selection";
    try {
      cameraStream = await openSelectedCamera(deviceId);
      if (this.disposed || this.captureAuthorityRevoked || generation !== this.cameraSelectionGeneration) {
        stopStream(cameraStream);
        return;
      }
      this.cameraStream = cameraStream;
      const camera = this.cameraChoices.find((choice) => choice.deviceId === deviceId);
      this.selectedCamera = camera ?? null;
      preview.srcObject = this.cameraStream;
      stage = "preview_playback";
      await preview.play();
      if (this.disposed || this.captureAuthorityRevoked || generation !== this.cameraSelectionGeneration) {
        stopStream(cameraStream);
        if (preview.srcObject === cameraStream) preview.srcObject = null;
        return;
      }
      root.querySelector(".capture-video-empty")!.classList.add("is-hidden");
      root.querySelector<HTMLElement>("#camera-field-status")!.hidden = true;
      root.querySelector(".capture-video-empty")!.classList.remove("has-error");
      stage = "capture_composition";
      const sourceSettings = this.cameraStream.getVideoTracks()[0]?.getSettings();
      const sourceTrack = this.cameraStream.getVideoTracks()[0];
      if (!sourceTrack || sourceTrack.readyState !== "live") {
        throw new Error("The selected camera did not provide a live video track");
      }
      const sourceWidth = sourceSettings?.width ?? preview.videoWidth;
      const sourceHeight = sourceSettings?.height ?? preview.videoHeight;
      const captureFrame = cameraCaptureFrame(sourceWidth, sourceHeight);
      let composer!: CameraCaptureComposer;
      composer = new CameraCaptureComposer(
        preview,
        sourceTrack,
        captureFrame,
        sourceSettings?.frameRate ?? 30,
        (error) => this.failCameraCapture(root, composer, error),
      );
      this.cameraCaptureComposer = composer;
      const outputSettings = composer.stream.getVideoTracks()[0]?.getSettings();
      if (outputSettings?.width !== captureFrame.outputWidth
        || outputSettings.height !== captureFrame.outputHeight) {
        throw new Error("The camera capture surface dimensions do not match the recording frame");
      }
      root.dataset.cameraCaptureFrame = cameraCaptureFrameKey(captureFrame);
      root.dataset.cameraCaptureOutput = `${outputSettings.width}x${outputSettings.height}`;
      await this.composeCaptureStream();
      if (this.disposed
        || this.captureAuthorityRevoked
        || generation !== this.cameraSelectionGeneration
        || this.cameraCaptureComposer !== composer
        || !composer.isLive()) return;
      this.updateCaptureStatus(root, {
        camera: "ready",
        selectedCameraDeviceId: camera?.deviceId ?? deviceId,
        selectedCameraLabel: camera?.label ?? "Outward camera",
        selectedCameraWidth: captureFrame.outputWidth,
        selectedCameraHeight: captureFrame.outputHeight,
        selectedCameraFrame: captureFrame,
        selectedCameraFrameRate: sourceSettings?.frameRate ?? null,
        selectedCameraSide: camera?.side ?? "unknown",
        lastError: null,
      });
    } catch (error) {
      if (generation !== this.cameraSelectionGeneration) {
        stopStream(cameraStream);
        return;
      }
      this.cameraCaptureComposer?.dispose();
      this.cameraCaptureComposer = null;
      delete root.dataset.cameraCaptureFrame;
      delete root.dataset.cameraCaptureOutput;
      stopStream(cameraStream);
      if (preview.srcObject === cameraStream) preview.srcObject = null;
      if (this.cameraStream === cameraStream) this.cameraStream = null;
      this.captureStream = null;
      this.selectedCamera = null;
      this.updateCaptureStatus(root, {
        camera: "error",
        selectedCameraDeviceId: null,
        selectedCameraLabel: null,
        selectedCameraWidth: null,
        selectedCameraHeight: null,
        selectedCameraFrame: null,
        selectedCameraFrameRate: null,
        selectedCameraSide: "unknown",
        lastError: error instanceof Error ? error.message : "The selected camera could not be opened",
      });
      throw error;
    } finally {
      if (generation === this.cameraSelectionGeneration && select) select.disabled = false;
    }
  }

  private failCameraCapture(root: HTMLElement, composer: CameraCaptureComposer, failure: Error) {
    if (this.disposed || this.captureAuthorityRevoked || this.cameraCaptureComposer !== composer) return;
    this.cameraSelectionGeneration += 1;
    composer.dispose();
    this.cameraCaptureComposer = null;
    stopStream(this.cameraStream);
    this.cameraStream = null;
    this.captureStream = null;
    this.selectedCamera = null;
    const preview = root.querySelector<HTMLVideoElement>("#camera-preview");
    if (preview) preview.srcObject = null;
    delete root.dataset.cameraCaptureFrame;
    delete root.dataset.cameraCaptureOutput;
    this.xrCameraEdgesShownAt = null;
    root.dataset.xrCameraEdgesPhase = "hidden";
    this.lastXrReticleRenderAt = Number.NEGATIVE_INFINITY;
    this.renderXrReticleOverlay();
    const message = failure.message || "The composed camera recording track failed";
    this.updateCaptureStatus(root, {
      camera: "error",
      selectedCameraDeviceId: null,
      selectedCameraLabel: null,
      selectedCameraWidth: null,
      selectedCameraHeight: null,
      selectedCameraFrame: null,
      selectedCameraFrameRate: null,
      selectedCameraSide: "unknown",
      lastError: message,
    });
    this.setStatus(root, message, true);
    const recordingActive = (this.mediaRecorder && this.mediaRecorder.state !== "inactive")
      || (this.snapshot?.run.recordingState !== undefined && this.snapshot.run.recordingState !== "idle");
    if (recordingActive) {
      void this.stopRecorders(root)
        .catch((error) => {
          this.failRecorderFinalisation(root, error);
        });
      this.sendDemonstratorControl(root, "stop");
    }
  }

  private microphoneRequired() {
    if (this.bridge) return true;
    return microphoneCaptureRequired(
      this.configuration.recordAudio,
      this.localVoiceCommandRecognitionEnabled(),
    );
  }

  private acquireMicrophoneStream() {
    if (this.microphoneStream?.getAudioTracks().some(track => track.readyState === "live")) return Promise.resolve(this.microphoneStream);
    if (this.microphoneAcquisition) return this.microphoneAcquisition;
    const acquisition = openMicrophone().then((microphoneStream) => {
      if (this.disposed || this.captureAuthorityRevoked || !this.microphoneRequired()) {
        stopStream(microphoneStream);
        return null;
      }
      if (!this.microphoneStream) {
        this.microphoneStream = microphoneStream;
        this.enableLocalVoiceCommands(microphoneStream);
      } else if (this.microphoneStream !== microphoneStream) {
        stopStream(microphoneStream);
      }
      return this.microphoneStream;
    });
    this.microphoneAcquisition = acquisition;
    const clearAcquisition = () => {
      if (this.microphoneAcquisition === acquisition) this.microphoneAcquisition = null;
    };
    void acquisition.then(clearAcquisition, clearAcquisition);
    return acquisition;
  }

  private async composeCaptureStream() {
    if (this.captureAuthorityRevoked) return;
    const microphoneRequired = this.microphoneRequired();
    if (!microphoneRequired && this.microphoneStream) {
      stopStream(this.microphoneStream);
      this.microphoneStream = null;
    }
    if (microphoneRequired && !this.microphoneStream) {
      try {
        await this.acquireMicrophoneStream();
      } catch (error) {
        if (!this.disposed && !this.captureAuthorityRevoked && this.microphoneRequired()) {
          const detail = error instanceof Error ? error.message : "Microphone access is unavailable";
          if (this.localVoiceCommandRecognitionEnabled()) {
            this.localVoiceCommandStatus = "error";
            this.reportLocalVoiceCommandFailure(detail);
            this.showLocalVoiceCommandOverlay("error", detail);
            this.renderXrTaskHud();
          } else {
          }
          if (this.mountedRoot) this.setStatus(this.mountedRoot, detail, true);
        }
      }
    }
    if (this.disposed || this.captureAuthorityRevoked) return;
    if (this.bridge) return;
    if (!this.microphoneRequired() && this.microphoneStream) {
      stopStream(this.microphoneStream);
      this.microphoneStream = null;
    }
    // Durable audio remains independent of speech recognition. A disabled
    // recogniser releases only microphone access that recording does not need.
    const composer = this.cameraCaptureComposer;
    const videoTracks = composer?.stream.getVideoTracks() ?? [];
    if (!composer
      || !composer.isLive()
      || videoTracks.length !== 1
      || videoTracks[0].readyState !== "live") {
      this.captureStream = null;
      return;
    }
    this.captureStream = new MediaStream([
      videoTracks[0],
      ...(this.configuration.recordAudio ? this.microphoneStream?.getAudioTracks() ?? [] : []),
    ]);
    const root = this.mountedRoot;
    if (root) for (const peerId of [...this.peers.keys()]) void this.createOffer(root, peerId, true);
  }

  private liveComposedVideoTrack() {
    const composer = this.cameraCaptureComposer;
    const captureStream = this.captureStream;
    if (!composer || !captureStream || !composer.isLive()) return null;
    const composedTracks = composer.stream.getVideoTracks();
    const captureTracks = captureStream.getVideoTracks();
    if (composedTracks.length !== 1
      || captureTracks.length !== 1
      || composedTracks[0] !== captureTracks[0]
      || composedTracks[0].readyState !== "live") return null;
    return composedTracks[0];
  }

  private enableLocalVoiceCommands(stream: MediaStream) {
    if (
      this.localVoiceCommands
      || !this.localVoiceCommandRecognitionEnabled()
      || this.disposed
      || this.captureAuthorityRevoked
    ) return;
    this.localVoiceCommandRecovery.cancel(window);
    this.setLocalVoiceCommandRecognitionActive(false);
    this.localVoiceCommandStatus = "loading";
    this.localVoiceCommandErrorDetail = null;
    this.localVoiceCommandErrorKind = null;
    this.renderLocalVoiceCommandStatus();
    const commands = new LocalVoiceCommandController({
      stream,
      getContext: () => this.voiceCommandContext(),
      getExitContext: () => this.voiceExitContext(),
      onCommand: (command, context) => this.handleLocalVoiceCommand(command, context),
      onRecognitionChange: (active) => {
        if (
          this.localVoiceCommands !== commands
          || !this.localVoiceCommandRecognitionEnabled()
          || this.disposed
        ) return;
        this.setLocalVoiceCommandRecognitionActive(active);
      },
      onRecognitionSuccess: () => {
        if (this.localVoiceCommands !== commands || this.disposed) return;
        this.localVoiceCommandRecovery.reset(window);
      },
      onRecognitionResult: (matched) => {
        if (this.localVoiceCommands !== commands || this.disposed) return;
        this.localVoiceCommandResult = { matched, receivedAtMs: performance.now() };
        this.renderXrReticleOverlay();
      },
      onFatalError: () => {
        if (this.localVoiceCommands !== commands) return;
        this.localVoiceCommands = null;
        this.setLocalVoiceCommandRecognitionActive(false);
        commands.dispose();
        this.scheduleLocalVoiceCommandRecovery();
      },
      onStatus: (status, detail, failure) => {
        if (this.localVoiceCommands !== commands || !this.localVoiceCommandRecognitionEnabled()) return;
        if (status === "loading" && this.localVoiceCommandStatus === "error") return;
        const previousErrorDetail = this.localVoiceCommandErrorDetail;
        this.localVoiceCommandStatus = status;
        if (status === "loading" || status === "error") this.localVoiceCommandResult = null;
        if (status === "ready" || status === "fallback") {
          this.localVoiceCommandErrorDetail = null;
          this.localVoiceCommandErrorKind = null;
        }
        if (status === "error") this.reportLocalVoiceCommandFailure(detail, failure);
        this.renderLocalVoiceCommandStatus();
        this.showLocalVoiceCommandOverlay(status, detail);
        this.renderXrTaskHud();
        if (this.mountedRoot && status === "error" && this.localVoiceCommandErrorKind !== "model-assets") {
          this.setStatus(this.mountedRoot, detail ?? "Local voice commands are unavailable", true);
        } else if (this.mountedRoot && (status === "ready" || status === "fallback")) {
          const statusNode = this.mountedRoot.querySelector<HTMLElement>("#capture-status");
          if (statusNode?.classList.contains("is-error")
            && statusNode.textContent === previousErrorDetail) {
            this.setStatus(this.mountedRoot, detail ?? "Local voice commands ready");
          }
        }
      },
    });
    this.localVoiceCommands = commands;
    void commands.start().catch((error) => {
      if (this.localVoiceCommands !== commands) return;
      const detail = error instanceof Error ? error.message : "Local voice commands are unavailable";
      this.localVoiceCommands = null;
      this.setLocalVoiceCommandRecognitionActive(false);
      this.localVoiceCommandStatus = "error";
      this.reportLocalVoiceCommandFailure(detail);
      this.showLocalVoiceCommandOverlay("error", detail);
      this.renderXrTaskHud();
      if (this.mountedRoot) this.setStatus(this.mountedRoot, detail, true);
      commands.dispose();
      if (localVoiceCommandStartupFailureRetryable(error)) {
        this.scheduleLocalVoiceCommandRecovery();
      }
    });
  }

  private setLocalVoiceCommandRecognitionActive(active: boolean) {
    const nextStartedAt = active
      ? this.localVoiceCommandRecognitionStartedAt ?? performance.now()
      : null;
    if (nextStartedAt === this.localVoiceCommandRecognitionStartedAt) return;
    if (active) this.localVoiceCommandResult = null;
    this.localVoiceCommandRecognitionStartedAt = nextStartedAt;
    this.renderXrReticleOverlay();
  }

  private scheduleLocalVoiceCommandRecovery() {
    if (
      this.disposed
      || this.captureAuthorityRevoked
      || !this.localVoiceCommandRecognitionEnabled()
      || !this.microphoneStream
    ) return;
    this.localVoiceCommandRecovery.schedule(window, () => {
      const stream = this.microphoneStream;
      if (
        !stream
        || this.disposed
        || this.captureAuthorityRevoked
        || !this.localVoiceCommandRecognitionEnabled()
      ) return;
      this.enableLocalVoiceCommands(stream);
    });
  }

  private reconcileLocalVoiceCommands() {
    if (this.localVoiceCommandRecognitionEnabled()) {
      if (this.microphoneStream && !this.localVoiceCommandRecovery.pending) {
        this.enableLocalVoiceCommands(this.microphoneStream);
      }
      return;
    }
    this.localVoiceCommandRecovery.reset(window);
    const commands = this.localVoiceCommands;
    this.localVoiceCommands = null;
    commands?.dispose();
    if (!this.configuration.recordAudio && this.microphoneStream) {
      stopStream(this.microphoneStream);
      this.microphoneStream = null;
    }
    this.localVoiceCommandStatus = "loading";
    this.localVoiceCommandResult = null;
    this.localVoiceCommandErrorDetail = null;
    this.localVoiceCommandErrorKind = null;
    this.renderLocalVoiceCommandStatus();
    this.setLocalVoiceCommandRecognitionActive(false);
    this.localVoiceCommandOverlayNotice = null;
    this.localVoiceCommandOverlayPending = false;
    this.renderXrTaskHud();
  }

  private reportLocalVoiceCommandFailure(detail: string | undefined, failure?: LocalVoiceCommandFailure) {
    const message = detail ?? "Local voice commands are unavailable";
    const kind = failure?.kind ?? localVoiceCommandFailureKind(message);
    if (message === this.localVoiceCommandErrorDetail && kind === this.localVoiceCommandErrorKind) return;
    this.localVoiceCommandErrorDetail = message;
    this.localVoiceCommandErrorKind = kind;
    console.warn("Local voice command failure", { kind, detail: failure?.diagnosticDetail ?? message });
  }

  private renderLocalVoiceCommandStatus() {
    const node = this.mountedRoot?.querySelector<HTMLElement>("#local-voice-status");
    if (!node) return;
    const missingAssets = this.localVoiceCommandStatus === "error" && this.localVoiceCommandErrorKind === "model-assets";
    node.textContent = missingAssets ? this.localVoiceCommandErrorDetail : "";
    node.hidden = !missingAssets;
  }

  private showLocalVoiceCommandOverlay(
    status = this.localVoiceCommandStatus,
    detail = this.localVoiceCommandErrorDetail ?? undefined,
  ) {
    if (!this.xrSession || this.xrStartupIntro?.isActive) {
      this.localVoiceCommandOverlayPending = true;
      return;
    }
    const overlay = localVoiceCommandOverlay(status, detail, this.localVoiceCommandErrorKind ?? undefined);
    this.localVoiceCommandOverlayNotice = {
      expiresAtMs: performance.now() + overlay.durationMs,
      presentation: {
        label: overlay.label,
        dangerRatio: status === "error" ? .72 : .08,
        tapeOpacity: status === "error" ? .28 : .18,
        pulseIntervalMs: status === "error" ? 780 : 1_100,
      },
    };
    this.localVoiceCommandOverlayPending = false;
  }

  private voiceCommandContext() {
    return localVoiceCommandContext(this.sessionKey, this.snapshot, this.bridge?.paused ?? null);
  }

  private voiceExitContext() {
    return `${this.sessionKey}:${this.xrPresentationGeneration}:${this.xrSession ? "active" : "inactive"}`;
  }

  private handleLocalVoiceCommand(command: LocalVoiceCommand, context?: string) {
    const root = this.mountedRoot;
    if (!root
      || !this.localVoiceCommandRecognitionEnabled()
      || this.disposed
      || this.captureAuthorityRevoked
      || context !== undefined && context !== (command === "exit" ? this.voiceExitContext() : this.voiceCommandContext())) return;
    const action = localVoiceCommandAction(command);
    if (action === "exit-ar") {
      void this.exitXrForSystemTransition().catch(error => {
        this.reportError(root, error instanceof Error ? error.message : "AR could not close");
      });
      return;
    }
    const handDisplaySettings = localVoiceCommandHandDisplaySettings(
      this.handDisplaySettings,
      command,
    );
    if (handDisplaySettings) {
      this.applyHandDisplaySettings(handDisplaySettings);
      this.renderXrHandDisplayHud();
      this.sendDemonstratorHandDisplay(root);
      const control = localVoiceCommandHandDisplayControl(command);
      if (control) {
        this.xrCaptureHorizonHud?.flashVoiceHandControl(
          control,
          this.prefersReducedMotion(),
        );
      }
      return;
    }
    if (!action) return;
    if (this.bridge) {
      if (command === "pause" && !this.bridge.paused) void this.bridge.togglePause();
      else if (command === "start" && this.bridge.paused) void this.bridge.togglePause();
      else if (command === "stop" || command === "finish" || command === "done") void this.xrSession?.end();
      return;
    }
    if ((action === "success" || action === "fail")
      && (this.snapshot?.run.status !== "running"
        || this.snapshot.run.phase !== "post-task-pause"
        || this.snapshot.run.recordingState === "stopping")) {
      this.showRunControlNotice(root, PASS_FAIL_REVIEW_NOTICE);
      return;
    }
    if (command === "start" && this.authority.kind !== "solo") {
      // Voice retries express readiness once, including while its acknowledgement
      // is in flight. The corresponding pointer control can still toggle it.
      const currentContext = this.voiceCommandContext();
      if (this.snapshot?.run.demonstratorReady
        || this.snapshot?.solo?.startCountdownDeadlineMs != null
        || this.localVoiceStartPending?.context === currentContext
          && performance.now() < this.localVoiceStartPending.expiresAt) return;
      this.localVoiceStartPending = { context: currentContext, expiresAt: performance.now() + 4_000 };
    }
    if (command === "start" && this.authority.kind === "solo") {
      if (!this.onSoloStartRun || this.localVoiceSoloStartPending
        || this.snapshot?.solo?.startCountdownDeadlineMs != null
        || this.snapshot?.run.status === "stopped" && this.snapshot?.solo?.selectedStartTaskId != null) return;
      this.localVoiceSoloStartPending = true;
      this.xrCaptureHorizonHud?.flashVoiceAction(action, this.prefersReducedMotion());
      void Promise.resolve().then(() => this.onSoloStartRun?.()).catch(error => {
        this.reportError(root, error instanceof Error ? error.message : "The run could not start");
      }).finally(() => { this.localVoiceSoloStartPending = false; });
      return;
    }
    if (this.sendDemonstratorControl(root, action)) {
      this.xrCaptureHorizonHud?.flashVoiceAction(action, this.prefersReducedMotion());
    } else if (command === "start") {
      this.localVoiceStartPending = null;
    }
  }

  private handleCaptureAccountState(root: HTMLElement, accountUrl: string | null, state: UserIdentityState) {
    if (this.accountInviteTimer !== null) window.clearInterval(this.accountInviteTimer);
    this.accountInviteTimer = null;
    const list = root.querySelector<HTMLElement>("#capture-invitation-list");
    const count = root.querySelector<HTMLElement>("#capture-invitation-count");
    if (!list || !count) return;
    if (state.status !== "signed-in" || !accountUrl) {
      count.textContent = "--";
      list.replaceChildren(Object.assign(document.createElement("span"), {
        textContent: state.status === "loading" ? "Checking account" : "Log in to view invitations",
      }));
      return;
    }
    void this.loadCaptureInvitations(root, accountUrl);
    this.accountInviteTimer = window.setInterval(() => {
      if (!this.disposed) void this.loadCaptureInvitations(root, accountUrl);
    }, 15_000);
  }

  private async loadCaptureInvitations(root: HTMLElement, accountUrl: string) {
    try {
      this.renderCaptureInvitations(root, accountUrl, await applicationServices().invitations!.list());
    } catch {
      const list = root.querySelector<HTMLElement>("#capture-invitation-list");
      if (list) list.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Invitations unavailable" }));
    }
  }

  private renderCaptureInvitations(root: HTMLElement, accountUrl: string, invitations: DirectoryInvitation[]) {
    const list = root.querySelector<HTMLElement>("#capture-invitation-list");
    const count = root.querySelector<HTMLElement>("#capture-invitation-count");
    if (!list || !count) return;
    count.textContent = String(invitations.length);
    list.replaceChildren();
    if (invitations.length === 0) {
      list.append(Object.assign(document.createElement("span"), { textContent: "No pending invitations" }));
      return;
    }
    for (const invitation of invitations) {
      const button = document.createElement("button");
      button.type = "button";
      const inviter = document.createElement("strong");
      inviter.textContent = invitation.inviter;
      const detail = document.createElement("span");
      detail.textContent = invitation.mode === "relayed" ? "Relayed" : "Direct";
      button.append(inviter, detail);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          location.assign(await applicationServices().invitations!.accept(invitation.id));
        } catch {
          this.beginPairingJourney("account-invitation");
          this.finishPairingJourney("failed");
          button.disabled = false;
        }
      });
      list.append(button);
    }
  }

  private enterXr(root: HTMLElement): Promise<boolean> {
    if (this.disposed || this.captureAuthorityRevoked) return Promise.resolve(false);
    if (this.xrSession || this.world?.renderer.xr.getSession()) return Promise.resolve(true);
    if (this.bridge && (!this.bridge.ready || (this.bridgeCamera !== null && !this.bridgeCameraReady()))) {
      this.setStatus(root, "Pair a receiver and reconnect the selected camera before entering XR");
      return Promise.resolve(false);
    }
    if (this.demonstratorAudioCuesEnabled()) this.demonstratorAudioCuePlayer?.prepare();
    this.requestCaptureIntent();
    if (!this.captureIntentGranted) {
      this.setStatus(root, "Preparing this tab for the capture director. Join XR when the recorder is ready.");
      return Promise.resolve(false);
    }
    if (!globalThis.isSecureContext) {
      this.setStatus(root, "XR access requires HTTPS. Open the secure capture link.", true);
      return Promise.resolve(false);
    }
    const launch = this.xrLaunch.begin();
    if (!launch.owner) return launch.completion;
    this.updateCaptureStatus(root, { xr: "requesting", lastError: null });
    this.setStatus(root, "Requesting XR access");
    void this.startXrLaunch(root, launch);
    return launch.completion;
  }

  private async startXrLaunch(root: HTMLElement, launch: XrLaunchAttempt) {
    let createdWorld: any | null = null;
    let worldPublished = false;
    try {
      if (!this.bridge && usesSyntheticSensorSource() && usesHeadlessTestRendering()) {
        if (launch.signal.aborted) throw new DOMException("XR launch was cancelled", "AbortError");
        this.activateHeadlessSyntheticXr(root);
        this.xrLaunch.settle(launch, true);
        return;
      }
      let world = this.world;
      if (!world) {
        createdWorld = await World.create(root.querySelector<HTMLDivElement>("#xr-stage")!, {
          xr: this.bridge
            ? CERES_BRIDGE_XR_SESSION_OPTIONS
            : this.authority.kind === "solo" ? CERES_SOLO_XR_SESSION_OPTIONS : CERES_DIRECTED_XR_SESSION_OPTIONS,
          features: {
            spatialUI: {
              kits: CERES_HORIZON_UI_KIT,
              preferredColorScheme: "dark",
            },
          },
        } as any);
        if (this.disposed || this.captureAuthorityRevoked || launch.signal.aborted) {
          throw new DOMException("XR launch was cancelled", "AbortError");
        }
        this.captureControllerInputPolicy = configureCaptureControllerInputPolicy(createdWorld.input?.xr);
        if (!this.captureControllerInputPolicy) {
          throw new Error("Capture XR could not configure controller input filtering");
        }
        this.syncCaptureControllerInputPolicy();
        if (!configureCaptureHandRayVisuals(createdWorld.input?.xr)) {
          throw new Error("Capture XR could not configure the hand ray visual");
        }
        if (createdWorld.renderer) {
          createdWorld.renderer.localClippingEnabled = true;
          this.restoreXrRendererResize = guardImmersiveRendererResize(createdWorld.renderer);
        }
        this.world = createdWorld;
        worldPublished = true;
        this.createXrCaptureHorizonHud();
        this.createXrStartupIntro();
        if (!this.bridge) this.createXrBeamHud();
        this.createXrTrackingVisuals();
        if (this.soloPostAcquisitionPresentation) this.createXrSoloPostAcquisitionHud();
        this.xrWorkspace?.mount(createdWorld);
        this.bindXrEvents(root);
        world = createdWorld;
      }
      if (this.disposed || this.captureAuthorityRevoked || launch.signal.aborted) {
        throw new DOMException("XR launch was cancelled", "AbortError");
      }
      const session = await launchIwsdkXrSession(world, launch.signal);
      if (this.disposed || this.captureAuthorityRevoked || launch.signal.aborted) {
        await session.end().catch(() => undefined);
        throw new DOMException("XR launch was cancelled", "AbortError");
      }
      if (this.xrSession !== session || !this.xrReferenceSpace) {
        await session.end().catch(() => undefined);
        throw new Error("XR session started without a reference space");
      }
      this.xrLaunch.settle(launch, true);
    } catch (error) {
      if (createdWorld && (!this.disposed || !worldPublished)) {
        this.resetXrWorldAfterFailedLaunch(createdWorld);
      }
      if (!this.xrLaunch.isCurrent(launch)) return;
      const message = error instanceof Error ? error.message : "Immersive AR could not be initialised";
      this.xrLaunch.settle(launch, false);
      this.reportError(root, message);
    }
  }

  private activateHeadlessSyntheticXr(root: HTMLElement) {
    this.stopSensorLoop();
    this.xrPresentationGeneration += 1;
    this.xrSession = {
      inputSources: this.authority.kind === "solo"
        ? [
          { handedness: "left", hand: new Map() },
          { handedness: "right", hand: new Map() },
        ]
        : [],
      end: async () => undefined,
    };
    this.soloHandRecognition = recogniseXrHands(this.xrSession.inputSources);
    this.soloControllerRecognition = recogniseXrControllers(this.xrSession.inputSources);
    this.xrReferenceSpace = {};
    this.captureAuthorityGranted = false;
    this.captureXrAuthorityRequested = false;
    this.markCaptureXrActive();
    this.setStatus(root, "XR opened. Securing capture authority before data collection starts.");
  }

  private createXrCaptureHorizonHud() {
    const world = this.world;
    if (!world || this.xrCaptureHorizonHud) return;
    this.xrCaptureHorizonHud = new XrCaptureHorizonHud(world, {
      onMenu: () => {
        void this.onSoloReconfigure?.();
      },
      onRetread: () => {
        void this.onSoloRetread?.();
      },
      onExit: () => {
        void this.exitXrForSystemTransition().catch(() => undefined);
      },
      onRunControl: (control) => {
        if (!control.enabled) return;
        if (this.authority.kind === "solo" && control.id === "start-sequence") {
          void this.onSoloStartRun?.();
          return;
        }
        this.sendDemonstratorControl(
          this.mountedRoot,
          control.id as DemonstratorControlAction,
        );
      },
      onHandControl: (control) => {
        if (!control.enabled) return;
        this.applyHandDisplaySettings(
          cycleXrHandDisplaySetting(this.handDisplaySettings, control.key),
        );
        this.renderXrTaskHud();
        this.sendDemonstratorHandDisplay(this.mountedRoot);
      },
    }, this.bridge ? {
      onPause: () => { void this.bridge!.togglePause(); },
      onHudMode: () => { this.bridge!.cycleHudMode(); },
      onAudio: () => { if (this.mountedRoot) void this.toggleBridgeAudio(this.mountedRoot); },
    } : undefined);
    this.renderXrTaskHud();
  }

  refreshLaunchState() {
    const root = this.mountedRoot;
    if (!root || this.disposed) return;
    this.renderCaptureDiagnostics(root);
  }

  presentSoloPostAcquisitionQuality(presentation: SoloPostAcquisitionQualityPresentation) {
    const current = this.soloPostAcquisitionPresentation;
    if (current?.key === presentation.key
      && current.result === presentation.result) return;
    this.soloPostAcquisitionPresentation = presentation;
    this.createXrSoloPostAcquisitionHud();
    this.xrSoloPostAcquisitionHud?.update(presentation);
    this.applyXrSurfaceVisibility();
  }

  clearSoloPostAcquisitionQuality() {
    this.soloPostAcquisitionPresentation = null;
    this.xrSoloPostAcquisitionHud?.update(null);
    this.syncXrSoloPostAcquisitionClock();
  }

  private createXrStartupIntro() {
    const world = this.world;
    if (!world || this.xrStartupIntro) return;
    this.xrStartupIntro = new XrStartupIntro(world, {
      version: __CERES_BUILD_IDENTITY__.version,
      codename: __CERES_BUILD_IDENTITY__.codename,
      shortCommit: __CERES_BUILD_IDENTITY__.shortCommit,
    });
  }

  private createXrTaskHud() {
    const world = this.world;
    if (!world || this.xrTaskHud) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 530;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: texture, transparent: true, opacity: XR_TASK_HUD_PANEL_OPACITY, depthTest: false, depthWrite: false, side: DoubleSide });
    const panelGeometry = new PlaneGeometry(XR_TASK_HUD_WIDTH_M, XR_TASK_HUD_HEIGHT_M, 16, 1);
    const panelPositions = panelGeometry.getAttribute("position");
    for (let index = 0; index < panelPositions.count; index += 1) {
      const normalisedX = panelPositions.getX(index) / (XR_TASK_HUD_WIDTH_M / 2);
      panelPositions.setZ(index, .026 * normalisedX * normalisedX);
    }
    panelPositions.needsUpdate = true;
    panelGeometry.computeVertexNormals();
    const panel = new Mesh(panelGeometry, material);
    panel.frustumCulled = false;
    panel.renderOrder = 999;
    const group = new Group();
    group.name = "ceres-demonstrator-task-hud";
    group.add(panel);
    const storedAnchor = localStorage.getItem(TASK_HUD_ANCHOR_STORAGE_KEY);
    const anchor: XrTaskHudAnchor = isXrTaskHudAnchor(storedAnchor) ? storedAnchor : "above";
    const initialPosition = XR_TASK_HUD_ANCHORS[anchor];
    group.position.set(initialPosition.x, initialPosition.y, initialPosition.z);
    group.rotation.y = anchor === "left" ? .08 : anchor === "right" ? -.08 : -.035;
    group.visible = false;
    const hudEntity = world.createTransformEntity(group, { parent: world.cameraEntity, persistent: true });

    const frameMaterial = new MeshBasicMaterial({ color: XR_HUD_ACCENT, transparent: true, opacity: .22, depthTest: false, depthWrite: false, side: DoubleSide });
    const hitMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide, colorWrite: false });
    const edgeGroup = new Group();
    edgeGroup.position.z = .008;
    const addEdge = (width: number, height: number, x: number, y: number) => {
      const hitArea = new Mesh(new PlaneGeometry(width, height), hitMaterial);
      hitArea.position.set(x, y, 0);
      hitArea.renderOrder = 1_000;
      edgeGroup.add(hitArea);
      const horizontal = width > height;
      const grip = new Mesh(new PlaneGeometry(
        horizontal ? Math.min(width, .15) : .006,
        horizontal ? .006 : Math.min(height, .11),
      ), frameMaterial);
      grip.position.set(x, y, .002);
      grip.renderOrder = 1_001;
      edgeGroup.add(grip);
    };
    const edgeHitSize = .045;
    addEdge(XR_TASK_HUD_WIDTH_M + edgeHitSize, edgeHitSize, 0, XR_TASK_HUD_HEIGHT_M / 2);
    addEdge(XR_TASK_HUD_WIDTH_M + edgeHitSize, edgeHitSize, 0, -XR_TASK_HUD_HEIGHT_M / 2);
    addEdge(edgeHitSize, XR_TASK_HUD_HEIGHT_M - edgeHitSize, -XR_TASK_HUD_WIDTH_M / 2, 0);
    addEdge(edgeHitSize, XR_TASK_HUD_HEIGHT_M - edgeHitSize, XR_TASK_HUD_WIDTH_M / 2, 0);
    const edgeEntity = world.createTransformEntity(edgeGroup, { parent: hudEntity, persistent: true });
    edgeEntity.addComponent(RayInteractable);

    const controlHitGroup = new Group();
    controlHitGroup.position.z = .012;
    const controlHitWidth = XR_TASK_HUD_WIDTH_M * ((canvas.width - 96) / canvas.width);
    const controlHitHeight = XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M;
    const controlHitY = XR_TASK_HUD_CONTROL_CENTRE_Y_M;
    const controlHitArea = new Mesh(new PlaneGeometry(controlHitWidth, controlHitHeight), hitMaterial);
    controlHitArea.position.y = controlHitY;
    controlHitArea.renderOrder = 1_002;
    controlHitGroup.add(controlHitArea);
    const controlEntity = world.createTransformEntity(controlHitGroup, { parent: hudEntity, persistent: true });
    controlEntity.addComponent(RayInteractable);

    const hud: XrTaskHud = { group, canvas, texture, material, anchor, drag: null, frameMaterial, hoveredControl: null, pressedControl: null, interacting: false };
    this.xrTaskHud = hud;
    const updateHoveredControl = (event: SpatialPointerEvent) => {
      const action = this.xrTaskHudControlAt(event.point)?.action ?? null;
      if (action === hud.hoveredControl) return;
      hud.hoveredControl = action;
      this.renderXrTaskHud();
    };
    controlEntity.object3D.addEventListener("pointerenter", updateHoveredControl);
    controlEntity.object3D.addEventListener("pointermove", updateHoveredControl);
    controlEntity.object3D.addEventListener("pointerleave", () => {
      hud.hoveredControl = null;
      hud.pressedControl = advanceXrHudPress(hud.pressedControl, { type: "cancel" }).pressed;
      this.renderXrTaskHud();
    });
    controlEntity.object3D.addEventListener("pointerdown", (event: SpatialPointerEvent) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      const control = this.xrTaskHudControlAt(event.point);
      if (!control) return;
      const transition = advanceXrHudPress(hud.pressedControl, { type: "press", action: control.action, enabled: control.enabled });
      if (transition.pressed === hud.pressedControl) return;
      event.stopPropagation();
      hud.pressedControl = transition.pressed;
      this.renderXrTaskHud();
    });
    controlEntity.object3D.addEventListener("pointerup", (event: SpatialPointerEvent) => {
      const transition = advanceXrHudPress(hud.pressedControl, { type: "release" });
      if (!transition.committed) return;
      event.stopPropagation();
      hud.pressedControl = transition.pressed;
      this.renderXrTaskHud();
      this.sendDemonstratorControl(this.mountedRoot, transition.committed);
    });
    controlEntity.object3D.addEventListener("pointercancel", () => {
      hud.pressedControl = advanceXrHudPress(hud.pressedControl, { type: "cancel" }).pressed;
      this.renderXrTaskHud();
    });
    edgeEntity.object3D.addEventListener("pointerenter", () => {
      hud.interacting = true;
      if (!hud.drag) hud.frameMaterial.opacity = .50;
      this.renderXrTaskHud();
    });
    edgeEntity.object3D.addEventListener("pointerleave", () => {
      if (!hud.drag) {
        hud.interacting = false;
        hud.frameMaterial.opacity = .22;
        this.renderXrTaskHud();
      }
    });
    edgeEntity.object3D.addEventListener("pointerdown", (event: SpatialPointerEvent) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = world.camera.worldToLocal(event.point.clone());
      hud.drag = {
        pointerId: event.pointerId,
        offsetX: point.x - hud.group.position.x,
        offsetY: point.y - hud.group.position.y,
      };
      hud.interacting = true;
      hud.frameMaterial.opacity = .82;
    });
    edgeEntity.object3D.addEventListener("pointermove", (event: SpatialPointerEvent) => {
      if (!hud.drag || hud.drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const point = world.camera.worldToLocal(event.point.clone());
      const position = clampXrTaskHudDragPosition(point.x - hud.drag.offsetX, point.y - hud.drag.offsetY);
      hud.group.position.set(position.x, position.y, position.z);
      const previewAnchor = nearestXrTaskHudAnchor(position.x, position.y);
      if (previewAnchor !== hud.anchor) {
        hud.anchor = previewAnchor;
        this.renderXrTaskHud();
      }
    });
    const finishDrag = (event: SpatialPointerEvent) => {
      if (!hud.drag || hud.drag.pointerId !== event.pointerId) return;
      const target = edgeEntity.object3D;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      hud.drag = null;
      hud.interacting = true;
      hud.frameMaterial.opacity = .50;
      hud.anchor = nearestXrTaskHudAnchor(hud.group.position.x, hud.group.position.y);
      const position = XR_TASK_HUD_ANCHORS[hud.anchor];
      hud.group.position.set(position.x, position.y, position.z);
      hud.group.rotation.y = hud.anchor === "left" ? .08 : hud.anchor === "right" ? -.08 : -.035;
      localStorage.setItem(TASK_HUD_ANCHOR_STORAGE_KEY, hud.anchor);
      this.renderXrTaskHud();
    };
    edgeEntity.object3D.addEventListener("pointerup", finishDrag);
    edgeEntity.object3D.addEventListener("pointercancel", finishDrag);
    this.renderXrTaskHud();
  }

  private applyXrSurfaceVisibility() {
    const sessionActive = xrSessionSurfaceVisible(this.xrSession);
    const introActive = this.xrStartupIntro?.isActive === true;
    const presentationActive = sessionActive && !introActive;
    const captureControlsVisible = sessionActive
      && !this.xrOperationsMenuOpen
      && !introActive;
    this.xrCaptureHorizonHud?.setSessionActive(presentationActive);
    this.xrCaptureHorizonHud?.setRequestedVisible(captureControlsVisible);
    if (this.xrTaskHud) this.xrTaskHud.group.visible = captureControlsVisible;
    if (this.xrHandDisplayHud) this.xrHandDisplayHud.group.visible = captureControlsVisible;
    this.xrSoloPostAcquisitionHud?.setXrSession(this.xrSession);
    this.xrSoloPostAcquisitionHud?.setSurfaceVisible(
      captureControlsVisible,
      this.prefersReducedMotion(),
    );
    if (this.xrTrackingVisuals) {
      this.xrTrackingVisuals.reticle.visible = captureControlsVisible;
      this.xrTrackingVisuals.alert.group.visible = captureControlsVisible
        && Boolean(this.xrTrackingAlertText);
    }
    this.renderXrTaskHud();
    this.renderXrHandDisplayHud();
    this.syncXrSoloPostAcquisitionClock();
  }

  private createXrHandDisplayHud() {
    const world = this.world;
    if (!world || this.xrHandDisplayHud) return;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 176;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: texture, transparent: true, opacity: XR_HAND_DISPLAY_HUD_IDLE_OPACITY, depthTest: false, depthWrite: false, side: DoubleSide });
    const panel = new Mesh(new PlaneGeometry(XR_HAND_DISPLAY_HUD_WIDTH_M, XR_HAND_DISPLAY_HUD_HEIGHT_M), material);
    panel.name = "CERES hand display capsule";
    panel.frustumCulled = false;
    panel.renderOrder = 1_150;
    const group = new Group();
    group.name = "CERES hand display controls";
    group.add(panel);
    group.position.set(XR_HAND_DISPLAY_HUD_POSITION.x, XR_HAND_DISPLAY_HUD_POSITION.y, XR_HAND_DISPLAY_HUD_POSITION.z);
    group.visible = false;
    const hudEntity = world.createTransformEntity(group, { parent: world.cameraEntity, persistent: true });

    const hitMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide, colorWrite: false });
    const hitArea = new Mesh(new PlaneGeometry(XR_HAND_DISPLAY_HUD_WIDTH_M, XR_HAND_DISPLAY_HUD_HEIGHT_M), hitMaterial);
    hitArea.name = "CERES hand display capsule hit target";
    hitArea.position.z = .008;
    hitArea.renderOrder = 1_151;
    const hitGroup = new Group();
    hitGroup.add(hitArea);
    const hitEntity = world.createTransformEntity(hitGroup, { parent: hudEntity, persistent: true });
    hitEntity.addComponent(RayInteractable);

    const hud: XrHandDisplayHud = { group, canvas, texture, material, hoveredControl: null, pressedControl: null };
    this.xrHandDisplayHud = hud;
    const updateHoveredControl = (event: SpatialPointerEvent) => {
      const control = this.xrHandDisplayControlAt(event.point);
      if (control === hud.hoveredControl) return;
      hud.hoveredControl = control;
      this.renderXrHandDisplayHud();
    };
    hitEntity.object3D.addEventListener("pointerenter", updateHoveredControl);
    hitEntity.object3D.addEventListener("pointermove", updateHoveredControl);
    hitEntity.object3D.addEventListener("pointerleave", () => {
      hud.hoveredControl = null;
      hud.pressedControl = advanceXrHudPress(hud.pressedControl, { type: "cancel" }).pressed;
      this.renderXrHandDisplayHud();
    });
    hitEntity.object3D.addEventListener("pointerdown", (event: SpatialPointerEvent) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      const control = this.xrHandDisplayControlAt(event.point);
      if (!control) return;
      const transition = advanceXrHudPress(hud.pressedControl, { type: "press", action: control, enabled: true });
      if (transition.pressed === hud.pressedControl) return;
      event.stopPropagation();
      hud.pressedControl = transition.pressed;
      this.renderXrHandDisplayHud();
    });
    hitEntity.object3D.addEventListener("pointerup", (event: SpatialPointerEvent) => {
      const transition = advanceXrHudPress(hud.pressedControl, { type: "release" });
      if (!transition.committed) return;
      event.stopPropagation();
      hud.pressedControl = transition.pressed;
      this.applyHandDisplaySettings(cycleXrHandDisplaySetting(this.handDisplaySettings, transition.committed));
      this.renderXrHandDisplayHud();
      this.sendDemonstratorHandDisplay(this.mountedRoot);
    });
    hitEntity.object3D.addEventListener("pointercancel", () => {
      hud.pressedControl = advanceXrHudPress(hud.pressedControl, { type: "cancel" }).pressed;
      this.renderXrHandDisplayHud();
    });
    this.renderXrHandDisplayHud();
  }

  private xrHandDisplayControlAt(point: Vector3): XrHandDisplayControlKey | null {
    const hud = this.xrHandDisplayHud;
    if (!hud) return null;
    const local = hud.group.worldToLocal(point.clone());
    if (Math.abs(local.y) > XR_HAND_DISPLAY_HUD_HEIGHT_M / 2) return null;
    return xrHandDisplayControlAtLocalX(local.x);
  }

  private renderXrHandDisplayHud() {
    const hud = this.xrHandDisplayHud;
    if (!hud) return;
    const context = hud.canvas.getContext("2d")!;
    const { width, height } = hud.canvas;
    const segmentWidth = width / XR_HAND_DISPLAY_CONTROLS.length;
    const radius = height / 2 - 6;
    hud.material.opacity = xrHandDisplayHudOpacity(hud.hoveredControl !== null, hud.pressedControl !== null);
    context.clearRect(0, 0, width, height);
    context.save();
    context.beginPath();
    context.roundRect(5, 5, width - 10, height - 10, radius);
    context.clip();
    context.fillStyle = XR_HUD_COLOURS.panelSoft;
    context.fillRect(0, 0, width, height);
    XR_HAND_DISPLAY_CONTROLS.forEach(({ key }, index) => {
      const hovered = hud.hoveredControl === key;
      const pressed = hud.pressedControl === key;
      if (hovered || pressed) {
        context.fillStyle = pressed ? XR_HUD_COLOURS.accentPressed : XR_HUD_COLOURS.accentHover;
        context.fillRect(index * segmentWidth, 0, segmentWidth, height);
      }
      if (this.handDisplaySettings[key] !== "off") {
        context.fillStyle = XR_HUD_COLOURS.accentStrong;
        context.fillRect(index * segmentWidth + 44, 0, segmentWidth - 88, 7);
      }
    });
    context.restore();

    context.beginPath();
    context.roundRect(5, 5, width - 10, height - 10, radius);
    context.strokeStyle = XR_HUD_COLOURS.accentBorderSoft;
    context.lineWidth = 3;
    context.stroke();
    context.strokeStyle = XR_HUD_COLOURS.separator;
    context.lineWidth = 2;
    for (let index = 1; index < XR_HAND_DISPLAY_CONTROLS.length; index += 1) {
      context.beginPath();
      context.moveTo(segmentWidth * index, 28);
      context.lineTo(segmentWidth * index, height - 28);
      context.stroke();
    }

    context.textAlign = "center";
    context.textBaseline = "middle";
    XR_HAND_DISPLAY_CONTROLS.forEach(({ key, label }, index) => {
      const centreX = segmentWidth * (index + .5);
      const value = xrHandDisplayValue(
        this.handDisplaySettings,
        key,
        this.xrTrackingVisuals?.hands?.meshStatus ?? "outline-fallback",
      );
      context.fillStyle = XR_HUD_COLOURS.label;
      context.font = canvasFont("label", 650);
      context.fillText(label, centreX, 55);
      context.fillStyle = this.handDisplaySettings[key] === "off" ? XR_HUD_COLOURS.textDisabled : XR_HUD_COLOURS.textActive;
      context.font = canvasFont("body", 760);
      context.fillText(value, centreX, 111);
    });
    hud.texture.needsUpdate = true;
  }

  private createXrSoloPostAcquisitionHud() {
    const world = this.world;
    if (!world || this.xrSoloPostAcquisitionHud) return;
    this.xrSoloPostAcquisitionHud = new XrPostAcquisitionQualityHud(
      world,
      () => this.syncXrSoloPostAcquisitionClock(),
    );
    this.syncXrSoloPostAcquisitionReticleFrame();
    this.xrSoloPostAcquisitionHud.update(this.soloPostAcquisitionPresentation);
  }

  private syncXrSoloPostAcquisitionReticleFrame() {
    const hud = this.xrSoloPostAcquisitionHud;
    const cameraEdges = this.xrTrackingVisuals?.cameraEdges;
    const cameraWidth = this.captureStatus.selectedCameraWidth;
    const cameraHeight = this.captureStatus.selectedCameraHeight;
    if (!hud
      || !cameraEdges
      || this.liveComposedVideoTrack() === null
      || typeof cameraWidth !== "number"
      || !Number.isFinite(cameraWidth)
      || cameraWidth <= 0
      || typeof cameraHeight !== "number"
      || !Number.isFinite(cameraHeight)
      || cameraHeight <= 0) return;
    const now = performance.now();
    const frame = xrCameraEdgesPresentation(
      cameraEdges.canvas.width,
      cameraEdges.canvas.height,
      cameraWidth / cameraHeight,
      this.xrCameraEdgesShownAt === null ? 0 : now - this.xrCameraEdgesShownAt,
      this.prefersReducedMotion(),
    );
    hud.setReticleFrame(
      frame,
      cameraEdges.canvas.width,
      cameraEdges.canvas.height,
    );
  }

  private stopXrSoloPostAcquisitionClock() {
    const frame = this.xrSoloPostAcquisitionFrame;
    const session = this.xrSoloPostAcquisitionFrameSession;
    this.xrSoloPostAcquisitionFrame = null;
    this.xrSoloPostAcquisitionFrameSession = null;
    if (frame === null || !session) return;
    try {
      session.cancelAnimationFrame(frame);
    } catch {
      // The session may already have ended while its presentation frame was pending.
    }
  }

  private syncXrSoloPostAcquisitionClock() {
    const hud = this.xrSoloPostAcquisitionHud;
    const session = this.xrSession as XRSession | null;
    const recorderLoopDrivesPresentation = this.sensorLoopRunning
      && !usesSyntheticSensorSource();
    const shouldSchedule = !this.disposed
      && hud?.needsXrFrame === true
      && session !== null
      && typeof session.requestAnimationFrame === "function"
      && !recorderLoopDrivesPresentation;
    if (!shouldSchedule || this.xrSoloPostAcquisitionFrameSession !== session) {
      this.stopXrSoloPostAcquisitionClock();
    }
    if (!shouldSchedule || this.xrSoloPostAcquisitionFrame !== null) return;
    let scheduledFrame = -1;
    scheduledFrame = session.requestAnimationFrame((timestampMs) => {
      if (this.xrSoloPostAcquisitionFrame !== scheduledFrame
        || this.xrSoloPostAcquisitionFrameSession !== session) return;
      this.xrSoloPostAcquisitionFrame = null;
      this.xrSoloPostAcquisitionFrameSession = null;
      if (this.disposed || this.xrSession !== session) return;
      hud.advanceXrFrame(timestampMs);
      this.syncXrSoloPostAcquisitionClock();
    });
    this.xrSoloPostAcquisitionFrame = scheduledFrame;
    this.xrSoloPostAcquisitionFrameSession = session;
  }

  private xrTaskHudControlAt(point: Vector3): XrTaskHudControl | undefined {
    const hud = this.xrTaskHud;
    const controls = xrTaskHudControls(this.snapshot, this.connected);
    if (!hud || controls.length === 0) return undefined;
    const local = hud.group.worldToLocal(point.clone());
    if (Math.abs(local.y - XR_TASK_HUD_CONTROL_CENTRE_Y_M) > XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M / 2) return undefined;
    const canvasX = (local.x / XR_TASK_HUD_WIDTH_M + .5) * hud.canvas.width;
    const left = TASK_HUD_CONTROL_INSET_PX;
    const right = hud.canvas.width - TASK_HUD_CONTROL_INSET_PX;
    const gap = TASK_HUD_CONTROL_GAP_PX;
    if (canvasX < left || canvasX > right) return undefined;
    const buttonWidth = (right - left - gap * (controls.length - 1)) / controls.length;
    for (let index = 0; index < controls.length; index += 1) {
      const buttonLeft = left + index * (buttonWidth + gap);
      if (canvasX >= buttonLeft && canvasX <= buttonLeft + buttonWidth) return controls[index];
    }
    return undefined;
  }

  private startXrTaskHudClock() {
    if (this.taskHudTimer !== null) window.clearInterval(this.taskHudTimer);
    this.renderXrTaskHud();
    this.taskHudTimer = window.setInterval(() => this.renderXrTaskHud(), TASK_HUD_REFRESH_MS);
  }

  private stopXrTaskHudClock() {
    if (this.taskHudTimer !== null) window.clearInterval(this.taskHudTimer);
    this.taskHudTimer = null;
    if (this.taskHudRevealFrame !== null) window.cancelAnimationFrame(this.taskHudRevealFrame);
    this.taskHudRevealFrame = null;
    this.taskHudRevealStartedAt = null;
    this.lastTaskHudAnimationStep = "";
  }

  private prefersReducedMotion() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private announceXrTaskChange() {
    if ((!this.xrCaptureHorizonHud && !this.xrTaskHud) || !this.xrSession) {
      this.renderXrTaskHud();
      return;
    }
    if (this.taskHudRevealFrame !== null) window.cancelAnimationFrame(this.taskHudRevealFrame);
    if (this.prefersReducedMotion()) {
      this.taskHudRevealFrame = null;
      this.taskHudRevealStartedAt = null;
      this.lastTaskHudAnimationStep = "";
      this.renderXrTaskHud();
      return;
    }
    this.taskHudRevealStartedAt = performance.now();
    this.lastTaskHudAnimationStep = "";
    const animate = (now: number) => {
      if (this.prefersReducedMotion()) {
        this.taskHudRevealFrame = null;
        this.taskHudRevealStartedAt = null;
        this.lastTaskHudAnimationStep = "";
        this.renderXrTaskHud();
        return;
      }
      const revealElapsed = this.taskHudRevealStartedAt === null ? 0 : now - this.taskHudRevealStartedAt;
      const animationStep = `${Math.floor(revealElapsed / TASK_HUD_TYPE_INTERVAL_MS)}:${Math.floor(revealElapsed / 140)}`;
      if (animationStep !== this.lastTaskHudAnimationStep) {
        this.lastTaskHudAnimationStep = animationStep;
        this.renderXrTaskHud();
      }
      const task = this.snapshot ? this.configuration.tasks[this.snapshot.run.activeTaskIndex] : undefined;
      const description = task?.instructions && task.instructions !== "--"
        ? task.instructions
        : this.configuration.runDescription || this.configuration.runTitle || "";
      const duration = Math.max(TASK_HUD_BLINK_MS, description.length * TASK_HUD_TYPE_INTERVAL_MS + 420);
      if (this.taskHudRevealStartedAt !== null && now - this.taskHudRevealStartedAt < duration) {
        this.taskHudRevealFrame = window.requestAnimationFrame(animate);
        return;
      }
      this.taskHudRevealFrame = null;
      this.taskHudRevealStartedAt = null;
      this.lastTaskHudAnimationStep = "";
      this.renderXrTaskHud();
    };
    this.taskHudRevealFrame = window.requestAnimationFrame(animate);
  }

  private createXrCaptureHorizonPresentation(): XrCaptureHorizonHudPresentation {
    if (this.bridge) return {
      identity: "Bridge",
      upload: null,
      menuAvailable: false,
      retreadAvailable: false,
      task: {
        state: this.bridge.streaming ? "Streaming" : "Connecting",
        title: this.bridge.label,
        description: this.bridge.status,
        timing: "",
        stateTone: this.bridge.streaming ? "success" : "action",
      },
      progress: [],
      runControls: [],
      handControls: XR_HAND_DISPLAY_CONTROLS.map(({ key, label }) => ({
        key, label,
        value: xrHandDisplayValue(this.handDisplaySettings, key, this.xrTrackingVisuals?.hands?.meshStatus ?? "outline-fallback"),
        enabled: true,
        selected: this.handDisplaySettings[key] !== "off",
      })),
    };
    const snapshot = this.snapshot;
    const tasks = this.configuration.tasks;
    const taskIndex = Math.min(
      snapshot?.run.activeTaskIndex ?? 0,
      Math.max(0, tasks.length - 1),
    );
    const task = tasks[taskIndex];
    const run = snapshot?.run;
    const now = Date.now();
    const timing = snapshot ? xrTaskHudTiming(snapshot, now) : null;
    const hud = snapshot ? xrTaskHudRunPresentation(snapshot, now) : null;
    const state = runStatePresentation(snapshot, this.connected, now);
    const taskDescription = run?.phase === "active-task"
      && task?.instructions
      && task.instructions !== "--"
      ? task.instructions
      : state.detail;
    const workProgress = cycleWorkProgress(
      run?.cycle ?? 1,
      run?.phase === "cycle-pause"
        ? tasks.length
        : Math.max(0, run?.activeTaskIndex ?? 0),
      tasks.length,
      this.configuration.totalCycles,
    );
    const taskProgress = run?.phase === "cycle-pause"
      ? 1
      : timing?.taskProgress ?? 0;
    const finalisation = recorderFinalisationProgress(
      this.captureStatus,
      run?.recordingState === "stopping" || this.recordingFinalising,
    );

    const controls = xrTaskHudControls(
      snapshot,
      this.connected,
    ).map((control) => xrCaptureHorizonRunControlPresentation(control, {
      operatingMode: snapshot?.operatingMode === "solo" ? "solo" : "paired",
      soloStartAvailable: this.onSoloStartRun !== null,
    }));
    const stripTiming = finalisation?.label
      ?? hud?.timing
      ?? (timing?.leftMs !== null && timing?.leftMs !== undefined
        ? `Left ${formatDuration(timing.leftMs)}`
        : `Rep ${formatDuration(timing?.takeMs ?? 0)}`);

    return {
      identity: snapshot?.operatingMode === "solo" ? "Solo capture" : "Demonstrator",
      upload: this.soloUploadStatus
        ? {
            stage: this.soloUploadStatus.stage,
            label: this.soloUploadStatus.label,
            value: this.soloUploadStatus.progress,
          }
        : null,
      menuAvailable: snapshot?.operatingMode === "solo"
        && this.onSoloReconfigure !== null
        && snapshot.run.status !== "running"
        && snapshot.run.recordingState === "idle",
      retreadAvailable: snapshot?.operatingMode === "solo"
        && this.onSoloRetread !== null
        && snapshot.run.status === "complete"
        && snapshot.run.recordingState === "idle",
      task: {
        state: hud
          ? hud.state === "open" ? `OPEN  ${hud.metrics}` : hud.metrics
          : state.stateLabel,
        title: state.title,
        description: taskDescription,
        timing: stripTiming,
        stateTone: finalisation || hud?.state === "pause" ? "warning" : "action",
        timingTone: finalisation ? "warning" : hud?.timingTone,
      },
      progress: finalisation
        ? [{ label: finalisation.label, value: finalisation.value }]
        : hud
          ? [{ label: "Run", value: hud.runProgress }]
        : taskProgress !== null
          ? [{ label: "Task", value: taskProgress }]
          : [{ label: "Run", value: workProgress }],
      runControls: controls,
      handControls: XR_HAND_DISPLAY_CONTROLS.map(({ key, label }) => ({
        key,
        label,
        value: xrHandDisplayValue(
          this.handDisplaySettings,
          key,
          this.xrTrackingVisuals?.hands?.meshStatus ?? "outline-fallback",
        ),
        enabled: true,
        selected: this.handDisplaySettings[key] !== "off",
      })),
    };
  }

  private renderXrTaskHud() {
    this.syncCaptureControllerInputPolicy();
    if (this.bridge) {
      this.renderXrReticleOverlay();
      this.xrCaptureHorizonHud?.update(this.createXrCaptureHorizonPresentation());
      return;
    }
    const snapshot = this.snapshot;
    const nowMs = Date.now();
    this.playDemonstratorAudioCues(this.demonstratorAudioCueScheduler?.observePauseCountdown(snapshot, nowMs) ?? []);
    this.playDemonstratorAudioCues(this.demonstratorAudioCueScheduler?.observeTimedTaskCountdown(snapshot, nowMs) ?? []);
    const tasks = this.configuration.tasks;
    const taskIndex = Math.min(snapshot?.run.activeTaskIndex ?? 0, Math.max(0, tasks.length - 1));
    const task = tasks[taskIndex];
    const run = snapshot?.run;
    if (this.mountedRoot) this.mountedRoot.dataset.xrTaskHudState = !this.connected ? "offline" : task ? run?.status ?? "assigned" : "hidden";
    const recording = run?.recordingState === "recording";
    const recordingPaused = run?.recordingState === "paused";
    const recordingFinalising = run?.recordingState === "stopping";
    const recordingTapeVisible = recording || recordingPaused || recordingFinalising;
    const writing = recordingFinalising || recorderWriteIndicatorVisible(
      this.captureStatus.recorderPendingBlocks,
      performance.now(),
      this.recorderQueueDrainedAt,
    );
    if (this.mountedRoot) {
      this.mountedRoot.dataset.xrRecordingState = run?.recordingState ?? "idle";
      this.mountedRoot.dataset.xrSavingIndicator = String(writing);
      this.mountedRoot.dataset.xrUploadStage = this.soloUploadStatus?.stage ?? "idle";
      this.mountedRoot.dataset.xrUploadDetail = this.soloUploadStatus?.detail ?? "";
      this.mountedRoot.dataset.xrUploadProgress = this.soloUploadStatus?.progress === null
        || this.soloUploadStatus?.progress === undefined
        ? ""
        : String(this.soloUploadStatus.progress);
    }
    this.renderXrReticleOverlay();
    if (this.xrCaptureHorizonHud) {
      this.xrCaptureHorizonHud.update(this.createXrCaptureHorizonPresentation());
      if (task && this.hasConfiguredTask(task)) this.acknowledgeDirectTaskPresentation(
        task.id,
        run?.status === "running" && run.phase === "active-task" ? "active" : "assigned",
      );
    }
    const hud = this.xrTaskHud;
    if (!hud) return;
    const context = hud.canvas.getContext("2d")!;
    const { width, height } = hud.canvas;
    context.clearRect(0, 0, width, height);

    const controls = xrTaskHudControls(snapshot, this.connected);
    if (!controls.some((control) => control.action === hud.hoveredControl)) hud.hoveredControl = null;
    const hasTask = this.hasConfiguredTask(task);
    if (!hasTask && !hud.interacting) {
      hud.material.opacity = 0;
      hud.frameMaterial.opacity = 0;
      hud.texture.needsUpdate = true;
      return;
    }
    const episode = snapshot?.currentEpisode;
    const offlineActiveRun = !this.connected && run?.status === "running";
    const timing = snapshot ? xrTaskHudTiming(snapshot) : null;
    const elapsedMs = timing?.recordingMs ?? 0;
    const takeElapsed = timing?.takeMs ?? 0;
    const recordedFrames = Math.max(episode?.frameCount ?? 0, (snapshot?.captureStatus.recorderFrameIndex ?? -1) + 1);
    const taskDurationMs = task?.type === "timed" ? task.durationS * 1_000 : null;
    const taskRemaining = timing?.leftMs ?? null;
    const remaining = taskRemaining === null ? "--:--" : formatDuration(taskRemaining);
    const defaultTaskDescription = hasTask && task?.instructions && task.instructions !== "--"
      ? task.instructions
      : hasTask && this.configuration.runDescription
        ? this.configuration.runDescription
        : hasTask
          ? this.configuration.runTitle || task?.label || "Open task"
        : "Waiting for the capture director";
    const presentation = runStatePresentation(snapshot, this.connected);
    const taskDescription = run?.phase === "cycle-pause"
      ? `CYCLE ${run.cycle}/${this.configuration.totalCycles} COMPLETE`
      : this.connected && run?.status === "running" && run.phase === "active-task" && run.recordingState !== "paused"
        ? defaultTaskDescription
        : presentation.detail;
    const revealElapsed = this.taskHudRevealStartedAt === null ? null : performance.now() - this.taskHudRevealStartedAt;
    const visibleDescription = revealElapsed === null
      ? taskDescription
      : taskDescription.slice(0, Math.max(0, Math.floor(revealElapsed / TASK_HUD_TYPE_INTERVAL_MS)));
    hud.material.opacity = hasTask ? XR_TASK_HUD_PANEL_OPACITY : .82;
    hud.frameMaterial.opacity = hud.interacting ? .62 : .32;
    context.save();
    context.fillStyle = XR_HUD_COLOURS.panel;
    context.fillRect(16, 16, width - 32, height - 32);
    context.strokeStyle = XR_HUD_COLOURS.accentBorder;
    context.lineWidth = 2;
    context.strokeRect(16, 16, width - 32, height - 32);

    context.fillStyle = XR_HUD_ACCENT;
    context.font = canvasFont("label", 550);
    context.textAlign = "left";
    context.fillText(!this.connected
      ? offlineActiveRun
        ? (task?.id || "ACTIVE RUN").toUpperCase()
        : "NO ACTIVE RUN"
      : hasTask ? (task?.id || `task-${String(taskIndex + 1).padStart(3, "0")}`).toUpperCase() : "NO TASK", 48, 58);
    context.textAlign = "right";
    if (recordingTapeVisible) {
      context.fillStyle = XR_HUD_COLOURS.recording;
      if (this.recordingIcon.complete) {
        context.save();
        context.filter = "invert(58%) sepia(79%) saturate(1699%) hue-rotate(313deg) brightness(103%) contrast(101%)";
        context.drawImage(this.recordingIcon, width - 378, 27, 42, 42);
        context.restore();
      } else {
        context.beginPath();
        context.arc(width - 354, 49, 10, 0, Math.PI * 2);
        context.fill();
      }
      context.font = canvasFont("body", 780);
      context.fillText(`${recordingPaused ? "PAUSED" : recordingFinalising ? "FINALISING" : "REC"}  ${formatDuration(elapsedMs)}  ${recordedFrames} F`, width - 48, 60);
      context.font = canvasFont("label", 550);
    } else {
      context.fillStyle = this.connected ? XR_HUD_COLOURS.connected : XR_HUD_COLOURS.disconnected;
      context.fillText(this.connected ? "Live" : "Offline", width - 48, 58);
    }
    const slowHands = this.latestHandSpeed?.leftWarning && this.latestHandSpeed.rightWarning
      ? "BOTH"
      : this.latestHandSpeed?.leftWarning ? "LEFT" : this.latestHandSpeed?.rightWarning ? "RIGHT" : null;
    context.fillStyle = slowHands || recording || recordingPaused || !this.connected ? XR_HUD_COLOURS.recording : XR_HUD_ACCENT;
    context.fillRect(16, 38, 7, height - 76);
    context.strokeStyle = XR_HUD_COLOURS.separator;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(48, 78);
    context.lineTo(width - 48, 78);
    context.stroke();

    const uploadStatus = this.soloUploadStatus;
    const uploading = uploadStatus !== null;
    if (uploading || (writing && Math.floor(performance.now() / 420) % 2 === 0)) {
      context.fillStyle = XR_HUD_COLOURS.readySoft;
      context.textAlign = "right";
      if (uploading) {
        const uploadLabel = uploadStatus.label.toUpperCase();
        context.font = canvasFont("label", 620);
        const arrowX = Math.max(48, width - 64 - context.measureText(uploadLabel).width - 28);
        context.lineWidth = 4;
        context.lineCap = "round";
        context.strokeStyle = XR_HUD_COLOURS.readySoft;
        context.beginPath();
        context.moveTo(arrowX, 108);
        context.lineTo(arrowX, 87);
        context.moveTo(arrowX - 8, 95);
        context.lineTo(arrowX, 87);
        context.lineTo(arrowX + 8, 95);
        context.stroke();
        context.fillText(uploadLabel, width - 48, 101);
      } else {
        context.font = canvasFont("label", 720);
        context.fillText("SAVING", width - 48, 101);
      }
    }
    const voiceUnavailable = this.runtimeFeaturesLoaded && !this.localVoiceCommandRecognitionEnabled();
    const voiceState = voiceUnavailable
      ? "VOICE UNAVAILABLE"
      : this.localVoiceCommandStatus === "ready"
        ? "VOICE READY"
        : this.localVoiceCommandStatus === "fallback"
          ? "VOICE READY CPU"
          : this.localVoiceCommandStatus === "error"
            ? "VOICE UNAVAILABLE"
            : "VOICE LOADING";
    if (!writing && !uploading) {
      context.fillStyle = voiceUnavailable
        ? XR_HUD_COLOURS.textDisabled
        : this.localVoiceCommandStatus === "error"
        ? XR_HUD_COLOURS.recordingSoft
        : XR_HUD_COLOURS.readySoft;
      context.font = canvasFont("label", 650);
      context.textAlign = "right";
      context.fillText(voiceState, width - 48, 101);
    }

    context.fillStyle = XR_HUD_COLOURS.textStrong;
    context.font = canvasFont("title");
    context.textAlign = "left";
    this.drawXrWrappedText(context, visibleDescription, 48, 132, width - 96, 48, 3);

    const reducedMotion = this.prefersReducedMotion();
    const completion = this.taskCompletionOverlay;
    const completionElapsed = completion ? performance.now() - completion.startedAt : Number.POSITIVE_INFINITY;
    if (completion && completionElapsed <= TASK_COMPLETION_OVERLAY_MS) {
      const completionAnimationElapsed = reducedMotion ? 0 : completionElapsed;
      const completionOpacity = reducedMotion
        ? 1
        : Math.min(1, completionElapsed / 140) * Math.min(1, (TASK_COMPLETION_OVERLAY_MS - completionElapsed) / 420);
      context.save();
      context.globalAlpha = completionOpacity;
      context.fillStyle = semanticColours.text;
      context.textAlign = "center";
      context.font = canvasFont("label", 760);
      context.fillText("COMPLETED", width / 2, 142);
      context.font = canvasFont("title", 780);
      this.drawXrWrappedText(context, completion.label, width / 2, 205, width - 144, 44, 2);
      context.fillStyle = colourWithAlpha(semanticColours.accent, .42);
      for (let index = 0; index < 4; index += 1) {
        const phase = completionAnimationElapsed / 360 + index * 1.7;
        const sparkleX = width / 2 + Math.cos(phase) * (205 + index * 22);
        const sparkleY = 156 + Math.sin(phase * 1.3) * (42 + index * 5);
        const sparkleSize = 3 + (1 + Math.sin(phase * 2)) * 2;
        context.beginPath();
        context.moveTo(sparkleX, sparkleY - sparkleSize);
        context.lineTo(sparkleX + sparkleSize * .34, sparkleY - sparkleSize * .34);
        context.lineTo(sparkleX + sparkleSize, sparkleY);
        context.lineTo(sparkleX + sparkleSize * .34, sparkleY + sparkleSize * .34);
        context.lineTo(sparkleX, sparkleY + sparkleSize);
        context.lineTo(sparkleX - sparkleSize * .34, sparkleY + sparkleSize * .34);
        context.lineTo(sparkleX - sparkleSize, sparkleY);
        context.lineTo(sparkleX - sparkleSize * .34, sparkleY - sparkleSize * .34);
        context.closePath();
        context.fill();
      }
      context.restore();
    } else if (completion) {
      this.taskCompletionOverlay = null;
    }

    const buttonHeight = height * XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M / XR_TASK_HUD_HEIGHT_M;
    const buttonTop = height - height * XR_TASK_HUD_CONTROL_BOTTOM_INSET_M / XR_TASK_HUD_HEIGHT_M - buttonHeight;
    context.strokeStyle = XR_HUD_COLOURS.separator;
    context.beginPath();
    context.moveTo(48, buttonTop - 54);
    context.lineTo(width - 48, buttonTop - 54);
    context.stroke();
    context.fillStyle = recording || recordingPaused ? XR_HUD_COLOURS.recordingSoft : XR_HUD_COLOURS.readySoft;
    context.font = canvasFont("label");
    const repetitions = task && isRepetitionTask(task) ? Math.max(1, task.repeatCount) : 1;
    const resetRemaining = run?.resetDeadlineMs === null || run?.resetDeadlineMs === undefined
      ? null
      : formatDuration(run.resetDeadlineMs - Date.now());
    const metrics = !this.connected
      ? offlineActiveRun
        ? recording
          ? "DIRECTOR OFFLINE - RECORDING LOCALLY"
          : recordingPaused
            ? "DIRECTOR OFFLINE - PAUSED LOCALLY"
            : "DIRECTOR OFFLINE - RUN CONTROLS LOCKED"
        : "WAITING FOR CAPTURE DIRECTOR"
      : hasTask && task
      ? task.type === "pause"
        ? `C${run?.cycle ?? 1}/${this.configuration.totalCycles}  T${taskIndex + 1}/${tasks.length}  PAUSE  ${resetRemaining ?? `${task.durationS} S`}`
        : `C${run?.cycle ?? 1}/${this.configuration.totalCycles}  T${taskIndex + 1}/${tasks.length}  R${run?.repetition ?? 1}/${repetitions}`
      : "Move a pointer to any edge to position this panel";
    const runLabel = presentation.stateLabel;
    context.fillText(`${runLabel}  ${metrics}`, 48, buttonTop - 22);
    context.textAlign = "right";
    context.fillStyle = XR_HUD_COLOURS.textSoft;
    context.fillText(`LEFT ${remaining}  SESS ${formatDuration(timing?.sessionMs ?? 0)}  REP ${formatDuration(takeElapsed)}`, width - 48, buttonTop - 22);

    const gap = TASK_HUD_CONTROL_GAP_PX;
    const controlsLeft = TASK_HUD_CONTROL_INSET_PX;
    const controlsWidth = width - controlsLeft - TASK_HUD_CONTROL_INSET_PX;
    const buttonWidth = controls.length ? (controlsWidth - gap * (controls.length - 1)) / controls.length : 0;
    const controlLabels: Record<XrTaskHudControl["slot"], string> = {
      run: "READY",
      record: "REC",
      retry: "RETRY",
      next: "NEXT",
      pass: "PASS",
      fail: "FAIL",
    };
    const readinessControl = run?.status === "stopped" && controls.length === 1 && controls[0].slot === "run"
      ? controls[0]
      : null;
    if (readinessControl) {
      const readiness = xrTaskHudReadinessPresentation(snapshot, this.connected);
      const hovered = readinessControl.enabled && hud.hoveredControl === readinessControl.action;
      const pressed = readinessControl.enabled && hud.pressedControl === readinessControl.action;
      context.fillStyle = readiness.ready
        ? colourWithAlpha(semanticColours.success, pressed ? .82 : hovered ? .68 : .54)
        : colourWithAlpha(semanticColours.surfaceInteractive, pressed ? 1 : hovered ? .96 : .88);
      context.beginPath();
      context.roundRect(controlsLeft, buttonTop, controlsWidth, buttonHeight, 14);
      context.fill();
      context.strokeStyle = readiness.ready
        ? colourWithAlpha(semanticColours.success, .98)
        : colourWithAlpha(semanticColours.textMuted, .82);
      context.lineWidth = hovered || pressed ? 4 : 2;
      context.stroke();
      context.fillStyle = readinessControl.enabled ? XR_HUD_COLOURS.textStrong : XR_HUD_COLOURS.textDisabled;
      context.textAlign = "center";
      context.font = canvasFont("title", 780);
      context.fillText(readiness.label, width / 2, buttonTop + buttonHeight * .43);
      context.font = canvasFont("body", 650);
      context.fillText(readiness.detail, width / 2, buttonTop + buttonHeight * .76);
    } else controls.forEach((control, index) => {
      const left = controlsLeft + index * (buttonWidth + gap);
      const centreX = left + buttonWidth / 2;
      const centreY = buttonTop + buttonHeight * .39;
      const radius = Math.min(buttonWidth * .30, buttonHeight * .32);
      const hovered = hud.hoveredControl === control.action;
      const pressed = hud.pressedControl === control.action;
      const colours = XR_CONTROL_COLOURS[control.tone];
      context.fillStyle = control.enabled
        ? pressed ? XR_CONTROL_PRESSED : hovered ? colours.hover : colours.fill
        : XR_HUD_COLOURS.disabledFill;
      context.beginPath();
      context.arc(centreX, centreY, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = control.enabled ? colours.outline : XR_HUD_COLOURS.disabledOutline;
      context.lineWidth = (hovered || pressed) && control.enabled ? 4 : 2;
      context.stroke();
      context.fillStyle = control.enabled ? XR_HUD_COLOURS.textStrong : XR_HUD_COLOURS.textDisabled;
      this.drawXrControlIcon(context, control, centreX, centreY, radius * 1.05);
      context.font = canvasFont("label", 650);
      context.textAlign = "center";
      context.fillText(
        control.slot === "run" ? control.label.toUpperCase() : controlLabels[control.slot],
        centreX,
        buttonTop + buttonHeight - 5,
      );
    });

    const progress = timing?.taskProgress ?? xrTaskProgress(takeElapsed, taskDurationMs);
    const completedTaskItems = run?.phase === "cycle-pause" ? tasks.length : Math.max(0, run?.activeTaskIndex ?? 0);
    const workProgress = cycleWorkProgress(
      run?.cycle ?? 1,
      completedTaskItems,
      tasks.length,
      this.configuration.totalCycles,
    );
    if (this.connected) {
      const progressWidth = width - 96;
      context.fillStyle = XR_HUD_COLOURS.progressTrack;
      context.fillRect(48, 18, progressWidth, 7);
      context.fillStyle = semanticColours.accent;
      context.fillRect(width - 48 - progressWidth * workProgress, 18, progressWidth * workProgress, 7);
    }
    const resetDurationMs = run?.phase === "task-pause" && task?.type === "pause"
      ? task.durationS * 1_000
      : run?.phase === "post-task-pause" && task && isRepetitionTask(task)
        ? taskResetDurationMs(task.resetTimeS)
        : null;
    const resetRemainingMs = run?.resetDeadlineMs === null || run?.resetDeadlineMs === undefined
      ? null
      : Math.max(0, run.resetDeadlineMs - Date.now());
    const resetProgress = resetDurationMs && resetRemainingMs !== null
      ? xrTaskProgress(resetDurationMs - resetRemainingMs, resetDurationMs)
      : null;
    if (this.connected && (taskDurationMs !== null || resetProgress !== null)) {
      const progressWidth = width - 96;
      const progressTop = height - 18;
      context.fillStyle = XR_HUD_COLOURS.progressTrack;
      context.fillRect(48, progressTop, progressWidth, 10);
      const visibleProgress = run?.phase === "active-task" ? progress : resetProgress;
      if (visibleProgress !== null) {
        const gradient = context.createLinearGradient(48, 0, width - 48, 0);
        gradient.addColorStop(0, semanticColours.action);
        gradient.addColorStop(.48, semanticColours.accent);
        gradient.addColorStop(1, semanticColours.warning);
        context.fillStyle = gradient;
        context.fillRect(48, progressTop, progressWidth * visibleProgress, 10);
      }
    }
    context.restore();
    hud.texture.needsUpdate = true;
    if (task && hasTask) this.acknowledgeDirectTaskPresentation(
      task.id,
      run?.status === "running" && run.phase === "active-task" ? "active" : "assigned",
    );
  }

  private syncCaptureControllerInputPolicy() {
    const ignored = captureIgnoresControllers(
      Boolean(this.bridge) || this.authority?.kind === "solo",
      this.snapshot?.run.recordingState,
      this.recordingFinalising,
    );
    this.captureControllerInputPolicy?.setIgnoringControllers(ignored);
    if (this.mountedRoot) {
      this.mountedRoot.dataset.xrControllerInput = ignored ? "ignored" : "available";
      this.mountedRoot.dataset.xrControllerMenuInput = this.soloHandTrackingAlertsSuppressed
        ? "held"
        : "released";
    }
  }

  /**
   * True while a held controller is driving the Solo menus. Hand tracking stops
   * for a hand that holds a controller, so the hand-loss alert stands down
   * instead of reporting an interruption the demonstrator did not cause.
   */
  private get soloHandTrackingAlertsSuppressed() {
    return soloSuppressesHandTrackingAlerts(
      Boolean(this.bridge) || this.authority?.kind === "solo",
      this.soloControllerRecognition,
      this.snapshot?.run.recordingState,
      this.recordingFinalising,
    );
  }

  private acknowledgeDirectTaskPresentation(taskId: string, state: "assigned" | "active") {
    if (!this.xrSession || this.captureStatus.xr !== "active" || this.appliedConfigurationRevision < 0) return;
    const signature = `${this.xrPresentationGeneration}:${this.appliedConfigurationRevision}:${taskId}:${state}`;
    const acknowledgement: DirectTaskPresentationAcknowledgement = {
      type: "task-presented",
      revision: this.appliedConfigurationRevision,
      taskId,
      state,
    };
    for (const channel of this.peerControlChannels.values()) {
      if (channel.readyState !== "open"
        || this.taskPresentationByChannel.get(channel) === signature
        || this.pendingTaskPresentationByChannel.get(channel)?.signature === signature) continue;
      this.pendingTaskPresentationByChannel.set(channel, {
        acknowledgement,
        frame: this.xrPresentationFrameCount,
        signature,
      });
    }
  }

  private queueBeamPresentation(channel: RTCDataChannel, deliveryId: string) {
    const pending = this.pendingBeamPresentationByChannel.get(channel);
    if (pending && pending.deliveryId !== deliveryId) this.sendBeamAcknowledgement(channel, pending.deliveryId, "received");
    this.pendingBeamPresentationByChannel.set(channel, { deliveryId, frame: this.xrPresentationFrameCount });
  }

  private sendBeamAcknowledgement(channel: RTCDataChannel, deliveryId: string, state: DirectBeamDeliveryState) {
    if (channel.readyState !== "open") return;
    const acknowledgement: DirectBeamAcknowledgement = { type: "beam-ack", deliveryId, state };
    channel.send(JSON.stringify(acknowledgement));
  }

  private settlePendingBeamPresentations(state: DirectBeamDeliveryState) {
    for (const [channel, pending] of this.pendingBeamPresentationByChannel) {
      this.sendBeamAcknowledgement(channel, pending.deliveryId, state);
    }
    this.pendingBeamPresentationByChannel.clear();
  }

  private flushXrPresentationAcknowledgements() {
    const session = this.xrSession as { visibilityState?: string } | null;
    if (session?.visibilityState !== "visible") return;
    const frame = this.xrPresentationFrameCount;
    if (this.xrBeamHud?.group.visible) {
      for (const [channel, pending] of this.pendingBeamPresentationByChannel) {
        if (frame <= pending.frame) continue;
        this.sendBeamAcknowledgement(channel, pending.deliveryId, "visual-presented");
        this.pendingBeamPresentationByChannel.delete(channel);
      }
    }
    if (this.xrCaptureHorizonHud?.visible || this.xrTaskHud?.group.visible) {
      for (const [channel, pending] of this.pendingTaskPresentationByChannel) {
        if (frame <= pending.frame || channel.readyState !== "open") continue;
        channel.send(JSON.stringify(pending.acknowledgement));
        this.taskPresentationByChannel.set(channel, pending.signature);
        this.pendingTaskPresentationByChannel.delete(channel);
      }
    }
  }

  private drawXrControlIcon(context: CanvasRenderingContext2D, control: XrTaskHudControl, x: number, y: number, size: number) {
    const half = size / 2;
    context.save();
    context.lineWidth = Math.max(3, size * .10);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = context.fillStyle;
    if (control.slot === "run") {
      if (control.action === "stop" || control.action === "finish") context.fillRect(x - half * .55, y - half * .55, half * 1.1, half * 1.1);
      else {
        context.beginPath();
        context.moveTo(x - half * .42, y - half * .68);
        context.lineTo(x + half * .70, y);
        context.lineTo(x - half * .42, y + half * .68);
        context.closePath();
        context.fill();
      }
    } else if (control.slot === "record") {
      if (control.action === "pause") {
        context.fillRect(x - half * .58, y - half * .65, half * .40, half * 1.30);
        context.fillRect(x + half * .18, y - half * .65, half * .40, half * 1.30);
      } else if (control.action === "resume") {
        context.beginPath();
        context.moveTo(x - half * .42, y - half * .68);
        context.lineTo(x + half * .70, y);
        context.lineTo(x - half * .42, y + half * .68);
        context.closePath();
        context.fill();
      } else {
        context.beginPath();
        context.arc(x, y, half * .62, 0, Math.PI * 2);
        context.fill();
      }
    } else if (control.slot === "retry") {
      context.beginPath();
      context.arc(x, y, half * .65, Math.PI * .15, Math.PI * 1.72);
      context.stroke();
      context.beginPath();
      context.moveTo(x - half * .78, y - half * .50);
      context.lineTo(x - half * .82, y + half * .08);
      context.lineTo(x - half * .24, y - half * .02);
      context.closePath();
      context.fill();
    } else if (control.slot === "next") {
      context.beginPath();
      context.moveTo(x - half * .68, y - half * .68);
      context.lineTo(x + half * .34, y);
      context.lineTo(x - half * .68, y + half * .68);
      context.closePath();
      context.fill();
      context.fillRect(x + half * .38, y - half * .68, half * .23, half * 1.36);
    } else if (control.slot === "pass") {
      context.beginPath();
      context.moveTo(x - half * .72, y);
      context.lineTo(x - half * .18, y + half * .52);
      context.lineTo(x + half * .76, y - half * .58);
      context.stroke();
    } else {
      context.beginPath();
      context.moveTo(x - half * .62, y - half * .62);
      context.lineTo(x + half * .62, y + half * .62);
      context.moveTo(x + half * .62, y - half * .62);
      context.lineTo(x - half * .62, y + half * .62);
      context.stroke();
    }
    context.restore();
  }

  private drawXrWrappedText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    let line = "";
    let lineNumber = 0;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        context.fillText(line, x, y + lineNumber * lineHeight);
        lineNumber += 1;
        if (lineNumber === maxLines) return;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line && lineNumber < maxLines) context.fillText(line, x, y + lineNumber * lineHeight);
  }

  private createXrBeamHud() {
    if (!this.world || this.xrBeamHud) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 256;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide });
    const panel = new Mesh(new PlaneGeometry(.74, .185), material);
    panel.frustumCulled = false;
    panel.renderOrder = 1_200;
    const group = new Group();
    group.add(panel);
    group.position.set(0, BEAM_HUD_VERTICAL_OFFSET_M, -BEAM_HUD_DISTANCE_M);
    group.renderOrder = 1_200;
    group.visible = false;
    this.world.createTransformEntity(group, { parent: this.world.cameraEntity, persistent: true });
    this.xrBeamHud = { group, canvas, texture, material };
  }

  private clearXrBeamPresentation() {
    if (this.beamHudTimeout !== null) window.clearTimeout(this.beamHudTimeout);
    this.beamHudTimeout = null;
    this.settlePendingBeamPresentations("received");
  }

  private presentXrBeamHud(text: string) {
    const hud = this.xrBeamHud;
    if (!hud || !this.xrSession) return false;
    this.clearXrBeamPresentation();
    hud.material.opacity = .98;
    this.renderXrBeamHud(text);
    this.beamHudTimeout = window.setTimeout(() => {
      this.settlePendingBeamPresentations("received");
      hud.group.visible = false;
      this.beamHudTimeout = null;
    }, BEAM_DISPLAY_MS);
    return true;
  }

  private renderXrBeamHud(text: string) {
    const hud = this.xrBeamHud;
    if (!hud) return;
    const context = hud.canvas.getContext("2d")!;
    context.clearRect(0, 0, hud.canvas.width, hud.canvas.height);
    context.fillStyle = XR_HUD_COLOURS.panelBeam;
    context.fillRect(0, 0, hud.canvas.width, hud.canvas.height);
    context.strokeStyle = XR_HUD_ACCENT;
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(72, 40);
    context.lineTo(184, 40);
    context.stroke();
    context.fillStyle = XR_HUD_ACCENT;
    context.font = canvasFont("label", 600);
    context.textAlign = "left";
    context.fillText("BEAM", 72, 82);
    context.fillStyle = XR_HUD_COLOURS.textStrong;
    context.font = canvasFont("title");
    this.drawXrWrappedText(context, text.slice(0, 180), 72, 144, hud.canvas.width - 144, 44, 2);
    hud.texture.needsUpdate = true;
  }

  private createXrTrackingVisuals() {
    if (!this.world || this.xrTrackingVisuals) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 600;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const reticle = new Group();
    reticle.name = "ceres-xr-progress-reticle";
    const cameraEdgesCanvas = document.createElement("canvas");
    cameraEdgesCanvas.width = XR_CAMERA_EDGES_CANVAS_SIZE;
    cameraEdgesCanvas.height = XR_CAMERA_EDGES_CANVAS_SIZE;
    const cameraEdgesTexture = new CanvasTexture(cameraEdgesCanvas);
    cameraEdgesTexture.colorSpace = SRGBColorSpace;
    const cameraEdgesMaterial = new MeshBasicMaterial({
      map: cameraEdgesTexture,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const cameraEdgesPanel = new Mesh(new PlaneGeometry(XR_CAMERA_EDGES_PLANE_SIZE_M, XR_CAMERA_EDGES_PLANE_SIZE_M), cameraEdgesMaterial);
    cameraEdgesPanel.name = "ceres-xr-camera-edges";
    cameraEdgesPanel.frustumCulled = false;
    cameraEdgesPanel.renderOrder = 1_099;
    reticle.add(cameraEdgesPanel);
    const panel = new Mesh(new PlaneGeometry(.72, .42), material);
    panel.frustumCulled = false;
    panel.renderOrder = 1_100;
    reticle.add(panel);
    reticle.position.set(0, XR_CAPTURE_CENTRE_Y_M, -XR_CAMERA_EDGES_DISTANCE_M);
    reticle.renderOrder = 1_100;
    reticle.visible = false;
    this.world.createTransformEntity(reticle, { parent: this.world.playerHeadEntity, persistent: true });

    const alertCanvas = document.createElement("canvas");
    alertCanvas.width = 1_360;
    alertCanvas.height = 180;
    const alertTexture = new CanvasTexture(alertCanvas);
    alertTexture.colorSpace = SRGBColorSpace;
    const alertMaterial = new MeshBasicMaterial({
      map: alertTexture,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const alert = new Group();
    alert.name = "ceres-xr-warning-overlay";
    const alertPanel = new Mesh(new PlaneGeometry(XR_TRACKING_ALERT_WIDTH_M, XR_TRACKING_ALERT_HEIGHT_M), alertMaterial);
    alertPanel.name = "ceres-xr-warning-overlay-panel";
    alertPanel.frustumCulled = false;
    alertPanel.renderOrder = 1_110;
    alert.add(alertPanel);
    alert.position.set(XR_TRACKING_ALERT_POSITION.x, XR_TRACKING_ALERT_POSITION.y, XR_TRACKING_ALERT_POSITION.z);
    alert.renderOrder = 1_110;
    alert.visible = false;
    this.world.createTransformEntity(alert, { parent: this.world.playerHeadEntity, persistent: true });

    const visuals: XrTrackingVisuals = {
      reticle,
      canvas,
      texture,
      cameraEdges: { canvas: cameraEdgesCanvas, texture: cameraEdgesTexture },
      alert: { group: alert, canvas: alertCanvas, texture: alertTexture },
      hands: null,
    };
    this.xrTrackingVisuals = visuals;
    this.renderXrReticleOverlay();
    if (this.mountedRoot) this.mountedRoot.dataset.handMeshStatus = "loading";
    void XrHandVisualisation.create().then((hands) => {
      if (this.captureAuthorityRevoked || this.xrTrackingVisuals !== visuals || !this.world) {
        hands.dispose();
        return;
      }
      this.world.createTransformEntity(hands.leftRoot, { parent: this.world.sceneEntity, persistent: true });
      this.world.createTransformEntity(hands.rightRoot, { parent: this.world.sceneEntity, persistent: true });
      visuals.hands = hands;
      if (this.mountedRoot) this.mountedRoot.dataset.handMeshStatus = hands.meshStatus;
      this.renderXrHandDisplayHud();
    });
  }

  private updateXrTrackingVisuals(timestampMs: number, hands: { left: HandState; right: HandState }) {
    const visuals = this.xrTrackingVisuals;
    if (!visuals) return;
    if (this.xrStartupIntro?.isActive) {
      visuals.reticle.visible = false;
      visuals.alert.group.visible = false;
      visuals.hands?.clear();
      return;
    }
    visuals.reticle.visible = xrSessionSurfaceVisible(this.xrSession)
      && !this.xrOperationsMenuOpen;
    const nowMs = performance.now();
    const alertsSuppressed = this.soloHandTrackingAlertsSuppressed;
    if (alertsSuppressed) {
      // Resetting rather than pausing keeps the escalation from resuming
      // part-way through once the controller is put down.
      this.handTrackingAlert.reset();
      this.demonstratorAudioCueScheduler?.suspendHandCues();
    } else {
      this.handTrackingAlert.update(nowMs, hands.left.tracked, hands.right.tracked);
    }
    const missingCues = alertsSuppressed
      ? []
      : this.demonstratorAudioCueScheduler?.observeHands(hands.left.tracked, hands.right.tracked, nowMs) ?? [];
    const missingUrgency = this.handTrackingAlert.presentation(nowMs)?.dangerRatio ?? 0;
    this.playDemonstratorAudioCues(missingCues, missingUrgency);
    if (!visuals.hands) return;
    const managedSimulator = isMetaManagedXr();
    visuals.hands.update({
      timestampMs,
      leftHand: alignManagedSimulatorHandState(hands.left, "left", managedSimulator),
      rightHand: alignManagedSimulatorHandState(hands.right, "right", managedSimulator),
      settings: this.handDisplaySettings,
    });
  }

  private renderXrReticleOverlay() {
    const visuals = this.xrTrackingVisuals;
    if (!visuals) return;
    if (this.xrStartupIntro?.isActive) {
      visuals.reticle.visible = false;
      visuals.alert.group.visible = false;
      return;
    }
    const now = performance.now();
    if (now - this.lastXrReticleRenderAt < TASK_HUD_REFRESH_MS - 1) return;
    this.lastXrReticleRenderAt = now;
    const context = visuals.canvas.getContext("2d")!;
    const { width, height } = visuals.canvas;
    const cameraEdgesContext = visuals.cameraEdges.canvas.getContext("2d")!;
    const cameraEdgesWidth = visuals.cameraEdges.canvas.width;
    const cameraEdgesHeight = visuals.cameraEdges.canvas.height;
    const centreX = width / 2;
    const centreY = height / 2;
    const snapshot = this.snapshot;
    const run = snapshot?.run;
    const timing = snapshot ? xrTaskHudTiming(snapshot) : null;
    const hud = snapshot ? xrTaskHudRunPresentation(snapshot, Date.now()) : null;
    const taskProgress = hud?.taskProgress ?? (run?.phase === "cycle-pause"
      ? 1
      : timing?.taskProgress ?? 0);
    const completedItems = run?.phase === "cycle-pause"
      ? snapshot?.configuration.tasks.length ?? 0
      : Math.max(0, run?.activeTaskIndex ?? 0);
    const workProgress = hud?.runProgress ?? (snapshot
      ? cycleWorkProgress(run?.cycle ?? 1, completedItems, snapshot.configuration.tasks.length, snapshot.configuration.totalCycles)
      : 0);
    context.clearRect(0, 0, width, height);
    cameraEdgesContext.clearRect(0, 0, cameraEdgesWidth, cameraEdgesHeight);
    context.save();
    cameraEdgesContext.save();

    const cameraWidth = this.captureStatus.selectedCameraWidth;
    const cameraHeight = this.captureStatus.selectedCameraHeight;
    const cameraFrameReady = (this.bridge
      ? this.bridgeCameraReady()
      : this.liveComposedVideoTrack() !== null)
      && typeof cameraWidth === "number"
      && Number.isFinite(cameraWidth)
      && cameraWidth > 0
      && typeof cameraHeight === "number"
      && Number.isFinite(cameraHeight)
      && cameraHeight > 0;
    if (cameraFrameReady) {
      if (this.xrCameraEdgesShownAt === null) this.xrCameraEdgesShownAt = now;
      const cameraEdges = xrCameraEdgesPresentation(
        cameraEdgesWidth,
        cameraEdgesHeight,
        cameraWidth / cameraHeight,
        now - this.xrCameraEdgesShownAt,
        this.prefersReducedMotion(),
      );
      this.xrSoloPostAcquisitionHud?.setReticleFrame(
        cameraEdges,
        cameraEdgesWidth,
        cameraEdgesHeight,
      );
      this.xrCaptureHorizonHud?.setAppearanceFramePosition(
        xrCaptureHorizonAppearanceFramePosition(
          cameraEdges,
          cameraEdgesWidth,
          cameraEdgesHeight,
          XR_CAMERA_EDGES_PLANE_SIZE_M,
          XR_CAPTURE_CENTRE_Y_M,
          XR_CAMERA_EDGES_DISTANCE_M,
        ),
      );
      if (this.bridge?.hudMode !== "off") drawXrCameraEdges(cameraEdgesContext, cameraEdges);
      if (this.bridge?.hudMode === "full") drawXrBridgeAttitude(cameraEdgesContext, cameraEdges,
        cameraEdgesWidth, cameraEdgesHeight, this.bridgePitch, this.bridgeRoll);
      if (this.bridge) this.xrCaptureHorizonHud?.setBridgeFrame(cameraEdges, now, this.bridge.paused,
        this.bridge.streaming, this.prefersReducedMotion(), this.bridge.hudMode, this.bridge.audioEnabled);
      const recording = run?.recordingState === "recording"
        && this.captureStatus.recorder === "recording";
      const voice = xrCameraVoiceIndicatorState(
        this.bridge !== null || this.runtimeFeaturesLoaded,
        this.localVoiceCommandRecognitionEnabled(),
        this.localVoiceCommandStatus,
        {
          recognising: this.localVoiceCommandRecognitionStartedAt !== null,
          outcome: this.localVoiceCommandResult
            ? this.localVoiceCommandResult.matched ? "matched" : "unmatched"
            : null,
          outcomeElapsedMs: this.localVoiceCommandResult ? now - this.localVoiceCommandResult.receivedAtMs : undefined,
        },
      );
      const voiceElapsedMs = (voice === "matched" || voice === "unmatched") && this.localVoiceCommandResult
        ? now - this.localVoiceCommandResult.receivedAtMs
        : this.localVoiceCommandRecognitionStartedAt !== null ? now - this.localVoiceCommandRecognitionStartedAt : now;
      const uploading = this.soloUploadStatus !== null;
      if (!this.bridge) drawXrCameraEdgeIndicators(cameraEdgesContext, cameraEdges, {
        recording,
        voice,
        voiceElapsedMs,
        reducedMotion: this.prefersReducedMotion(),
        uploading,
      });
      else if (this.bridge.hudMode !== "off") drawXrVoiceIndicator(cameraEdgesContext, cameraEdges, {
        voice,
        voiceElapsedMs,
        reducedMotion: this.prefersReducedMotion(),
      });
      if (this.mountedRoot) {
        this.mountedRoot.dataset.xrCameraEdgesPhase = cameraEdges.phase;
        this.mountedRoot.dataset.xrCameraRecording = recording ? "recording" : "idle";
        if (this.bridge?.hudMode === "off") this.mountedRoot.dataset.xrCameraVoice = "hidden";
        else this.mountedRoot.dataset.xrCameraVoice = voice;
        this.mountedRoot.dataset.xrCameraUpload = uploading ? "uploading" : "idle";
      }
    } else {
      this.xrCameraEdgesShownAt = null;
      if (this.mountedRoot) {
        this.mountedRoot.dataset.xrCameraEdgesPhase = "hidden";
        this.mountedRoot.dataset.xrCameraRecording = "hidden";
        this.mountedRoot.dataset.xrCameraVoice = "hidden";
        this.mountedRoot.dataset.xrCameraUpload = "hidden";
      }
    }
    cameraEdgesContext.restore();

    if (this.bridge) {
      drawXrBridgeReticle(context, centreX, centreY, this.bridge.videoFps, this.bridge.motionFps,
        this.bridge.streaming, this.bridge.label, this.bridge.paused, this.bridge.hudMode === "off");
      if (this.mountedRoot) {
        this.mountedRoot.dataset.xrBridgeVideoFps = String(Math.round(this.bridge.videoFps));
        this.mountedRoot.dataset.xrBridgeMotionFps = String(Math.round(this.bridge.motionFps));
        this.mountedRoot.dataset.xrBridgeConnected = String(this.bridge.streaming);
        this.mountedRoot.dataset.xrBridgePaused = String(this.bridge.paused);
        this.mountedRoot.dataset.xrBridgeHudMode = this.bridge.hudMode;
      }
    } else drawXrProgressReticle(
      context,
      centreX,
      centreY,
      taskProgress,
      workProgress,
      hud?.centreLines ?? [],
    );

    const slowHands = xrHandSpeedAlertLabel(
      this.latestHandSpeed?.leftWarning === true,
      this.latestHandSpeed?.rightWarning === true,
    );
    const tracking = this.handTrackingAlert.presentation(now);
    const operationalError = xrAlertLabel(this.captureStatus.lastError);
    if (this.localVoiceCommandOverlayNotice && now >= this.localVoiceCommandOverlayNotice.expiresAtMs) {
      this.localVoiceCommandOverlayNotice = null;
    }
    if (this.runControlNotice && now >= this.runControlNotice.expiresAtMs) this.clearRunControlNotice();
    const alert: XrWarningTapePresentation | null = operationalError
      ? { label: operationalError, ...xrTrackingAlertPresentation(run?.startedAtMs !== null && run?.startedAtMs !== undefined) }
      : this.runControlNotice
        ? this.runControlNotice.presentation
      : tracking
        ? tracking
        : this.localVoiceCommandOverlayNotice
          ? this.localVoiceCommandOverlayNotice.presentation
        : slowHands
          ? {
            label: slowHands,
            ...XR_HAND_SPEED_WARNING_PRESENTATION,
          }
          : null;
    this.renderXrTrackingAlert(alert, now);
    context.restore();
    visuals.texture.needsUpdate = true;
    visuals.cameraEdges.texture.needsUpdate = true;
  }

  private renderXrTrackingAlert(alert: XrWarningTapePresentation | null, nowMs: number) {
    const visuals = this.xrTrackingVisuals;
    if (!visuals) return;
    const surface = visuals.alert;
    this.xrTrackingAlertText = alert?.label ?? null;
    const context = surface.canvas.getContext("2d")!;
    const { width, height } = surface.canvas;
    context.clearRect(0, 0, width, height);
    surface.group.visible = Boolean(alert)
      && xrSessionSurfaceVisible(this.xrSession)
      && !this.xrOperationsMenuOpen
      && !this.xrStartupIntro?.isActive;
    if (!alert) {
      surface.texture.needsUpdate = true;
      return;
    }
    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = canvasFont("title", 940);
    const metrics = context.measureText(alert.label);
    const labelWidth = metrics.width;
    const labelHeight = Math.max(
      1,
      metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    );
    const horizontalPadding = Math.max(48, Math.min(112, labelWidth * .11));
    const verticalPadding = Math.max(13, Math.min(28, labelHeight * .20));
    const tapeWidth = Math.min(width, labelWidth + horizontalPadding * 2);
    const tapeHeight = Math.min(height, labelHeight + verticalPadding * 2);
    const tapeLeft = (width - tapeWidth) / 2;
    const tapeTop = (height - tapeHeight) / 2;
    const pulsePhase = (Math.sin((nowMs / alert.pulseIntervalMs) * Math.PI * 2) + 1) / 2;
    const tapeOpacity = alert.tapeOpacity * (.72 + pulsePhase * .28);
    context.fillStyle = colourWithAlpha(
      mixHexColours(semanticColours.warning, semanticColours.danger, alert.dangerRatio),
      tapeOpacity,
    );
    context.fillRect(tapeLeft, tapeTop, tapeWidth, tapeHeight);
    context.globalCompositeOperation = "destination-out";
    context.fillStyle = semanticColours.text;
    context.fillText(alert.label, width / 2, height / 2);
    context.restore();
    surface.texture.needsUpdate = true;
  }

  private readXrHands(xrFrame: any, referenceSpace: any) {
    const hands: XrHandsReadResult = {
      left: emptyHand(),
      right: emptyHand(),
      leftJointPoseCount: 0,
      rightJointPoseCount: 0,
    };
    if (!this.xrSession) return hands;
    for (const source of this.xrSession.inputSources as any[]) {
      const handedness = source.handedness as "left" | "right";
      if (!source.hand || (handedness !== "left" && handedness !== "right")) continue;
      const hand = emptyHand();
      let jointPoseCount = 0;
      for (const jointName of source.hand.keys()) {
        const jointSpace = source.hand.get(jointName);
        const cached = this.bridge?.observations;
        const pose = cached?.hasSample(xrFrame, referenceSpace)
          ? cached.jointPose(handedness, jointName) : jointSpace ? xrFrame.getJointPose(jointSpace, referenceSpace) : null;
        if (!pose) continue;
        hand.joints[jointName] = { ...toTransform(pose.transform), radius: pose.radius };
        jointPoseCount += 1;
      }
      hand.tracked = jointPoseCount > 0;
      const thumb = hand.joints["thumb-tip"]?.position;
      const index = hand.joints["index-finger-tip"]?.position;
      hand.pinch = thumb && index ? Math.hypot(thumb.x - index.x, thumb.y - index.y, thumb.z - index.z) : 0;
      hands[handedness] = hand;
      if (handedness === "left") hands.leftJointPoseCount += jointPoseCount;
      else hands.rightJointPoseCount += jointPoseCount;
    }
    return hands;
  }

  private bindXrEvents(root: HTMLElement) {
    const world = this.world;
    if (!world) return;
    this.unbindXrEvents();
    const xr = world.renderer.xr;
    const sessionStartHandler = () => {
      if (this.disposed) return;
      this.xrPresentationGeneration += 1;
      this.xrSession = xr.getSession();
      this.xrReferenceSpace = xr.getReferenceSpace();
      if (!this.xrSession || !this.xrReferenceSpace) {
        return;
      }
      if (!this.bridge && this.authority.kind !== "solo") this.directedDepth.startSession(this.xrSession, world.renderer);
      this.bindSoloHandRecognition(root);
      this.stopSensorLoop();
      if (!this.bridge && usesSyntheticSensorSource() && usesHeadlessTestRendering()) world.renderer.setAnimationLoop(null);
      this.xrWorkspace?.setSessionActive(false);
      this.localVoiceCommandOverlayPending = this.localVoiceCommands !== null
        || this.localVoiceCommandStatus === "error";
      this.xrCameraEdgesShownAt = null;
      root.dataset.xrCameraEdgesPhase = "hidden";
      root.dataset.xrStartupIntro = "loading";
      this.xrStartupIntro?.start(() => {
        if (this.disposed || !this.xrSession) return;
        root.dataset.xrStartupIntro = "complete";
        this.xrCameraEdgesShownAt = performance.now();
        this.renderXrReticleOverlay();
        this.xrWorkspace?.setSessionActive(true);
        if (this.localVoiceCommandOverlayPending) this.showLocalVoiceCommandOverlay();
        this.applyXrSurfaceVisibility();
      });
      this.bindXrSessionVisibility(this.xrSession as XRSession);
      this.startXrStartupIntroClock(root);
      this.applyXrSurfaceVisibility();
      if (this.lastBeamText) this.presentXrBeamHud(this.lastBeamText);
      if (!this.bridge) this.startXrTaskHudClock();
      this.captureAuthorityGranted = false;
      this.captureXrAuthorityRequested = false;
      this.markCaptureXrActive();
      if (!this.bridge) this.setStatus(root, "XR opened. Securing capture authority before data collection starts.");
    };
    const sessionEndHandler = () => {
      if (this.disposed) return;
      this.bridge?.stop();
      this.directedDepth?.stopSession();
      this.pauseActiveCaptureForXrExit(root);
      this.stopSensorLoop();
      this.stopXrStartupIntroClock();
      this.unbindXrSessionVisibility();
      this.unbindSoloHandRecognition();
      this.soloHandRecognition = { left: false, right: false };
      this.soloControllerRecognition = { left: false, right: false };
      this.xrSession = null;
      this.localVoiceCommandResult = null;
      this.clearRunControlNotice();
      this.xrReferenceSpace = null;
      root.dataset.xrStartupIntro = "idle";
      this.xrOperationsMenuOpen = false;
      this.xrCameraEdgesShownAt = null;
      root.dataset.xrCameraEdgesPhase = "hidden";
      this.xrTrackingAlertText = null;
      this.localVoiceCommandOverlayNotice = null;
      this.localVoiceCommandOverlayPending = this.localVoiceCommands !== null
        || this.localVoiceCommandStatus === "error";
      root.dataset.xrSurface = "capture";
      this.captureXrAuthorityRequested = false;
      this.handTrackingAlert.reset();
      this.demonstratorAudioCueScheduler?.reset();
      this.stopXrTaskHudClock();
      this.xrStartupIntro?.cancel();
      if (this.xrBeamHud) this.xrBeamHud.group.visible = false;
      if (this.xrTrackingVisuals) {
        this.xrTrackingVisuals.alert.group.visible = false;
        this.xrTrackingVisuals.hands?.clear();
      }
      this.xrWorkspace?.setSessionActive(false);
      this.applyXrSurfaceVisibility();
      this.updateCaptureStatus(root, {
        xr: "ended",
        sensorSource: "none",
        handTracking: "waiting",
        leftHandTracked: false,
        rightHandTracked: false,
        sensorRateHz: 0,
      });
      this.setStatus(root, "XR session ended");
    };
    this.xrEventSource = xr;
    this.xrSessionStartHandler = sessionStartHandler;
    this.xrSessionEndHandler = sessionEndHandler;
    xr.addEventListener("sessionstart", sessionStartHandler);
    xr.addEventListener("sessionend", sessionEndHandler);
  }

  private unbindXrEvents() {
    this.directedDepth?.stopSession();
    if (this.xrEventSource && this.xrSessionStartHandler) this.xrEventSource.removeEventListener("sessionstart", this.xrSessionStartHandler);
    if (this.xrEventSource && this.xrSessionEndHandler) this.xrEventSource.removeEventListener("sessionend", this.xrSessionEndHandler);
    this.unbindXrSessionVisibility();
    this.unbindSoloHandRecognition();
    this.xrEventSource = null;
    this.xrSessionStartHandler = null;
    this.xrSessionEndHandler = null;
  }

  private bindXrSessionVisibility(session: XRSession) {
    this.unbindXrSessionVisibility();
    const handler = () => {
      if (this.disposed || this.xrSession !== session) return;
      this.applyXrSurfaceVisibility();
    };
    this.xrSessionVisibilityEventSource = session;
    this.xrSessionVisibilityChangeHandler = handler;
    session.addEventListener("visibilitychange", handler);
  }

  private unbindXrSessionVisibility() {
    if (this.xrSessionVisibilityEventSource && this.xrSessionVisibilityChangeHandler) {
      this.xrSessionVisibilityEventSource.removeEventListener(
        "visibilitychange",
        this.xrSessionVisibilityChangeHandler,
      );
    }
    this.xrSessionVisibilityEventSource = null;
    this.xrSessionVisibilityChangeHandler = null;
  }

  private bindSoloHandRecognition(root: HTMLElement) {
    if ((!this.bridge && this.authority.kind !== "solo") || !this.xrSession) return;
    this.unbindSoloHandRecognition();
    const session = this.xrSession;
    const handler = () => this.refreshSoloHandRecognition(root);
    this.xrInputSourcesChangeHandler = handler;
    session.addEventListener("inputsourceschange", handler);
    this.refreshSoloHandRecognition(root, true);
  }

  private unbindSoloHandRecognition() {
    if (this.xrSession && this.xrInputSourcesChangeHandler) {
      this.xrSession.removeEventListener("inputsourceschange", this.xrInputSourcesChangeHandler);
    }
    this.xrInputSourcesChangeHandler = null;
  }

  private refreshSoloHandRecognition(root: HTMLElement, force = false) {
    if (!this.bridge && this.authority.kind !== "solo") return;
    const recognition = recogniseXrHands(this.xrSession?.inputSources);
    const controllers = recogniseXrControllers(this.xrSession?.inputSources);
    const controllersChanged = controllers.left !== this.soloControllerRecognition.left
      || controllers.right !== this.soloControllerRecognition.right;
    if (controllersChanged) {
      this.soloControllerRecognition = controllers;
      this.syncCaptureControllerInputPolicy();
    }
    const changed = force
      || recognition.left !== this.soloHandRecognition.left
      || recognition.right !== this.soloHandRecognition.right;
    if (!changed) return;
    this.soloHandRecognition = recognition;
    this.updateCaptureStatus(root, {
      handTracking: recognition.left || recognition.right ? "active" : "waiting",
      leftHandTracked: recognition.left,
      rightHandTracked: recognition.right,
      lastError: this.captureStatus.lastError === "Solo capture interrupted: recognised left and right hands are required"
        ? null
        : this.captureStatus.lastError,
    });
    if (this.captureAuthorityGranted && !this.sensorLoopRunning) this.beginXrSensorLoop(root);
  }

  private stopSensorLoop() {
    this.sensorLoopRunning = false;
    this.sensorLoopFailureReported = false;
    if (this.simulatedSensorFrame !== null) window.cancelAnimationFrame(this.simulatedSensorFrame);
    this.simulatedSensorFrame = null;
    if (this.xrSensorFrame !== null && this.xrSession?.cancelAnimationFrame) this.xrSession.cancelAnimationFrame(this.xrSensorFrame);
    this.xrSensorFrame = null;
    this.lastSimulatedRecorderAt = Number.NEGATIVE_INFINITY;
    this.syncXrSoloPostAcquisitionClock();
  }

  private startXrStartupIntroClock(root: HTMLElement) {
    this.stopXrStartupIntroClock();
    const session = this.xrSession;
    if (!session || !this.xrStartupIntro?.isActive) return;
    const nextFrame = (timestamp: number) => {
      this.xrStartupIntroFrame = null;
      if (this.disposed || this.xrSession !== session || !this.xrStartupIntro?.isActive) return;
      this.xrStartupIntro.advance(timestamp);
      if (this.xrStartupIntro?.isActive) {
        this.xrStartupIntroFrame = session.requestAnimationFrame(nextFrame);
      } else {
        this.applyXrSurfaceVisibility();
      }
    };
    this.xrStartupIntroFrame = session.requestAnimationFrame(nextFrame);
  }

  private stopXrStartupIntroClock() {
    if (this.xrStartupIntroFrame !== null && this.xrSession?.cancelAnimationFrame) {
      this.xrSession.cancelAnimationFrame(this.xrStartupIntroFrame);
    }
    this.xrStartupIntroFrame = null;
  }

  private resetXrWorldAfterFailedLaunch(world: any) {
    if (this.world && this.world !== world) {
      this.disposeXrWorld(world);
      return;
    }
    this.stopSensorLoop();
    this.stopXrStartupIntroClock();
    this.stopXrSoloPostAcquisitionClock();
    this.stopXrTaskHudClock();
    this.unbindXrEvents();
    this.captureControllerInputPolicy?.dispose();
    this.captureControllerInputPolicy = null;
    this.xrSession = null;
    this.xrReferenceSpace = null;
    this.xrTrackingVisuals?.hands?.dispose();
    this.xrTrackingVisuals = null;
    try {
      this.xrWorkspace?.unmount();
    } catch {
      // Continue releasing the failed world when an optional workspace cannot unmount.
    }
    try {
      this.xrCaptureHorizonHud?.dispose();
    } catch {
      // The world may already have released a partially constructed HUD entity.
    }
    this.xrCaptureHorizonHud = null;
    try {
      this.xrStartupIntro?.dispose();
    } catch {
      // The world may already have released a partially constructed intro entity.
    }
    this.xrStartupIntro = null;
    this.xrTaskHud = null;
    this.xrHandDisplayHud = null;
    this.xrBeamHud = null;
    try {
      this.xrSoloPostAcquisitionHud?.dispose();
    } catch {
      // The world may already have released a partially constructed quality entity.
    }
    this.xrSoloPostAcquisitionHud = null;
    this.restoreXrRendererResize?.();
    this.restoreXrRendererResize = null;
    this.world = null;
    this.disposeXrWorld(world);
  }

  private disposeXrWorld(world: any) {
    const renderer = world.renderer;
    try {
      renderer.setAnimationLoop(null);
    } catch {
      // Continue releasing the remaining world resources.
    }
    for (const system of [...world.getSystems()].reverse()) {
      try {
        world.unregisterSystem(system.constructor);
      } catch {
        // A system may already have been stopped by XR session shutdown.
      }
    }
    try {
      world.input?.destroy();
    } catch {
      // Input teardown is best effort after all systems have stopped.
    }
    disposeObject3DResources(world.scene);
    world.scene.clear();
    try {
      renderer.xr.dispose();
    } catch {
      // The XR manager may already be disposed after session shutdown.
    }
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement?.remove();
  }

  private beginXrSensorLoop(root: HTMLElement) {
    if (this.disposed
      || this.captureAuthorityRevoked
      || this.sensorLoopRunning
      || !this.xrSession
      || !this.xrReferenceSpace) return;
    this.sensorLoopRunning = true;
    this.sensorLoopFailureReported = false;
    this.sensorWindowStart = performance.now();
    this.lastSimulatedRecorderAt = Number.NEGATIVE_INFINITY;
    this.syncXrSoloPostAcquisitionClock();
    if (usesSyntheticSensorSource() && !this.bridge) {
      const nextSimulatedFrame = (displayTime: number) => {
        this.simulatedSensorFrame = null;
        if (this.disposed || this.captureAuthorityRevoked || !this.sensorLoopRunning || !this.xrSession || !this.xrReferenceSpace) return;
        try {
          const sourceTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000);
          const frame = this.createSimulatedSensorFrame(sourceTimestampUs / 1_000);
          if (this.recorder.recorderState === "recording") {
            const recorderRateHz = Math.max(1, this.configuration.recorderRateHz);
            const recorderIntervalMs = 1_000 / recorderRateHz;
            if (!usesHeadlessTestRendering() || displayTime - this.lastSimulatedRecorderAt >= recorderIntervalMs) {
              this.lastSimulatedRecorderAt = displayTime;
              this.recorder.enqueueSensorFrame(frame, sourceTimestampUs);
            }
          }
          this.sendSimulatedMonitorFrame(root, frame);
          this.xrPresentationFrameCount += 1;
          this.flushXrPresentationAcknowledgements();
        } catch (error) {
          this.reportSensorCaptureFailure(root, error, "Simulated sensor capture failed");
        }
        this.simulatedSensorFrame = window.requestAnimationFrame(nextSimulatedFrame);
      };
      this.simulatedSensorFrame = window.requestAnimationFrame(nextSimulatedFrame);
      return;
    }
    const xrSession = this.xrSession;
    const xrReferenceSpace = this.xrReferenceSpace;
    const nextFrame = (_time: number, xrFrame: any) => {
      this.xrSensorFrame = null;
      if (this.disposed || this.captureAuthorityRevoked || !this.sensorLoopRunning || this.xrSession !== xrSession || this.xrReferenceSpace !== xrReferenceSpace) return;
      try {
        const displayTime = Number.isFinite(xrFrame.predictedDisplayTime) ? xrFrame.predictedDisplayTime : performance.now();
        const sourceTimestampUs = Math.round((performance.timeOrigin + displayTime) * 1_000);
        if (this.bridge) this.bridge.publish(xrFrame, xrReferenceSpace, displayTime);
        else if (this.recorder.isArmed) this.recorder.enqueueXrFrame(
          xrFrame,
          xrReferenceSpace,
          xrSession,
          sourceTimestampUs,
          this.selectedCamera?.side ?? "unknown",
        );
        this.bridge?.publishDepth(xrFrame, xrReferenceSpace, displayTime);
        if (!this.bridge) this.directedDepth.publish(xrFrame, xrReferenceSpace, displayTime);
        this.xrSoloPostAcquisitionHud?.advanceXrFrame(_time);
        this.captureStatus.xrFrameCount = (this.captureStatus.xrFrameCount ?? 0) + 1;
        const hands = this.readXrHands(xrFrame, xrReferenceSpace);
        const viewerPose = this.bridge?.observations.hasSample(xrFrame, xrReferenceSpace)
          ? this.bridge.observations.viewerPose : xrFrame.getViewerPose(xrReferenceSpace);
        if (this.bridge && viewerPose) {
          const { x, y, z, w } = viewerPose.transform.orientation;
          this.bridgePitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z))));
          this.bridgeRoll = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z));
        }
        if (viewerPose) this.captureStatus.viewerPoseFrameCount = (this.captureStatus.viewerPoseFrameCount ?? 0) + 1;
        this.captureStatus.leftHandJointPoseCount = (this.captureStatus.leftHandJointPoseCount ?? 0) + hands.leftJointPoseCount;
        this.captureStatus.rightHandJointPoseCount = (this.captureStatus.rightHandJointPoseCount ?? 0) + hands.rightJointPoseCount;
        const timestampMs = sourceTimestampUs / 1_000;
        this.updateXrTrackingVisuals(timestampMs, hands);
        if (this.bridge) {
          const now = performance.now();
          if (now - this.lastSensorAt >= SENSOR_INTERVAL_MS) {
            this.lastSensorAt = now;
            this.latestHandSpeed = this.handSpeedTracker.update({ timestampMs, leftHand: hands.left, rightHand: hands.right });
          }
          this.renderXrReticleOverlay();
        } else this.sendMonitorFrame(root, viewerPose, hands, timestampMs);
        this.xrPresentationFrameCount += 1;
        this.flushXrPresentationAcknowledgements();
      } catch (error) {
        this.reportSensorCaptureFailure(root, error, "Sensor capture failed");
      }
      this.xrSensorFrame = xrSession.requestAnimationFrame(nextFrame);
    };
    this.xrSensorFrame = xrSession.requestAnimationFrame(nextFrame);
  }

  private createSimulatedSensorFrame(timestampMs: number): SensorFrame {
    const camera = this.world?.camera;
    if (camera) {
      camera.getWorldPosition(this.simulatedHeadPosition);
      camera.getWorldQuaternion(this.simulatedHeadRotation);
    } else {
      this.simulatedHeadPosition.set(0, 1.6, 0);
      this.simulatedHeadRotation.identity();
    }
    return {
      timestampMs,
      frameIndex: this.frameIndex,
      head: {
        position: { x: this.simulatedHeadPosition.x, y: this.simulatedHeadPosition.y, z: this.simulatedHeadPosition.z },
        rotation: { x: this.simulatedHeadRotation.x, y: this.simulatedHeadRotation.y, z: this.simulatedHeadRotation.z, w: this.simulatedHeadRotation.w },
      },
      cameraSide: this.selectedCamera?.side ?? "unknown",
      camera: null,
      // The synthetic XR session fabricates Solo hand input sources, so the
      // simulated frames report those hands as tracked for the same reason.
      // Without this the Solo start countdown would wait forever in simulation.
      leftHand: this.simulatedHand(),
      rightHand: this.simulatedHand(),
      sceneStatus: { planes: false, meshes: false, anchors: false },
    };
  }

  private simulatedHand(): HandState {
    const hand = emptyHand();
    hand.tracked = this.authority.kind === "solo";
    return hand;
  }

  private sendSimulatedMonitorFrame(root: HTMLElement, frame: SensorFrame) {
    const now = performance.now();
    const intervalMs = usesHeadlessTestRendering() ? HEADLESS_TEST_MONITOR_INTERVAL_MS : SENSOR_INTERVAL_MS;
    if (now - this.lastSensorAt < intervalMs) return;
    this.lastSensorAt = now;
    if (sessionSocketBlocksMonitorFrame(
      this.connectionProfile,
      this.authority.bufferedAmount,
      SessionClient.monitorBufferedAmountLimit,
    )) return;
    frame.frameIndex = this.frameIndex++;
    this.publishMonitorFrame(root, frame, now, this.configuration.recorderRateHz);
  }

  private sendMonitorFrame(
    root: HTMLElement,
    viewerPose: any,
    hands: { left: HandState; right: HandState },
    timestampMs: number,
  ) {
    const now = performance.now();
    if (now - this.lastSensorAt < SENSOR_INTERVAL_MS) return;
    this.lastSensorAt = now;
    if (sessionSocketBlocksMonitorFrame(
      this.connectionProfile,
      this.authority.bufferedAmount,
      SessionClient.monitorBufferedAmountLimit,
    )) return;
    if (!viewerPose) return;
    const head = toTransform(viewerPose.transform);
    const cameraSide = this.selectedCamera?.side ?? "unknown";
    const camera = cameraViewPoseFromViewerPose(
      viewerPose,
      cameraSide,
      {
        width: this.captureStatus.selectedCameraWidth,
        height: this.captureStatus.selectedCameraHeight,
      },
    );
    const captureFrame = this.cameraCaptureComposer?.frame ?? this.captureStatus.selectedCameraFrame;
    const outputRegistration = captureFrame
      ? cameraRegistrationForCaptureFrame(this.cameraRegistration, captureFrame)
      : !this.cameraRegistration?.captureFrameKey && cameraRegistrationMatches(
          this.cameraRegistration,
          this.selectedCamera?.deviceId,
          cameraSide,
          this.captureStatus.selectedCameraWidth,
          this.captureStatus.selectedCameraHeight,
        ) ? this.cameraRegistration : null;
    const registration = cameraRegistrationMatches(
      outputRegistration,
      this.selectedCamera?.deviceId,
      cameraSide,
      this.captureStatus.selectedCameraWidth,
      this.captureStatus.selectedCameraHeight,
    ) ? outputRegistration : null;
    const frame: SensorFrame = {
      timestampMs,
      frameIndex: this.frameIndex++,
      head,
      cameraSide,
      camera,
      handProjection: projectHandsToRegisteredCamera(
        hands.left,
        hands.right,
        camera,
        registration,
        head,
        cameraSide,
      ),
      leftHand: hands.left,
      rightHand: hands.right,
      sceneStatus: { planes: false, meshes: false, anchors: false },
    };
    this.publishMonitorFrame(root, frame, now);
  }

  private publishMonitorFrame(root: HTMLElement, frame: SensorFrame, now: number, reportedSensorRateHz?: number) {
    this.latestHandSpeed = this.handSpeedTracker.update(frame);
    this.playDemonstratorAudioCues(
      this.demonstratorAudioCueScheduler?.observeFastHands(
        this.latestHandSpeed.leftWarning || this.latestHandSpeed.rightWarning,
        now,
      ) ?? [],
    );
    this.sensorWindowFrames += 1;
    const elapsed = now - this.sensorWindowStart;
    const measuredSensorRateHz = elapsed >= 500 ? this.sensorWindowFrames * 1000 / elapsed : this.captureStatus.sensorRateHz;
    const sensorRateHz = reportedSensorRateHz ?? measuredSensorRateHz;
    if (elapsed >= 500) {
      this.sensorWindowFrames = 0;
      this.sensorWindowStart = now;
    }
    const handTracking = frame.leftHand.tracked || frame.rightHand.tracked ? "active" : "waiting";
    // Per-hand tracking gates the Solo start countdown, so a transition must
    // reach the authority promptly. Transitions are rare, so publish on change
    // only and never on the ordinary per-frame path.
    const handTrackingChanged = this.captureStatus.leftHandTracked !== frame.leftHand.tracked
      || this.captureStatus.rightHandTracked !== frame.rightHand.tracked;
    this.captureStatus = {
      ...this.captureStatus,
      handTracking,
      leftHandTracked: frame.leftHand.tracked,
      rightHandTracked: frame.rightHand.tracked,
      sensorRateHz,
      lastFrameAt: frame.timestampMs,
    };
    if (handTrackingChanged && this.authority.kind === "solo" && !this.disposed && !this.captureAuthorityRevoked) {
      this.publishCaptureStatus();
    }
    if (captureRecorderTransportMode(this.authority, this.connectionProfile) === "peer") {
      this.publishPeerMessage({ type: "sensor-frame", frame });
    } else {
      this.authority.publishSensorFrame(frame);
    }
    if (elapsed >= 500) this.publishCaptureStatus();
    this.renderCaptureDiagnostics(root);
  }

  private enqueueRecorderRunEvent(episode: Episode | undefined, event: RecorderRunEvent) {
    const segment = episode?.segments?.find((entry) => entry.id === event.segmentId);
    if (!episode || !segment) {
      throw new Error("The recorder event identifies an unknown task segment");
    }
    if (event.type === "annotation") {
      const annotation = segment.annotations.find((entry) => entry.id === event.annotationId);
      if (!annotation || annotation.action !== event.action || annotation.actor !== event.actor) {
        throw new Error("The recorder event conflicts with the authoritative task annotation");
      }
    } else if (segment.taskId !== event.taskId || segment.taskLabel !== event.taskLabel) {
      throw new Error("The recorder event conflicts with the authoritative task segment");
    }
    const key = this.recorderRunEventKey(episode.id, event);
    if (this.recorderRunEvents.has(key)) return;
    const sourceTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000);
    if (this.recorder.recorderState !== "recording" && this.recorder.recorderState !== "paused") {
      this.recorderRunEvents.add(key);
      this.pendingRecorderRunEvents.push({ episodeId: episode.id, event, key });
      return;
    }
    if (!this.recorder.enqueueRunEvent(event, sourceTimestampUs)) {
      throw new Error("The durable recorder could not journal the task annotation");
    }
    this.recorderRunEvents.add(key);
  }

  private recorderRunEventKey(episodeId: string, event: RecorderRunEvent) {
    return `${episodeId}:${event.segmentId}:${event.type}:${event.type === "annotation" ? event.annotationId : "boundary"}`;
  }

  private claimInitialRecorderRunEvent(episodeId: string, episode: Episode | undefined) {
    if (!episode || episode.id !== episodeId) {
      throw new Error("The recorder arming command does not identify the authoritative capture");
    }
    const segment = episode.segments?.[0];
    if (!segment) throw new Error("The recorder arming command has no initial task segment");
    const event: RecorderRunEvent = {
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    };
    const key = this.recorderRunEventKey(episodeId, event);
    this.recorderRunEvents.add(key);
    for (let index = this.pendingRecorderRunEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingRecorderRunEvents[index].key === key) this.pendingRecorderRunEvents.splice(index, 1);
    }
    return { event, key };
  }

  private flushRecorderRunEvents(episodeId: string) {
    for (let index = 0; index < this.pendingRecorderRunEvents.length;) {
      const pending = this.pendingRecorderRunEvents[index];
      if (pending.episodeId !== episodeId) {
        index += 1;
        continue;
      }
      if (!this.recorder.enqueueRunEvent(pending.event)) {
        this.recorderRunEvents.delete(pending.key);
        throw new Error("The durable recorder could not journal the queued run event");
      }
      this.pendingRecorderRunEvents.splice(index, 1);
    }
  }

  private async startRecorders(
    root: HTMLElement,
    episodeId?: string,
    stopRunOnFailure = true,
    episode?: Episode,
  ) {
    if (this.disposed || this.captureAuthorityRevoked) return false;
    const workflowEpisode = this.activeRecorderEpisode?.id === episodeId
      ? this.activeRecorderEpisode
      : episode;
    await this.recordingFinalise;
    if (this.disposed || this.captureAuthorityRevoked) return false;
    if (this.recordingFinalising) {
      this.failRecorderWorkflow(workflowEpisode);
      this.clearRecorderWorkflow(workflowEpisode);
      return false;
    }
    if ((this.mediaRecorder && this.mediaRecorder.state !== "inactive")
      || (this.audioRecorder && this.audioRecorder.state !== "inactive")) {
      this.failRecorderWorkflow(workflowEpisode);
      this.clearRecorderWorkflow(workflowEpisode);
      return false;
    }
    const cameraRequired = this.captureStatus.camera === "ready"
      || this.captureStatus.camera === "requesting";
    const preparedVideoTrack = this.liveComposedVideoTrack();
    if (cameraRequired && !preparedVideoTrack) {
      this.failRecorderWorkflow(workflowEpisode);
      this.clearRecorderWorkflow(workflowEpisode);
      this.reportError(root, "CAMERA RECORDING FRAME IS NOT READY");
      if (stopRunOnFailure) this.sendDemonstratorControl(root, "stop");
      return false;
    }
    const recorderArmed = episodeId ? await this.recorder.waitUntilArmed() : false;
    if (this.disposed || this.captureAuthorityRevoked) return false;
    if (recorderArmed) {}
    let initialRunEvent: { event: RecorderRunEvent; key: string } | null = null;
    let initialRunEventError: string | null = null;
    try {
      if (episodeId && recorderArmed) initialRunEvent = this.claimInitialRecorderRunEvent(episodeId, episode);
    } catch (error) {
      initialRunEventError = error instanceof Error ? error.message : "The initial task segment is invalid";
    }
    if (workflowEpisode && this.activeRecorderEpisode?.id === workflowEpisode.id) {
      this.activeRecorderDurableAckBaseline = this.captureStatus.recorderDurableAckSequence;
    }
    if (episodeId && recorderArmed && initialRunEvent) {
    }
    const recorderStarted = episodeId && recorderArmed && initialRunEvent
      ? await this.recorder.startEpisode(episodeId, initialRunEvent.event)
      : false;
    if (!episodeId || !recorderArmed || !initialRunEvent || !recorderStarted) {
      if (this.activeRecorderEpisode?.id === workflowEpisode?.id) {
        this.activeRecorderDurableAckBaseline = null;
      }
      this.failRecorderWorkflow(workflowEpisode);
      this.clearRecorderWorkflow(workflowEpisode);
      if (initialRunEvent) this.recorderRunEvents.delete(initialRunEvent.key);
      const recorderFailure = this.recorder.failureReason;
      this.reportError(root, initialRunEventError ?? (recorderFailure
        ? `DURABLE RECORDER FAILED: ${this.recorder.failureReason}`
        : "DURABLE RECORDER DID NOT ARM"), !recorderFailure);
      if (stopRunOnFailure) this.sendDemonstratorControl(root, "stop");
      return false;
    }
    this.recorderFinalisationFailureReported = false;
    this.mediaChunkTail = Promise.resolve();
    this.audioChunkTail = Promise.resolve();
    this.mediaChunkFailure = null;
    this.audioChunkFailure = null;
    const recordMediaFailure = (
      kind: "audio" | "video",
      failure: Error,
      stage: string,
      worker: "durable_recorder" | "media_recorder",
    ) => {
      const firstFailure = kind === "video"
        ? this.mediaChunkFailure === null
        : this.audioChunkFailure === null;
      if (kind === "video") this.mediaChunkFailure ??= failure;
      else this.audioChunkFailure ??= failure;
      if (!firstFailure) return;
      this.failRecorderWorkflow(this.activeRecorderEpisode);
      this.reportError(root, failure.message);
      if (kind === "video" || this.configuration.recordAudio) {
        this.sendDemonstratorControl(root, "stop");
      }
    };
    try {
      this.flushRecorderRunEvents(episodeId);
      this.lastSimulatedRecorderAt = Number.NEGATIVE_INFINITY;
      const captureStream = cameraRequired ? this.captureStream : null;
      if (cameraRequired
        && (!captureStream || this.liveComposedVideoTrack() !== preparedVideoTrack)) {
        throw new Error("The camera recording frame was lost while recording started");
      }
      if (captureStream) {
        const videoMime = [
          "video/mp4;codecs=avc1.42001E,mp4a.40.2",
          "video/mp4;codecs=avc1.42E01E",
          "video/mp4",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ].find((type) => MediaRecorder.isTypeSupported(type));
        this.mediaSequence = 0;
        this.mediaRecorder = new MediaRecorder(captureStream, videoMime ? { mimeType: videoMime } : undefined);
        this.mediaRecorder.addEventListener("error", (event) => {
          const candidate = workerErrorFromEvent(event);
          const failure = candidate instanceof Error ? candidate : new Error("Video recorder failed");
          recordMediaFailure("video", failure, "video_recording", "media_recorder");
        }, { once: true });
        this.mediaRecorder.addEventListener("dataavailable", (event) => {
          if (this.disposed || this.captureAuthorityRevoked) return;
          if (!event.data.size) return;
          const sequence = this.mediaSequence++;
          this.mediaChunkTail = this.mediaChunkTail.then(async () => {
            const buffer = await event.data.arrayBuffer();
            if (this.disposed || this.captureAuthorityRevoked) return;
            if (!this.recorder.enqueueMedia("media", event.data.type || "video/webm", buffer)) {
              throw new Error(this.recorder.failureReason
                ? `Video chunk ${sequence} was rejected because the recorder had already failed: ${this.recorder.failureReason}`
                : `Video chunk ${sequence} could not enter the durable journal`);
            }
          }).catch((error) => {
            const failure = error instanceof Error ? error : new Error("Video journalling failed");
            recordMediaFailure("video", failure, "video_journalling", "durable_recorder");
          });
        });
      }
      const serverAsrAudioEnabled = this.speechEnabled()
        && this.authority.sendAudioForAsr !== undefined;
      if (this.microphoneStream && (this.configuration.recordAudio || serverAsrAudioEnabled)) {
        const audioMime = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        this.audioSequence = 0;
        this.audioRecorder = new MediaRecorder(this.microphoneStream, audioMime ? { mimeType: audioMime } : undefined);
        this.audioRecorder.addEventListener("error", (event) => {
          const candidate = workerErrorFromEvent(event);
          const failure = candidate instanceof Error ? candidate : new Error("Audio recorder failed");
          recordMediaFailure("audio", failure, "audio_recording", "media_recorder");
        }, { once: true });
        this.audioRecorder.addEventListener("dataavailable", (event) => {
          if (this.disposed || this.captureAuthorityRevoked) return;
          if (!event.data.size) return;
          const sequence = this.audioSequence++;
          this.audioChunkTail = this.audioChunkTail.then(async () => {
            const buffer = await event.data.arrayBuffer();
            if (this.disposed || this.captureAuthorityRevoked) return;
            if (!this.configuration.recordAudio) {
              if (this.speechEnabled()) {
                this.authority.sendAudioForAsr?.(event.data.type || "audio/webm", buffer);
              }
              return;
            }
            if (!this.recorder.enqueueMedia("audio", event.data.type || "audio/webm", buffer)) {
              throw new Error(this.recorder.failureReason
                ? `Audio chunk ${sequence} was rejected because the recorder had already failed: ${this.recorder.failureReason}`
                : `Audio chunk ${sequence} could not enter the durable journal`);
            }
          }).catch((error) => {
            const failure = error instanceof Error ? error : new Error("Audio journalling failed");
            recordMediaFailure("audio", failure, "audio_journalling", "durable_recorder");
          });
        });
        this.audioRecorder.start(1_000);
      }
      this.mediaRecorder?.start(2_000);
    } catch (error) {
      const startFailure = error instanceof Error ? error : new Error("Media recorders could not start");
      try {
        await this.stopRecorders(root);
      } catch (rollbackError) {
        const rollbackFailure = directRecorderError(rollbackError, "The durable recorder could not roll back the failed media start");
        const failure = new Error(`${startFailure.message}; recorder rollback failed: ${rollbackFailure}`);
        this.failRecorderFinalisation(root, failure);
        if (stopRunOnFailure) this.sendDemonstratorControl(root, "stop");
        throw failure;
      }
      this.reportError(root, startFailure.message);
      this.failRecorderWorkflow(workflowEpisode);
      this.clearRecorderWorkflow(workflowEpisode);
      if (stopRunOnFailure) this.sendDemonstratorControl(root, "stop");
      return false;
    }
    root.querySelector(".join-card")!.classList.add("is-recording");
    this.setStatus(root, "Recording started");
    return true;
  }

  private stopRecorders(root: HTMLElement) {
    if (this.recordingFinalising) return this.recordingFinalise;
    this.recordingFinalising = true;
    this.recorderFinalisationStartedAt = performance.now();
    this.recorderFinalisationTelemetrySignatures = new Set();
    this.recorderFinalisationTerminalReported = false;
    this.recordingFinalise = Promise.resolve().then(async () => {
      try {
        this.recorder.stopEpisode();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("The durable recorder could not stop its clock");
        this.signalRecorderFinalisationFailure(failure);
        throw failure;
      }

      const mediaStops: Promise<void>[] = [];
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        mediaStops.push(stopMediaRecorderWithinDeadline(
          this.mediaRecorder,
          "video",
          this.recorderMediaStopTimeoutMs ?? RECORDER_MEDIA_STOP_TIMEOUT_MS,
        ));
      }
      if (this.audioRecorder && this.audioRecorder.state !== "inactive") {
        mediaStops.push(stopMediaRecorderWithinDeadline(
          this.audioRecorder,
          "audio",
          this.recorderMediaStopTimeoutMs ?? RECORDER_MEDIA_STOP_TIMEOUT_MS,
        ));
      }
      const mediaStopResults = await Promise.allSettled(mediaStops);
      const mediaStopFailures = mediaStopResults.flatMap((result) => (
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason : new Error("A media recorder could not stop")]
          : []
      ));
      if (mediaStopFailures.length > 0) {
        const failure = combinedRecorderFinalisationFailure(mediaStopFailures);
        this.signalRecorderFinalisationFailure(failure);
        throw failure;
      }
      let mediaTailResults: PromiseSettledResult<void>[];
      try {
        mediaTailResults = await promiseWithinRecorderFinalisationDeadline(
          Promise.allSettled([this.mediaChunkTail, this.audioChunkTail]),
          this.recorderMediaTailTimeoutMs ?? RECORDER_MEDIA_TAIL_TIMEOUT_MS,
          "saving",
          "Recorder finalisation timed out while journalling terminal media",
        );
      } catch (error) {
        const failure = error instanceof Error
          ? error
          : new Error("Recorder finalisation timed out while journalling terminal media");
        this.signalRecorderFinalisationFailure(failure);
        throw failure;
      }
      const failures = mediaTailResults.flatMap((result) => (
        result.status === "rejected"
          ? [result.reason instanceof Error
              ? result.reason
              : new Error("A terminal media chunk did not finish journalling")]
          : []
      ));
      if (this.mediaChunkFailure) failures.push(this.mediaChunkFailure);
      if (this.audioChunkFailure) failures.push(this.audioChunkFailure);

      if (failures.length === 0) {
      }
      try {
        await this.recorder.finishEpisode();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error("The durable recorder did not finish cleanly"));
      }
      if (failures.length > 0) {
        const failure = combinedRecorderFinalisationFailure(failures);
        this.signalRecorderFinalisationFailure(failure);
        throw failure;
      }
    })
      .catch((error) => {
        const stage = error instanceof RecorderFinalisationTimeoutError
          ? error.finalisationStage
          : recorderFinalisationProgress(this.captureStatus, true)?.stage ?? "closing-media";
        this.failRecorderWorkflow(
          this.activeRecorderEpisode,
          recorderFinalisationTimedOut(error),
        );
        throw error;
      })
      .finally(() => {
        this.mediaRecorder = null;
        this.audioRecorder = null;
        this.recordingFinalising = false;
        this.recorderFinalisationStartedAt = null;
        this.recorderFinalisationTelemetrySignatures.clear();
        this.renderXrTaskHud();
      });
    this.renderXrTaskHud();
    root.querySelector(".join-card")?.classList.remove("is-recording");
    this.setStatus(root, "Recording stopped");
    return this.recordingFinalise;
  }

  private pauseRecorders(root: HTMLElement) {
    if (this.mediaRecorder && this.mediaRecorder.state !== "recording") {
      throw new Error("The video recorder is not recording and cannot be paused");
    }
    if (this.audioRecorder && this.audioRecorder.state !== "recording") {
      throw new Error("The audio recorder is not recording and cannot be paused");
    }
    const pauseTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000);
    if (!this.recorder.pauseEpisode(pauseTimestampUs)) throw new Error("The durable recorder is not recording and cannot be paused");
    const pausedMedia: MediaRecorder[] = [];
    try {
      for (const recorder of [this.mediaRecorder, this.audioRecorder]) {
        if (recorder?.state !== "recording") continue;
        recorder.pause();
        pausedMedia.push(recorder);
      }
    } catch (error) {
      this.recorder.resumeEpisode();
      for (const recorder of pausedMedia) {
        if (recorder.state === "paused") recorder.resume();
      }
      throw error;
    }
    this.setStatus(root, "Recording paused");
  }

  private resumeRecorders(root: HTMLElement) {
    if (this.mediaRecorder && this.mediaRecorder.state !== "paused") {
      throw new Error("The video recorder is not paused and cannot be resumed");
    }
    if (this.audioRecorder && this.audioRecorder.state !== "paused") {
      throw new Error("The audio recorder is not paused and cannot be resumed");
    }
    const resumeTimestampUs = Math.round((performance.timeOrigin + performance.now()) * 1_000);
    if (!this.recorder.resumeEpisode(resumeTimestampUs)) throw new Error("The durable recorder is not paused and cannot be resumed");
    const resumedMedia: MediaRecorder[] = [];
    try {
      for (const recorder of [this.mediaRecorder, this.audioRecorder]) {
        if (recorder?.state !== "paused") continue;
        recorder.resume();
        resumedMedia.push(recorder);
      }
    } catch (error) {
      this.recorder.pauseEpisode();
      for (const recorder of resumedMedia) {
        if (recorder.state === "recording") recorder.pause();
      }
      throw error;
    }
    this.setStatus(root, "Recording resumed");
  }

  private closeVideoPeers() {
    this.directedDepth?.clearPeers();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.peerNegotiationIds.clear();
    this.pendingIceCandidates.clear();
    this.remoteDescriptionReadyPeers.clear();
    this.pendingOutgoingIceCandidates.clear();
    this.signalledLocalDescriptions.clear();
    this.peerTelemetryChannels.clear();
    this.peerControlChannels.clear();
    this.pendingTaskPresentationByChannel.clear();
    this.pendingBeamPresentationByChannel.clear();
    this.peerRecorderChannels.clear();
    this.relayedTurnPermit = null;
    if (!this.authority.recorderTransport) this.recordingRecorder?.setPeerBlockSender(null);
    if (this.authority.supportsPeerMedia && isPeerConnectionMode(this.connectionProfile)) {
      this.refreshPeerControlAvailability();
    }
  }

  private revokeCaptureAuthority(root: HTMLElement, failure: TerminalCapturePairing) {
    if (this.disposed || this.captureAuthorityRevoked) return;
    this.finishPairingJourney("failed");
    this.captureAuthorityRevoked = true;
    this.xrLaunch.cancel();
    clearStoredPairingInvitationTarget();
    this.connected = false;
    this.qrScanning = false;
    this.stopSensorLoop();
    this.stopXrTaskHudClock();
    this.handTrackingAlert.reset();
    this.clearXrBeamPresentation();
    this.closeVideoPeers();
    this.authority.close();

    for (const mediaRecorder of [this.mediaRecorder, this.audioRecorder]) {
      if (!mediaRecorder || mediaRecorder.state === "inactive") continue;
      try {
        mediaRecorder.stop();
      } catch {
        // The media tracks are released below even if a recorder already stopped.
      }
    }
    this.mediaRecorder = null;
    this.audioRecorder = null;
    this.recorder.dispose();
    this.cameraSelectionGeneration += 1;
    this.releaseBridgeCamera(root);
    this.cameraCaptureComposer?.dispose();
    this.cameraCaptureComposer = null;
    delete root.dataset.cameraCaptureFrame;
    delete root.dataset.cameraCaptureOutput;

    const preview = root.querySelector<HTMLVideoElement>("#camera-preview");
    const releasedMedia = releaseCaptureMediaResources({
      cameraStream: this.cameraStream,
      captureStream: this.captureStream,
      microphoneStream: this.microphoneStream,
    }, preview);
    this.cameraStream = releasedMedia.cameraStream;
    this.captureStream = releasedMedia.captureStream;
    this.microphoneStream = releasedMedia.microphoneStream;
    this.cameraChoices = [];
    this.selectedCamera = null;

    const xrSession = this.xrSession ?? this.world?.renderer.xr.getSession();
    this.unbindXrEvents();
    this.xrSession = null;
    this.xrReferenceSpace = null;
    this.stopXrSoloPostAcquisitionClock();
    this.applyXrSurfaceVisibility();
    if (xrSession) void xrSession.end().catch(() => undefined);
    if (this.xrTrackingVisuals) {
      this.xrTrackingVisuals.reticle.visible = false;
      this.xrTrackingVisuals.alert.group.visible = false;
      this.xrTrackingVisuals.hands?.clear();
    }

    this.captureStatus = {
      ...this.captureStatus,
      camera: "error",
      xr: this.captureStatus.xr === "idle" ? "idle" : "ended",
      transport: "failed",
      selectedCameraDeviceId: null,
      selectedCameraLabel: null,
      selectedCameraWidth: null,
      selectedCameraHeight: null,
      selectedCameraFrame: null,
      selectedCameraFrameRate: null,
      selectedCameraSide: "unknown",
      handTracking: "unavailable",
      recorder: "idle",
      sensorRateHz: 0,
      lastFrameAt: null,
      lastError: failure.message,
    };
    root.dataset.captureAuthority = "revoked";
    for (const selector of [
      "#prepare-camera",
      "#camera-select",
      "#scan-qr",
      "#join-code",
      "#join-code-submit",
      "#prepare-prompts",
      "#enter-xr",
      "#take-review button",
    ]) {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(selector)
        .forEach((control) => { control.disabled = true; });
    }
    const select = root.querySelector<HTMLSelectElement>("#camera-select");
    if (select) select.innerHTML = "<option>Pairing ended</option>";
    this.showCameraError(root, failure.message);
    this.renderCaptureDiagnostics(root);
    this.setStatus(root, failure.message, true);
  }

  private returnToCaptureEntry() {
    const entryUrl = new URL("/launch/capture/", location.origin);
    location.replace(entryUrl);
  }

  private activeRelayedIceServers() {
    const permit = activeTurnLease(this.relayedTurnPermit);
    if (!permit) this.relayedTurnPermit = null;
    return permit?.iceServers ?? null;
  }

  private signalCaptureLocalDescription(peerId: string, negotiationId: string, description: RTCSessionDescriptionInit) {
    if (!this.sendWebRtcSignal(peerId, { negotiationId, description })) return false;
    this.signalledLocalDescriptions.add(negotiationId);
    for (const candidate of this.pendingOutgoingIceCandidates.get(negotiationId) ?? []) {
      this.sendWebRtcSignal(peerId, { negotiationId, candidate });
    }
    this.pendingOutgoingIceCandidates.delete(negotiationId);
    return true;
  }

  private async createOffer(root: HTMLElement, peerId: string, replaceExisting = false) {
    if (this.disposed || this.captureAuthorityRevoked || !peerId) return;
    if (this.pairingInvite) {
      let retiredPeer = false;
      for (const existingPeerId of [...this.peers.keys()]) {
        if (existingPeerId !== peerId) retiredPeer = this.closeCapturePeer(existingPeerId) || retiredPeer;
      }
      if (retiredPeer) this.refreshPeerControlAvailability();
    }
    const existing = this.peers.get(peerId);
    const existingNegotiationId = this.peerNegotiationIds.get(peerId);
    const existingOfferWasSignalled = existingNegotiationId
      ? this.signalledLocalDescriptions.has(existingNegotiationId)
      : false;
    if (!replaceExisting
      && existing
      && existingOfferWasSignalled
      && !["failed", "closed", "disconnected"].includes(existing.connectionState)) return;
    const negotiationId = crypto.randomUUID();
    const peer = this.createCapturePeer(root, peerId, negotiationId);
    const offer = await peer.createOffer();
    if (this.disposed || this.peers.get(peerId) !== peer) return;
    await peer.setLocalDescription(offer);
    if (this.disposed || this.peers.get(peerId) !== peer) return;
    const signalled = this.signalCaptureLocalDescription(peerId, negotiationId, { type: offer.type, sdp: offer.sdp });
    if (!signalled) this.reportTransientSignalIssue(root, "Signalling was interrupted; retrying the capture director connection");
    this.scheduleCapturePeerNegotiationRetry(root, peerId, peer);
  }

  private scheduleCapturePeerNegotiationRetry(root: HTMLElement, peerId: string, peer: RTCPeerConnection) {
    if (!this.pairingInvite) return;
    window.setTimeout(() => {
      if (this.disposed
        || this.captureAuthorityRevoked
        || this.peers.get(peerId) !== peer
        || peer.connectionState === "connected") return;
      void this.createOffer(root, peerId, true);
    }, 6_000);
  }

  private createCapturePeer(root: HTMLElement, peerId: string, negotiationId: string, relayedIceServers = this.activeRelayedIceServers()) {
    this.closeCapturePeer(peerId);
    const peer = new RTCPeerConnection(rtcConfigurationForConnectionProfile(this.connectionProfile, relayedIceServers));
    this.peers.set(peerId, peer);
    this.peerNegotiationIds.set(peerId, negotiationId);
    this.pendingIceCandidates.set(negotiationId, []);
    this.remoteDescriptionReadyPeers.delete(negotiationId);
    this.pendingOutgoingIceCandidates.set(negotiationId, []);
    this.signalledLocalDescriptions.delete(negotiationId);
    this.updateCaptureStatus(root, { transport: "connecting" });
    this.captureStream?.getTracks().forEach((track) => peer.addTrack(track, this.captureStream!));
    if (isPeerConnectionMode(this.connectionProfile)) {
      this.wirePeerTelemetryChannel(peerId, peer, peer.createDataChannel("ceres-telemetry", { ordered: false, maxRetransmits: 0 }));
      this.wirePeerControlChannel(peerId, peer, peer.createDataChannel("ceres-control", capturePeerControlChannelOptions));
      this.wirePeerRecorderChannel(peerId, peer, peer.createDataChannel("ceres-recorder", { ordered: true }));
      try {
        this.directedDepth.addPeer(peerId, peer.createDataChannel(DEPTH_CHANNEL, { ordered: false, maxRetransmits: 0 }));
      } catch {
        // Optional depth setup cannot interrupt the recorder or control peer.
      }
    }
    peer.addEventListener("connectionstatechange", () => {
      if (this.disposed) return;
      const connectionState = peer.connectionState;
      const anyConnected = [...this.peers.values()].some((entry) => entry.connectionState === "connected");
      this.updateCaptureStatus(root, { transport: anyConnected ? "connected" : connectionState === "failed" ? "failed" : "connecting" });
      if (["failed", "closed"].includes(connectionState) && this.peers.get(peerId) === peer) {
        this.closeCapturePeer(peerId, peer);
        this.refreshPeerControlAvailability();
      }
    });
    peer.addEventListener("icecandidate", (event) => {
      if (this.disposed) return;
      const activeNegotiationId = this.peers.get(peerId) === peer ? this.peerNegotiationIds.get(peerId) : null;
      if (event.candidate && this.webRtcSignal && activeNegotiationId) {
        const candidate = event.candidate.toJSON();
        if (this.signalledLocalDescriptions.has(activeNegotiationId)) {
          this.sendWebRtcSignal(peerId, { negotiationId: activeNegotiationId, candidate });
        } else {
          const pending = this.pendingOutgoingIceCandidates.get(activeNegotiationId) ?? [];
          pending.push(candidate);
          this.pendingOutgoingIceCandidates.set(activeNegotiationId, pending);
        }
      }
    });
    return peer;
  }

  private closeCapturePeer(peerId: string, expectedPeer?: RTCPeerConnection) {
    const peer = this.peers.get(peerId);
    if (!peer || (expectedPeer && peer !== expectedPeer)) return false;
    const negotiationId = this.peerNegotiationIds.get(peerId);
    this.peers.delete(peerId);
    this.peerNegotiationIds.delete(peerId);
    if (negotiationId) {
      this.pendingIceCandidates.delete(negotiationId);
      this.remoteDescriptionReadyPeers.delete(negotiationId);
      this.pendingOutgoingIceCandidates.delete(negotiationId);
      this.signalledLocalDescriptions.delete(negotiationId);
    }
    this.peerTelemetryChannels.delete(peerId);
    this.peerControlChannels.delete(peerId);
    this.peerRecorderChannels.delete(peerId);
    this.directedDepth?.removePeer(peerId);
    peer.close();
    return true;
  }

  private wireWebRtcSignal(root: HTMLElement) {
    if (!this.authority.supportsPeerMedia || !this.sessionKey) return;
    const relayUrl = connectionServerUrl(this.connectionProfile);
    if (!relayUrl || !this.pairingInvite) return;
    const signal = new WebRtcSignalClient(
      this.sessionKey,
      "capture",
      relayUrl,
      this.pairingId,
      this.pairingInvite ? {
        ...demonstratorSignalCredentials(this.pairingInvite),
        expiresAt: this.pairingInvite.expiresAt,
        bound: this.pairingInvitationBound,
        boundAt: this.pairingInvitationBoundAt ?? undefined,
      } : null,
    );
    this.webRtcSignal = signal;
    signal.on<boolean>("connection", (connected) => this.handleWebRtcSignalConnection(root, signal, connected));
    signal.on<boolean>("capture-intent", (granted) => {
      if (signal !== this.webRtcSignal) return;
      this.captureIntentGranted = granted;
      root.dataset.captureIntent = granted ? "granted" : "waiting";
      if (!granted) {
        this.captureAuthorityGranted = false;
        this.captureXrAuthorityRequested = false;
        this.stopSensorLoop();
        if (this.xrSession) this.captureStatus = { ...this.captureStatus, xr: "requesting", sensorSource: "none" };
        this.armedRecorderSession = "";
        this.armedRecorderRate = 0;
        this.closeVideoPeers();
        this.setStatus(root, "Another capture tab is preparing. Enable camera to use this tab.");
      } else if (!this.connected) {
        this.setStatus(root, "This tab is selected. Connecting to the capture director.");
      }
      if (granted && this.xrSession && this.captureStatus.xr === "requesting") this.markCaptureXrActive();
      this.renderCaptureDiagnostics(root);
    });
    signal.on<boolean>("capture-authority", (granted) => {
      if (signal !== this.webRtcSignal || !granted) return;
      this.acceptCaptureXrAuthority(root);
    });
    signal.on<string>("invitation-bound", (boundAt) => {
      if (signal !== this.webRtcSignal || !this.pairingInvite) return;
      this.pairingInvitationBound = true;
      this.pairingInvitationBoundAt ??= boundAt;
      markStoredPairingInvitationTargetBound(undefined, location.origin, Date.now(), this.pairingInvite, boundAt);
    });
    signal.on<{ peerId: string }>("webrtc-request-offer", (message) => {
      if (signal === this.webRtcSignal) void this.createOffer(root, message.peerId);
    });
    signal.on<{ peerId: string; signal: WebRtcSignal }>("webrtc-signal", (message) => {
      if (signal === this.webRtcSignal) void this.acceptSignal(message.peerId, message.signal);
    });
    signal.on<WebRtcSignalError>("error", (error) => this.handleWebRtcSignalError(root, signal, error));
    if (this.captureStatus.camera === "ready") signal.requestCaptureIntent();
    if (this.xrSession) {
      this.captureXrAuthorityRequested = false;
      this.markCaptureXrActive();
    }
    signal.connect();
  }

  private requestCaptureIntent() {
    if (this.bridge) return this.bridge.ready;
    if (this.webRtcSignal) return this.webRtcSignal.requestCaptureIntent();
    if (captureRecorderTransportMode(this.authority, this.connectionProfile) !== "peer") {
      return this.authority.requestCaptureIntent();
    }
    return false;
  }

  private markCaptureXrActive() {
    if (this.bridge) {
      const root = this.mountedRoot;
      if (!root || !this.xrSession || !this.xrReferenceSpace) return false;
      this.bridge.start(this.xrSession, this.xrReferenceSpace, "local-floor", this.world?.renderer);
      this.acceptCaptureXrAuthority(root);
      return true;
    }
    if (this.captureXrAuthorityRequested) return false;
    this.captureXrAuthorityRequested = true;
    if (this.webRtcSignal) return this.webRtcSignal.markXrActive();
    if (captureRecorderTransportMode(this.authority, this.connectionProfile) !== "peer") {
      return this.authority.markXrActive();
    }
    this.captureXrAuthorityRequested = false;
    return false;
  }

  private acceptCaptureXrAuthority(root: HTMLElement) {
    if (!this.xrSession || this.captureAuthorityRevoked) return;
    this.captureAuthorityGranted = true;
    root.dataset.captureAuthority = "granted";
    this.updateCaptureStatus(root, {
      xr: "active",
      sensorSource: currentCaptureSensorSource(true),
      handTracking: this.authority.kind === "solo"
        && (this.soloHandRecognition.left || this.soloHandRecognition.right)
        ? "active"
        : "waiting",
      lastError: null,
    });
    this.setStatus(root, this.bridge ? this.bridge.status : this.connected
      ? "XR active and capture data is flowing"
      : "XR active with the default task. Connect to the capture director before recording.");
    if (!this.sensorLoopRunning) this.beginXrSensorLoop(root);
  }

  private handleWebRtcSignalError(root: HTMLElement, signal: WebRtcSignalClient, error: WebRtcSignalError) {
    if (signal !== this.webRtcSignal) return;
    if (error.retrying) {
      this.reportTransientSignalIssue(root, error.message);
      return;
    }
    if (!error.terminal || error.code === 4401) {
      if (error.code !== 4401) this.reportError(root, error.message);
      return;
    }
    this.transientSignalIssue = null;
    this.finishPairingJourney("failed");
    clearStoredPairingInvitationTarget();
    signal.dispose();
    if (this.webRtcSignal === signal) this.webRtcSignal = null;
    this.resetJoin(root);
    this.reportError(root, error.message);
  }

  private handleWebRtcSignalConnection(root: HTMLElement, signal: WebRtcSignalClient, connected: boolean) {
    if (signal !== this.webRtcSignal || !connected) return;
    this.pairingInvitationBound = true;
    this.clearTransientSignalIssue(
      root,
      this.connected ? "Capture director link restored" : "Signalling restored; reconnecting to the capture director",
    );
  }

  private reportTransientSignalIssue(root: HTMLElement, message: string) {
    this.transientSignalIssue = message;
    this.setStatus(root, message, true);
  }

  private clearTransientSignalIssue(root: HTMLElement, message: string) {
    if (!this.transientSignalIssue) return;
    this.transientSignalIssue = null;
    this.setStatus(root, message);
  }

  private sendWebRtcSignal(peerId: string, signal: WebRtcSignal) {
    if (this.webRtcSignal) return this.webRtcSignal.signal(peerId, signal);
    if (!this.authority.supportsPeerMedia || this.connectionProfile.mode === "local") return false;
    return this.authority.publishWebRtcSignal(peerId, signal);
  }

  private wirePeerTelemetryChannel(peerId: string, peer: RTCPeerConnection, channel: RTCDataChannel) {
    channel.addEventListener("open", () => {
      if (this.peers.get(peerId) !== peer) return;
      this.peerTelemetryChannels.set(peerId, channel);
      this.publishCaptureStatus();
    });
    channel.addEventListener("close", () => {
      if (this.peerTelemetryChannels.get(peerId) === channel) this.peerTelemetryChannels.delete(peerId);
    });
  }

  private wirePeerControlChannel(peerId: string, peer: RTCPeerConnection, channel: RTCDataChannel) {
    channel.addEventListener("open", () => {
      if (this.peers.get(peerId) !== peer) return;
      this.peerControlChannels.set(peerId, channel);
      this.publishTelemetryMode();
      if (this.mountedRoot) this.clearTransientSignalIssue(this.mountedRoot, "Capture director link restored");
      this.refreshPeerControlAvailability();
      this.recorder.setPeerBlockSender((sequence, block) => this.sendPeerRecorderBlock(peerId, sequence, block));
      this.armRecorder();
      const root = this.mountedRoot;
      if (root) {
        this.publishCaptureStatus();
        if (this.snapshot) this.renderTaskSetup(root, this.snapshot);
        this.renderTakeReview(root);
        this.renderCaptureDiagnostics(root);
        this.renderXrTaskHud();
      }
    });
    channel.addEventListener("message", (event) => {
      if (this.peers.get(peerId) !== peer || typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as { type?: string; configuration?: CaptureConfiguration; revision?: number; checksum?: string; settings?: HandDisplaySettings; registration?: unknown; state?: unknown; action?: string; episode?: Episode; deliveryId?: unknown; resetId?: unknown; text?: string; speak?: boolean; visual?: boolean };
        const root = this.mountedRoot;
        const revision = typeof message.revision === "number" ? message.revision : Number.NaN;
        if (message.type === "restart-session"
          && typeof message.resetId === "string"
          && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(message.resetId)
          && root) {
          channel.send(JSON.stringify({ type: "session-restarted", resetId: message.resetId }));
          window.setTimeout(() => {
            this.revokeCaptureAuthority(root, {
              code: "capture-session-restarted",
              message: "The capture director restarted the session",
            });
            this.returnToCaptureEntry();
          }, 50);
        } else if (message.type === "configuration" && message.configuration && Number.isSafeInteger(revision) && typeof message.checksum === "string" && root) {
          this.receiveDirectConfiguration(root, peerId, message.configuration, revision, message.checksum);
        } else if (message.type === "hand-display" && message.settings) {
          this.applyHandDisplaySettings(message.settings);
          this.renderXrHandDisplayHud();
        } else if (message.type === "camera-registration") {
          this.cameraRegistration = normaliseCameraRegistration(message.registration ?? null);
        } else if (message.type === "run-state" && isDirectRunState(message.state) && root) {
          this.receiveDirectRunState(root, message.state);
        } else if (message.type === "control" && typeof message.action === "string" && root) {
          this.receiveDirectControl(root, peerId, message.action, message.episode, (message as { event?: RecorderRunEvent }).event);
        } else if (message.type === "beam" && root) {
          const deliveryState = this.receiveBeam(root, message);
          if (deliveryState && isDirectBeamDeliveryId(message.deliveryId)) {
            if (deliveryState === "visual-pending") this.queueBeamPresentation(channel, message.deliveryId);
            else this.sendBeamAcknowledgement(channel, message.deliveryId, deliveryState);
          }
        } else {
          this.recorder.receivePeerControl(message);
        }
      } catch {
        if (this.mountedRoot) this.reportError(this.mountedRoot, "The monitor recorder sent an unreadable control message");
      }
    });
    channel.addEventListener("close", () => {
      if (this.peerControlChannels.get(peerId) !== channel) return;
      this.peerControlChannels.delete(peerId);
      this.directedDepth?.removePeer(peerId);
      this.pendingTaskPresentationByChannel.delete(channel);
      this.pendingBeamPresentationByChannel.delete(channel);
      this.refreshPeerControlAvailability();
    });
  }

  private refreshPeerControlAvailability() {
    const wasConnected = this.connected;
    this.connected = this.peerControlChannels.size > 0;
    if (!wasConnected && this.connected) this.finishPairingJourney("succeeded");
    if (this.connected) {
      this.pairingInvitationBound = true;
      markStoredPairingInvitationTargetBound(undefined, location.origin, Date.now(), this.pairingInvite, this.pairingInvitationBoundAt ?? undefined);
    }
    this.refreshDirectSnapshotReadiness();
    if (this.connected) return;
    this.recorder.setPeerBlockSender(null);
    if (this.xrTaskHud) {
      this.xrTaskHud.hoveredControl = null;
      this.xrTaskHud.pressedControl = null;
    }
    const root = this.mountedRoot;
    if (!root) return;
    this.renderOfflineTaskSetup(root);
    this.renderTakeReview(root);
    this.renderCaptureDiagnostics(root);
    this.renderXrTaskHud();
  }

  private wirePeerRecorderChannel(peerId: string, peer: RTCPeerConnection, channel: RTCDataChannel) {
    channel.addEventListener("open", () => {
      if (this.peers.get(peerId) === peer) this.peerRecorderChannels.set(peerId, channel);
    });
    channel.addEventListener("close", () => {
      if (this.peerRecorderChannels.get(peerId) === channel) this.peerRecorderChannels.delete(peerId);
    });
  }

  private sendPeerRecorderBlock(peerId: string, sequence: number, block: ArrayBuffer) {
    const channel = this.peerRecorderChannels.get(peerId);
    if (!channel || channel.readyState !== "open") return false;
    const fragments = fragmentPeerRecorderBlock(sequence, new Uint8Array(block));
    const bytes = fragments.reduce((total, fragment) => total + fragment.byteLength, 0);
    if (channel.bufferedAmount + bytes > 8 * 1024 * 1024) return false;
    for (const fragment of fragments) channel.send(fragment);
    return true;
  }

  private receiveDirectConfiguration(root: HTMLElement, peerId: string, configuration: CaptureConfiguration, revision: number, checksum: string) {
    const audioChanged = this.configuration.recordAudio !== configuration.recordAudio;
    const promptChanged = JSON.stringify(this.configuration.promptAudio) !== JSON.stringify(configuration.promptAudio);
    this.applyConfiguration(configuration);
    this.appliedConfigurationRevision = revision;
    if (promptChanged) {
      this.promptAudioReady = false;
      this.promptAssets.clear();
    }
    if (audioChanged && this.cameraStream) void this.composeCaptureStream();
    this.armRecorder();
    this.publishCaptureStatus();
    this.peerControlChannels.get(peerId)?.send(JSON.stringify({ type: "configuration-applied", revision, checksum }));
    this.refreshDirectSnapshotReadiness();
    this.renderDirectTaskSetup(root);
    this.renderXrTaskHud();
    this.renderCaptureDiagnostics(root);
  }

  private renderDirectTaskSetup(root: HTMLElement) {
    const section = root.querySelector<HTMLElement>("#task-setup")!;
    const task = this.configuration.tasks[0];
    root.querySelector("#task-setup-label")!.textContent = "Assigned task";
    root.querySelector("#task-setup-title")!.textContent = task?.label ?? "Waiting for the capture director";
    root.querySelector("#task-setup-description")!.textContent = task
      ? task.instructions === "--"
        ? this.configuration.runDescription || this.configuration.runTitle
        : task.instructions
      : "The capture director has not configured a task yet.";
    section.classList.toggle("is-ready", Boolean(task));
  }

  private receiveDirectRunState(root: HTMLElement, state: DirectRunState) {
    const previous = this.snapshot;
    const readiness = directCaptureReadiness(
      state,
      this.configuration,
      this.connected,
      this.appliedConfigurationRevision >= 0,
      this.captureStatus.recorder,
    );
    const next: SessionSnapshot = {
      sessionId: this.sessionKey,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      telemetryMode: "disabled" as const,
      telemetryModeAuthoritative: true,
      operatingMode: state.operatingMode,
      solo: state.solo ? structuredClone(state.solo) : undefined,
      features: { ...state.features },
      handDisplay: this.handDisplaySettings,
      captureConnected: this.connected,
      monitorCount: 1,
      recording: state.recording,
      activeTaskIndex: state.run.activeTaskIndex,
      run: structuredClone(state.run),
      configuration: this.configuration,
      configurationStatus: {
        state: "applied",
        revision: this.appliedConfigurationRevision,
        checksum: `direct-${this.appliedConfigurationRevision}`,
        appliedRevision: this.appliedConfigurationRevision,
        error: null,
      },
      sequenceReadiness: readiness.sequenceReadiness,
      recordingReadiness: readiness.recordingReadiness,
      currentEpisode: structuredClone(state.currentEpisode),
      pendingEpisode: structuredClone(state.pendingEpisode),
      episodes: previous?.episodes ?? [],
      attempts: previous?.attempts ?? [],
      jobs: previous?.jobs ?? [],
      promptAudioStatus: previous?.promptAudioStatus ?? { state: "unavailable", detail: "Prompt audio is disabled for direct sessions" },
      promptDeliveries: previous?.promptDeliveries ?? [],
      lastFrame: previous?.lastFrame ?? null,
      lastTranscript: previous?.lastTranscript ?? null,
      commandLog: previous?.commandLog ?? [],
      captureStatus: structuredClone(this.captureStatus),
    };
    this.captureTaskCompletion(previous, next);
    const taskSignature = xrTaskHudChangeSignature(next);
    const taskChanged = Boolean(taskSignature && taskSignature !== this.lastXrTaskSignature);
    this.lastXrTaskSignature = taskSignature;
    this.snapshot = next;
    this.playDemonstratorAudioCues(this.demonstratorAudioCueScheduler?.observeRunTransition(previous, next) ?? []);
    this.reconcileXrExitPause(next);
    this.syncCaptureControllerInputPolicy();
    this.renderSpeechFeature(root);
    if (!this.speechEnabled() && "speechSynthesis" in window) window.speechSynthesis.cancel();
    this.renderTaskSetup(root, next);
    this.renderTakeReview(root);
    this.renderPromptAudioState(root, next);
    if (taskChanged) this.announceXrTaskChange();
    else this.renderXrTaskHud();
  }

  private refreshDirectSnapshotReadiness() {
    const snapshot = this.snapshot;
    if (!snapshot || !isPeerConnectionMode(this.connectionProfile)) return;
    const state: DirectRunState = {
      operatingMode: snapshot.operatingMode,
      solo: snapshot.solo ? structuredClone(snapshot.solo) : undefined,
      features: { ...snapshot.features },
      run: structuredClone(snapshot.run),
      recording: snapshot.recording,
      currentEpisode: structuredClone(snapshot.currentEpisode),
      pendingEpisode: structuredClone(snapshot.pendingEpisode),
    };
    const readiness = directCaptureReadiness(
      state,
      this.configuration,
      this.connected,
      this.appliedConfigurationRevision >= 0,
      this.captureStatus.recorder,
    );
    snapshot.captureConnected = this.connected;
    snapshot.configuration = this.configuration;
    snapshot.configurationStatus = {
      state: this.appliedConfigurationRevision >= 0 ? "applied" : "sent",
      revision: this.appliedConfigurationRevision,
      checksum: `direct-${this.appliedConfigurationRevision}`,
      appliedRevision: this.appliedConfigurationRevision >= 0 ? this.appliedConfigurationRevision : null,
      error: null,
    };
    snapshot.captureStatus = structuredClone(this.captureStatus);
    snapshot.sequenceReadiness = readiness.sequenceReadiness;
    snapshot.recordingReadiness = readiness.recordingReadiness;
  }

  private adoptRecorderWorkflowEpisode(episode: Episode) {
    if (!this.activeRecorderEpisode || this.activeRecorderEpisode.id === episode.id) {
      const previousEpisodeId = this.activeRecorderEpisode?.id ?? null;
      this.activeRecorderEpisode = structuredClone(episode);
      if (previousEpisodeId !== episode.id) {
        this.activeRecorderDurableAckBaseline = null;
        this.recorderWorkflowFailureOutcomeHint = null;
        this.recorderWorkflowTerminalEpisodeId = null;
      }
    }
  }

  private beginRecorderWorkflow(episode: Episode) {
    this.adoptRecorderWorkflowEpisode(episode);
  }

  private clearRecorderWorkflow(episode: Episode | null | undefined) {
    if (!episode || this.activeRecorderEpisode?.id !== episode.id) return;
    this.activeRecorderEpisode = null;
    this.activeRecorderDurableAckBaseline = null;
  }

  private failRecorderWorkflow(episode: Episode | null | undefined, timedOut = false) {
    if (!episode) return false;
    const hintedOutcome = this.recorderWorkflowFailureOutcomeHint?.episodeId === episode.id
      ? this.recorderWorkflowFailureOutcomeHint.timedOut
      : timedOut;
    if (this.recorderWorkflowTerminalEpisodeId === episode.id) return false;
    this.recorderWorkflowTerminalEpisodeId = episode.id;
    const startedAt = Date.parse(episode.startedAt);
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
    return false;
  }

  private completeRecorderWorkflow(episode?: Episode) {
    const workflowEpisode = episode ?? this.activeRecorderEpisode;
    if (workflowEpisode && this.recorderWorkflowTerminalEpisodeId !== workflowEpisode.id) {
      this.recorderWorkflowTerminalEpisodeId = workflowEpisode.id;
    }
    if (episode) this.clearRecorderWorkflow(episode);
    else {
      this.activeRecorderEpisode = null;
      this.activeRecorderDurableAckBaseline = null;
    }
  }

  private receiveDirectControl(
    root: HTMLElement,
    peerId: string,
    action: string,
    episode?: Episode,
    event?: RecorderRunEvent,
  ) {
    if ((action === "recording-arming" || action === "recording-recover-arming") && episode) {
      this.beginRecorderWorkflow(episode);
      void this.directRecorderBoundary.apply(action, episode.id, episode)
        .then((result) => {
          this.sendDirectRecorderResult(peerId, result);
          if (result.type === "recording-rejected") this.clearRecorderWorkflow(episode);
        });
      return;
    }
    if (action === "recording-stopped") {
      this.completeRecorderWorkflow(episode);
      this.renderXrTaskHud();
      return;
    }
    if (action === "recording-started") {
      this.renderXrTaskHud();
      return;
    }
    if (action === "recording-paused" || action === "recording-resumed") {
      try {
        applyDirectRecorderTransition(
          action,
          () => this.applyRecorderPauseTransition(root, "recording-paused"),
          () => this.applyRecorderPauseTransition(root, "recording-resumed"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : `Recorder ${action === "recording-paused" ? "pause" : "resume"} failed`;
        this.reportError(root, message);
        this.sendDemonstratorControl(root, "stop");
      }
      return;
    }
    if (action === "recording-event" && episode && event) {
      this.enqueueRecorderRunEvent(episode, event);
      return;
    }
    if ((action === "recording-stopping" || action === "recording-recover-stopping") && episode) {
      this.adoptRecorderWorkflowEpisode(episode);
      void this.directRecorderBoundary.apply(action, episode.id)
        .then((result) => {
          if (result.type === "recording-finalised" && result.error) {
            this.failRecorderWorkflow(episode);
          }
          this.sendDirectRecorderResult(peerId, result);
        });
    }
  }

  private receiveAuthorityRecorderCommand(
    root: HTMLElement,
    source: CaptureAuthorityPort,
    action: DirectRecorderCommandAction,
    episode: Episode,
  ) {
    if (action === "recording-stopping" || action === "recording-recover-stopping") {
      this.adoptRecorderWorkflowEpisode(episode);
    }
    void this.directRecorderBoundary.apply(action, episode.id, episode).then((result) => {
      if (source !== this.authority) return;
      if (result.type === "recording-finalised" && result.error) {
        this.failRecorderWorkflow(episode);
      }
      const published = source.publishRecorderResult(result);
      if (published
        && result.type === "recording-finalised"
        && !result.error
        && this.activeRecorderEpisode?.id === result.episodeId) {
      }
      if (result.type === "recording-rejected") {
        this.clearRecorderWorkflow(episode);
        this.reportError(root, result.error);
        this.sendDemonstratorControl(root, "stop");
      }
    });
  }

  private sendDirectRecorderResult(peerId: string, result: DirectRecorderCommandResult) {
    const channel = this.peerControlChannels.get(peerId);
    if (channel?.readyState !== "open") return false;
    channel.send(JSON.stringify(result));
    if (result.type === "recording-finalised"
      && !result.error
      && this.activeRecorderEpisode?.id === result.episodeId) {
    }
    return true;
  }

  private publishPeerMessage(message: Extract<ServerMessage, { type: "capture-status" | "sensor-frame" }>) {
    if (!isPeerConnectionMode(this.connectionProfile)) return false;
    const encoded = JSON.stringify(message);
    let sent = false;
    for (const channel of this.peerTelemetryChannels.values()) {
      if (channel.readyState !== "open" || channel.bufferedAmount > SessionClient.monitorBufferedAmountLimit) continue;
      channel.send(encoded);
      sent = true;
    }
    return sent;
  }

  private publishCaptureStatus() {
    if (this.bridge) return false;
    const message = { type: "capture-status", status: this.captureStatus } as const;
    return captureRecorderTransportMode(this.authority, this.connectionProfile) === "peer"
      ? this.publishPeerMessage(message)
      : this.authority.publishCaptureStatus(this.captureStatus);
  }

  private async acceptSignal(peerId: string, signal: WebRtcSignal) {
    if (this.disposed) return;
    const currentNegotiationId = this.peerNegotiationIds.get(peerId);
    const negotiationId = signal.negotiationId === undefined
      ? currentNegotiationId ?? webRtcSignalNegotiationId(undefined, peerId)
      : webRtcSignalNegotiationId(signal.negotiationId, peerId);
    if (!negotiationId) return;
    if (signal.turnPermit && this.connectionProfile.mode === "relayed") {
      const permit = normaliseTurnLease(signal.turnPermit);
      const activePermit = activeTurnLease(permit);
      if (!activePermit || (currentNegotiationId && negotiationId !== currentNegotiationId)) {
        if (this.mountedRoot) this.reportTransientSignalIssue(this.mountedRoot, "The capture director sent an expired or invalid TURN permit; waiting for a fresh permit");
        return;
      }
      this.relayedTurnPermit = activePermit;
      const root = this.mountedRoot;
      if (root) await this.restartRelayedIce(root, peerId);
      return;
    }
    const peer = this.peers.get(peerId);
    if (!peer || currentNegotiationId !== negotiationId) return;
    if (signal.description?.type === "answer" && peer.signalingState === "have-local-offer") {
      await peer.setRemoteDescription(signal.description as RTCSessionDescriptionInit);
      if (this.disposed || this.peers.get(peerId) !== peer || this.peerNegotiationIds.get(peerId) !== negotiationId) return;
      this.remoteDescriptionReadyPeers.add(negotiationId);
      for (const candidate of this.pendingIceCandidates.get(negotiationId)?.splice(0) ?? []) await peer.addIceCandidate(candidate);
    }
    if (!signal.candidate) return;
    const candidate = signal.candidate as RTCIceCandidateInit;
    if (this.remoteDescriptionReadyPeers.has(negotiationId)) await peer.addIceCandidate(candidate);
    else this.pendingIceCandidates.get(negotiationId)?.push(candidate);
  }

  private async restartRelayedIce(root: HTMLElement, peerId: string) {
    if (this.disposed || this.connectionProfile.mode !== "relayed") return;
    const iceServers = this.activeRelayedIceServers();
    if (!iceServers) {
      this.reportTransientSignalIssue(root, "The capture director sent an expired TURN permit; waiting for a fresh permit");
      return;
    }
    const negotiationId = crypto.randomUUID();
    const peer = this.createCapturePeer(root, peerId, negotiationId, iceServers);
    const offer = await peer.createOffer();
    if (this.disposed || this.peers.get(peerId) !== peer || this.peerNegotiationIds.get(peerId) !== negotiationId) return;
    await peer.setLocalDescription(offer);
    if (this.disposed || this.peers.get(peerId) !== peer || this.peerNegotiationIds.get(peerId) !== negotiationId) return;
    const signalled = this.signalCaptureLocalDescription(peerId, negotiationId, { type: offer.type, sdp: offer.sdp });
    if (!signalled) this.reportTransientSignalIssue(root, "Signalling was interrupted while applying TURN; retrying");
    this.scheduleCapturePeerNegotiationRetry(root, peerId, peer);
  }

  private updateCaptureStatus(root: HTMLElement, patch: Partial<CaptureStatus>) {
    if (this.disposed || this.captureAuthorityRevoked) return;
    this.captureStatus = { ...this.captureStatus, ...patch };
    this.refreshDirectSnapshotReadiness();
    this.publishCaptureStatus();
    this.renderCaptureDiagnostics(root);
    if (patch.xr !== undefined || patch.transport !== undefined || patch.camera !== undefined) this.renderXrTaskHud();
  }

  private armRecorder() {
    if (this.bridge) return;
    if (this.disposed || this.captureAuthorityRevoked) return;
    const recorderRateHz = this.configuration.recorderRateHz;
    const transportMode = captureRecorderTransportMode(this.authority, this.connectionProfile);
    const transportReady = transportMode === "peer"
      ? this.peerControlChannels.size > 0
      : transportMode === "local"
        ? this.connected
        : this.connected && this.captureIntentGranted;
    const configurationReady = transportMode === "session"
      || this.appliedConfigurationRevision >= 0;
    if (!transportReady
      || !configurationReady
      || !this.sessionKey
      || (this.armedRecorderSession === this.sessionKey && this.armedRecorderRate === recorderRateHz)) return;
    this.armedRecorderSession = this.sessionKey;
    this.armedRecorderRate = recorderRateHz;
    this.captureStatus = { ...this.captureStatus, recorder: "arming", recorderRateHz };
    this.refreshDirectSnapshotReadiness();
    this.renderXrTaskHud();
    this.recorder.arm(this.sessionKey, recorderRateHz, this.pairingId);
  }



  private signalRecorderFinalisationFailure(error: Error) {
    if (this.activeRecorderEpisode) {
      this.recorderWorkflowFailureOutcomeHint = {
        episodeId: this.activeRecorderEpisode.id,
        timedOut: recorderFinalisationTimedOut(error),
      };
    }
    this.recorder.failFinalisation(error);
  }

  private receiveRecorderStatus(status: DurableRecorderStatus) {
    if (this.disposed || this.captureAuthorityRevoked) return;
    const root = this.mountedRoot;
    const previousRecorderState = this.captureStatus.recorder;
    const previousPendingBlocks = this.previousRecorderPendingBlocks;
    const finalising = this.snapshot?.run.recordingState === "stopping"
      || this.recordingFinalising;
    const previousFinalisationSignature = recorderFinalisationProgress(
      this.captureStatus,
      finalising,
    )?.signature ?? "";
    if (previousPendingBlocks > 0 && status.pendingBlocks === 0) {
      this.recorderQueueDrainedAt = performance.now();
    } else if (status.pendingBlocks > 0) {
      this.recorderQueueDrainedAt = null;
    }
    this.previousRecorderPendingBlocks = status.pendingBlocks;
    this.captureStatus = {
      ...this.captureStatus,
      recorder: status.state,
      recorderRateHz: this.configuration.recorderRateHz,
      recorderFrameIndex: status.recorderFrameIndex - 1,
      recorderGaps: status.explicitGaps,
      recorderPendingBlocks: status.pendingBlocks,
      recorderQueuedBlocks: status.queuedBlocks,
      recorderDurableAckSequence: status.durableAckSequence,
      recorderFinaliseStartAckSequence: status.finaliseStartAckSequence,
      recorderFinaliseTargetSequence: status.finaliseTargetSequence,
      lastError: status.error ?? this.captureStatus.lastError,
    };
    if (status.state !== previousRecorderState) {
    }
    const finalisationSignature = recorderFinalisationProgress(
      this.captureStatus,
      finalising,
    )?.signature ?? "";
    const finalisationProgress = recorderFinalisationProgress(this.captureStatus, finalising);
    if (finalisationProgress) {
    }
    if (this.activeRecorderEpisode
      && this.activeRecorderDurableAckBaseline !== null
      && status.durableAckSequence > this.activeRecorderDurableAckBaseline) {
      this.activeRecorderDurableAckBaseline = null;
    }
    if (status.state === "failed") {
      this.failRecorderWorkflow(this.activeRecorderEpisode);
    }
    this.refreshDirectSnapshotReadiness();
    if (!root) return;
    root.dataset.recorderPendingBlocks = String(status.pendingBlocks);
    root.dataset.recorderQueuedBlocks = String(status.queuedBlocks);
    root.dataset.recorderDurableAckSequence = String(status.durableAckSequence);
    root.dataset.recorderFinaliseStartAckSequence = String(status.finaliseStartAckSequence ?? "");
    root.dataset.recorderFinaliseTargetSequence = String(status.finaliseTargetSequence ?? "");
    this.publishCaptureStatus();
    this.renderCaptureDiagnostics(root);
    if (previousRecorderState !== status.state
      || (previousPendingBlocks === 0) !== (status.pendingBlocks === 0)
      || previousFinalisationSignature !== finalisationSignature) {
      this.renderXrTaskHud();
    }
    if (status.state === "failed") {
      if (this.snapshot?.currentEpisode || this.snapshot?.pendingEpisode) {
        void this.stopRecorders(root).catch(() => undefined);
        this.sendDemonstratorControl(root, "stop");
      }
      this.reportError(root, status.error || "The durable recorder path failed", false);
    }
  }

  private failRecorderFinalisation(root: HTMLElement, error: unknown) {
    const detail = error instanceof Error ? error.message : "The recorder did not finish cleanly";
    const message = `Recorder finalisation failed: ${detail}`.slice(0, 512);
    if (!this.recorderFinalisationFailureReported) {
      this.recorderFinalisationFailureReported = true;
    }
    this.updateCaptureStatus(root, { recorder: "failed", lastError: message });
    this.renderXrTaskHud();
    this.setStatus(root, message, true);
    return message;
  }

  private reportSensorCaptureFailure(root: HTMLElement, error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    if (!this.sensorLoopFailureReported) {
      this.sensorLoopFailureReported = true;
    }
    this.reportError(root, message, false);
  }

  private reportError(root: HTMLElement, message: string, emitDiagnostic = true) {
    if (this.disposed || this.captureAuthorityRevoked) return;
    if (message === PASS_FAIL_REVIEW_NOTICE) {
      this.showRunControlNotice(root, message);
      return;
    }
    this.updateCaptureStatus(root, { camera: this.captureStatus.camera === "requesting" ? "error" : this.captureStatus.camera, xr: this.captureStatus.xr === "requesting" ? "error" : this.captureStatus.xr, lastError: message });
    if (/camera|video|source|stream|device|permission|timeout/i.test(message)) {
      this.showCameraError(root, message);
      this.setStatus(root, "Camera needs attention");
      return;
    }
    this.setStatus(root, message, true);
  }

  private showRunControlNotice(root: HTMLElement, message: string) {
    this.clearRunControlNotice();
    this.runControlNotice = {
      message,
      expiresAtMs: performance.now() + 4_000,
      presentation: {
        label: xrAlertLabel(message) ?? message,
        dangerRatio: .12,
        tapeOpacity: .22,
        pulseIntervalMs: 1_600,
      },
    };
    this.setStatus(root, message, true);
    this.runControlNoticeTimer = window.setTimeout(() => {
      this.clearRunControlNotice();
      this.renderXrReticleOverlay();
    }, 4_000);
    this.renderXrReticleOverlay();
  }

  private clearRunControlNotice() {
    if (this.runControlNoticeTimer !== null) window.clearTimeout(this.runControlNoticeTimer);
    this.runControlNoticeTimer = null;
    const root = this.mountedRoot;
    const notice = this.runControlNotice;
    this.runControlNotice = null;
    if (root && notice && root.querySelector("#capture-status")?.textContent === notice.message) this.setStatus(root, "");
  }

  private showCameraError(root: HTMLElement, message: string) {
    const empty = root.querySelector<HTMLElement>(".capture-video-empty")!;
    const status = root.querySelector<HTMLElement>("#camera-field-status")!;
    status.textContent = message;
    status.hidden = false;
    empty.classList.remove("is-hidden");
    empty.classList.add("has-error");
  }

  private renderCaptureDiagnostics(root: HTMLElement) {
    if (this.bridge) {
      const camerasReady = this.captureStatus.camera === "ready" && this.bridgeCameraReady();
      this.setStatusPill(root, "#join-camera-state", camerasReady ? "OK" : this.captureStatus.camera === "requesting" ? "WAIT" : this.captureStatus.camera === "error" || this.captureStatus.camera === "ready" ? "ERR" : "IDLE");
      this.setStatusPill(root, "#join-key-state", this.bridge.ready ? "OK" : "WAIT");
      this.setStatusPill(root, "#join-session-state", this.bridge.streaming ? "OK" : this.xrSession ? "WAIT" : "IDLE");
      this.setXrStatusPill(root, this.captureStatus.xr === "active" ? "READY" : "IDLE");
      this.renderCaptureModeSelector(root);
      const active = Boolean(this.xrSession) || this.captureStatus.xr === "requesting";
      const button = root.querySelector<HTMLButtonElement>("#enter-xr")!;
      button.disabled = active || !this.bridge.ready || (this.bridgeCamera !== null && !camerasReady);
      button.title = active ? "Bridge XR is starting or active"
        : !this.bridge.ready ? "Pair a receiver before entering XR"
        : this.bridgeCamera !== null && !camerasReady ? "Reconnect the selected camera before entering XR"
        : "Launch Bridge XR";
      root.querySelector<HTMLSelectElement>("#camera-select")!.disabled = active || this.captureStatus.camera === "requesting" || !this.cameraChoices.length;
      root.querySelector<HTMLButtonElement>("#prepare-camera")!.disabled = active || this.captureStatus.camera === "requesting" || !cameraAccessCapability().available;
      renderCaptureSetup(root, this.bridge.ready, camerasReady, this.captureStatus.xr === "active");
      return;
    }
    const soloMode = this.authority.kind === "solo";
    const camera = this.captureAuthorityRevoked ? "ERR" : this.captureStatus.camera === "ready" ? "OK" : this.captureStatus.camera === "requesting" ? "WAIT" : this.captureStatus.camera === "error" ? "ERR" : "IDLE";
    const key = soloMode
      ? this.captureAuthorityRevoked ? "ERR" : this.connected ? "OK" : "WAIT"
      : this.pairingInvite ? this.connected ? "OK" : "WAIT" : "AUTH";
    const session = soloMode
      ? this.captureAuthorityRevoked || this.captureStatus.recorder === "failed"
        ? "ERR"
        : this.captureStatus.recorder === "armed"
          ? "OK"
          : "WAIT"
      : this.captureAuthorityRevoked ? "ERR" : this.connected ? "OK" : this.sessionKey ? "WAIT" : "AUTH";
    const xr = this.captureStatus.xr === "active"
      ? "READY"
      : this.captureStatus.xr === "error" || this.captureStatus.xr === "ended"
        ? "NOT AVAILABLE"
        : "IDLE";
    this.setStatusPill(root, "#join-camera-state", camera);
    this.setStatusPill(root, "#join-key-state", key);
    this.setStatusPill(root, "#join-session-state", session);
    this.setXrStatusPill(root, xr);
    this.renderCaptureModeSelector(root);
    const enterXr = root.querySelector<HTMLButtonElement>("#enter-xr")!;
    enterXr.hidden = false;
    const xrLaunchReady = captureXrLaunchReady({
      invitation: this.authority.supportsPairing ? Boolean(this.pairingInvite) : this.connected,
      intentGranted: this.captureIntentGranted,
      controlConnected: this.connected,
      recorder: this.captureStatus.recorder,
      xr: this.captureStatus.xr,
      secureContext: globalThis.isSecureContext,
      authorityRevoked: this.captureAuthorityRevoked,
    });
    enterXr.disabled = !xrLaunchReady || !(this.isXrLaunchAllowed?.() ?? true);
    enterXr.title = enterXr.disabled
      ? soloMode
        ? "Enable the camera and wait for the local recorder"
        : "Pair the capture director and wait for durable recorder readiness"
      : soloMode ? "Launch Solo XR" : "Launch demonstrator XR";
    if (!soloMode) renderCaptureSetup(root, this.connected, this.captureStatus.camera === "ready", this.captureStatus.xr === "active");
    if (this.onLaunchStateChange) {
      // Diagnostics also render from the XR frame path, so notify only on state transitions.
      const camera = this.captureStatus.camera;
      const recorder = this.captureStatus.recorder;
      const xr = this.captureStatus.xr;
      const xrLaunchReady = !enterXr.disabled;
      const leftHandRecognition: CaptureLaunchPresentationState["leftHandRecognition"] = this.authority.kind === "solo" && this.xrSession
        ? this.soloHandRecognition.left ? "recognised" : "missing"
        : "waiting";
      const rightHandRecognition: CaptureLaunchPresentationState["rightHandRecognition"] = this.authority.kind === "solo" && this.xrSession
        ? this.soloHandRecognition.right ? "recognised" : "missing"
        : "waiting";
      const previous = this.launchPresentationState;
      if (!previous
        || previous.camera !== camera
        || previous.recorder !== recorder
        || previous.xr !== xr
        || previous.xrLaunchReady !== xrLaunchReady
        || previous.leftHandRecognition !== leftHandRecognition
        || previous.rightHandRecognition !== rightHandRecognition) {
        const next = { camera, recorder, xr, xrLaunchReady, leftHandRecognition, rightHandRecognition };
        this.launchPresentationState = next;
        this.onLaunchStateChange(next);
      }
    }
  }

  private setStatusPill(root: HTMLElement, selector: string, value: "IDLE" | "WAIT" | "OK" | "AUTH" | "ERR") {
    const node = root.querySelector<HTMLElement>(selector)!;
    node.textContent = value;
    node.className = `status-pill is-${value.toLowerCase()}`;
  }

  private setStatus(root: HTMLElement, message: string, error = false) {
    const node = root.querySelector<HTMLElement>("#capture-status");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", error);
    if (this.bridge) node.hidden = !message;
  }

  private setXrStatusPill(root: HTMLElement, value: "READY" | "NOT AVAILABLE" | "IDLE") {
    const node = root.querySelector<HTMLElement>("#join-xr-state")!;
    node.textContent = value;
    node.className = `status-pill ${value === "READY" ? "is-ok" : value === "NOT AVAILABLE" ? "is-err" : "is-idle"}`;
  }
}

function isDirectRunState(value: unknown): value is DirectRunState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (!state.features || typeof state.features !== "object"
    || typeof (state.features as Record<string, unknown>).speech !== "boolean") return false;
  if (typeof state.recording !== "boolean") return false;
  if (state.currentEpisode !== null && (typeof state.currentEpisode !== "object" || !state.currentEpisode)) return false;
  if (state.pendingEpisode !== null && (typeof state.pendingEpisode !== "object" || !state.pendingEpisode)) return false;
  if (!state.run || typeof state.run !== "object") return false;
  const run = state.run as Record<string, unknown>;
  const nullableFinite = (entry: unknown) => entry === null || (typeof entry === "number" && Number.isFinite(entry));
  return ["stopped", "running", "complete", "error"].includes(String(run.status))
    && (run.phase === null || ["active-task", "post-task-pause", "task-pause", "cycle-pause"].includes(String(run.phase)))
    && ["idle", "arming", "recording", "paused", "stopping"].includes(String(run.recordingState))
    && nullableFinite(run.startedAtMs)
    && nullableFinite(run.endedAtMs)
    && Number.isSafeInteger(run.cycle)
    && Number.isSafeInteger(run.activeTaskIndex)
    && Number.isSafeInteger(run.repetition)
    && Number.isSafeInteger(run.take)
    && nullableFinite(run.takeStartedAtMs)
    && typeof run.takeElapsedMs === "number"
    && Number.isFinite(run.takeElapsedMs)
    && nullableFinite(run.recordingStartedAtMs)
    && typeof run.recordingElapsedMs === "number"
    && Number.isFinite(run.recordingElapsedMs)
    && (run.reviewEpisodeId === null || typeof run.reviewEpisodeId === "string")
    && nullableFinite(run.resetDeadlineMs)
    && (run.error === null || typeof run.error === "string");
}
