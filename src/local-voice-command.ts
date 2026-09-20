import { workerErrorFromEvent } from "./worker-errors.js";
import { LocalVoiceCommandQueue } from "./local-voice-command-queue.js";
import { LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS } from "./local-voice-command-timing.js";
import type { LocalVoiceCommandAudioMessage } from "./local-voice-command-audio.js";

import type { HandDisplaySettings } from "../shared/hand-display.js";

export const localVoiceCommands = [
  "next",
  "pause",
  "stop",
  "finish",
  "done",
  "start",
  "redo",
  "pass",
  "fail",
  "mesh",
  "outline",
  "points",
  "normals",
  "velocity",
  "speed",
  "motion",
  "trail on",
  "trail off",
] as const;

export type LocalVoiceCommand = typeof localVoiceCommands[number];
export type LocalVoiceCommandStatus = "loading" | "ready" | "fallback" | "error";
export type LocalVoiceCommandAction =
  | "next"
  | "pause"
  | "stop"
  | "finish"
  | "start-sequence"
  | "retry"
  | "success"
  | "fail";

const localVoiceCommandAliases: Readonly<Record<string, LocalVoiceCommand>> = Object.freeze({
  "key points": "points",
  normal: "normals",
  paused: "pause",
  paws: "pause",
  point: "points",
  pose: "pause",
  "trails off": "trail off",
  "trails on": "trail on",
});

export interface LocalVoiceCommandOverlay {
  readonly durationMs: number;
  readonly label: string;
}

const LOCAL_VOICE_COMMAND_RECOVERY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export interface LocalVoiceCommandTimerHost {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(timer: number): void;
}

export class LocalVoiceCommandRecovery {
  private timer: number | null = null;
  private attempt = 0;

  get pending() {
    return this.timer !== null;
  }

  schedule(timerHost: LocalVoiceCommandTimerHost, retry: () => void) {
    if (this.timer !== null) return false;
    const delayMs = LOCAL_VOICE_COMMAND_RECOVERY_DELAYS_MS[this.attempt];
    if (delayMs === undefined) return false;
    this.attempt += 1;
    this.timer = timerHost.setTimeout(() => {
      this.timer = null;
      retry();
    }, delayMs);
    return true;
  }

  cancel(timerHost: LocalVoiceCommandTimerHost) {
    if (this.timer !== null) timerHost.clearTimeout(this.timer);
    this.timer = null;
  }

  reset(timerHost: LocalVoiceCommandTimerHost) {
    this.cancel(timerHost);
    this.attempt = 0;
  }
}

export type LocalVoiceCommandFailureKind =
  | "audio-worklet"
  | "microphone"
  | "model-assets"
  | "model-download"
  | "model-runtime"
  | "recognition";

export interface LocalVoiceCommandFailure {
  kind: LocalVoiceCommandFailureKind;
  diagnosticDetail: string;
}

export const LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE = "Voice command files are missing from this CERES installation. Repair the installation, then reload.";

export function localVoiceCommandOverlay(
  status: LocalVoiceCommandStatus,
  detail?: string,
  failureKind?: LocalVoiceCommandFailureKind,
): LocalVoiceCommandOverlay {
  if (status === "ready") return { durationMs: 3_500, label: "VOICE: LOCAL COMMANDS READY" };
  if (status === "fallback") return { durationMs: 4_500, label: "VOICE: CPU COMMANDS READY" };
  if (status === "loading") return { durationMs: 5_500, label: "VOICE: PREPARING LOCAL RECOGNISER" };
  return { durationMs: 7_000, label: `VOICE: ${localVoiceCommandFailureLabel(detail, failureKind)}` };
}

export function localVoiceCommandFailureLabel(detail?: string, kind = localVoiceCommandFailureKind(detail)) {
  if (kind === "microphone") return "MICROPHONE ACCESS FAILED";
  if (kind === "audio-worklet") return "AUDIO WORKLET FAILED";
  if (kind === "model-assets") return "COMMAND FILES MISSING";
  if (kind === "model-runtime") return "MODEL RUNTIME FAILED";
  if (kind === "model-download") return "MODEL DOWNLOAD FAILED";
  return "LOCAL RECOGNISER FAILED";
}

