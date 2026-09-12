import { BRIDGE_INVITE_MS, BRIDGE_ROOM_MS, BridgeFault, authenticateBridge,
  bridgeSession, claimBridge, requireBridgeIdentity, type BridgeBinding, type BridgeRole } from "./bridge-authority.js";
import type { SignallingContext, SignallingSocket } from "./signalling-context.js";

const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 8192;

export async function bridgeHash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function jsonBody(request: Request): Promise<Record<string, any>> {
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeFault(400, "Bridge request body is required");
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY) { await reader.cancel(); throw new BridgeFault(413, "Bridge request is too large"); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let body;
  try { body = JSON.parse(text); } catch { throw new BridgeFault(400, "Invalid Bridge JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeFault(400, "Invalid Bridge request");
  return body;
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: baseHeaders });
}

function describe(binding: BridgeBinding) {
  return { version: 1, bindingId: binding.id, label: binding.label, epoch: binding.epoch, expiresAt: binding.expiresAt, paired: Boolean(binding.sender) };
}

type Connection = { role?: BridgeRole; deviceId?: string; epoch?: number; openedAt: number };

/** One actor per binding, or per short-lived code. No live observations enter it. */
export class BridgeSignallingAuthority {
  constructor(private readonly ctx: SignallingContext) {}
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/code" && request.method === "POST") {
        const body = await jsonBody(request);
        return await this.ctx.storage.transaction(async (storage) => {
          if (await storage.get("code")) throw new BridgeFault(409, "Bridge code is already allocated");
          await storage.put("code", body);
          await storage.setAlarm(body.expiresAt);
          return response({ ok: true });
        });
      }
      if (path === "/code" && request.method === "GET") {
        const code = await this.ctx.storage.get<{ expiresAt: number }>("code");
        if (!code || Date.now() >= code.expiresAt) throw new BridgeFault(410, "Bridge invitation expired");
        return response(code);
      }
      if (path === "/create" && request.method === "POST") {
        const body = await jsonBody(request);
        const now = Date.now();
        const binding: BridgeBinding = {
          version: 1, id: body.bindingId, label: body.label, appOrigin: body.appOrigin,
          receiver: { id: body.deviceId, hash: await bridgeHash(body.secret) }, sender: null,
          invitation: { code: body.code, hash: await bridgeHash(body.invitationSecret), expiresAt: now + BRIDGE_INVITE_MS },
          epoch: 1, expiresAt: now + BRIDGE_ROOM_MS, revoked: false,
        };
        return await this.ctx.storage.transaction(async (storage) => {
          if (await storage.get("binding")) throw new BridgeFault(409, "Bridge identity is already registered");
          await storage.put("binding", binding);
          return response(describe(binding));
        });
      }
      if (path === "/available") {
        const binding = await this.binding();
        if (binding.revoked || binding.sender || Date.now() >= binding.invitation.expiresAt) throw new BridgeFault(410, "Bridge invitation is no longer available");
        return response({ ok: true });
      }
      if (path === "/signal") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new BridgeFault(426, "Expected SignallingSocket upgrade");
        if (this.ctx.getWebSockets().length >= 4) throw new BridgeFault(429, "Bridge connection limit reached");
        return this.ctx.openWebSocket();
      }
      if (request.method !== "POST") throw new BridgeFault(405, "Use POST for Bridge session operations");
      const body = await jsonBody(request);
      requireBridgeIdentity(body.deviceId);
      requireBridgeIdentity(body.secret);
      const identity = { id: body.deviceId, hash: await bridgeHash(body.secret) };
      const invitationHash = path === "/claim" ? await bridgeHash(String(body.invitationSecret ?? "")) : "";
      const previousEpoch = (await this.binding()).epoch;
      const result = await this.ctx.storage.transaction(async (storage) => {
        let binding = await storage.get<BridgeBinding>("binding");
        if (!binding) throw new BridgeFault(404, "Bridge pairing was not found");
        if (path === "/claim") binding = claimBridge(binding, invitationHash, identity, Date.now());
        else {
          authenticateBridge(binding, body.role, identity);
          if (path === "/session") binding = bridgeSession(binding, Date.now(), body.restartAfter);
          else if (path === "/revoke") binding = { ...binding, revoked: true };
          else throw new BridgeFault(404, "Unknown Bridge operation");
        }
        await storage.put("binding", binding);
        return binding;
      });
      if (result.revoked || result.epoch !== previousEpoch) {
        for (const socket of this.ctx.getWebSockets()) socket.close(4410, result.revoked ? "Pairing revoked" : "Session replaced");
      }
      return response(describe(result));
    } catch (error) {
      if (error instanceof BridgeFault) return response({ error: error.message }, error.status);
      return response({ error: "Bridge request failed" }, 500);
    }
  }

  private async binding(): Promise<BridgeBinding> {
    const binding = await this.ctx.storage.get<BridgeBinding>("binding");
    if (!binding) throw new BridgeFault(404, "Bridge pairing was not found");
    return binding;
  }

  async webSocketMessage(socket: SignallingSocket, raw: string | ArrayBuffer) {
    try {
      if (typeof raw !== "string" || raw.length > 32768) throw new BridgeFault(400, "Invalid Bridge signal size");
      const message = JSON.parse(raw);
      const binding = await this.binding();
      if (binding.revoked || Date.now() >= binding.expiresAt) throw new BridgeFault(410, "Bridge session expired");
      let connection = socket.deserializeAttachment() as Connection;
      if (!connection.role) {
        if (message.type !== "register" || message.version !== 1 || message.epoch !== binding.epoch) throw new BridgeFault(400, "Invalid Bridge registration");
        requireBridgeIdentity(message.deviceId);
        requireBridgeIdentity(message.secret);
        const identity = { id: message.deviceId, hash: await bridgeHash(message.secret) };
        // Re-read after hashing, then check and attach without yielding. Throwing from
        // blockConcurrencyWhile would reset the actor and disconnect its valid pair.
        const current = await this.binding();
        authenticateBridge(current, message.role, identity);
        if (current.epoch !== message.epoch || Date.now() >= current.expiresAt) throw new BridgeFault(410, "Bridge session expired");
        for (const other of this.ctx.getWebSockets()) {
          const peer = other.deserializeAttachment() as Connection;
          if (other !== socket && peer.role === message.role) throw new BridgeFault(409, "Bridge endpoint is already connected");
        }
        connection = { role: message.role, deviceId: message.deviceId, epoch: current.epoch, openedAt: Date.now() };
        socket.serializeAttachment(connection);
        socket.send(JSON.stringify({ type: "registered", epoch: binding.epoch }));
        for (const other of this.ctx.getWebSockets()) {
          const peer = other.deserializeAttachment() as Connection;
          if (peer.role && peer.role !== connection.role && peer.epoch === binding.epoch) {
            other.send(JSON.stringify({ type: "peer-ready", epoch: binding.epoch }));
            socket.send(JSON.stringify({ type: "peer-ready", epoch: binding.epoch }));
          }
        }
        return;
      }
      if (connection.epoch !== binding.epoch || message.epoch !== binding.epoch || message.type !== "signal"
        || !message.signal || typeof message.signal !== "object") throw new BridgeFault(400, "Invalid Bridge signal");
      const signal = message.signal;
      const sdp = signal.type === "offer" || signal.type === "answer";
      if (sdp ? typeof signal.sdp !== "string" || (signal.type === "offer") !== (connection.role === "sender")
        : !("candidate" in signal) || !(signal.candidate === null || typeof signal.candidate === "object")) {
        throw new BridgeFault(400, "Only SDP and ICE are accepted");
      }
      for (const other of this.ctx.getWebSockets()) {
        const peer = other.deserializeAttachment() as Connection;
        if (peer.role && peer.role !== connection.role && peer.epoch === binding.epoch) other.send(raw);
      }
    } catch (error) {
      socket.close(error instanceof BridgeFault && error.status === 409 ? 4409 : 4403,
        error instanceof BridgeFault ? error.message : "Invalid Bridge message");
    }
  }

  webSocketClose(socket: SignallingSocket, code: number, reason: string) { socket.close(code, reason); }
  webSocketError(socket: SignallingSocket) { socket.close(1011, "Bridge signalling failed"); }
  async alarm() {
    const code = await this.ctx.storage.get<{ expiresAt: number }>("code");
    if (code && Date.now() >= code.expiresAt) await this.ctx.storage.delete("code");
    for (const socket of this.ctx.getWebSockets()) {
      const peer = socket.deserializeAttachment() as Connection;
      if (!peer.role && Date.now() - peer.openedAt >= 9000) socket.close(4408, "Registration timed out");
    }
  }
}
