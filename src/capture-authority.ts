import type { CameraRegistration } from "../shared/camera-registration.js";
import type { HandDisplaySettings } from "../shared/hand-display.js";
import type {
  CaptureConfiguration,
  CaptureStatus,
  DirectBeamCommand,
  PromptAudioStatus,
  PromptDelivery,
  SensorFrame,
  ServerMessage,
  SessionSnapshot,
  SessionTelemetryMode,
  WebRtcSignal,
} from "../shared/protocol.js";
import type { DirectCaptureCommand, DirectRunControlAction } from "./direct-session-reducer.js";
import type { DirectRecorderCommandResult } from "./direct-recorder-command-boundary.js";
import type { TerminalCapturePairing } from "./session-client.js";

export type CaptureAuthorityKind = "paired" | "solo" | "bridge";
export type CaptureAuthorityControlAction = DirectRunControlAction | "instructions";
export type CaptureAuthorityControlMessage =
  | Extract<ServerMessage, { type: "control" }>
  | Extract<DirectCaptureCommand, { type: "control" }>;
export type CaptureAuthorityBeamMessage =
  | Extract<ServerMessage, { type: "beam" }>
  | DirectBeamCommand;

export interface CaptureAuthorityError {
  type?: "error";
  code?: string;
  message: string;
}

export interface CaptureAuthorityEventMap {
  "pairing-terminal": TerminalCapturePairing;
  "session-registered": Extract<ServerMessage, { type: "session-registered" }>;
  "pairing-rejected": Extract<ServerMessage, { type: "pairing-rejected" }>;
  "capture-intent-granted": Extract<ServerMessage, { type: "capture-intent-granted" }>;
  "capture-intent-suspended": Extract<ServerMessage, { type: "capture-intent-suspended" }>;
  "capture-authority-granted": Extract<ServerMessage, { type: "capture-authority-granted" }>;
  "hand-display": { type: "hand-display"; settings: HandDisplaySettings };
  "camera-registration": { type: "camera-registration"; registration: CameraRegistration | null };
  "webrtc-request-offer": Extract<ServerMessage, { type: "webrtc-request-offer" }>;
  "webrtc-signal": Extract<ServerMessage, { type: "webrtc-signal" }>;
  "voice-command": Extract<ServerMessage, { type: "voice-command" }>;
  connection: boolean;
  configuration: {
    type: "configuration";
    configuration: CaptureConfiguration;
    revision: number;
    checksum: string;
  };
  snapshot: SessionSnapshot;
  control: CaptureAuthorityControlMessage;
  beam: CaptureAuthorityBeamMessage;
  prompt: { type: "prompt"; delivery: PromptDelivery; useTextToSpeech: boolean };
  error: CaptureAuthorityError;
}

export interface CaptureRecorderTransport {
  sendBlock(sequence: number, block: ArrayBuffer): boolean;
  onControl(listener: (message: unknown) => void): () => void;
}

export interface CaptureAuthorityPort {
  readonly kind: CaptureAuthorityKind;
  readonly sessionId: string;
  readonly pairingId: string;
  readonly bufferedAmount: number;
  readonly supportsPairing: boolean;
  readonly supportsPeerMedia: boolean;
  readonly recorderTransport?: CaptureRecorderTransport;

  on<K extends keyof CaptureAuthorityEventMap>(
    event: K,
    listener: (value: CaptureAuthorityEventMap[K]) => void,
  ): () => void;
  on<T>(event: string, listener: (value: T) => void): () => void;

  connect(): void | Promise<void>;
  close(): void;
  dispose(): void | Promise<void>;
  control(action: CaptureAuthorityControlAction, nextCursor?: string): boolean;
  setHandDisplay(settings: HandDisplaySettings): boolean;
  publishTelemetryMode?(telemetryMode: SessionTelemetryMode): boolean;
  requestCaptureIntent(): boolean;
  markXrActive(): boolean;
  configurationApplied(revision: number, checksum: string): boolean;
  publishCaptureStatus(status: CaptureStatus): boolean;
  publishPromptAudioStatus(status: PromptAudioStatus): boolean;
  sendAudioForAsr?(mimeType: string, data: ArrayBuffer): boolean;
  acknowledgePrompt(
    deliveryId: string,
    state: "queued" | "started" | "completed" | "failed",
    error?: string,
  ): boolean;
  publishSensorFrame(frame: SensorFrame): boolean;
  publishRecorderResult(result: DirectRecorderCommandResult): boolean;
  publishWebRtcSignal(peerId: string, signal: WebRtcSignal): boolean;
}
