import { decideInvitationCaptureAuthority, decideInvitationCaptureRegistration,
  invitationExpiryAllowed, invitationSignallingAvailable, pairedInvitationRetentionMs } from "./invitation-authority.js";
import type { SignallingContext, SignallingSocket } from "./signalling-context.js";

type SignalRole = "capture" | "monitor";

interface SignalConnection {
  id: string;
  role: SignalRole;
  pairingId: string | null;
  invitation: boolean;
  capabilityHash: string | null;
  candidate: boolean;
  xrActive: boolean;
}

interface RegisterMessage {
  type: "register";
  sessionId: string;
  role: SignalRole;
  pairingId?: string;
}

interface InvitationRegisterMessage {
  type: "register";
  protocol: "invitation";
  sessionId: string;
  roomId: string;
  role: SignalRole;
  capability: string;
  pairingId?: string;
  peerId?: string;
}

interface InvitationRoom {
  version: 1;
  roomId: string;
  sessionId: string;
  monitorCapabilityHash: string;
  demonstratorCapabilityHash: string;
  expiresAt: string;
  joinUrl: string;
}

interface SignalMessage {
  type: "webrtc-request-offer" | "webrtc-signal";
  peerId?: string;
  signal?: unknown;
}

interface CaptureIntentMessage {
  type: "capture-intent" | "capture-xr-active";
}

const sessionIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const roomIdPattern = /^(?:[A-Z2-9]{8}|[A-Za-z0-9_-]{20,128})$/;
const opaqueIdPattern = /^[A-Za-z0-9_-]{20,128}$/;
const pairingIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const maxMessageBytes = 32 * 1024;
const maxMonitorConnections = 8;
const maxCaptureConnections = 8;
const captureConnectionActiveCloseCode = 4409;
const captureConnectionActiveMessage = "The paired capture tab is still connected";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

function isRegisterMessage(value: unknown): value is RegisterMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<RegisterMessage>;
  return message.type === "register"
    && (message.role === "capture" || message.role === "monitor")
    && typeof message.sessionId === "string"
    && sessionIdPattern.test(message.sessionId)
    && (message.role !== "capture" || typeof message.pairingId === "string" && pairingIdPattern.test(message.pairingId));
}

function isInvitationRegisterMessage(value: unknown): value is InvitationRegisterMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<InvitationRegisterMessage>;
  return message.type === "register"
    && message.protocol === "invitation"
    && (message.role === "capture" || message.role === "monitor")
    && typeof message.sessionId === "string" && sessionIdPattern.test(message.sessionId)
    && typeof message.roomId === "string" && roomIdPattern.test(message.roomId)
    && typeof message.capability === "string" && opaqueIdPattern.test(message.capability)
    && (message.role !== "capture" || typeof message.pairingId === "string" && pairingIdPattern.test(message.pairingId))
    && (message.role === "monitor"
      ? message.peerId === undefined || typeof message.peerId === "string" && opaqueIdPattern.test(message.peerId)
      : message.peerId === undefined);
}

function isInvitationRoom(value: unknown): value is InvitationRoom {
  if (!value || typeof value !== "object") return false;
  const room = value as Partial<InvitationRoom>;
  return room.version === 1
    && typeof room.roomId === "string" && roomIdPattern.test(room.roomId)
    && typeof room.sessionId === "string" && sessionIdPattern.test(room.sessionId)
    && typeof room.monitorCapabilityHash === "string" && opaqueIdPattern.test(room.monitorCapabilityHash)
    && typeof room.demonstratorCapabilityHash === "string" && opaqueIdPattern.test(room.demonstratorCapabilityHash)
    && typeof room.expiresAt === "string" && !Number.isNaN(Date.parse(room.expiresAt))
    && typeof room.joinUrl === "string" && room.joinUrl.length <= 1_024;
}

function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SignalMessage>;
  if (message.type === "webrtc-request-offer") return true;
  return message.type === "webrtc-signal" && Boolean(message.signal) && (message.peerId === undefined || typeof message.peerId === "string");
}

function isCaptureIntentMessage(value: unknown): value is CaptureIntentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<CaptureIntentMessage>;
  return message.type === "capture-intent" || message.type === "capture-xr-active";
}

