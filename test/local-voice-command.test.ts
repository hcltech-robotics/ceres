import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LocalVoiceCommandController,
  LocalVoiceCommandRecovery,
  LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE,
  localVoiceCommandAction,
  localVoiceCommandFailureKind,
  localVoiceCommandFailureLabel,
  localVoiceCommandHandDisplayControl,
  localVoiceCommandHandDisplaySettings,
  localVoiceCommandOverlay,
  localVoiceCommandRecognitionEnabled,
  localVoiceCommandStartupFailureRetryable,
  microphoneCaptureRequired,
  normaliseLocalVoiceCommand,
} from "../src/local-voice-command.js";
import {
  localVoiceCommandInitialisationRetryDelay,
} from "../src/local-voice-command-timing.js";

test("accepts the closed local voice vocabulary and bounded recognition aliases", () => {
  assert.equal(normaliseLocalVoiceCommand("Next"), "next");
  assert.equal(normaliseLocalVoiceCommand("  redo! "), "redo");
  assert.equal(normaliseLocalVoiceCommand("pass."), "pass");
  assert.equal(normaliseLocalVoiceCommand("finish"), "finish");
  assert.equal(normaliseLocalVoiceCommand("DONE!"), "done");
  assert.equal(normaliseLocalVoiceCommand("Paws."), "pause");
  assert.equal(normaliseLocalVoiceCommand("paused"), "pause");
  assert.equal(normaliseLocalVoiceCommand("mesh"), "mesh");
  assert.equal(normaliseLocalVoiceCommand("key points"), "points");
  assert.equal(normaliseLocalVoiceCommand("trail on"), "trail on");
  assert.equal(normaliseLocalVoiceCommand("trails off"), "trail off");
  assert.equal(normaliseLocalVoiceCommand("next task"), null);
  assert.equal(normaliseLocalVoiceCommand("please stop"), null);
  assert.equal(normaliseLocalVoiceCommand(""), null);
});

test("maps every local command to its live run-control action", () => {
  assert.equal(localVoiceCommandAction("next"), "next");
  assert.equal(localVoiceCommandAction("pause"), "pause");
  assert.equal(localVoiceCommandAction("stop"), "stop");
  assert.equal(localVoiceCommandAction("finish"), "finish");
  assert.equal(localVoiceCommandAction("done"), "finish");
  assert.equal(localVoiceCommandAction("start"), "start-sequence");
  assert.equal(localVoiceCommandAction("redo"), "retry");
  assert.equal(localVoiceCommandAction("pass"), "success");
  assert.equal(localVoiceCommandAction("fail"), "fail");
  assert.equal(localVoiceCommandAction("mesh"), null);
  assert.equal(localVoiceCommandAction("trail on"), null);
});

test("maps visualisation voice commands onto the existing hand display settings", () => {
  const initial = {
    handMode: "outline",
    handShading: "side",
    handTrail: "off",
  } as const;
  assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, "mesh"), {
    ...initial,
    handMode: "mesh",
  });
  assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, "outline"), initial);
  assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, "points"), {
    ...initial,
    handMode: "keypoints",
  });
  assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, "normals"), {
    ...initial,
    handShading: "normal",
  });
  for (const command of ["velocity", "speed"] as const) {
    assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, command), {
      ...initial,
      handShading: "velocity",
    });
  }
  assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, "motion"), {
    ...initial,
    handShading: "motion",
  });
  assert.deepEqual(localVoiceCommandHandDisplaySettings(initial, "trail on"), {
    ...initial,
    handTrail: "cog",
  });
  assert.deepEqual(localVoiceCommandHandDisplaySettings({ ...initial, handTrail: "cog" }, "trail off"), initial);
  assert.equal(localVoiceCommandHandDisplaySettings(initial, "next"), null);
  assert.equal(localVoiceCommandHandDisplayControl("mesh"), "handMode");
  assert.equal(localVoiceCommandHandDisplayControl("points"), "handMode");
  assert.equal(localVoiceCommandHandDisplayControl("normals"), "handShading");
  assert.equal(localVoiceCommandHandDisplayControl("speed"), "handShading");
  assert.equal(localVoiceCommandHandDisplayControl("trail on"), "handTrail");
  assert.equal(localVoiceCommandHandDisplayControl("next"), null);
  assert.deepEqual(initial, {
    handMode: "outline",
    handShading: "side",
    handTrail: "off",
  });
});

