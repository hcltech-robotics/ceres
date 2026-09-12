import type { HandDisplaySettings } from "../shared/hand-display.js";
import type {
  CaptureStatus,
  PromptAudioStatus,
  SensorFrame,
  WebRtcSignal,
} from "../shared/protocol.js";
import type {
  CaptureAuthorityControlAction,
  CaptureAuthorityEventMap,
  CaptureAuthorityPort,
  CaptureRecorderTransport,
} from "./capture-authority.js";
import type { DirectCaptureCommand } from "./direct-session-reducer.js";
import type { DirectRecorderCommandResult } from "./direct-recorder-command-boundary.js";
import type { SoloSessionController } from "./solo-session-controller.js";

type AuthorityListener<T> = (value: T) => void;

export interface SoloCaptureAuthorityOptions {
  pairingId?: string;
}

export class SoloCaptureAuthority implements CaptureAuthorityPort {
  readonly kind = "solo" as const;
  readonly supportsPairing = false;
  readonly supportsPeerMedia = false;
  readonly pairingId: string;
  readonly recorderTransport: CaptureRecorderTransport;
  private readonly listeners = new Map<string, Set<AuthorityListener<unknown>>>();
  private readonly recorderControlListeners = new Set<(message: unknown) => void>();
  private connected = false;
  private mounted = false;
  private disposed = false;
  private captureIntentRequested = false;
  private xrActiveRequested = false;
  private connectionGeneration = 0;
  private connectionPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private operationTail = Promise.resolve();
  private bufferedCommands: DirectCaptureCommand[] | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;

  constructor(
    private readonly controller: SoloSessionController,
    options: SoloCaptureAuthorityOptions = {},
  ) {
    this.pairingId = options.pairingId ?? `solo-${controller.sessionId}`.slice(0, 128);
    this.recorderTransport = Object.freeze({
      sendBlock: (sequence: number, block: ArrayBuffer) => this.sendRecorderBlock(sequence, block),
      onControl: (listener: (message: unknown) => void) => {
        this.recorderControlListeners.add(listener);
        return () => {
          this.recorderControlListeners.delete(listener);
        };
      },
    });
  }

  get sessionId() {
    return this.controller.sessionId;
  }

  get bufferedAmount() {
    return 0;
  }

  on<K extends keyof CaptureAuthorityEventMap>(
    event: K,
    listener: (value: CaptureAuthorityEventMap[K]) => void,
  ): () => void;
  on<T>(event: string, listener: (value: T) => void): () => void;
  on<T>(event: string, listener: (value: T) => void) {
    const entries = this.listeners.get(event) ?? new Set<AuthorityListener<unknown>>();
    entries.add(listener as AuthorityListener<unknown>);
    this.listeners.set(event, entries);
    return () => {
      entries.delete(listener as AuthorityListener<unknown>);
      if (entries.size === 0) this.listeners.delete(event);
    };
  }

  connect() {
    if (this.disposed) {
      this.emitError("The Solo capture authority is disposed");
      return Promise.resolve();
    }
    if (this.connected) return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;
    const generation = ++this.connectionGeneration;
    const attempt = this.connectController(generation);
    const tracked = attempt.finally(() => {
      if (this.connectionPromise === tracked) this.connectionPromise = null;
    });
    this.connectionPromise = tracked;
    return tracked;
  }

  close() {
    const wasConnected = this.connected;
    this.connectionGeneration += 1;
    this.connected = false;
    this.captureIntentRequested = false;
    this.xrActiveRequested = false;
    this.bufferedCommands = null;
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.controller.setCaptureCommandSink(null);
    this.controller.setRecorderControlSink(null);
    if (wasConnected) this.emit("connection", false);
    if (this.mounted) {
      this.enqueueControllerOperation(() => this.controller.setCaptureConnected(false), true);
    }
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.close();
    this.disposed = true;
    this.disposePromise = (async () => {
      await this.whenIdle();
      await this.controller.dispose();
      this.listeners.clear();
      this.recorderControlListeners.clear();
    })();
    return this.disposePromise;
  }

  control(action: CaptureAuthorityControlAction, nextCursor?: string) {
    return this.enqueueControllerOperation(() => this.controller.control(action, nextCursor));
  }

  setHandDisplay(settings: HandDisplaySettings) {
    return this.enqueueControllerOperation(() => this.controller.setHandDisplay(settings));
  }

  requestCaptureIntent() {
    if (this.disposed) return false;
    this.captureIntentRequested = true;
    if (!this.connected) return false;
    this.emit("capture-intent-granted", { type: "capture-intent-granted" });
    return true;
  }

