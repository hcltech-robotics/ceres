import type { Transcriber } from "@moonshine-ai/moonshine-wasm";
import model from "../shared/local-voice-model.json";
import runtime from "../shared/local-voice-runtime.json";
import { localVoiceCommandKeyterms, normaliseLocalVoiceCommand, type LocalVoiceCommandFailure } from "./local-voice-command.js";
import { localVoiceCommandInitialisationRetryDelay } from "./local-voice-command-timing.js";
import { LocalVoiceModelRecovery } from "./local-voice-model-recovery.js";
import { transcribeLocalVoiceUtterance } from "./local-voice-transcriber.js";

let transcriber: Transcriber | null = null;
let loading: Promise<void> | null = null;
let retryInitialisationAt = 0;
let retryInitialisationTimer: ReturnType<typeof setTimeout> | null = null;
let retryInitialisationAttempt = 0;
const modelRecovery = new LocalVoiceModelRecovery();
declare const __CERES_ALLOW_REMOTE_MODELS__: boolean;

function postStatus(status: "loading" | "ready" | "error", detail?: string, failure?: LocalVoiceCommandFailure) {
  postMessage({ type: "status", status, detail, failure });
}

function scheduleInitialisationRetry() {
  if (retryInitialisationTimer !== null || transcriber || modelRecovery.blocked) return;
  const delayMs = localVoiceCommandInitialisationRetryDelay(retryInitialisationAttempt++);
  retryInitialisationAt = Date.now() + delayMs;
  retryInitialisationTimer = setTimeout(() => {
    retryInitialisationTimer = null;
    void initialise();
  }, delayMs);
}

async function initialise() {
  if (transcriber || modelRecovery.blocked) return;
  if (loading) return loading;
  if (Date.now() < retryInitialisationAt) return;
  loading = (async () => {
    postStatus("loading", "Loading local voice commands");
    const allowRemoteModels = typeof __CERES_ALLOW_REMOTE_MODELS__ !== "undefined" && __CERES_ALLOW_REMOTE_MODELS__;
    try {
      if (!globalThis.crossOriginIsolated) throw new Error("Moonshine WebAssembly requires cross-origin isolation");
      // Keep the upstream module and its pthread entry together at our origin.
      // The build packages them separately from the recorder and XR bundles.
      const sdkUrl = new URL(`${runtime.basePath}index.js`, self.location.href).href;
      const sdk = await import(/* @vite-ignore */ sdkUrl) as typeof import("@moonshine-ai/moonshine-wasm");
      const baseUrl = allowRemoteModels
        ? model.downloadBaseUrl
        : new URL(`/models/${model.modelId}/`, self.location.href).href;
      const files = Object.fromEntries(model.files.map(file => [file.path, new URL(file.path, baseUrl).href]));
      transcriber = await sdk.Transcriber.loadFromUrls(files, {
        modelArch: sdk.ModelArch.TinyStreaming,
        options: {
          // The audio worklet has already detected and bounded this utterance.
          // A second smoothed VAD would discard brief one-word commands.
          vad_threshold: "0",
          keyterms: localVoiceCommandKeyterms.join(","),
          keyterm_boost: "2.0",
        },
      });
      retryInitialisationAttempt = 0;
      retryInitialisationAt = 0;
      postStatus("ready", "Local voice commands ready");
    } catch (error) {
      const result = await modelRecovery.failure(error, allowRemoteModels);
      postStatus("error", result.detail, result.failure);
      if (result.retryable) scheduleInitialisationRetry();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

self.addEventListener("message", async (event: MessageEvent<{
  type?: string;
  requestId?: number;
  samples?: Float32Array;
  sampleRate?: number;
}>) => {
  if (event.data.type === "initialise") {
    await initialise();
    return;
  }
  const { requestId, samples, sampleRate } = event.data;
  if (event.data.type !== "audio" || !Number.isSafeInteger(requestId)) return;
  let successful = false;
  let command = null;
  try {
    if (!transcriber || !(samples instanceof Float32Array)
      || !samples.length || !Number.isFinite(sampleRate) || sampleRate! <= 0) return;
    // The controller serialises requests and keeps a bounded retry independently
    // of this synchronous Wasm call. Its main-thread deadline can replace a hang.
    command = normaliseLocalVoiceCommand(transcribeLocalVoiceUtterance(transcriber, samples, sampleRate!));
    successful = true;
  } catch {
    // A failed utterance does not disable listening or impose a retry cooldown.
    // The next request starts a new stream while retaining the loaded model.
  } finally {
    postMessage({ type: "result", requestId, successful, command });
  }
});