export function localVoiceCommandFailureKind(detail?: string): LocalVoiceCommandFailureKind {
  const value = detail?.trim() ?? "";
  if (/notallowed|permission|microphone/i.test(value)) return "microphone";
  if (/audioworklet|worklet|audiocontext|web audio/i.test(value)) return "audio-worklet";
  if (value === LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE || /file was not found locally|local file missing at/i.test(value)) {
    return "model-assets";
  }
  if (/fetch|network|download|dynamically imported module|failed to import|loading chunk|connection|https?:/i.test(value)) {
    return "model-download";
  }
  if (/wasm|webassembly|onnx|runtime|ort/i.test(value)) return "model-runtime";
  if (/load|model/i.test(value)) return "model-download";
  return "recognition";
}

export function localVoiceCommandStartupFailureRetryable(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (["AbortError", "InvalidStateError", "NetworkError"].includes(name)) return true;
  if (["NotAllowedError", "NotSupportedError", "SecurityError"].includes(name)) return false;
  const detail = error instanceof Error ? error.message : String(error);
  if (/requires Web Audio support|not supported|not implemented|not available/i.test(detail)) return false;
  return /aborted|failed to fetch|interrupted|network|temporary|temporarily/i.test(detail);
}

export function localVoiceCommandRecognitionEnabled(
  runtimeFeaturesLoaded: boolean,
  runtimeFeaturesAvailable: boolean,
) {
  return runtimeFeaturesLoaded && runtimeFeaturesAvailable;
}

export function microphoneCaptureRequired(
  recordAudio: boolean,
  localRecognitionEnabled: boolean,
) {
  return recordAudio || localRecognitionEnabled;
}

export function normaliseLocalVoiceCommand(value: string): LocalVoiceCommand | null {
  const normalised = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ");
  return localVoiceCommands.find((command) => command === normalised)
    ?? localVoiceCommandAliases[normalised]
    ?? null;
}

export function localVoiceCommandAction(command: LocalVoiceCommand): LocalVoiceCommandAction | null {
  if (command === "next") return "next";
  if (command === "redo") return "retry";
  if (command === "pass") return "success";
  if (command === "fail") return "fail";
  if (command === "start") return "start-sequence";
  if (command === "finish" || command === "done") return "finish";
  if (command === "pause" || command === "stop") return command;
  return null;
}

export function localVoiceCommandHandDisplayControl(
  command: LocalVoiceCommand,
): keyof HandDisplaySettings | null {
  if (command === "mesh" || command === "outline" || command === "points") {
    return "handMode";
  }
  if (
    command === "normals"
    || command === "velocity"
    || command === "speed"
    || command === "motion"
  ) {
    return "handShading";
  }
  if (command === "trail on" || command === "trail off") return "handTrail";
  return null;
}

export function localVoiceCommandHandDisplaySettings(
  settings: HandDisplaySettings,
  command: LocalVoiceCommand,
): HandDisplaySettings | null {
  if (command === "mesh" || command === "outline") {
    return { ...settings, handMode: command };
  }
  if (command === "points") return { ...settings, handMode: "keypoints" };
  if (command === "normals") return { ...settings, handShading: "normal" };
  if (command === "velocity" || command === "speed") {
    return { ...settings, handShading: "velocity" };
  }
  if (command === "motion") return { ...settings, handShading: "motion" };
  if (command === "trail on") return { ...settings, handTrail: "cog" };
  if (command === "trail off") return { ...settings, handTrail: "off" };
  return null;
}

type LocalVoiceCommandWorkerMessage =
  | {
    type: "status";
    status: LocalVoiceCommandStatus;
    detail?: string;
    failure?: LocalVoiceCommandFailure;
  }
  | { type: "result"; requestId: number; command?: LocalVoiceCommand; successful: boolean };

export interface LocalVoiceCommandControllerOptions {
  stream: MediaStream;
  getContext?(): string;
  onCommand(command: LocalVoiceCommand, context?: string): void;
  onStatus(status: LocalVoiceCommandStatus, detail?: string, failure?: LocalVoiceCommandFailure): void;
  onRecognitionChange?(active: boolean): void;
  onRecognitionSuccess?(): void;
  onFatalError?(detail: string): void;
}