function parseMessage(value: string | ArrayBuffer) {
  if (typeof value !== "string" || value.length > maxMessageBytes) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function messageText(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ type, ...payload });
}

async function hashOpaqueValue(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

function opaqueValuesEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function encodeBase64Url(bytes: Uint8Array) {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 1) encoded += String.fromCharCode(bytes[index]!);
  return btoa(encoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class SessionSignallingAuthority {
  constructor(private readonly ctx: SignallingContext, private readonly allowLegacy = true) {}
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/internal/create-invitation" && request.method === "POST") return this.createInvitation(request);
    if (url.pathname === "/internal/resolve-invitation" && request.method === "GET") return this.resolveInvitation();
    if (url.pathname !== "/signal" && url.pathname !== "/invite-signal") {
      return new Response("Not found", { status: 404, headers: responseHeaders });
    }
    if (url.pathname === "/invite-signal") {
      const room = await this.invitationRoom();
      const pickedUpAt = await this.ctx.storage.get<string>("invitationPickedUpAt") ?? null;
      if (!room || !invitationSignallingAvailable(room.expiresAt, pickedUpAt)) {
        return new Response("Pairing invitation expired", { status: 410, headers: responseHeaders });
      }
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected SignallingSocket upgrade", { status: 426, headers: responseHeaders });
    }
    return this.ctx.openWebSocket();
  }

  async webSocketMessage(socket: SignallingSocket, message: string | ArrayBuffer) {
    const parsed = parseMessage(message);
    if (!parsed) return this.close(socket, 4400, "Invalid signalling message");
    const connection = this.connection(socket);
    if (!connection) return this.register(socket, parsed);
    if (isCaptureIntentMessage(parsed)) {
      if (connection.role !== "capture") return this.close(socket, 4403, "Only capture tabs can claim capture intent");
      if (parsed.type === "capture-intent") return this.selectCaptureCandidate(socket, connection);
      return this.activateCapture(socket, connection);
    }
    if (!isSignalMessage(parsed)) return this.close(socket, 4400, "Only WebRTC signalling is accepted");
    if (parsed.type === "webrtc-request-offer") return this.requestOffer(socket, connection);
    return this.relaySignal(socket, connection, parsed);
  }

  async webSocketClose(socket: SignallingSocket, code: number, reason: string, wasClean: boolean) {
    const connection = this.connection(socket);
    socket.close(code, reason);
    if (connection?.role === "capture" && connection.candidate && !connection.xrActive) {
      await this.selectWaitingCapture(connection.invitation, socket);
    }
  }

  async alarm() {
    const pickedUpAt = await this.ctx.storage.get<string>("invitationPickedUpAt");
    if (pickedUpAt) {
      const retentionDeadline = Date.parse(pickedUpAt) + pairedInvitationRetentionMs;
      if (retentionDeadline > Date.now()) {
        await this.ctx.storage.setAlarm(retentionDeadline);
        return;
      }
    }
    for (const { socket } of this.connections(undefined, true)) socket.close(4408, "Pairing invitation expired");
    await this.ctx.storage.deleteAll();
  }

  private async createInvitation(request: Request) {
    const source = await request.text();
    if (source.length > 2_048) return new Response("Invitation request too large", { status: 413, headers: responseHeaders });
    let candidate: unknown;
    try {
      candidate = JSON.parse(source);
    } catch {
      return new Response("Invitation request is invalid", { status: 400, headers: responseHeaders });
    }
    if (!isInvitationRoom(candidate)) return new Response("Invitation request is invalid", { status: 400, headers: responseHeaders });
    if (!invitationExpiryAllowed(candidate.expiresAt)) {
      return new Response("Pairing invitation expiry is outside the allowed window", { status: 400, headers: responseHeaders });
    }
    const existing = await this.invitationRoom();
    if (existing) return new Response("Pairing room already exists", { status: 409, headers: responseHeaders });
    await this.ctx.storage.put("invitation", candidate);
    await this.ctx.storage.setAlarm(Date.parse(candidate.expiresAt));
    return new Response(null, { status: 201, headers: responseHeaders });
  }

  private async resolveInvitation() {
    const room = await this.invitationRoom();
    if (!room || typeof room.joinUrl !== "string" || Date.parse(room.expiresAt) <= Date.now()) {
      return new Response("Pairing invitation expired", { status: 410, headers: responseHeaders });
    }
    return Response.json({ joinUrl: room.joinUrl, expiresAt: room.expiresAt }, { headers: responseHeaders });
  }

  private async register(socket: SignallingSocket, value: unknown) {
    if (isInvitationRegisterMessage(value)) return this.registerInvitation(socket, value);
    if (!this.allowLegacy) return this.close(socket, 4403, "An invitation capability is required");
    if (!isRegisterMessage(value)) return this.close(socket, 4400, "Registration is required");
    const connections = this.connections(undefined, false);
    if (value.role === "capture") {
      const captures = connections.filter((entry) => entry.connection.role === "capture");
      const activeCapture = captures.find((entry) => entry.connection.xrActive);
      if (activeCapture && activeCapture.connection.pairingId !== value.pairingId) {
        return this.close(socket, 4403, "A different capture device is already paired");
      }
      if (activeCapture) return this.close(socket, captureConnectionActiveCloseCode, captureConnectionActiveMessage);
      if (captures.length >= maxCaptureConnections) return this.close(socket, 4429, "Capture connection limit reached");
    } else if (connections.filter((entry) => entry.connection.role === "monitor").length >= maxMonitorConnections) {
      return this.close(socket, 4429, "Monitor connection limit reached");
    }
    const connection: SignalConnection = {
      id: crypto.randomUUID(),
      role: value.role,
      pairingId: value.role === "capture" ? value.pairingId! : null,
      invitation: false,
      capabilityHash: null,
      candidate: false,
      xrActive: false,
    };
    socket.serializeAttachment(connection);
    this.send(socket, messageText("session-registered", { sessionId: value.sessionId, role: value.role }));
    if (connection.role === "capture") {
      if (!this.signallingCapture(false)) await this.selectCaptureCandidate(socket, connection);
    } else {
      const capture = this.signallingCapture(false);
      if (capture) this.send(capture.socket, messageText("webrtc-request-offer", { peerId: connection.id }));
    }
  }

  private async registerInvitation(socket: SignallingSocket, value: InvitationRegisterMessage) {
    const room = await this.invitationRoom();
    const pickedUpAt = await this.ctx.storage.get<string>("invitationPickedUpAt") ?? null;
    if (!room || !invitationSignallingAvailable(room.expiresAt, pickedUpAt)) return this.close(socket, 4408, "Pairing invitation expired");
    if (room.roomId !== value.roomId || room.sessionId !== value.sessionId) return this.close(socket, 4403, "Pairing invitation mismatch");
    const capabilityHash = await hashOpaqueValue(value.capability);
    const expectedHash = value.role === "monitor" ? room.monitorCapabilityHash : room.demonstratorCapabilityHash;
    if (!opaqueValuesEqual(capabilityHash, expectedHash)) return this.close(socket, 4403, "Pairing invitation rejected");
    const active = value.role === "capture" ? this.activeCapture(true) : this.connections("monitor", true)[0];
    if (value.role === "capture") {
      const pairingId = value.pairingId!;
      const boundPairingId = await this.ctx.storage.get<string>("invitationPairingId") ?? null;
      const registration = decideInvitationCaptureRegistration(boundPairingId, active?.connection.pairingId ?? null, pairingId);
      if (registration.waitForActiveRelease) {
        return this.close(socket, captureConnectionActiveCloseCode, captureConnectionActiveMessage);
      }
      if (!registration.accepted) return this.close(socket, 4403, "A different capture tab is already paired");
      if (this.connections("capture", true).length >= maxCaptureConnections) {
        return this.close(socket, 4429, "Capture connection limit reached");
      }
    } else if (active) {
      this.close(active.socket, 4401, "Monitor connection superseded");
    }
    const connection: SignalConnection = {
      id: value.role === "monitor" && value.peerId ? value.peerId : crypto.randomUUID(),
      role: value.role,
      pairingId: value.role === "capture" ? value.pairingId! : null,
      invitation: true,
      capabilityHash,
      candidate: false,
      xrActive: false,
    };
    socket.serializeAttachment(connection);
    const acceptedPickedUpAt = connection.role === "capture" ? await this.markInvitationPickedUp(room) : null;
    this.send(socket, messageText("session-registered", {
      sessionId: room.sessionId,
      role: value.role,
      ...(acceptedPickedUpAt ? { pickedUpAt: acceptedPickedUpAt } : {}),
    }));
    if (connection.role === "capture") {
      if (!this.signallingCapture(true)) await this.selectCaptureCandidate(socket, connection);
    } else {
      const pickedUpAt = await this.ctx.storage.get<string>("invitationPickedUpAt");
      if (pickedUpAt) this.send(socket, messageText("invitation-picked-up", { sessionId: room.sessionId, pickedUpAt }));
      const capture = this.signallingCapture(true);
      if (capture) this.send(capture.socket, messageText("webrtc-request-offer", { peerId: connection.id }));
    }
  }

  private async markInvitationPickedUp(room: InvitationRoom) {
    const existing = await this.ctx.storage.get<string>("invitationPickedUpAt");
    const pickedUpAt = existing ?? new Date().toISOString();
    if (!existing) await this.ctx.storage.put("invitationPickedUpAt", pickedUpAt);
    await this.ctx.storage.setAlarm(Date.parse(pickedUpAt) + pairedInvitationRetentionMs);
    const message = messageText("invitation-picked-up", { sessionId: room.sessionId, pickedUpAt });
    for (const monitor of this.connections("monitor", true)) this.send(monitor.socket, message);
    return pickedUpAt;
  }

  private async selectCaptureCandidate(socket: SignallingSocket, connection: SignalConnection) {
    if (connection.role !== "capture") return;
    const active = this.activeCapture(connection.invitation);
    if (active && active.socket !== socket) {
      if (active.connection.pairingId === connection.pairingId) {
        return this.close(socket, captureConnectionActiveCloseCode, captureConnectionActiveMessage);
      }
      return this.close(socket, 4403, "A different capture tab is already paired");
    }
    if (connection.invitation) {
      const boundPairingId = await this.ctx.storage.get<string>("invitationPairingId") ?? null;
      if (boundPairingId && boundPairingId !== connection.pairingId) {
        return this.close(socket, 4403, "A different capture tab is already paired");
      }
    }
    for (const previous of this.connections("capture", connection.invitation)) {
      if (previous.socket === socket || !previous.connection.candidate) continue;
      this.setConnection(previous.socket, { ...previous.connection, candidate: false });
      this.send(previous.socket, messageText("capture-intent-suspended", {}));
    }
    const selected = { ...connection, candidate: true };
    this.setConnection(socket, selected);
    this.send(socket, messageText("capture-intent-granted", {}));
    for (const monitor of this.connections("monitor", connection.invitation)) {
      this.send(socket, messageText("webrtc-request-offer", { peerId: monitor.connection.id }));
    }
  }

  private async activateCapture(socket: SignallingSocket, connection: SignalConnection) {
    const active = this.activeCapture(connection.invitation);
    if (active && active.socket !== socket) {
      if (active.connection.pairingId === connection.pairingId) {
        return this.close(socket, captureConnectionActiveCloseCode, captureConnectionActiveMessage);
      }
      return this.close(socket, 4403, "A different capture tab is already paired");
    }
    if (connection.invitation) {
      const authority = await this.ctx.storage.transaction(async (storage) => {
        const boundPairingId = await storage.get<string>("invitationPairingId") ?? null;
        const decision = decideInvitationCaptureAuthority(
          boundPairingId,
          active?.connection.pairingId ?? null,
          connection.pairingId!,
        );
        if (decision.accepted && decision.bindPairingId) await storage.put("invitationPairingId", connection.pairingId!);
        return decision;
      });
      if (!authority.accepted) return this.close(socket, 4403, "A different capture tab is already paired");
    } else {
      const authority = decideInvitationCaptureAuthority(
        null,
        active?.connection.pairingId ?? null,
        connection.pairingId!,
      );
      if (!authority.accepted) return this.close(socket, 4403, "A different capture device is already paired");
    }
    const current = this.connection(socket);
    if (!current || current.role !== "capture") return;
    const activated = { ...current, candidate: true, xrActive: true };
    this.setConnection(socket, activated);
    this.send(socket, messageText("capture-authority-granted", {}));
    for (const other of this.connections("capture", connection.invitation)) {
      if (other.socket === socket) continue;
      this.setConnection(other.socket, { ...other.connection, candidate: false });
      this.send(other.socket, messageText("capture-intent-suspended", {}));
      this.close(other.socket, 4401, "Capture connection superseded by an active XR tab");
    }
    for (const monitor of this.connections("monitor", connection.invitation)) {
      this.send(socket, messageText("webrtc-request-offer", { peerId: monitor.connection.id }));
    }
  }

  private async selectWaitingCapture(invitation: boolean, closedSocket: SignallingSocket) {
    const boundPairingId = invitation
      ? await this.ctx.storage.get<string>("invitationPairingId") ?? null
      : null;
    const waiting = this.connections("capture", invitation).find((entry) => entry.socket !== closedSocket
      && !entry.connection.xrActive
      && (!boundPairingId || entry.connection.pairingId === boundPairingId));
    if (waiting) await this.selectCaptureCandidate(waiting.socket, waiting.connection);
  }

  private requestOffer(socket: SignallingSocket, connection: SignalConnection) {
    if (connection.role !== "monitor") return this.close(socket, 4403, "Only monitors can request a WebRTC offer");
    const capture = this.signallingCapture(connection.invitation);
    if (capture) this.send(capture.socket, messageText("webrtc-request-offer", { peerId: connection.id }));
  }

  private relaySignal(socket: SignallingSocket, connection: SignalConnection, message: SignalMessage) {
    const peerId = message.peerId ?? connection.id;
    if (connection.role === "capture") {
      const capture = this.signallingCapture(connection.invitation);
      if (!capture || capture.socket !== socket) return;
      const monitor = this.connections("monitor", connection.invitation).find((entry) => entry.connection.id === peerId);
      if (monitor) this.send(monitor.socket, messageText("webrtc-signal", { peerId, signal: message.signal }));
      return;
    }
    if (peerId !== connection.id) return this.close(socket, 4403, "Monitor signal peer mismatch");
    const capture = this.signallingCapture(connection.invitation);
    if (capture) this.send(capture.socket, messageText("webrtc-signal", { peerId, signal: message.signal }));
  }

  private activeCapture(invitation: boolean) {
    return this.connections("capture", invitation).find((entry) => entry.connection.xrActive);
  }

  private signallingCapture(invitation: boolean) {
    return this.activeCapture(invitation)
      ?? this.connections("capture", invitation).find((entry) => entry.connection.candidate);
  }

  private connections(role?: SignalRole, invitation?: boolean) {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const connection = this.connection(socket);
      return connection
        && (!role || connection.role === role)
        && (invitation === undefined || connection.invitation === invitation)
        ? [{ socket, connection }]
        : [];
    });
  }

  private connection(socket: SignallingSocket) {
    const attachment = socket.deserializeAttachment();
    if (!attachment || typeof attachment !== "object") return null;
    const value = attachment as Partial<SignalConnection>;
    if ((value.role !== "capture" && value.role !== "monitor") || typeof value.id !== "string" || typeof value.invitation !== "boolean") return null;
    return {
      id: value.id,
      role: value.role,
      pairingId: typeof value.pairingId === "string" ? value.pairingId : null,
      invitation: value.invitation,
      capabilityHash: typeof value.capabilityHash === "string" ? value.capabilityHash : null,
      candidate: value.candidate === true,
      xrActive: value.xrActive === true,
    } satisfies SignalConnection;
  }

  private setConnection(socket: SignallingSocket, connection: SignalConnection) {
    socket.serializeAttachment(connection);
  }

  private invitationRoom() {
    return this.ctx.storage.get<InvitationRoom>("invitation");
  }

  private send(socket: SignallingSocket, value: string) {
    try {
      socket.send(value);
    } catch {
      socket.close(1011, "Signal delivery failed");
    }
  }

  private close(socket: SignallingSocket, code: number, reason: string) {
    socket.close(code, reason);
  }
}
