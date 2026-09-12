import type { WebRtcSignal } from "../shared/protocol.js";

export type LocalSignalRole = "offer" | "answer";

export interface LocalSignalEnvelope {
  version: 1;
  sessionId: string;
  role: LocalSignalRole;
  signal: Pick<WebRtcSignal, "description">;
}

export interface LocalSignalTransfer {
  transferId: string;
  frames: string[];
}

const framePrefix = "ceres-local:1:";
const maximumFramePayloadLength = 720;
const maximumFrameCount = 128;
const maximumEncodedLength = maximumFramePayloadLength * maximumFrameCount;

export function createLocalSignalTransfer(sessionId: string, role: LocalSignalRole, description: RTCSessionDescriptionInit): LocalSignalTransfer {
  const envelope: LocalSignalEnvelope = {
    version: 1,
    sessionId,
    role,
    signal: { description: { type: description.type, sdp: description.sdp } },
  };
  assertEnvelope(envelope);
  const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
  if (encoded.length > maximumEncodedLength) throw new Error("The local pairing signal is too large to transfer");
  const transferId = createTransferId();
  const count = Math.max(1, Math.ceil(encoded.length / maximumFramePayloadLength));
  return {
    transferId,
    frames: Array.from({ length: count }, (_, index) => {
      const payload = encoded.slice(index * maximumFramePayloadLength, (index + 1) * maximumFramePayloadLength);
      return `${framePrefix}${role}:${transferId}:${index + 1}/${count}:${payload}`;
    }),
  };
}

export class LocalSignalAssembler {
  private transfer: { transferId: string; role: LocalSignalRole; count: number; frames: Map<number, string> } | null = null;

  accept(value: string): LocalSignalEnvelope | null {
    const frame = parseLocalSignalFrame(value);
    if (!frame) return null;
    if (!this.transfer) {
      this.transfer = { transferId: frame.transferId, role: frame.role, count: frame.count, frames: new Map() };
    }
    const transfer = this.transfer;
    if (transfer.transferId !== frame.transferId || transfer.role !== frame.role || transfer.count !== frame.count) {
      throw new Error("The local pairing signal belongs to a different transfer");
    }
    const existing = transfer.frames.get(frame.index);
    if (existing && existing !== frame.payload) throw new Error("The local pairing signal contains conflicting frames");
    transfer.frames.set(frame.index, frame.payload);
    if (transfer.frames.size !== transfer.count) return null;
    const encoded = Array.from({ length: transfer.count }, (_, index) => transfer.frames.get(index + 1)!).join("");
    this.transfer = null;
    if (encoded.length > maximumEncodedLength) throw new Error("The local pairing signal is too large to accept");
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
    } catch {
      throw new Error("The local pairing signal could not be decoded");
    }
    assertEnvelope(envelope);
    if (envelope.role !== frame.role) throw new Error("The local pairing signal role does not match its frames");
    return envelope;
  }

  reset() {
    this.transfer = null;
  }

  get progress() {
    return this.transfer ? { received: this.transfer.frames.size, total: this.transfer.count } : null;
  }
}

interface LocalSignalFrame {
  role: LocalSignalRole;
  transferId: string;
  index: number;
  count: number;
  payload: string;
}

export function parseLocalSignalFrame(value: string): LocalSignalFrame | null {
  const match = /^ceres-local:1:(offer|answer):([A-Za-z0-9_-]{8,64}):(\d{1,3})\/(\d{1,3}):([A-Za-z0-9_-]+)$/.exec(value.trim());
  if (!match) return null;
  const index = Number(match[3]);
  const count = Number(match[4]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < 1 || index > count || count > maximumFrameCount || match[5].length > maximumFramePayloadLength) {
    throw new Error("The local pairing signal frame is invalid");
  }
  return { role: match[1] as LocalSignalRole, transferId: match[2], index, count, payload: match[5] };
}

function assertEnvelope(value: unknown): asserts value is LocalSignalEnvelope {
  const envelope = value as Partial<LocalSignalEnvelope> | null;
  const description = envelope?.signal?.description;
  if (envelope?.version !== 1
    || typeof envelope.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envelope.sessionId)
    || (envelope.role !== "offer" && envelope.role !== "answer")
    || !description || (description.type !== "offer" && description.type !== "answer") || typeof description.sdp !== "string" || !description.sdp) {
    throw new Error("The local pairing signal is invalid");
  }
  if ((envelope.role === "offer") !== (description.type === "offer")) throw new Error("The local pairing signal type is invalid");
}

function createTransferId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array) {
  let encoded = "";
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return btoa(encoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
