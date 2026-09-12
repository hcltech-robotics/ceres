import type {
  CapturePairingRejectionCode,
  CaptureConfiguration,
  ClientMessage,
  ClientRole,
  ServerMessage,
  SessionSnapshot,
} from "../shared/protocol.js";
import {
  CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
  CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE,
  isStateBoundRunControlAction,
} from "../shared/protocol.js";
import type { HandDisplaySettings } from "../shared/hand-display.js";
import type { ConnectionProfile } from "./connection-profile.js";
import { applyConnectionProfile } from "./connection-profile.js";
import { rememberMonitorSession } from "./monitor-session-persistence.js";


declare const __CERES_CAPTURE_BASE_URL__: string;

type Listener<T> = (value: T) => void;
type EpisodeUploadCommitRequest = Extract<ClientMessage, { type: "episode-upload-commit" }>;
type EpisodeUploadCommitAck = Extract<ServerMessage, { type: "episode-upload-ack" }>;
type EpisodeUploadCommitError = Extract<ServerMessage, { type: "episode-upload-error" }>;

interface PendingEpisodeUploadCommit {
  message: EpisodeUploadCommitRequest;
  promise: Promise<EpisodeUploadCommitAck>;
  resolve: (acknowledgement: EpisodeUploadCommitAck) => void;
  reject: (error: Error) => void;
}

export interface TerminalCapturePairing {
  code: CapturePairingRejectionCode;
  message: string;
}

const capturePairingIdStorageKey = "ceres.capture-pairing-id";
const captureBrowsingContextStorageKey = "ceres.capture-browsing-context-id";
const captureBrowsingContextNamePrefix = "ceres-capture-context:";
let inMemoryCapturePairingId: string | null = null;
type PairingStorage = Pick<Storage, "getItem" | "setItem">;

export class SessionClient {
  static readonly monitorBufferedAmountLimit = 256 * 1024;
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener<any>>>();
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private registered = false;
  private captureIntentRequested = false;
  private xrActiveIntent = false;
  private readonly pendingEpisodeUploadCommits = new Map<string, PendingEpisodeUploadCommit>();
  readonly pairingId: string | null;
  exportCapability: string | null = null;

  constructor(
    readonly sessionId: string,
    readonly role: ClientRole,
    pairingId?: string,
    readonly serverUrl: string | null = null,
  ) {
    this.pairingId = role === "monitor" || role === "monitor-control"
      ? null
      : pairingId ?? (role === "capture" ? capturePairingId() : null);
  }

