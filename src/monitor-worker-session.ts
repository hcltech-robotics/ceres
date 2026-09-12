import { isStateBoundRunControlAction, nextRunControlCursor, type CaptureConfiguration, type ClientMessage, type SensorFrame, type ServerMessage, type SessionSnapshot } from "../shared/protocol.js";
import type { HandDisplaySettings, HandMeshStatus } from "../shared/hand-display.js";
import type { CameraRegistration } from "../shared/camera-registration.js";
import { workerErrorFromEvent } from "./worker-errors.js";

import { SessionClient, sessionWebSocketUrl } from "./session-client.js";

declare const __CERES_TEST_HEADLESS_RENDERING__: boolean;

export interface MonitorReadout {
  source: "live" | "episode";
  frameIndex: number;
  traceCount: number;
  headPosition: [number, number, number] | null;
  leftHandTracked: boolean;
  rightHandTracked: boolean;
  leftWristPosition: [number, number, number] | null;
  leftWristRotation: [number, number, number, number] | null;
  rightWristPosition: [number, number, number] | null;
  rightWristRotation: [number, number, number, number] | null;
  handProjectionRegistered: boolean;
  leftProjectedJointCount: number;
  rightProjectedJointCount: number;
  trackedHandCount: number;
  manoLoaded: boolean;
  handMeshStatus: HandMeshStatus;
  leftHandEnergyMps: number;
  rightHandEnergyMps: number;
  leftHandWarning: boolean;
  rightHandWarning: boolean;
  leftPinch: number;
  rightPinch: number;
  droppedRenderFrames: number;
  overloadStage: number;
  renderer: "webgpu" | "canvas2d" | "none";
  renderDurationMs: number;
  gpuDurationMs: number | null;
  inboundKbps: number;
}

export interface MonitorVisualSettings extends HandDisplaySettings {
  signals: string[];
  cameraProjection: {
    width: number;
    height: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    distortion: number[];
  } | null;
  reticle: boolean;
  aid: boolean;
  trails: boolean;
}

type Listener<T> = (value: T) => void;

interface WorkerEventMessage {
  type: "event";
  event: string;
  value: unknown;
}

interface WorkerReadyMessage {
  type: "ready";
  renderer: "webgpu" | "canvas2d" | "none";
  crossOriginIsolated: boolean;
  handMeshStatus: HandMeshStatus;
}

type WorkerMessage = WorkerEventMessage | WorkerReadyMessage;