test("maps local recogniser failures to brief, safe headset notices", () => {
  assert.equal(localVoiceCommandOverlay("loading").label, "VOICE: PREPARING LOCAL RECOGNISER");
  assert.equal(localVoiceCommandOverlay("ready").label, "VOICE: LOCAL COMMANDS READY");
  assert.equal(localVoiceCommandOverlay("error", "AudioWorklet module failed").label, "VOICE: AUDIO WORKLET FAILED");
  assert.equal(localVoiceCommandFailureLabel("Failed to fetch model"), "MODEL DOWNLOAD FAILED");
  assert.equal(localVoiceCommandFailureLabel("ONNX runtime aborted"), "MODEL RUNTIME FAILED");
  assert.equal(localVoiceCommandFailureLabel("anything else"), "LOCAL RECOGNISER FAILED");
  assert.equal(localVoiceCommandFailureKind("Permission denied"), "microphone");
  assert.equal(localVoiceCommandFailureKind("AudioWorklet module failed"), "audio-worklet");
  assert.equal(localVoiceCommandFailureKind("Failed to fetch model"), "model-download");
  assert.equal(
    localVoiceCommandFailureKind(
      "TypeError: Failed to fetch dynamically imported module: https://ceres.cam/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs",
    ),
    "model-download",
  );
  assert.equal(localVoiceCommandFailureKind("ONNX runtime aborted"), "model-runtime");
  const missingFile = '`local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "/models/onnx-community/moonshine-tiny-ONNX/onnx/encoder_model_q4.onnx".';
  assert.equal(localVoiceCommandFailureKind(missingFile), "model-assets");
  assert.equal(localVoiceCommandFailureLabel(missingFile), "COMMAND FILES MISSING");
  assert.equal(localVoiceCommandFailureKind(LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE), "model-assets");
  assert.equal(localVoiceCommandOverlay("error", missingFile, "model-download").label, "VOICE: MODEL DOWNLOAD FAILED");
  assert.equal(localVoiceCommandFailureKind("anything else"), "recognition");
});

test("enables local recognition only after runtime feature status is available", () => {
  assert.equal(localVoiceCommandRecognitionEnabled(false, false), false);
  assert.equal(localVoiceCommandRecognitionEnabled(false, true), false);
  assert.equal(localVoiceCommandRecognitionEnabled(true, false), false);
  assert.equal(localVoiceCommandRecognitionEnabled(true, true), true);
});

test("keeps microphone capture only for durable audio or enabled local recognition", () => {
  assert.equal(microphoneCaptureRequired(false, false), false);
  assert.equal(microphoneCaptureRequired(true, false), true);
  assert.equal(microphoneCaptureRequired(false, true), true);
  assert.equal(microphoneCaptureRequired(true, true), true);
});

test("backs off failed model initialisation without holding an audio sample", () => {
  assert.equal(localVoiceCommandInitialisationRetryDelay(0), 30_000);
  assert.equal(localVoiceCommandInitialisationRetryDelay(1), 60_000);
  assert.equal(localVoiceCommandInitialisationRetryDelay(2), 120_000);
  assert.equal(localVoiceCommandInitialisationRetryDelay(20), 120_000);
});

