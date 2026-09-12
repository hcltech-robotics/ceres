import { PAIRING_CONNECTION_ACTIVE_CLOSE_CODE, type WebRtcSignal } from "../shared/protocol.js";

export type WebRtcSignalRole = "capture" | "monitor";

type Listener<T> = (value: T) => void;

export interface WebRtcSignalError {
  message: string;
  code?: number;
  terminal?: boolean;
  retrying?: boolean;
}

export interface InvitationSignalCredentials {
  roomId: string;
  capability: string;
  expiresAt?: string;
  bound?: boolean;
  boundAt?: string;
}

const invitationExpiredCloseCode = 4408;
const invitationExpiredMessage = "Pairing invitation expired";
export const pairedInvitationRetentionMs = 24 * 60 * 60 * 1_000;
const terminalSignalCloseCodes = new Set([4400, 4401, 4403, 4429]);
const maximumPreRegistrationAttempts = 8;
const reconnectBaseDelayMs = 1_000;
const activeCaptureReconnectBaseDelayMs = 5_000;
const reconnectMaximumDelayMs = 60_000;
const reconnectJitter = 0.2;

export interface InvitationPickedUp {
  sessionId: string;
  pickedUpAt: string;
}

export class WebRtcSignalClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private terminalFailure = false;
  private registered = false;
  private registeredOnce = false;
  private reconnectAttempt = 0;
  private waitingForOnline = false;
  private captureIntentRequested = false;
  private xrActiveIntent = false;
  private readonly invitationPeerId: string | null;
  private invitationRegistered: boolean;
  private invitationBoundAt: string | null;
  private readonly listeners = new Map<string, Set<Listener<unknown>>>();
  private readonly handleOnline = () => {
    this.waitingForOnline = false;
    if (!this.closedByUser && !this.terminalFailure) this.connect();
  };

  constructor(
    readonly sessionId: string,
    readonly role: WebRtcSignalRole,
    readonly relayUrl: string,
    readonly pairingId: string | null = null,
    readonly invitation: InvitationSignalCredentials | null = null,
  ) {
    this.invitationPeerId = role === "monitor" && invitation ? crypto.randomUUID() : null;
    this.invitationBoundAt = validTimestamp(invitation?.boundAt) ? invitation!.boundAt! : null;
    this.invitationRegistered = invitation?.bound === true || this.invitationBoundAt !== null;
  }

  connect() {
    if (!this.sessionId || this.closedByUser || this.terminalFailure) return;
    if (this.invitation && invitationAuthorityExpired(this.invitation, this.invitationBoundAt)) {
      this.failExpiredInvitation();
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    this.reconnectTimer = null;
    this.reconnectAttempt += 1;
    const socket = new WebSocket(this.invitation
      ? invitationSignalUrl(this.relayUrl, this.invitation.roomId)
      : webRtcSignalUrl(this.relayUrl, this.sessionId));
    let socketErrored = false;
    this.socket = socket;
    socket.addEventListener("open", () => {
      const registration = this.invitation
        ? {
          type: "register",
          protocol: "invitation",
          sessionId: this.sessionId,
          role: this.role,
          roomId: this.invitation.roomId,
          capability: this.invitation.capability,
          ...(this.role === "capture"
            ? { pairingId: this.pairingId }
            : { peerId: this.invitationPeerId }),
        }
        : this.role === "capture"
        ? { type: "register", sessionId: this.sessionId, role: this.role, pairingId: this.pairingId }
        : { type: "register", sessionId: this.sessionId, role: this.role };
      socket.send(JSON.stringify(registration));
    });
    socket.addEventListener("message", (event) => this.receive(socket, String(event.data)));
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.registered = false;
      this.emit("connection", false);
      if (this.invitation && invitationCloseExpired(event, this.invitation, Date.now(), true, this.invitationBoundAt)) {
        this.failExpiredInvitation();
        return;
      }
      if (terminalSignalCloseCodes.has(event.code)) {
        this.failTerminal(event.reason || "The signalling relay rejected this connection", event.code);
        return;
      }
      if (event.code === PAIRING_CONNECTION_ACTIVE_CLOSE_CODE) {
        this.scheduleReconnect(event.code, event.reason);
        return;
      }
      if (socketErrored) {
        this.emit("error", {
          message: "WebRTC signalling was interrupted; retrying",
          retrying: true,
        } satisfies WebRtcSignalError);
      }
      this.scheduleReconnect(event.code, event.reason);
    });
    socket.addEventListener("error", () => { socketErrored = true; });
  }

  dispose() {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.removeOnlineListener();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Signal transport closed");
    this.listeners.clear();
  }

  on<T>(event: string, listener: Listener<T>) {
    const entries = this.listeners.get(event) ?? new Set<Listener<unknown>>();
    entries.add(listener as Listener<unknown>);
    this.listeners.set(event, entries);
    return () => entries.delete(listener as Listener<unknown>);
  }

  requestOffer() {
    return this.send({ type: "webrtc-request-offer" });
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

  signal(peerId: string, signal: WebRtcSignal) {
    return this.send({ type: "webrtc-signal", peerId, signal });
  }

  private receive(socket: WebSocket, encoded: string) {
    try {
      const message = JSON.parse(encoded) as { type?: string; sessionId?: string; role?: string; peerId?: string; signal?: WebRtcSignal; pickedUpAt?: string };
      if (message.type === "session-registered") {
        if (message.sessionId !== this.sessionId || message.role !== this.role) {
          this.emit("error", { message: "The signalling relay acknowledged a different session client" } satisfies WebRtcSignalError);
          socket.close(4400, "Unexpected registration");
          return;
        }
        if (this.invitation) {
          this.invitationRegistered = true;
          if (this.role === "capture") {
            this.invitationBoundAt ??= validTimestamp(message.pickedUpAt)
              ? message.pickedUpAt!
              : new Date().toISOString();
            this.emit("invitation-bound", this.invitationBoundAt);
          }
        }
        this.registered = true;
        this.registeredOnce = true;
        this.reconnectAttempt = 0;
        if (this.role === "capture" && this.captureIntentRequested) this.send({ type: "capture-intent" });
        if (this.role === "capture" && this.xrActiveIntent) this.send({ type: "capture-xr-active" });
        this.emit("connection", true);
      } else if (message.type === "capture-intent-granted" && this.role === "capture") {
        this.captureIntentRequested = true;
        this.emit("capture-intent", true);
      } else if (message.type === "capture-intent-suspended" && this.role === "capture") {
        this.captureIntentRequested = false;
        this.xrActiveIntent = false;
        this.emit("capture-intent", false);
      } else if (message.type === "capture-authority-granted" && this.role === "capture") {
        this.captureIntentRequested = true;
        this.xrActiveIntent = true;
        this.emit("capture-authority", true);
      } else if (message.type === "webrtc-request-offer" && typeof message.peerId === "string") {
        this.emit("webrtc-request-offer", { peerId: message.peerId });
      } else if (message.type === "webrtc-signal" && typeof message.peerId === "string" && message.signal) {
        this.emit("webrtc-signal", { peerId: message.peerId, signal: message.signal });
      } else if (message.type === "invitation-picked-up"
        && this.role === "monitor"
        && message.sessionId === this.sessionId
        && typeof message.pickedUpAt === "string"
        && !Number.isNaN(Date.parse(message.pickedUpAt))) {
        this.invitationBoundAt ??= message.pickedUpAt;
        this.emit("invitation-picked-up", {
          sessionId: message.sessionId,
          pickedUpAt: message.pickedUpAt,
        } satisfies InvitationPickedUp);
      } else {
        this.emit("error", { message: "The signalling relay sent an unreadable message" } satisfies WebRtcSignalError);
      }
    } catch {
      this.emit("error", { message: "The signalling relay sent an unreadable message" } satisfies WebRtcSignalError);
    }
  }

  private send(message: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private emit(event: string, value: unknown) {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }

  private scheduleReconnect(code: number, reason: string) {
    if (this.closedByUser || this.terminalFailure) return;
    if (!this.registeredOnce && this.reconnectAttempt >= maximumPreRegistrationAttempts) {
      this.failTerminal(
        reason || "The signalling relay could not be reached after repeated attempts",
        code || 1006,
      );
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (!this.waitingForOnline && typeof window.addEventListener === "function") {
        this.waitingForOnline = true;
        window.addEventListener("online", this.handleOnline, { once: true });
      }
      return;
    }
    const baseDelay = code === PAIRING_CONNECTION_ACTIVE_CLOSE_CODE
      ? activeCaptureReconnectBaseDelayMs
      : reconnectBaseDelayMs;
    const delayAttempt = this.registeredOnce ? this.reconnectAttempt + 1 : this.reconnectAttempt;
    const delay = reconnectDelayMs(delayAttempt, baseDelay);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private removeOnlineListener() {
    if (!this.waitingForOnline) return;
    this.waitingForOnline = false;
    if (typeof window.removeEventListener === "function") window.removeEventListener("online", this.handleOnline);
  }

  private failExpiredInvitation() {
    if (this.terminalFailure || this.closedByUser) return;
    this.terminalFailure = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.removeOnlineListener();
    this.emit("error", { message: invitationExpiredMessage, code: invitationExpiredCloseCode, terminal: true } satisfies WebRtcSignalError);
  }

  private failTerminal(message: string, code: number) {
    if (this.terminalFailure || this.closedByUser) return;
    this.terminalFailure = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.removeOnlineListener();
    this.emit("error", { message, code, terminal: true } satisfies WebRtcSignalError);
  }
}

function reconnectDelayMs(attempt: number, baseDelayMs: number) {
  const exponent = Math.min(Math.max(0, attempt - 1), 16);
  const exponentialDelay = Math.min(reconnectMaximumDelayMs, baseDelayMs * 2 ** exponent);
  const jitteredDelay = exponentialDelay * (1 - reconnectJitter + Math.random() * reconnectJitter * 2);
  return Math.min(reconnectMaximumDelayMs, Math.max(1, Math.round(jitteredDelay)));
}

export function invitationHasExpired(invitation: InvitationSignalCredentials, now = Date.now()) {
  if (!invitation.expiresAt) return false;
  const expiresAt = Date.parse(invitation.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function invitationAuthorityExpired(
  invitation: InvitationSignalCredentials,
  boundAt: string | null | undefined = invitation.boundAt,
  now = Date.now(),
) {
  if (validTimestamp(boundAt)) return Date.parse(boundAt) + pairedInvitationRetentionMs <= now;
  if (invitation.bound) return false;
  return invitationHasExpired(invitation, now);
}

export function invitationCloseExpired(
  event: Pick<CloseEvent, "code" | "reason">,
  invitation: InvitationSignalCredentials,
  now = Date.now(),
  includeLocalDeadline = true,
  boundAt: string | null | undefined = invitation.boundAt,
) {
  const authorityExpired = invitationAuthorityExpired(invitation, boundAt, now);
  const relayReportedExpiry = event.code === invitationExpiredCloseCode
    || event.reason.trim().toLowerCase() === invitationExpiredMessage.toLowerCase();
  const bound = validTimestamp(boundAt) || invitation.bound === true;
  return relayReportedExpiry && (!bound || authorityExpired)
    || includeLocalDeadline && authorityExpired;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function webRtcSignalUrl(relayUrl: string, sessionId: string) {
  const url = new URL("/signal", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", sessionId);
  return url.toString();
}

export function invitationSignalUrl(relayUrl: string, roomId: string) {
  const url = new URL("/invite-signal", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", roomId);
  return url.toString();
}