  markXrActive() {
    if (this.disposed) return false;
    this.captureIntentRequested = true;
    this.xrActiveRequested = true;
    if (!this.connected) return false;
    this.emit("capture-intent-granted", { type: "capture-intent-granted" });
    this.emit("capture-authority-granted", { type: "capture-authority-granted" });
    return true;
  }

  configurationApplied(revision: number, checksum: string) {
    return this.enqueueControllerOperation(() => (
      this.controller.configurationApplied(revision, checksum)
    ));
  }

  publishCaptureStatus(status: CaptureStatus) {
    return this.enqueueControllerOperation(() => this.controller.setCaptureStatus(status));
  }

  publishPromptAudioStatus(status: PromptAudioStatus) {
    return this.enqueueControllerOperation(() => this.controller.setPromptAudioStatus(status));
  }

  acknowledgePrompt(
    _deliveryId: string,
    _state: "queued" | "started" | "completed" | "failed",
    _error?: string,
  ) {
    return this.connected && !this.disposed;
  }

  publishSensorFrame(_frame: SensorFrame) {
    return this.connected && !this.disposed;
  }

  publishRecorderResult(result: DirectRecorderCommandResult) {
    return this.enqueueControllerOperation(() => this.controller.handleRecorderResult(result));
  }

  publishWebRtcSignal(_peerId: string, _signal: WebRtcSignal) {
    return false;
  }

  async whenIdle() {
    const connection = this.connectionPromise;
    if (connection) await connection;
    await this.operationTail;
  }

  private async connectController(generation: number) {
    this.bufferedCommands = [];
    this.controller.setCaptureCommandSink((commands) => this.receiveCaptureCommands(commands));
    this.controller.setRecorderControlSink((message) => {
      if (this.disposed) return;
      for (const listener of this.recorderControlListeners) listener(structuredClone(message));
    });
    try {
      if (!this.mounted) {
        await this.controller.mount(true);
        this.mounted = true;
      } else {
        await this.controller.setCaptureConnected(true);
        await this.controller.synchronise();
      }
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.connected = true;
      this.emit("connection", true);
      const commands = this.bufferedCommands ?? [];
      this.bufferedCommands = null;
      this.applyCaptureCommands(commands);
      this.unsubscribeSnapshot = this.controller.subscribe((snapshot) => {
        if (this.connected && !this.disposed) this.emit("snapshot", snapshot);
      });
      if (this.captureIntentRequested) {
        this.emit("capture-intent-granted", { type: "capture-intent-granted" });
      }
      if (this.xrActiveRequested) {
        this.emit("capture-authority-granted", { type: "capture-authority-granted" });
      }
    } catch (error) {
      if (generation !== this.connectionGeneration || this.disposed) return;
      this.connected = false;
      this.bufferedCommands = null;
      this.controller.setCaptureCommandSink(null);
      this.controller.setRecorderControlSink(null);
      this.emitError(error);
      this.emit("connection", false);
      throw error;
    }
  }

  private receiveCaptureCommands(commands: readonly DirectCaptureCommand[]) {
    if (this.bufferedCommands) {
      this.bufferedCommands.push(...structuredClone(commands));
      return;
    }
    if (this.connected && !this.disposed) this.applyCaptureCommands(commands);
  }

  private applyCaptureCommands(commands: readonly DirectCaptureCommand[]) {
    for (const command of commands) {
      if (command.type === "run-state") continue;
      if (command.type === "configuration") {
        this.emit("configuration", command);
      } else if (command.type === "hand-display") {
        this.emit("hand-display", command);
      } else if (command.type === "camera-registration") {
        this.emit("camera-registration", command);
      } else if (command.type === "control") {
        this.emit("control", command);
      } else if (command.type === "beam") {
        this.emit("beam", command);
      }
    }
  }

  private sendRecorderBlock(sequence: number, block: ArrayBuffer) {
    if (!this.connected || this.disposed) return false;
    try {
      return this.controller.appendRecorderBlock(sequence, block);
    } catch (error) {
      this.emitError(error);
      return false;
    }
  }

  private enqueueControllerOperation(
    operation: () => Promise<unknown>,
    allowDisconnected = false,
  ) {
    if (this.disposed || (!allowDisconnected && !this.connected)) return false;
    this.operationTail = this.operationTail
      .then(operation)
      .then(
        () => undefined,
        (error) => {
          if (!this.disposed) this.emitError(error);
        },
      );
    return true;
  }

  private emit<K extends keyof CaptureAuthorityEventMap>(
    event: K,
    value: CaptureAuthorityEventMap[K],
  ) {
    this.listeners.get(event)?.forEach((listener) => listener(structuredClone(value)));
  }

  private emitError(error: unknown) {
    const message = error instanceof Error && error.message.trim()
      ? error.message
      : typeof error === "string" && error.trim()
        ? error
        : "The Solo capture authority failed";
    this.emit("error", { type: "error", message });
  }
}
