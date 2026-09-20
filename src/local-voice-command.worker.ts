import { env, pipeline } from "@huggingface/transformers";
import onnxRuntimeModuleUrl from "../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import onnxRuntimeWasmUrl from "../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import model from "../shared/local-voice-model.json";
import { normaliseLocalVoiceCommand, type LocalVoiceCommandFailure } from "./local-voice-command.js";
import { localVoiceCommandInitialisationRetryDelay } from "./local-voice-command-timing.js";
import { LocalVoiceModelRecovery } from "./local-voice-model-recovery.js";

type VoicePipeline = (audio: Float32Array) => Promise<{ text?: string }>;

let transcriber: VoicePipeline | null = null;
let loading: Promise<void> | null = null;
let processing = false;
let recognitionActive = false;
let lastStatus: "loading" | "ready" | "fallback" | "error" = "loading";
let retryInitialisationAt = 0;
let retryInitialisationTimer: ReturnType<typeof setTimeout> | null = null;
let retryInitialisationAttempt = 0;
const modelRecovery = new LocalVoiceModelRecovery();
const createPipeline = pipeline as unknown as (...args: unknown[]) => Promise<unknown>;
declare const __CERES_ALLOW_REMOTE_MODELS__: boolean;

function postStatus(status: "loading" | "ready" | "fallback" | "error", detail?: string, failure?: LocalVoiceCommandFailure) {
  lastStatus = status;
  postMessage({ type: "status", status, detail, failure });
}

function postRecognition(active: boolean, successful = false) {
  if (recognitionActive === active) return;
  recognitionActive = active;
  postMessage({ type: "recognition", active, successful });
}

function scheduleInitialisationRetry() {
  if (retryInitialisationTimer !== null || transcriber || modelRecovery.blocked) return;
  const delayMs = localVoiceCommandInitialisationRetryDelay(retryInitialisationAttempt);
  retryInitialisationAttempt += 1;
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
    env.allowLocalModels = !allowRemoteModels;
    env.allowRemoteModels = allowRemoteModels;
    env.localModelPath = "/models/";
    env.useBrowserCache = true;
    // Quest Browser can expose cross-origin isolation without enough reliable
    // worker capacity for ONNX Runtime's automatic thread count. One Wasm thread
    // keeps inference in this dedicated worker and avoids a startup failure that
    // leaves the XR status indicator red.
    const onnxWasm = env.backends.onnx.wasm;
    if (onnxWasm) {
      onnxWasm.numThreads = 1;
      // Transformers.js otherwise imports the ONNX runtime module from a CDN.
      // Production permits worker scripts from this origin only. Vite emits both
      // pinned runtime files as immutable application assets, so development,
      // preview and production all import the same-origin module URL.
      onnxWasm.wasmPaths = {
        mjs: onnxRuntimeModuleUrl,
        wasm: onnxRuntimeWasmUrl,
      };
    }
    try {
      transcriber = await createPipeline("automatic-speech-recognition", model.modelId, {
        // Keep inference off the WebXR GPU. Quest Browser can continue rendering
        // while the worker downloads, compiles and runs the local recogniser.
        device: "wasm",
        dtype: "q4",
        ...(!allowRemoteModels ? { revision: model.revision } : {}),
      }) as VoicePipeline;
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

function resample(samples: Float32Array, sourceRate: number, targetRate = 16_000) {
  if (sourceRate === targetRate) return samples;
  const length = Math.floor(samples.length * targetRate / sourceRate);
  const output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, samples.length - 1);
    output[index] = samples[lower] + (samples[upper] - samples[lower]) * (position - lower);
  }
  return output;
}

self.addEventListener("message", async (event: MessageEvent<{ type?: string; samples?: Float32Array; sampleRate?: number }>) => {
  if (event.data.type === "initialise") {
    await initialise();
    return;
  }
  if (event.data.type !== "audio" || processing || !(event.data.samples instanceof Float32Array) || !Number.isFinite(event.data.sampleRate)) return;
  processing = true;
  let recognitionSucceeded = false;
  try {
    await initialise();
    if (!transcriber) return;
    postRecognition(true);
    const result = await transcriber(resample(event.data.samples, event.data.sampleRate!));
    recognitionSucceeded = true;
    if (lastStatus === "error") postStatus("ready", "Local voice commands ready");
    const command = normaliseLocalVoiceCommand(result.text ?? "");
    if (command) postMessage({ type: "command", command });
  } catch (error) {
    postStatus("error", error instanceof Error ? error.message : "Local voice recognition failed");
  } finally {
    postRecognition(false, recognitionSucceeded);
    processing = false;
  }
});