test("deduplicates and bounds repeated ready-then-crash recovery timers", () => {
  let scheduled: { callback: () => void; delayMs: number; timer: number } | null = null;
  let nextTimer = 1;
  const timerHost = {
    setTimeout(callback: () => void, delayMs: number) {
      const timer = nextTimer;
      nextTimer += 1;
      scheduled = { callback, delayMs, timer };
      return timer;
    },
    clearTimeout(timer: number) {
      if (scheduled?.timer === timer) scheduled = null;
    },
  };
  const recovery = new LocalVoiceCommandRecovery();
  let retries = 0;
  const reportReady = () => undefined;

  assert.equal(recovery.schedule(timerHost, () => { retries += 1; }), true);
  assert.equal(recovery.schedule(timerHost, () => { retries += 1; }), false);
  assert.equal(recovery.pending, true);
  assert.equal(scheduled?.delayMs, 5_000);
  scheduled!.callback();
  assert.equal(retries, 1);
  assert.equal(recovery.pending, false);

  reportReady();
  assert.equal(recovery.schedule(timerHost, () => { retries += 1; }), true);
  assert.equal(scheduled?.delayMs, 15_000);
  scheduled!.callback();
  reportReady();
  assert.equal(recovery.schedule(timerHost, () => { retries += 1; }), true);
  assert.equal(scheduled?.delayMs, 30_000);
  scheduled!.callback();
  assert.equal(recovery.schedule(timerHost, () => { retries += 1; }), false);

  recovery.reset(timerHost);
  assert.equal(recovery.schedule(timerHost, () => { retries += 1; }), true);
  assert.equal(scheduled?.delayMs, 5_000);
  recovery.cancel(timerHost);
  assert.equal(recovery.pending, false);
});

test("does not retry permanent startup capability failures", () => {
  assert.equal(
    localVoiceCommandStartupFailureRetryable(
      new Error("Local voice commands require Web Audio support"),
    ),
    false,
  );
  assert.equal(
    localVoiceCommandStartupFailureRetryable(
      new DOMException("Permission denied", "NotAllowedError"),
    ),
    false,
  );
  assert.equal(
    localVoiceCommandStartupFailureRetryable(
      new DOMException("The request was aborted", "AbortError"),
    ),
    true,
  );
});

