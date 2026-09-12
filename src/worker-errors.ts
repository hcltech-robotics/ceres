export interface WorkerErrorStackFrame {
  readonly column: number;
  readonly file: string;
  readonly functionName: string;
  readonly line: number;
}


export interface WorkerErrorDetail {
  readonly causeMessage?: string;
  readonly causeType?: string;
  readonly message: string;
  readonly stack: readonly WorkerErrorStackFrame[];
  readonly type: string;
}


export interface WorkerErrorContext {
  readonly episodeCount?: number;
  readonly functionName?: string;
  readonly stage?: string;
  readonly worker?: string;
}


export interface WorkerErrorEventLike {
  readonly colno?: unknown;
  readonly error?: unknown;
  readonly filename?: unknown;
  readonly lineno?: unknown;
  readonly message?: unknown;
}

export const MAX_JAVASCRIPT_ERROR_MESSAGE_LENGTH = 384;

export const MAX_JAVASCRIPT_ERROR_STACK_FRAMES = 8;


const MAX_JAVASCRIPT_ERROR_INPUT_LENGTH = 4_096;

const MAX_JAVASCRIPT_ERROR_STACK_INPUT_LENGTH = 32_768;

const SAFE_FRAME_PATH = /^\/(?:assets|src)\/[A-Za-z0-9_./@+-]+\.(?:c?js|mjs|ts|tsx)$/;

const JAVASCRIPT_ERROR_STACK_FILE_CATEGORIES = [
  "export-service",
  "camera-calibration",
  "camera",
  "capture-recorder",
  "capture-runtime",
  "capture",
  "demonstrator-audio",
  "worker-errors",
  "local-voice-command",
  "monitor-app",
  "monitor-export",
  "monitor-recorder",
  "monitor-runtime",
  "monitor-worker",
  "recorder-kernels",
  "recorder",
  "solo-quality",
  "solo-runtime",
  "solo-upload",
  "solo",
  "voice",
  "worker",
] as const;

const JAVASCRIPT_ERROR_STACK_FILES = new Set(
  ["assets", "src"].flatMap((root) => (
    ["js", "mjs", "cjs", "ts", "tsx"].flatMap((extension) => (
      [...JAVASCRIPT_ERROR_STACK_FILE_CATEGORIES, "application"].map(
        (category) => `/${root}/${category}.${extension}`,
      )
    ))
  )),
);


const JAVASCRIPT_ERROR_STAGES = new Set([
  "acquiring",
  "analysing",
  "audio_journalling",
  "audio_recording",
  "audio_worklet",
  "authority_connect",
  "beam_playback",
  "cancelled",
  "closing-media",
  "committing",
  "completed",
  "capture_composition",
  "creating",
  "device_enumeration",
  "device_selection",
  "failed",
  "finalising",
  "ffmpeg_exec",
  "ffmpeg_inspect",
  "ffmpeg_load",
  "ffmpeg_read",
  "ffmpeg_write",
  "hashing",
  "initialisation",
  "main-thread-long-task",
  "media",
  "monitor_bootstrap",
  "opening",
  "permission_request",
  "playback",
  "preparing",
  "preview_playback",
  "processing",
  "progress_callback",
  "protocol",
  "queued",
  "reading",
  "recognition",
  "recording",
  "reconciling",
  "reducing",
  "repository",
  "restoring_session",
  "resuming",
  "rollback",
  "route_import",
  "saving",
  "starting",
  "starting_session",
  "storage",
  "uploading",
  "validating",
  "video_journalling",
  "video_recording",
  "worker_crash",
  "writing",
]);


const JAVASCRIPT_ERROR_WORKERS = new Set([
  "camera_calibration",
  "durable_recorder",
  "hugging_face_upload",
  "lerobot_export",
  "media_recorder",
  "monitor_recorder",
  "monitor_telemetry",
  "solo_quality",
  "speech_recognition",
]);