export class MonitorWorkerSession {
  private readonly listeners = new Map<string, Set<Listener<unknown>>>();
  private readonly worker = new Worker(new URL("./monitor-worker.ts", import.meta.url), { type: "module", name: "ceres-monitor" });
  private readonly controlSession: SessionClient;
  private readonly queuedMessages: ClientMessage[] = [];
  private readonly queuedControlMessages: ClientMessage[] = [];
  private ready = false;
  private workerConnected = false;
  private controlConnected = false;
  private peerConnected = false;
  private combinedConnection: boolean | null = null;
  private snapshot: SessionSnapshot | null = null;
  private closed = false;
  private workerFailureReported = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    readonly sessionId: string,
    readonly serverUrl: string | null = null,
    private readonly transportEnabled = true,
  ) {
    this.controlSession = new SessionClient(sessionId, "monitor-control", undefined, serverUrl);
    this.controlSession.on<boolean>("connection", (connected) => {
      this.controlConnected = connected;
      if (connected) this.flushControlMessages();
      this.emitCombinedConnection();
    });
    this.controlSession.on<SessionSnapshot>("snapshot", (snapshot) => {
      this.snapshot = snapshot;
      this.emit("snapshot", snapshot);
    });
    this.controlSession.on<{ resetId: string }>("session-restarted", (message) => this.emit("session-restarted", message));
    this.controlSession.on("error", (error) => this.emit("error", error));
    this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "ready") {
        this.ready = true;
        this.emit("monitor-renderer", {
          kind: event.data.renderer,
          crossOriginIsolated: event.data.crossOriginIsolated,
          handMeshStatus: event.data.handMeshStatus,
        });
        for (const message of this.queuedMessages.splice(0)) this.send(message);
        return;
      }
      if (event.data.event === "connection") {
        this.workerConnected = event.data.value === true;
        this.emitCombinedConnection();
        return;
      }
      if (event.data.event === "snapshot") return;
      this.emit(event.data.event, event.data.value);
    });
    this.worker.addEventListener("error", (event) => {
      const candidate = workerErrorFromEvent(event);
      const error = candidate instanceof Error
        ? candidate
        : new Error(event.message || "The monitor telemetry worker stopped");
      this.reportWorkerFailure(error, "worker_crash");
    });
    this.worker.addEventListener("messageerror", () => {
      this.reportWorkerFailure(
        new Error("The monitor telemetry worker returned an unreadable response"),
        "protocol",
      );
    });
  }

  connect(poseCanvas: HTMLCanvasElement, signalCanvas: HTMLCanvasElement) {
    const headlessTestRendering = typeof __CERES_TEST_HEADLESS_RENDERING__ !== "undefined"
      && __CERES_TEST_HEADLESS_RENDERING__;
    const supportsOffscreen = !headlessTestRendering
      && typeof poseCanvas.transferControlToOffscreen === "function"
      && typeof signalCanvas.transferControlToOffscreen === "function";
    const transfer: Transferable[] = [];
    let pose: OffscreenCanvas | null = null;
    let signal: OffscreenCanvas | null = null;
    if (supportsOffscreen) {
      pose = poseCanvas.transferControlToOffscreen();
      signal = signalCanvas.transferControlToOffscreen();
      transfer.push(pose, signal);
    }
    this.worker.postMessage({
      type: "init",
      sessionId: this.sessionId,
      wsUrl: this.transportEnabled ? sessionWebSocketUrl(this.serverUrl) : null,
      poseCanvas: pose,
      signalCanvas: signal,
      pixelRatio: Math.min(devicePixelRatio, 2),
    }, transfer);
    if (this.transportEnabled) this.controlSession.connect();
    if (supportsOffscreen) {
      const resize = () => this.worker.postMessage({
        type: "resize",
        poseWidth: Math.max(1, Math.round(poseCanvas.clientWidth * Math.min(devicePixelRatio, 2))),
        poseHeight: Math.max(1, Math.round(poseCanvas.clientHeight * Math.min(devicePixelRatio, 2))),
        signalWidth: Math.max(1, Math.round(signalCanvas.clientWidth * Math.min(devicePixelRatio, 2))),
        signalHeight: Math.max(1, Math.round(signalCanvas.clientHeight * Math.min(devicePixelRatio, 2))),
      });
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(poseCanvas);
      this.resizeObserver.observe(signalCanvas);
      resize();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.worker.postMessage({ type: "close" });
    this.worker.terminate();
    this.controlSession.dispose();
    this.listeners.clear();
    this.queuedMessages.length = 0;
    this.queuedControlMessages.length = 0;
    this.ready = false;
    this.workerConnected = false;
    this.controlConnected = false;
    this.peerConnected = false;
    this.combinedConnection = false;
    this.snapshot = null;
  }

  on<T>(event: string, listener: Listener<T>) {
    const entries = this.listeners.get(event) ?? new Set<Listener<unknown>>();
    entries.add(listener as Listener<unknown>);
    this.listeners.set(event, entries);
    return () => entries.delete(listener as Listener<unknown>);
  }

  configure(configuration: CaptureConfiguration) {
    this.sendControl({ type: "set-configuration", configuration });
  }

  control(
    action: "start-sequence" | "start" | "pause" | "stop" | "finish" | "success" | "fail" | "retry" | "resume" | "next" | "instructions",
    nextCursor?: string,
  ) {
    const actions = { next: "next-task", instructions: "show-instructions" } as const;
    const normalised = actions[action as keyof typeof actions] ?? action;
    if (isStateBoundRunControlAction(normalised)) {
      const cursor = nextCursor ?? (this.snapshot ? nextRunControlCursor(this.snapshot, normalised) : null);
      if (!cursor) return;
      this.sendControl({ type: "control", action: normalised, nextCursor: cursor });
      return;
    }
    this.sendControl({ type: "control", action: normalised });
  }

  send(message: ClientMessage) {
    if (this.closed) return;
    if (!this.ready) {
      this.queuedMessages.push(message);
      return;
    }
    this.worker.postMessage({ type: "send", message });
  }

  commitEpisodeUpload(message: Extract<ClientMessage, { type: "episode-upload-commit" }>) {
    if (this.closed) return Promise.reject(new Error("The monitor session is closed"));
    return this.controlSession.commitEpisodeUpload(message);
  }

  receivePeerMessage(message: Extract<ServerMessage, { type: "capture-status" | "sensor-frame" }>) {
    if (this.closed) return;
    this.worker.postMessage({ type: "peer-message", message });
  }

  setPeerConnected(connected: boolean) {
    if (this.closed || this.peerConnected === connected) return;
    this.peerConnected = connected;
    this.emitCombinedConnection();
  }

  get exportCapability() {
    return this.controlSession.exportCapability;
  }

  setVisualSettings(settings: MonitorVisualSettings) {
    this.worker.postMessage({ type: "visual-settings", settings });
  }

  setHandDisplay(settings: HandDisplaySettings) {
    this.sendControl({ type: "set-hand-display", settings });
  }

  setCameraRegistration(registration: CameraRegistration | null) {
    this.sendControl({ type: "set-camera-registration", registration });
  }

  restartSession(resetId: string) {
    this.sendControl({ type: "restart-session", resetId });
  }

  presentVideoFrame(captureTimestampMs: number) {
    this.worker.postMessage({ type: "video-frame", captureTimestampMs });
  }

  presentEpisodeFrames(frames: SensorFrame[]) {
    this.worker.postMessage({ type: "episode-replay", frames });
  }

  clearEpisodeReplay() {
    this.worker.postMessage({ type: "clear-episode-replay" });
  }

  private emit(event: string, value: unknown) {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }

  private reportWorkerFailure(error: Error, stage: "protocol" | "worker_crash") {
    if (this.closed || this.workerFailureReported) return;
    this.workerFailureReported = true;    this.ready = false;
    this.workerConnected = false;
    this.emitCombinedConnection();
    this.emit("error", { message: error.message });
  }

  private sendControl(message: ClientMessage) {
    if (this.closed) return;
    if (!this.controlConnected || !this.controlSession.send(message)) this.queuedControlMessages.push(message);
  }

  private flushControlMessages() {
    while (this.controlConnected && this.queuedControlMessages.length > 0) {
      const message = this.queuedControlMessages.shift()!;
      if (this.controlSession.send(message)) continue;
      this.queuedControlMessages.unshift(message);
      break;
    }
  }

  private emitCombinedConnection() {
    const connected = this.transportEnabled
      ? this.workerConnected && this.controlConnected
      : this.peerConnected;
    if (this.combinedConnection === connected) return;
    this.combinedConnection = connected;
    this.emit("connection", connected);
  }
}