test("gates local recognition on runtime readiness independently of server speech", () => {
  const capture = readFileSync(
    new URL("../src/capture-app.ts", import.meta.url),
    "utf8",
  );
  assert.match(capture, /private runtimeFeaturesLoaded = false/);
  assert.match(capture, /private runtimeFeaturesAvailable = false/);
  assert.match(capture, /private speechEnabled\(\) \{[\s\S]*return this\.runtimeFeaturesLoaded/);
  assert.match(capture, /speech: result\.available && result\.features\.speech/);
  assert.match(capture, /this\.runtimeFeaturesAvailable = result\.available/);
  const localRecognitionGate = capture.slice(
    capture.indexOf("private localVoiceCommandRecognitionEnabled"),
    capture.indexOf("private demonstratorAudioCuesEnabled"),
  );
  assert.match(localRecognitionGate, /this\.runtimeFeaturesLoaded[\s\S]*this\.runtimeFeaturesAvailable/);
  assert.doesNotMatch(localRecognitionGate, /runtimeFeatures\.speech|snapshot\?\.features\.speech/);
  assert.match(capture, /this\.runtimeFeaturesLoaded = true;[\s\S]*this\.reconcileLocalVoiceCommands\(\)/);
  assert.match(capture, /private enableLocalVoiceCommands[\s\S]*!this\.localVoiceCommandRecognitionEnabled\(\)/);
  assert.match(capture, /private handleLocalVoiceCommand[\s\S]*!this\.localVoiceCommandRecognitionEnabled\(\)/);
  assert.match(
    capture,
    /private handleLocalVoiceCommand[\s\S]*localVoiceCommandHandDisplaySettings\([\s\S]*this\.applyHandDisplaySettings\(handDisplaySettings\)[\s\S]*this\.sendDemonstratorHandDisplay\(root\)[\s\S]*flashVoiceHandControl\(/,
  );
  assert.match(capture, /commands\?\.dispose\(\);[\s\S]*this\.localVoiceCommandStatus = "loading"/);
  assert.match(capture, /private reconcileLocalVoiceCommands[\s\S]*!this\.configuration\.recordAudio[\s\S]*stopStream\(this\.microphoneStream\)/);
  const reticleVoiceIndicator = capture.match(
    /const voice = xrCameraVoiceIndicatorState\([\s\S]*?drawXrCameraEdgeIndicators\(cameraEdgesContext, cameraEdges, \{[\s\S]*?\}\);/,
  )?.[0];
  assert.ok(reticleVoiceIndicator);
  assert.match(reticleVoiceIndicator, /this\.runtimeFeaturesLoaded/);
  assert.match(reticleVoiceIndicator, /this\.localVoiceCommandStatus/);
  assert.match(reticleVoiceIndicator, /this\.localVoiceCommandRecognitionEnabled\(\)/);
  assert.doesNotMatch(
    reticleVoiceIndicator,
    /configuration\.recordAudio|audioRecorder|microphoneStream/,
  );
  assert.match(capture, /voiceUnavailable[\s\S]*"VOICE UNAVAILABLE"[\s\S]*XR_HUD_COLOURS\.textDisabled/);
  assert.match(capture, /private microphoneRequired\(\)[\s\S]*microphoneCaptureRequired\([\s\S]*this\.configuration\.recordAudio,[\s\S]*this\.localVoiceCommandRecognitionEnabled\(\)/);
  assert.match(capture, /if \(!microphoneRequired && this\.microphoneStream\)[\s\S]*stopStream\(this\.microphoneStream\)/);
  assert.match(capture, /if \(microphoneRequired && !this\.microphoneStream\)/);
  assert.match(capture, /if \(this\.localVoiceCommandRecognitionEnabled\(\)\)[\s\S]*this\.showLocalVoiceCommandOverlay\("error", detail\)/);
  assert.match(
    capture,
    /const serverAsrAudioEnabled = this\.speechEnabled\(\)[\s\S]*this\.authority\.sendAudioForAsr !== undefined/,
  );
  assert.match(
    capture,
    /if \(!this\.configuration\.recordAudio\) \{[\s\S]*if \(this\.speechEnabled\(\)\) \{[\s\S]*this\.authority\.sendAudioForAsr\?\./,
  );
  assert.match(capture, /status === "loading" && this\.localVoiceCommandStatus === "error"/);
  const failedStart = capture.match(/void commands\.start\(\)\.catch\(\(error\) => \{[\s\S]*?commands\.dispose\(\);[\s\S]*?\}\);/)?.[0];
  assert.ok(failedStart);
  assert.match(failedStart, /this\.localVoiceCommands = null/);
  assert.match(failedStart, /localVoiceCommandStartupFailureRetryable\(error\)/);
  assert.match(failedStart, /this\.scheduleLocalVoiceCommandRecovery\(\)/);
  assert.match(capture, /onFatalError:[\s\S]*this\.localVoiceCommands = null;[\s\S]*this\.scheduleLocalVoiceCommandRecovery\(\)/);
  assert.match(capture, /private scheduleLocalVoiceCommandRecovery[\s\S]*this\.localVoiceCommandRecovery\.schedule\(window/);
  assert.match(capture, /this\.localVoiceCommandRecovery\.reset\(window\)/);
  assert.match(capture, /onRecognitionSuccess:[\s\S]*this\.localVoiceCommandRecovery\.reset\(window\)/);
  assert.doesNotMatch(
    capture,
    /status === "ready" \|\| status === "fallback"[\s\S]{0,160}localVoiceCommandRecovery\.reset/,
  );
  assert.match(capture, /onRecognitionChange:[\s\S]*this\.setLocalVoiceCommandRecognitionActive\(active\)/);
  const runtimeFeatureInitialisation = capture.slice(
    capture.indexOf("private async initialiseRuntimeFeatures"),
    capture.indexOf("private renderSpeechFeature"),
  );
  assert.match(runtimeFeatureInitialisation, /recognitionEnabled !== recognitionWasEnabled[\s\S]*this\.reconcileLocalVoiceCommands\(\)[\s\S]*this\.composeCaptureStream\(\)/);
  const directRunState = capture.slice(
    capture.indexOf("private receiveDirectRunState"),
    capture.indexOf("private refreshDirectSnapshotReadiness"),
  );
  assert.doesNotMatch(directRunState, /reconcileLocalVoiceCommands|composeCaptureStream/);
});

test("surfaces worker failures only while the voice controller is live", () => {
  type FakeListener = (event: { message?: string }) => void;
  class FakeWorker {
    static latest: FakeWorker | null = null;
    readonly listeners = new Map<string, FakeListener[]>();
    terminated = false;

    constructor() {
      FakeWorker.latest = this;
    }

    addEventListener(type: string, listener: FakeListener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    postMessage() {}

    terminate() {
      this.terminated = true;
    }

    emit(type: string, event: { message?: string } = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  const statuses: Array<{ status: string; detail?: string }> = [];
  const fatalErrors: string[] = [];
  try {
    const controller = new LocalVoiceCommandController({
      stream: {} as MediaStream,
      onCommand: () => undefined,
      onStatus: (status, detail) => statuses.push({ status, detail }),
      onFatalError: (detail) => fatalErrors.push(detail),
    });
    const worker = FakeWorker.latest!;
    worker.emit("error", { message: "worker crashed" });
    worker.emit("messageerror");
    assert.deepEqual(statuses, [
      { status: "error", detail: "worker crashed" },
    ]);
    assert.equal(worker.terminated, true);
    assert.deepEqual(fatalErrors, ["worker crashed"]);
    controller.dispose();
    worker.emit("error", { message: "late worker crash" });
    worker.emit("messageerror");
    assert.equal(statuses.length, 1);
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("keeps a ready worker eligible after a transient inference error", () => {
  type FakeWorkerEvent = {
    data?: {
      type: "status";
      status: "loading" | "ready" | "fallback" | "error";
      detail?: string;
    };
  };
  type FakeListener = (event: FakeWorkerEvent) => void;
  class FakeWorker {
    static latest: FakeWorker | null = null;
    readonly listeners = new Map<string, FakeListener[]>();

    constructor() {
      FakeWorker.latest = this;
    }

    addEventListener(type: string, listener: FakeListener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    postMessage() {}

    terminate() {}

    emitStatus(status: "loading" | "ready" | "fallback" | "error", detail?: string) {
      const event = { data: { type: "status" as const, status, detail } };
      for (const listener of this.listeners.get("message") ?? []) listener(event);
    }
  }
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  try {
    const controller = new LocalVoiceCommandController({
      stream: {} as MediaStream,
      onCommand: () => undefined,
      onStatus: () => undefined,
    });
    const worker = FakeWorker.latest!;
    const state = controller as unknown as { workerReady: boolean };

    worker.emitStatus("ready");
    assert.equal(state.workerReady, true);
    worker.emitStatus("error", "Transient inference failure");
    assert.equal(state.workerReady, true);

    worker.emitStatus("loading");
    assert.equal(state.workerReady, false);
    controller.dispose();
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("preserves confirmed missing-file diagnostics separately from the voice message", () => {
  type Status = { type: "status"; status: "error"; detail: string; failure: { kind: "model-assets"; diagnosticDetail: string } };
  class FakeWorker {
    static latest: FakeWorker;
    private listener: ((event: { data: Status }) => void) | null = null;
    constructor() { FakeWorker.latest = this; }
    addEventListener(type: string, listener: (event: { data: Status }) => void) {
      if (type === "message") this.listener = listener;
    }
    postMessage() {}
    terminate() {}
    emit(data: Status) { this.listener?.({ data }); }
  }
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  const statuses: unknown[] = [];
  try {
    const controller = new LocalVoiceCommandController({
      stream: {} as MediaStream,
      onCommand: () => undefined,
      onStatus: (status, detail, failure) => statuses.push({ status, detail, failure }),
    });
    const failure = { kind: "model-assets" as const, diagnosticDetail: "raw ONNX local-path exception" };
    FakeWorker.latest.emit({ type: "status", status: "error", detail: LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE, failure });
    assert.deepEqual(statuses, [{ status: "error", detail: LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE, failure }]);
    assert.equal((controller as unknown as { workerReady: boolean }).workerReady, false);
    controller.dispose();
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("fails closed on module-worker errors and stops audio forwarding", () => {
  const controller = readFileSync(
    new URL("../src/local-voice-command.ts", import.meta.url),
    "utf8",
  );
  assert.match(controller, /addEventListener\("error"/);
  assert.match(controller, /addEventListener\("messageerror"/);
  assert.match(controller, /addEventListener\("processorerror"/);
  assert.match(controller, /private failWorker[\s\S]*this\.stopAudioForwarding\(\);[\s\S]*this\.worker\.terminate\(\)/);
  assert.match(controller, /private stopAudioForwarding[\s\S]*this\.captureNode\?\.port\.close\(\)/);
  assert.match(controller, /this\.workerFailed[\s\S]*!this\.workerReady[\s\S]*this\.worker\.postMessage/);
});