async function localVoiceCommandWorkletUrl() {
  const workletModule = await import("./local-voice-command.worklet.ts?worker&url");
  return workletModule.default;
}

/**
 * Captures microphone samples once and sends short speech utterances to a
 * dedicated local inference worker. The recorder continues to own durable
 * audio and is never delayed by model loading or inference.
 */
export class LocalVoiceCommandController {
  private worker!: Worker;
  private readonly queue = new LocalVoiceCommandQueue();
  private readonly stream: MediaStream;
  private readonly getContext: LocalVoiceCommandControllerOptions["getContext"];
  private readonly onCommand: LocalVoiceCommandControllerOptions["onCommand"];
  private readonly onStatus: LocalVoiceCommandControllerOptions["onStatus"];
  private readonly onRecognitionChange: LocalVoiceCommandControllerOptions["onRecognitionChange"];
  private readonly onRecognitionSuccess: LocalVoiceCommandControllerOptions["onRecognitionSuccess"];
  private readonly onFatalError: LocalVoiceCommandControllerOptions["onFatalError"];
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private silentOutput: GainNode | null = null;
  private disposed = false;
  private workerFailed = false;
  private workerReady = false;
  private recognitionActive = false;
  private consecutiveInferenceFailures = 0;
  private inferenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LocalVoiceCommandControllerOptions) {
    this.stream = options.stream;
    this.getContext = options.getContext;
    this.onCommand = options.onCommand;
    this.onStatus = options.onStatus;
    this.onRecognitionChange = options.onRecognitionChange;
    this.onRecognitionSuccess = options.onRecognitionSuccess;
    this.onFatalError = options.onFatalError;
    this.initialiseWorker();
  }

  private initialiseWorker() {
    const worker = new Worker(new URL("./local-voice-command.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.addEventListener("message", (event: MessageEvent<LocalVoiceCommandWorkerMessage>) => {
      if (worker === this.worker) this.receiveWorkerMessage(event.data);
    });
    worker.addEventListener("error", (event) => {
      if (worker !== this.worker) return;
      const error = workerErrorFromEvent(event) ?? new Error("Local voice command worker failed");
      this.failWorker(error instanceof Error ? error.message : "Local voice command worker failed");
    });
    worker.addEventListener("messageerror", () => {
      if (worker !== this.worker) return;
      const error = new Error("Local voice command worker returned an unreadable response");
      this.failWorker(error.message);
    });
    worker.postMessage({ type: "initialise" });
  }

  async start() {
    if (this.disposed || this.workerFailed || this.audioContext) return;
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("Local voice commands require Web Audio support");
    const audioContext = new AudioContextConstructor();
    try {
      // Resume while this is still part of the camera-start gesture. Quest Browser
      // otherwise leaves a newly created context suspended after media permission.
      if (audioContext.state === "suspended") await audioContext.resume();
      await audioContext.audioWorklet.addModule(await localVoiceCommandWorkletUrl());
      if (this.disposed || this.workerFailed) {
        await audioContext.close();
        return;
      }
      const source = audioContext.createMediaStreamSource(this.stream);
      const captureNode = new AudioWorkletNode(audioContext, "ceres-local-voice-capture");
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      captureNode.addEventListener("processorerror", () => {
        const error = new Error("Local voice command audio processor failed");
        this.failWorker(error.message);
      });
      captureNode.port.addEventListener("message", (event: MessageEvent<LocalVoiceCommandAudioMessage>) => {
        this.receiveAudioMessage(event.data);
      });
      captureNode.port.start();
      source.connect(captureNode).connect(silentOutput).connect(audioContext.destination);
      this.audioContext = audioContext;
      this.source = source;
      this.captureNode = captureNode;
      this.silentOutput = silentOutput;
    } catch (error) {
      if (audioContext.state !== "closed") await audioContext.close();
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.setRecognitionActive(false);
    this.disposed = true;
    this.clearInferenceTimer();
    this.queue.clear();
    this.stopAudioForwarding();
    this.worker.terminate();
  }

  private stopAudioForwarding() {
    this.captureNode?.port.close();
    this.captureNode?.disconnect();
    this.source?.disconnect();
    this.silentOutput?.disconnect();
    if (this.audioContext && this.audioContext.state !== "closed") void this.audioContext.close();
    this.captureNode = null;
    this.source = null;
    this.silentOutput = null;
    this.audioContext = null;
  }

  private failWorker(detail: string) {
    if (this.disposed || this.workerFailed) return;
    this.workerFailed = true;
    this.workerReady = false;
    this.clearInferenceTimer();
    this.queue.clear();
    this.setRecognitionActive(false);
    this.stopAudioForwarding();
    this.worker.terminate();
    this.onStatus("error", detail);
    this.onFatalError?.(detail);
  }

  private receiveWorkerMessage(message: LocalVoiceCommandWorkerMessage) {
    if (this.disposed || this.workerFailed) return;
    if (message.type === "status" && message.status) {
      if (message.status === "ready" || message.status === "fallback") this.workerReady = true;
      else if (message.status === "loading") this.workerReady = false;
      this.onStatus(message.status, message.detail, message.failure);
      this.dispatchPending();
      return;
    }
    if (message.type !== "result") return;
    const completed = this.queue.complete(message.requestId, performance.now());
    if (!completed) return;
    this.clearInferenceTimer();
    this.setRecognitionActive(false);
    this.consecutiveInferenceFailures = message.successful ? 0 : this.consecutiveInferenceFailures + 1;
    if (this.consecutiveInferenceFailures >= 2) {
      this.replaceWorker();
      return;
    }
    try {
      if (message.successful) this.onRecognitionSuccess?.();
      if (message.successful && message.command && completed.fresh && this.contextMatches(completed.request.context)) {
        this.onCommand(message.command, completed.request.context);
      }
    } finally {
      this.dispatchPending();
    }
  }

  private receiveAudioMessage(message: LocalVoiceCommandAudioMessage) {
    if (this.disposed || this.workerFailed) return;
    if (message.type === "speech-start") {
      this.queue.start(message.utteranceId, performance.now(), this.getContext?.());
    } else if (message.type === "speech-cancel") {
      this.queue.cancel(message.utteranceId);
    } else if (message.type === "audio" && message.samples instanceof Float32Array) {
      this.queue.capture(message.utteranceId, message.samples, message.sampleRate, performance.now());
      this.dispatchPending();
    }
  }

  private dispatchPending() {
    if (this.disposed || this.workerFailed || !this.workerReady) return;
    const request = this.queue.next(performance.now());
    if (!request) return;
    if (!this.contextMatches(request.context)) {
      this.queue.abandon(request.requestId);
      return;
    }
    this.setRecognitionActive(true);
    this.inferenceTimer = setTimeout(() => this.replaceStalledWorker(request.requestId), LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS);
    try {
      this.worker.postMessage({
        type: "audio",
        requestId: request.requestId,
        samples: request.samples,
        sampleRate: request.sampleRate,
      }, [request.samples.buffer]);
    } catch (error) {
      this.failWorker(error instanceof Error ? error.message : "Local voice command audio could not reach the worker");
    }
  }

  private contextMatches(context: string | undefined) {
    return !this.getContext || context === this.getContext();
  }

  private clearInferenceTimer() {
    if (this.inferenceTimer !== null) clearTimeout(this.inferenceTimer);
    this.inferenceTimer = null;
  }

  private replaceStalledWorker(requestId: number) {
    if (this.disposed || this.workerFailed) return;
    if (!this.queue.abandon(requestId)) return;
    this.replaceWorker();
  }

  private replaceWorker() {
    if (this.disposed || this.workerFailed) return;
    this.clearInferenceTimer();
    this.consecutiveInferenceFailures = 0;
    this.workerReady = false;
    this.setRecognitionActive(false);
    this.worker.terminate();
    this.onStatus("loading", "Restarting local voice recogniser");
    try {
      this.initialiseWorker();
    } catch (error) {
      this.failWorker(error instanceof Error ? error.message : "Local voice command worker could not restart");
    }
  }

  private setRecognitionActive(active: boolean) {
    if (this.recognitionActive === active) return;
    this.recognitionActive = active;
    this.onRecognitionChange?.(active);
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
