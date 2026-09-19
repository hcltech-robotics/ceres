export interface Binding {
  version: 1;
  bindingId: string;
  deviceId: string;
  secret: string;
  label: string;
  epoch: number;
  revoked?: boolean;
  invitationSecret?: string;
  code?: string;
}

import { defaultCeresRelayUrl } from "../connection-profile.js";
import { normalisePairingCode, pairingCodeInputError } from "../../shared/pairing-code.js";
export const relayOrigin = defaultCeresRelayUrl;
export const relayBase = relayOrigin.replace(/\/$/, "") + "/api/bridge/v1";
export const randomIdentity = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
export class PairingError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function storedBinding(value?: Binding | null): Promise<Binding | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ceres-bridge", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("pairing");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("pairing", value === undefined ? "readonly" : "readwrite");
      const store = transaction.objectStore("pairing");
      const request = value === undefined ? store.get("receiver") : value === null ? store.delete("receiver") : store.put(value, "receiver");
      transaction.oncomplete = () => resolve(value === undefined ? request.result ?? null : value);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function bridgeRequest(path: string, body?: unknown): Promise<any> {
  const result = await fetch(`${relayBase}${path}`, {
    method: body ? "POST" : "GET", credentials: "omit", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  const reader = result.body?.getReader();
  if (!reader) throw new Error("Empty receiver pairing response");
  const bytes = new Uint8Array(8192);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.length > bytes.length) throw new Error("Receiver pairing response exceeds its budget");
      bytes.set(chunk.value, length);
      length += chunk.value.length;
    }
  } finally { await reader.cancel(); }
  const value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid receiver pairing response");
  if (!result.ok) throw new PairingError(value.error || "Receiver pairing is unavailable", result.status);
  return value;
}

export async function refreshBinding(binding: Binding, restartAfter?: number): Promise<Binding> {
  if (binding.revoked) throw new Error("This receiver has been forgotten");
  const session = await bridgeRequest(`/bindings/${binding.bindingId}/session`, {
    role: "sender", deviceId: binding.deviceId, secret: binding.secret, restartAfter,
  });
  if (!Number.isInteger(session.epoch) || session.epoch < 1 || session.epoch > 0xffffffff) throw new Error("Invalid receiver connection epoch");
  binding = { ...binding, epoch: session.epoch };
  await storedBinding(binding);
  return binding;
}

export async function pairReceiver(code: string): Promise<Binding> {
  const normalised = normalisePairingCode(code);
  if (!normalised) throw new Error(pairingCodeInputError);
  code = normalised;
  const previous = await storedBinding();
  if (previous?.code === code && previous.invitationSecret && !previous.revoked) return completeClaim(previous);
  if (previous) await forgetReceiver(previous);
  const invitation = await bridgeRequest(`/invitations/${code}`);
  if (invitation.version !== 1 || !/^[A-Za-z0-9_-]{20,128}$/.test(invitation.bindingId)
    || !/^[A-Za-z0-9_-]{20,128}$/.test(invitation.invitationSecret)
    || typeof invitation.label !== "string" || invitation.label.length > 80) throw new Error("Invalid receiver invitation");
  const binding: Binding = { version: 1, bindingId: invitation.bindingId, label: invitation.label,
    deviceId: randomIdentity(), secret: randomIdentity(), epoch: 1, invitationSecret: invitation.invitationSecret, code };
  // Persist the exclusive claim identity before the network operation, so a lost response is recoverable.
  await storedBinding(binding);
  return completeClaim(binding);
}

export async function completeClaim(binding: Binding): Promise<Binding> {
  if (binding.invitationSecret) {
    const session = await bridgeRequest(`/bindings/${binding.bindingId}/claim`, binding);
    binding = { ...binding, epoch: session.epoch };
    delete binding.invitationSecret;
    delete binding.code;
    await storedBinding(binding);
  }
  return refreshBinding(binding);
}

export async function forgetReceiver(binding: Binding) {
  // A pending revocation can only be used to revoke, never to reconnect.
  await storedBinding({ ...binding, revoked: true });
  try {
    await bridgeRequest(`/bindings/${binding.bindingId}/revoke`, { role: "sender", deviceId: binding.deviceId, secret: binding.secret });
  } catch (error) {
    if (!(error instanceof PairingError) || ![403, 404, 410].includes(error.status)) throw error;
  }
  await storedBinding(null);
}