const JAVASCRIPT_ERROR_TYPES = new Set([
  "AbortError",
  "AccountExportInvalidResponseError",
  "AccountExportRequestError",
  "AccountUploadCancellationUnconfirmedError",
  "AccountUploadInvalidResponseError",
  "AggregateError",
  "CompileError",
  "DataCloneError",
  "DOMException",
  "EncodingError",
  "Error",
  "EvalError",
  "ExportBusyError",
  "ExportInactivityError",
  "ExportWorkerProtocolError",
  "InvalidAccessError",
  "InvalidCharacterError",
  "InvalidModificationError",
  "InvalidStateError",
  "LinkError",
  "MonitorSnapshotCommitError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "NotSupportedError",
  "OperationError",
  "OverconstrainedError",
  "QuotaExceededError",
  "RangeError",
  "RecorderProtocolError",
  "ReferenceError",
  "RemoteTurnError",
  "RuntimeError",
  "SecurityError",
  "SoloHuggingFaceDestinationError",
  "SoloUploadCancellationUnconfirmedError",
  "StringRejection",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
  "UnknownError",
]);


const JAVASCRIPT_ERROR_FUNCTIONS = new Set([
  "ArrivalApp.startup",
  "BrowserObservability.initialise",
  "CameraCalibrationWorker.process",
  "CaptureApp.captureMedia",
  "CaptureApp.failCameraCapture",
  "CaptureApp.mount",
  "CaptureApp.prepareCamera",
  "CaptureApp.prepareMicrophone",
  "CaptureApp.promptAudio",
  "CaptureApp.selectCamera",
  "CaptureApp.startup",
  "CaptureRecorder.process",
  "DemonstratorAudioCues.play",
  "JavaScript",
  "LocalVoiceCommandController.audioProcessor",
  "LocalVoiceCommandController.recognition",
  "LocalVoiceCommandController.start",
  "LocalVoiceCommandController.worker",
  "MonitorApp.completeBackendUpload",
  "MonitorApp.handleExportEvent",
  "MonitorApp.reconcileBackendUpload",
  "MonitorApp.reportExportStartError",
  "MonitorApp.startup",
  "MonitorBootstrap.initialise",
  "MonitorRecorder.process",
  "MonitorWorkerSession.process",
  "SoloApp.prepareFolderSystemTransition",
  "SoloApp.handleExportEvent",
  "SoloApp.reconcileAccountUpload",
  "SoloApp.resumeBrowserExport",
  "SoloApp.resumePendingUpload",
  "SoloApp.scheduleAutomaticHuggingFaceUpload",
  "SoloApp.scheduleAutomaticLocalExport",
  "SoloApp.settlePreparedUploadStartFailure",
  "SoloApp.startAccountUpload",
  "SoloApp.startExport",
  "SoloApp.startHeadsetUpload",
  "SoloApp.startHuggingFaceUpload",
  "SoloApp.startSession",
  "SoloRunQualityController.analyse",
  "WindowEvent.error",
  "WindowEvent.unhandledrejection",
]);

const SAFE_STATIC_ERROR_MESSAGES = new Set([
  "Capture configuration was unavailable",
  "Invalid worker error details",
  "JavaScript error",
  "One failure reported through two handlers",
  "Progress integration failed",
  "Recorder queue exceeded its safe limit",
  "Retry budget exceeded",
  "The browser export stopped reporting progress",
  "The browser export worker returned an invalid response",
  "The browser export worker returned an unreadable response",
  "The browser export worker stopped",
  "The background upload worker returned an unreadable response",
  "The upload operation did not settle promptly",
  "The value could not be cloned",
  "Failed to fetch",
  "Hugging Face background finalisation failed",
  "No outward video input is available",
  "The background headset upload returned an invalid result",
  "The background Hugging Face upload authority changed",
  "The CERES account authorisation changed before the upload began",
  "The headset authorisation changed before the upload began",
  "The Hugging Face destination changed after it was reviewed",
  "The Hugging Face destination or authorisation changed before upload. Verify both, then retry the upload.",
  "The Hugging Face upload authority changed before the upload began",
  "The Hugging Face upload authority changed before completion was recorded",
  "The Hugging Face upload destination is incomplete",
  "The Hugging Face upload destination is invalid",
  "Upload response did not contain an archive",
  "Upload response did not contain the exported archive",
]);

