import type { HandDisplaySettings } from "../shared/hand-display.js";
import type {
  CaptureStatus,
  ClientMessage,
  PromptAudioStatus,
  SensorFrame,
  SessionTelemetryMode,
  WebRtcSignal,
} from "../shared/protocol.js";
import type {
  CaptureAuthorityControlAction,
  CaptureAuthorityEventMap,
  CaptureAuthorityPort,
} from "./capture-authority.js";
import type { DirectRecorderCommandResult } from "./direct-recorder-command-boundary.js";
import type { SessionClient } from "./session-client.js";

export interface PairedCaptureSessionClient {
  readonly sessionId: string;
  readonly role: string;
  readonly pairingId: string | null;
  readonly bufferedAmount: number;
  on<T>(event: string, listener: (value: T) => void): () => void;
  connect(): void;
  close(): void;
  dispose(): void;
  control(action: CaptureAuthorityControlAction, nextCursor?: string): boolean;
  setHandDisplay(settings: HandDisplaySettings): void;
  requestCaptureIntent(): boolean;
  markXrActive(): boolean;
  send(message: ClientMessage): boolean;
  sendLossy(message: ClientMessage, bufferedAmountLimit?: number): boolean;
}

export class SessionClientCaptureAuthority implements CaptureAuthorityPort {
  readonly kind = "paired" as const;
  readonly supportsPairing = true;
  readonly supportsPeerMedia = true;

  constructor(private readonly session: PairedCaptureSessionClient | SessionClient) {
    if (session.role !== "capture") {
      throw new Error("The paired capture authority requires a capture SessionClient");
    }
    if (!session.pairingId) {
      throw new Error("The paired capture authority requires a pairing identity");
    }
  }

  get sessionId() {
    return this.session.sessionId;
  }

  get pairingId() {
    return this.session.pairingId!;
  }

  get bufferedAmount() {
    return this.session.bufferedAmount;
  }

  on<K extends keyof CaptureAuthorityEventMap>(
    event: K,
    listener: (value: CaptureAuthorityEventMap[K]) => void,
  ): () => void;
  on<T>(event: string, listener: (value: T) => void): () => void;
  on<T>(event: string, listener: (value: T) => void) {
    return this.session.on(event, listener);
  }

  connect() {
    this.session.connect();
  }

  close() {
    this.session.close();
  }

  dispose() {
    this.session.dispose();
  }

  control(action: CaptureAuthorityControlAction, nextCursor?: string) {
    return this.session.control(action, nextCursor);
  }

  setHandDisplay(settings: HandDisplaySettings) {
    this.session.setHandDisplay(settings);
    return true;
  }

  publishTelemetryMode(telemetryMode: SessionTelemetryMode) {
    return this.session.send({ type: "set-telemetry-mode", telemetryMode });
  }

  requestCaptureIntent() {
    return this.session.requestCaptureIntent();
  }

  markXrActive() {
    return this.session.markXrActive();
  }

  configurationApplied(revision: number, checksum: string) {
    return this.session.send({ type: "configuration-applied", revision, checksum });
  }

  publishCaptureStatus(status: CaptureStatus) {
    return this.session.send({ type: "capture-status", status });
  }

  publishPromptAudioStatus(status: PromptAudioStatus) {
    return this.session.send({ type: "prompt-audio-status", status });
  }

  sendAudioForAsr(mimeType: string, data: ArrayBuffer) {
    return this.session.send({
      type: "audio-chunk",
      mimeType,
      sequence: this.asrAudioSequence++,
      dataBase64: bytesToBase64(new Uint8Array(data)),
    });
  }

  acknowledgePrompt(
    deliveryId: string,
    state: "queued" | "started" | "completed" | "failed",
    error?: string,
  ) {
    return this.session.send({
      type: "prompt-ack",
      deliveryId,
      state,
      ...(error ? { error } : {}),
    });
  }

  publishSensorFrame(frame: SensorFrame) {
    return this.session.sendLossy({ type: "sensor-frame", frame });
  }

  publishRecorderResult(result: DirectRecorderCommandResult) {
    if (result.type === "recording-accepted") {
      return this.session.send({
        type: "recording-accepted",
        episodeId: result.episodeId,
      });
    }
    if (result.type === "recording-finalised") {
      return this.session.send({
        type: "recording-finalised",
        episodeId: result.episodeId,
        ...(result.error ? { error: result.error } : {}),
      });
    }
    return false;
  }

  publishWebRtcSignal(peerId: string, signal: WebRtcSignal) {
    return this.session.send({ type: "webrtc-signal", peerId, signal });
  }

  private asrAudioSequence = 0;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