  connect() {
    if (!this.sessionId) {
      this.emit("connection", false);
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    this.closedByUser = false;
    const socket = new WebSocket(sessionWebSocketUrl(this.serverUrl));
    this.socket = socket;
    let terminalErrorReported = false;
    const reportTerminalPairing = (code: CapturePairingRejectionCode, message: string) => {
      if (terminalErrorReported) return;
      this.closedByUser = true;
      terminalErrorReported = true;
      const failure: TerminalCapturePairing = { code, message };
      this.emit("pairing-terminal", failure);
      this.emitPairingError(code, message);
    };
    socket.addEventListener("open", () => {
      const registration: ClientMessage = this.role === "monitor" || this.role === "monitor-control"
        ? { type: "register", sessionId: this.sessionId, role: this.role }
        : this.role === "capture"
          ? {
            type: "register",
            sessionId: this.sessionId,
            role: this.role,
            pairingId: this.pairingId!,
            telemetryMode: "disabled" as const,
          }
          : { type: "register", sessionId: this.sessionId, role: this.role, pairingId: this.pairingId! };
      socket.send(JSON.stringify(registration));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "session-registered") {
          if (message.sessionId !== this.sessionId || message.role !== this.role) {
            this.emit("error", { type: "error", message: "The server acknowledged a different session client" });
            return;
          }
          this.registered = true;
          this.exportCapability = message.exportCapability ?? null;
          this.flushEpisodeUploadCommits();
          if (this.role === "capture" && this.captureIntentRequested) this.send({ type: "capture-intent" });
          if (this.role === "capture" && this.xrActiveIntent) this.send({ type: "capture-xr-active" });
          this.emit("connection", true);
          this.emit(message.type, message);
        } else if (message.type === "pairing-rejected") {
          this.emit(message.type, message);
          reportTerminalPairing(message.code, message.message);
        } else if (message.type === "episode-upload-ack") {
          this.resolveEpisodeUploadCommit(message);
          this.emit(message.type, message);
        } else if (message.type === "episode-upload-error") {
          this.rejectEpisodeUploadCommit(message);
          this.emit(message.type, message);
        } else if (message.type === "capture-intent-granted" && this.role === "capture") {
          this.captureIntentRequested = true;
          this.emit(message.type, message);
        } else if (message.type === "capture-intent-suspended" && this.role === "capture") {
          this.captureIntentRequested = false;
          this.xrActiveIntent = false;
          this.emit(message.type, message);
        } else if (message.type === "capture-authority-granted" && this.role === "capture") {
          this.captureIntentRequested = true;
          this.xrActiveIntent = true;
          this.emit(message.type, message);
        } else if (message.type === "snapshot") this.emit("snapshot", message.snapshot);
        else this.emit(message.type, message as any);
      } catch {
        this.emit("error", { type: "error", message: "The server sent an unreadable message" });
      }
    });
    socket.addEventListener("close", (event) => {
      const isCurrentSocket = this.socket === socket;
      const isExplicitClose = this.socket === null && this.closedByUser;
      if (!isCurrentSocket && !isExplicitClose) return;
      if (isCurrentSocket) this.socket = null;
      this.registered = false;
      this.exportCapability = null;
      const terminalPairingClose = event.code === CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE
        || event.code === CAPTURE_PAIRING_REJECTED_CLOSE_CODE;
      if (terminalPairingClose) {
        const code: CapturePairingRejectionCode = event.code === CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE
          ? "capture-superseded"
          : "capture-pairing-required";
        reportTerminalPairing(code, event.reason || "The capture pairing was closed by the server");
      }
      this.emit("connection", false);
      if (!this.closedByUser) this.reconnectTimer = window.setTimeout(() => this.connect(), 1_000);
    });
  }

  close() {
    this.closedByUser = true;
    this.registered = false;
    this.exportCapability = null;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectAllEpisodeUploadCommits("The session closed before upload metadata was acknowledged");
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Session rolled");
  }

  dispose() {
    this.listeners.clear();
    this.close();
  }

  on<T>(event: string, listener: Listener<T>) {
    const entries = this.listeners.get(event) ?? new Set();
    entries.add(listener as Listener<any>);
    this.listeners.set(event, entries);
    return () => entries.delete(listener as Listener<any>);
  }

  configure(configuration: CaptureConfiguration) {
    this.send({ type: "set-configuration", configuration });
  }

  setHandDisplay(settings: HandDisplaySettings) {
    this.send({ type: "set-hand-display", settings });
  }

  control(
    action: "start-sequence" | "start" | "pause" | "stop" | "finish" | "success" | "fail" | "retry" | "resume" | "next" | "instructions",
    nextCursor?: string,
  ) {
    const actions = {
      next: "next-task",
      instructions: "show-instructions",
    } as const;
    const normalised = actions[action as keyof typeof actions] ?? action;
    if (isStateBoundRunControlAction(normalised)) {
      if (!nextCursor) return false;
      return this.send({ type: "control", action: normalised, nextCursor });
    }
    return this.send({ type: "control", action: normalised });
  }

  requestCaptureIntent() {
    if (this.role !== "capture") return false;
    this.captureIntentRequested = true;
    return this.registered && this.send({ type: "capture-intent" });
  }

  markXrActive() {
    if (this.role !== "capture") return false;
    this.captureIntentRequested = true;
    this.xrActiveIntent = true;
    if (!this.registered) return false;
    this.send({ type: "capture-intent" });
    return this.send({ type: "capture-xr-active" });
  }

  send(message: ClientMessage) {
    if (message.type === "episode-upload-commit") return false;
    return this.sendImmediate(message);
  }

  sendLossy(message: ClientMessage, bufferedAmountLimit = SessionClient.monitorBufferedAmountLimit) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > bufferedAmountLimit) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  get bufferedAmount() {
    return this.socket?.bufferedAmount ?? Number.POSITIVE_INFINITY;
  }

  commitEpisodeUpload(message: EpisodeUploadCommitRequest): Promise<EpisodeUploadCommitAck> {
    if (this.role !== "monitor" && this.role !== "monitor-control") {
      return Promise.reject(new Error("Only the capture director can persist upload metadata"));
    }
    const existing = this.pendingEpisodeUploadCommits.get(message.requestId);
    if (existing) {
      if (JSON.stringify(existing.message) !== JSON.stringify(message)) {
        return Promise.reject(new Error("An upload metadata request reused its identity with different content"));
      }
      return existing.promise;
    }
    let resolve!: (acknowledgement: EpisodeUploadCommitAck) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<EpisodeUploadCommitAck>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pendingEpisodeUploadCommits.set(message.requestId, {
      message: structuredClone(message),
      promise,
      resolve,
      reject,
    });
    if (this.registered) this.sendImmediate(message);
    return promise;
  }

  private emit(event: string, value: unknown) {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }

  private emitPairingError(code: CapturePairingRejectionCode, message: string) {
    this.emit("error", { type: "error", code, message });
  }

  private sendImmediate(message: ClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private flushEpisodeUploadCommits() {
    if (!this.registered) return;
    for (const pending of this.pendingEpisodeUploadCommits.values()) {
      if (!this.sendImmediate(pending.message)) return;
    }
  }

  private resolveEpisodeUploadCommit(message: EpisodeUploadCommitAck) {
    const pending = this.pendingEpisodeUploadCommits.get(message.requestId);
    if (!pending) return;
    this.pendingEpisodeUploadCommits.delete(message.requestId);
    const expectedEpisodeIds = [...pending.message.episodeIds].sort(compareText);
    const acknowledgedEpisodeIds = Array.isArray(message.episodeIds)
      ? [...message.episodeIds].sort(compareText)
      : [];
    if ((message.status !== "durable" && message.status !== "duplicate")
      || acknowledgedEpisodeIds.length !== expectedEpisodeIds.length
      || !acknowledgedEpisodeIds.every((episodeId, index) => episodeId === expectedEpisodeIds[index])) {
      pending.reject(new Error("The upload metadata acknowledgement did not match the request"));
      return;
    }
    pending.resolve(message);
  }

  private rejectEpisodeUploadCommit(message: EpisodeUploadCommitError) {
    const pending = this.pendingEpisodeUploadCommits.get(message.requestId);
    if (!pending) return;
    this.pendingEpisodeUploadCommits.delete(message.requestId);
    pending.reject(new Error(message.message));
  }

  private rejectAllEpisodeUploadCommits(message: string) {
    const error = new Error(message);
    for (const pending of this.pendingEpisodeUploadCommits.values()) pending.reject(error);
    this.pendingEpisodeUploadCommits.clear();
  }
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function capturePairingId(
  storageOverride?: PairingStorage | null,
  browsingContextOverride?: string | null,
) {
  let storage: PairingStorage | null = storageOverride ?? null;
  const browsingContextId = browsingContextOverride === undefined
    ? captureBrowsingContextId()
    : browsingContextOverride;
  try {
    if (storageOverride === undefined) storage = typeof sessionStorage === "undefined" ? null : sessionStorage;
    const stored = storage?.getItem(capturePairingIdStorageKey);
    const storedContext = storage?.getItem(captureBrowsingContextStorageKey);
    if (stored && isSafePairingId(stored)) {
      if (!browsingContextId || !storedContext || storedContext === browsingContextId) {
        if (browsingContextId && !storedContext) storage?.setItem(captureBrowsingContextStorageKey, browsingContextId);
        return stored;
      }
    }
  } catch {
    storage = null;
  }
  if (!storage && inMemoryCapturePairingId) return inMemoryCapturePairingId;
  const created = createCapturePairingId();
  try {
    storage?.setItem(capturePairingIdStorageKey, created);
    if (browsingContextId) storage?.setItem(captureBrowsingContextStorageKey, browsingContextId);
  } catch {
    storage = null;
  }
  if (!storage) inMemoryCapturePairingId = created;
  return created;
}

function isSafePairingId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function createCapturePairingId() {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof browserCrypto?.getRandomValues === "function") {
    browserCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function suppliedSessionId() {
  const search = new URLSearchParams(location.search);
  return search.get("session");
}

function captureBrowsingContextId() {
  if (typeof window === "undefined") return null;
  try {
    const marker = window.name.split("|").find((part) => part.startsWith(captureBrowsingContextNamePrefix));
    const stored = marker?.slice(captureBrowsingContextNamePrefix.length) ?? "";
    if (isSafePairingId(stored)) return stored;
    const created = createCapturePairingId();
    window.name = [window.name, `${captureBrowsingContextNamePrefix}${created}`].filter(Boolean).join("|");
    return created;
  } catch {
    return null;
  }
}

export function captureEntryRequested() {
  const search = new URLSearchParams(location.search);
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  return search.get("role") === "demonstrator" || pathname === "/launch/capture";
}

export function createSessionId() {
  return crypto.randomUUID().slice(0, 8);
}

export function sessionWebSocketUrl(serverUrl: string | null = null) {
  const browserOrigin = typeof location === "undefined" ? "" : location.origin;
  const origin = serverUrl || browserOrigin;
  if (!origin) throw new Error("A session server URL is required outside the browser");
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function captureSessionUrl(sessionId: string, baseUrl?: string, connectionProfile?: ConnectionProfile) {
  const configuredBaseUrl = typeof __CERES_CAPTURE_BASE_URL__ === "string" ? __CERES_CAPTURE_BASE_URL__ : "";
  const browserOrigin = typeof location === "undefined" ? "" : location.origin;
  const resolvedBaseUrl = baseUrl || configuredBaseUrl || browserOrigin;
  if (!resolvedBaseUrl) throw new Error("A capture base URL is required outside the browser");
  const url = new URL("/", resolvedBaseUrl);
  url.searchParams.set("session", sessionId);
  if (connectionProfile) applyConnectionProfile(url.searchParams, connectionProfile);
  return url.toString();
}

export function monitorSessionId() {
  const supplied = suppliedSessionId();
  const id = rememberMonitorSession(supplied) ?? createSessionId();
  rememberMonitorSession(id);
  const search = new URLSearchParams(location.search);
  search.set("session", id);
  history.replaceState(null, "", `${location.pathname}?${search.toString()}`);
  return id;
}

export type { SessionSnapshot };