const SAFE_TECHNICAL_ERROR_MESSAGE = /^(?:(?:Cannot (?:read|set) properties of (?:undefined|null))|(?:(?:Browser export|Export|Hugging Face upload|Recorder|Solo upload|Upload) failed))(?:;\s*(?:account|artefact|credential|id|path|private_field|repository|session|token|url)=\[(?:account|artefact|id|path|redacted|repository|token|url)\])*$/i;

const reconstructedErrorContexts = new WeakMap<object, WorkerErrorContext>();


function bounded(value: string, maximumLength: number) {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 3)}...`;
}


function printableText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}


function admittedJavascriptErrorMessage(value: string) {
  return SAFE_STATIC_ERROR_MESSAGES.has(value) || SAFE_TECHNICAL_ERROR_MESSAGE.test(value)
    ? value
    : "JavaScript error";
}


/**
 * Preserves actionable JavaScript error text while removing values that can
 * identify an account, capture, repository or local filesystem.
 */
export function sanitiseJavascriptErrorMessage(value: unknown) {
  if (typeof value !== "string") return "JavaScript error";
  let message = printableText(value.slice(0, MAX_JAVASCRIPT_ERROR_INPUT_LENGTH));
  if (!message) return "JavaScript error";
  message = message
    .replace(
      /^(Cannot (?:read|set) properties of (?:undefined|null))(?: \([^;]*\))?(?::[^;]*)?/i,
      "$1",
    )
    .replace(/\bshards\/episode-[A-Za-z0-9_-]+\/[A-Za-z0-9_./@+-]+/gi, "[artefact]")
    .replace(/\bceres-(?:lerobot-v3|monitor-recordings|solo-recordings)\/[A-Za-z0-9_./-]+/gi, "[path]")
    .replace(/\b(?:Bearer\s+)?(?:hf|phc|gh[pousr]|github_pat|xox[baprs]|pk_live|sk_live|pk_test|sk_test)_[A-Za-z0-9_-]+\b/gi, "[token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token]")
    .replace(
      /\b(token|credential|authorization|secret|api[ _-]?key)(?:\s*[:=]\s*|\s+)(?:(?:Bearer|Basic)\s+)?(?:\[[a-z]+\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      (_match, label: string) => `${label}=[redacted]`,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b[0-9a-f]{16,}\b/gi, "[id]")
    .replace(/\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/gi, "[id]")
    .replace(
      /\b(?:account|acct|user|subject|sub|session|sess|job|episode|run|take|task|request|trace|span|correlation|device|repository|repo|dpl|prj|team)_[A-Za-z0-9_-]{6,}\b/gi,
      "[id]",
    )
    .replace(/\b(?:[0-9a-f]{32,}|[A-Za-z0-9_-]{48,})\b/g, "[id]")
    .replace(/\b(?:blob:)?(?:https?|wss?|file):\/\/[^\s)'\"<>]+/gi, "[url]")
    .replace(/\bdata:[^\s)'\"<>]+/gi, "[url]")
    .replace(
      /(^|[\s("'=:])(?:[A-Za-z]:\\|\\\\)[^"'(),;:\]}]*/g,
      (_match, prefix: string) => `${prefix}[path]`,
    )
    .replace(
      /(^|[\s("'=:])\/(?:Users|home|var|tmp)\/[^"'(),;:\]}]*/g,
      (_match, prefix: string) => `${prefix}[path]`,
    )
    .replace(
      /(^|[\s("'=:])\/(?:[^/"'(),;:\]}]+\/)+[^/"'(),;:\]}]*/g,
      (_match, prefix: string) => `${prefix}[path]`,
    )
    .replace(
      /\b(repository|repo)\s+(?:datasets\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/gi,
      (_match, label: string) => `${label} [redacted]`,
    )
    .replace(/\b(?:datasets\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g, "[repository]")
    .replace(
      /["'][A-Za-z0-9_.-]*(?:account|user|subject|session|job|episode|request|trace|span|correlation|device|repository|repo|task|prompt|instruction|description|capture|content|transcript|payload|file|path|artefact|artifact|token|credential|email|uuid|oid|commit)[A-Za-z0-9_.-]*["']\s*:\s*(?:\[[a-z]+\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      "private_field=[redacted]",
    )
    .replace(
      /["'](account|subject|user|session|job|episode|request|trace|span|correlation|device|repository|repo|task|prompt|instruction|description|capture|content|transcript|payload|file|path|artefact|artifact|id|uuid|oid|commit)(?:[ _-]?(?:id|name|text|content|path|oid|sha|subject))?["']\s*:\s*(?:\[[a-z]+\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      (_match, label: string) => `${label}=[redacted]`,
    )
    .replace(
      /\b(account|subject|user|session|job|episode|request|trace|span|correlation|device|repository|repo|task|prompt|instruction|description|capture|content|transcript|payload|file|path|artefact|artifact|id|uuid|oid|commit)(?:[ _-]?(?:id|name|text|content|path|oid|sha|subject))?\s*[:=]\s*(?:\[[a-z]+\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      (_match, label: string) => `${label}=[redacted]`,
    )
    .replace(
      /\b(account|subject|user|session|job|episode|request|trace|span|correlation|device|repository|repo|id|uuid|oid)(?:[ _-]?id)?\s+(?:"[^"]*"|'[^']*'|(?=[A-Za-z0-9_.:@/-]{6,})(?=[A-Za-z0-9_.:@/-]*[0-9_:@/-])[A-Za-z0-9][A-Za-z0-9_.:@/-]{5,})/gi,
      (_match, label: string) => `${label}=[redacted]`,
    )
    .replace(
      /\b(task|prompt|instruction|description)\s+(?:"[^"]*"|'[^']*')/gi,
      (_match, label: string) => `${label} [redacted]`,
    )
    .replace(
      /\b(task|prompt|instruction|description|transcript|payload|capture content)\s*(?::|=|\bis\b|\bwas\b)\s*(?:"[^"]*"|'[^']*'|[^;,.]+)/gi,
      (_match, label: string) => `${label}=[redacted]`,
    )
    .replace(
      /\b(?:signed in as|account(?: name)?\s*(?::|=|\bis\b|\bwas\b|\bfor\b))\s*(?:"[^"]*"|'[^']*'|[^;,.)]+)/gi,
      "account=[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return admittedJavascriptErrorMessage(
    bounded(message || "JavaScript error", MAX_JAVASCRIPT_ERROR_MESSAGE_LENGTH),
  );
}


export function isJavascriptErrorStage(value: unknown): value is string {
  return typeof value === "string" && JAVASCRIPT_ERROR_STAGES.has(value);
}


export function isJavascriptErrorWorker(value: unknown): value is string {
  return typeof value === "string" && JAVASCRIPT_ERROR_WORKERS.has(value);
}


export function isJavascriptErrorFunction(value: unknown): value is string {
  return typeof value === "string" && JAVASCRIPT_ERROR_FUNCTIONS.has(value);
}


export function isJavascriptErrorType(value: unknown): value is string {
  return typeof value === "string" && JAVASCRIPT_ERROR_TYPES.has(value);
}


export function isJavascriptErrorStackFile(value: unknown): value is string {
  return typeof value === "string" && JAVASCRIPT_ERROR_STACK_FILES.has(value);
}


function safeErrorType(value: unknown) {
  return isJavascriptErrorType(value)
    ? value
    : "UnknownError";
}


function safeOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}


function canonicalStackFile(value: string) {
  const extension = /\.(c?js|mjs|ts|tsx)$/i.exec(value)?.[1]?.toLowerCase();
  if (!extension) return null;
  const lower = value.toLowerCase();
  const category = JAVASCRIPT_ERROR_STACK_FILE_CATEGORIES.find((candidate) => (
    lower.includes(candidate)
  )) ?? "application";
  const root = value.startsWith("/src/") ? "src" : "assets";
  return `/${root}/${category}.${extension}`;
}


function stackFrame(line: string, origin: string | null): WorkerErrorStackFrame | null {
  const trimmed = line.trim();
  const location = /(https?:\/\/[^\s)]+|\/(?:assets|src)\/[^\s):]+|[A-Za-z0-9_.+-]+\.(?:c?js|mjs|ts|tsx)):(\d+):(\d+)\)?$/.exec(trimmed);
  if (!location) return null;
  let file = location[1]!;
  if (/^https?:\/\//i.test(file)) {
    try {
      const url = new URL(file);
      if (!origin || url.origin !== origin) return null;
      file = url.pathname;
    } catch {
      return null;
    }
  } else if (!file.startsWith("/")) {
    file = `/assets/${file}`;
  }
  if (!SAFE_FRAME_PATH.test(file) || file.includes("../")) return null;
  const safeFile = canonicalStackFile(file);
  if (!safeFile || !isJavascriptErrorStackFile(safeFile)) return null;
  const lineNumber = Number(location[2]);
  const column = Number(location[3]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1
    || !Number.isSafeInteger(column) || column < 1) return null;
  return Object.freeze({
    column,
    file: safeFile,
    functionName: "<anonymous>",
    line: lineNumber,
  });
}


export function sanitiseJavascriptErrorStack(value: unknown, origin?: string) {
  if (typeof value !== "string") return Object.freeze([]) as readonly WorkerErrorStackFrame[];
  const resolvedOrigin = safeOrigin(origin);
  const frames: WorkerErrorStackFrame[] = [];
  for (const line of value.slice(0, MAX_JAVASCRIPT_ERROR_STACK_INPUT_LENGTH).split(/\r?\n/)) {
    const frame = stackFrame(line, resolvedOrigin);
    if (frame) frames.push(frame);
    if (frames.length >= MAX_JAVASCRIPT_ERROR_STACK_FRAMES) break;
  }
  return Object.freeze(frames);
}


function guardedErrorProperty(error: unknown, name: "cause" | "message" | "name" | "stack") {
  try {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") return undefined;
    return (error as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}


function localError(error: unknown): error is Error {
  try {
    return error instanceof Error;
  } catch {
    return false;
  }
}


interface ErrorLikeSnapshot {
  readonly cause: unknown;
  readonly message: unknown;
  readonly name: unknown;
  readonly stack: unknown;
}


function errorLikeSnapshot(error: unknown): ErrorLikeSnapshot | null {
  const isLocalError = localError(error);
  const message = guardedErrorProperty(error, "message");
  const stack = guardedErrorProperty(error, "stack");
  const name = guardedErrorProperty(error, "name");
  if (
    !isLocalError
    && (
      typeof message !== "string"
      || (typeof stack !== "string" && !isJavascriptErrorType(name))
    )
  ) return null;
  return {
    cause: guardedErrorProperty(error, "cause"),
    message,
    name,
    stack,
  };
}


function errorName(error: unknown, snapshot: ErrorLikeSnapshot | null) {
  if (snapshot) return safeErrorType(snapshot.name);
  return typeof error === "string" ? "StringRejection" : "UnknownError";
}


function errorMessage(error: unknown, snapshot: ErrorLikeSnapshot | null) {
  if (snapshot) return sanitiseJavascriptErrorMessage(snapshot.message);
  return sanitiseJavascriptErrorMessage(error);
}


function errorStack(snapshot: ErrorLikeSnapshot | null, origin?: string) {
  return snapshot
    ? sanitiseJavascriptErrorStack(snapshot.stack, origin)
    : Object.freeze([]) as readonly WorkerErrorStackFrame[];
}


export function serialiseWorkerError(error: unknown, origin?: string): WorkerErrorDetail {
  const snapshot = errorLikeSnapshot(error);
  const cause = snapshot?.cause;
  const causeSnapshot = cause === undefined ? null : errorLikeSnapshot(cause);
  return Object.freeze({
    type: errorName(error, snapshot),
    message: errorMessage(error, snapshot),
    stack: errorStack(snapshot, origin),
    ...(cause === undefined
      ? {}
      : {
          causeType: errorName(cause, causeSnapshot),
          causeMessage: errorMessage(cause, causeSnapshot),
        }),
  });
}


export function workerErrorFromEvent(event: WorkerErrorEventLike): Error | null {
  if (event.error !== undefined && event.error !== null) {
    if (localError(event.error)) return event.error;
    return workerErrorFromDetail(serialiseWorkerError(event.error, currentOrigin()));
  }
  if (typeof event.message !== "string" || event.message.length === 0) return null;
  const error = new Error(event.message);
  if (
    typeof event.filename === "string"
    && typeof event.lineno === "number"
    && Number.isSafeInteger(event.lineno)
    && event.lineno > 0
    && typeof event.colno === "number"
    && Number.isSafeInteger(event.colno)
    && event.colno > 0
  ) {
    error.stack = `${error.name}: ${error.message}\n    at <anonymous> (${event.filename}:${event.lineno}:${event.colno})`;
  }
  return error;
}


function safeContext(context: WorkerErrorContext | undefined): WorkerErrorContext {
  const stage = isJavascriptErrorStage(context?.stage)
    ? context.stage
    : undefined;
  const worker = isJavascriptErrorWorker(context?.worker)
    ? context.worker
    : undefined;
  const functionName = isJavascriptErrorFunction(context?.functionName)
    ? context.functionName
    : undefined;
  const episodeCount = typeof context?.episodeCount === "number"
    && Number.isSafeInteger(context.episodeCount)
    && context.episodeCount >= 0
    && context.episodeCount <= 10_000
    ? context.episodeCount
    : undefined;
  return Object.freeze({
    ...(stage ? { stage } : {}),
    ...(worker ? { worker } : {}),
    ...(functionName ? { functionName } : {}),
    ...(episodeCount !== undefined ? { episodeCount } : {}),
  });
}


export function workerErrorContext(error: unknown): WorkerErrorContext {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? reconstructedErrorContexts.get(error as object) ?? {}
    : {};
}

export function withErrorContext<T>(error: T, context: WorkerErrorContext): T {
  try {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      reconstructedErrorContexts.set(error as object, safeContext(context));
    }
  } catch {
    // Worker error details context must never affect the original failure path.
  }
  return error;
}


function currentOrigin() {
  try {
    return typeof location === "undefined" ? undefined : location.origin;
  } catch {
    return undefined;
  }
}


export function isWorkerErrorDetail(value: unknown): value is WorkerErrorDetail {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const telemetry = value as Partial<WorkerErrorDetail>;
    if (!isJavascriptErrorType(telemetry.type)) return false;
    if (
      typeof telemetry.message !== "string"
      || telemetry.message !== sanitiseJavascriptErrorMessage(telemetry.message)
    ) return false;
    if (telemetry.causeType !== undefined && !isJavascriptErrorType(telemetry.causeType)) return false;
    if (
      telemetry.causeMessage !== undefined
      && (
        typeof telemetry.causeMessage !== "string"
        || telemetry.causeMessage !== sanitiseJavascriptErrorMessage(telemetry.causeMessage)
      )
    ) return false;
    if (!Array.isArray(telemetry.stack) || telemetry.stack.length > MAX_JAVASCRIPT_ERROR_STACK_FRAMES) {
      return false;
    }
    return telemetry.stack.every((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const frame = candidate as Partial<WorkerErrorStackFrame>;
      return typeof frame.file === "string"
        && isJavascriptErrorStackFile(frame.file)
        && frame.functionName === "<anonymous>"
        && typeof frame.line === "number"
        && Number.isSafeInteger(frame.line)
        && frame.line >= 1
        && typeof frame.column === "number"
        && Number.isSafeInteger(frame.column)
        && frame.column >= 1;
    });
  } catch {
    return false;
  }
}


export function workerErrorFromDetail(
  telemetry: WorkerErrorDetail,
  context?: WorkerErrorContext,
) {
  const safeTelemetry = isWorkerErrorDetail(telemetry)
    ? telemetry
    : serialiseWorkerError(new Error("Invalid worker error details"));
  const error = new Error(safeTelemetry.message);
  error.name = safeErrorType(safeTelemetry.type);
  if (safeTelemetry.stack.length > 0) {
    error.stack = [
      `${error.name}: ${error.message}`,
      ...safeTelemetry.stack.map((frame) => (
        `    at ${frame.functionName} (${frame.file}:${frame.line}:${frame.column})`
      )),
    ].join("\n");
  }
  if (safeTelemetry.causeType || safeTelemetry.causeMessage) {
    const cause = new Error(safeTelemetry.causeMessage ?? "JavaScript error");
    cause.name = safeErrorType(safeTelemetry.causeType);
    Object.defineProperty(error, "cause", { configurable: true, value: cause });
  }
  return withErrorContext(error, context ?? {});
}
