import { pairingCodePattern } from "./pairing-code.js";

export const BRIDGE_INVITE_MS = 5 * 60_000;
export const BRIDGE_ROOM_MS = 24 * 60 * 60_000;
export const bridgeIdPattern = /^[A-Za-z0-9_-]{20,128}$/;
export const bridgeCodePattern = pairingCodePattern;
export type BridgeRole = "sender" | "receiver";
export interface BridgeIdentity { id: string; hash: string }
export interface BridgeBinding {
  version: 1;
  id: string;
  label: string;
  appOrigin: string;
  receiver: BridgeIdentity;
  sender: BridgeIdentity | null;
  invitation: { code: string; hash: string; expiresAt: number };
  epoch: number;
  expiresAt: number;
  revoked: boolean;
}

export class BridgeFault extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function requireBridgeIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !bridgeIdPattern.test(value)) throw new BridgeFault(400, "Invalid Bridge identity");
}

export function authenticateBridge(binding: BridgeBinding, role: BridgeRole, identity: BridgeIdentity): void {
  const bound = role === "sender" ? binding.sender : role === "receiver" ? binding.receiver : null;
  if (binding.revoked || !bound || bound.id !== identity.id || !constantEqual(bound.hash, identity.hash)) {
    throw new BridgeFault(403, "Bridge pairing is unavailable or revoked");
  }
}

export function claimBridge(binding: BridgeBinding, claimHash: string, identity: BridgeIdentity, now: number): BridgeBinding {
  if (binding.revoked) throw new BridgeFault(410, "Bridge pairing was revoked");
  // An interrupted claim can be retried with the identity saved before the request.
  if (binding.sender) {
    authenticateBridge(binding, "sender", identity);
    return binding;
  }
  if (now >= binding.invitation.expiresAt) throw new BridgeFault(410, "Bridge invitation expired");
  if (!constantEqual(binding.invitation.hash, claimHash)) throw new BridgeFault(403, "Invalid Bridge invitation");
  return { ...binding, sender: identity };
}

export function bridgeSession(binding: BridgeBinding, now: number, restartAfter?: number): BridgeBinding {
  if (binding.revoked) throw new BridgeFault(410, "Bridge pairing was revoked");
  if (restartAfter !== undefined && (!Number.isInteger(restartAfter) || restartAfter < 1 || restartAfter > 0xffffffff)) {
    throw new BridgeFault(400, "Invalid Bridge session generation");
  }
  if (now < binding.expiresAt && restartAfter !== binding.epoch) return binding;
  return { ...binding, epoch: (binding.epoch + 1) >>> 0 || 1, expiresAt: now + BRIDGE_ROOM_MS };
}
