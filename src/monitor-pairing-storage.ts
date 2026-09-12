import { normaliseConnectionServer, type ConnectionProfile } from "./connection-profile.js";
import {
  demonstratorInvite,
  isPairingSessionId,
  pairingInvitationIdentityFromUrl,
  pairingInviteUrl,
  shareablePairingInviteUrl,
  type PairingRoomCredentials,
} from "./pairing-invite.js";
import { pairedInvitationRetentionMs } from "./webrtc-signal-client.js";

type MonitorPairingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface MonitorPairingInvitationState {
  room: PairingRoomCredentials;
  connectionProfile: ConnectionProfile;
  shareLink: string;
  qrTarget: string;
  pickedUpAt?: string;
}

const monitorPairingInvitationStorageKey = "ceres.monitor-pairing-invitation.v1";
export const monitorPairingRetentionMs = pairedInvitationRetentionMs;
const roomIdPattern = /^(?:[A-Z2-9]{8}|[A-Za-z0-9_-]{20,128})$/;
const opaqueIdPattern = /^[A-Za-z0-9_-]{20,128}$/;

export function storedMonitorPairingInvitation(
  sessionId: string,
  connectionProfile: ConnectionProfile,
  storageOverride?: MonitorPairingStorage | null,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
): MonitorPairingInvitationState | null {
  const storage = monitorPairingStorage(storageOverride);
  if (!storage || !applicationOrigin) return null;
  try {
    const encoded = storage.getItem(monitorPairingInvitationStorageKey);
    if (!encoded) return null;
    const decoded = decodeMonitorPairingInvitation(encoded);
    const restored = decoded
      ? validateMonitorPairingInvitation(decoded, sessionId, connectionProfile, applicationOrigin, now)
      : null;
    if (restored) return restored;
    storage.removeItem(monitorPairingInvitationStorageKey);
  } catch {
    return null;
  }
  return null;
}

export function storeMonitorPairingInvitation(
  state: MonitorPairingInvitationState,
  storageOverride?: MonitorPairingStorage | null,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
) {
  const storage = monitorPairingStorage(storageOverride);
  if (!storage || !applicationOrigin) return false;
  try {
    const validated = validateMonitorPairingInvitation(
      state,
      state.room.sessionId,
      state.connectionProfile,
      applicationOrigin,
      now,
    );
    if (!validated) return false;
    storage.setItem(monitorPairingInvitationStorageKey, JSON.stringify({
      version: 1,
      ...validated,
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredMonitorPairingInvitation(storageOverride?: MonitorPairingStorage | null) {
  const storage = monitorPairingStorage(storageOverride);
  if (!storage) return;
  try {
    storage.removeItem(monitorPairingInvitationStorageKey);
  } catch {
    // A blocked sessionStorage implementation is equivalent to no persistence.
  }
}

function validateMonitorPairingInvitation(
  value: MonitorPairingInvitationState,
  expectedSessionId: string,
  expectedConnectionProfile: ConnectionProfile,
  applicationOrigin: string,
  now: number,
): MonitorPairingInvitationState | null {
  const room = value.room;
  if (!isPairingSessionId(expectedSessionId)
    || !isConnectionProfile(expectedConnectionProfile)
    || !room
    || room.version !== 1
    || room.sessionId !== expectedSessionId
    || !roomIdPattern.test(room.roomId)
    || !opaqueIdPattern.test(room.monitorCapability)
    || !opaqueIdPattern.test(room.demonstratorCapability)
    || !validTimestamp(room.expiresAt)
    || !connectionProfilesMatch(value.connectionProfile, expectedConnectionProfile)
    || typeof value.shareLink !== "string"
    || typeof value.qrTarget !== "string") return null;

  const pickedUpAt = value.pickedUpAt;
  if (pickedUpAt !== undefined && !validTimestamp(pickedUpAt)) return null;
  if (pickedUpAt && Date.parse(pickedUpAt) > now + 60_000) return null;
  if (pickedUpAt
    ? Date.parse(pickedUpAt) + monitorPairingRetentionMs <= now
    : Date.parse(room.expiresAt) <= now) return null;

  const invite = demonstratorInvite(room);
  const expectedTarget = pairingInviteUrl(invite, applicationOrigin, expectedConnectionProfile);
  const expectedShareLink = shareablePairingInviteUrl(invite, applicationOrigin, expectedConnectionProfile);
  if (value.qrTarget !== expectedTarget || value.shareLink !== expectedShareLink) return null;
  const target = pairingInvitationIdentityFromUrl(value.qrTarget, applicationOrigin, now);
  if (!target
    || !connectionProfilesMatch(target.connectionProfile, expectedConnectionProfile)
    || target.invite.sessionId !== room.sessionId
    || target.invite.roomId !== room.roomId
    || target.invite.demonstratorCapability !== room.demonstratorCapability
    || target.invite.expiresAt !== room.expiresAt) return null;

  return {
    room: { ...room },
    connectionProfile: { ...expectedConnectionProfile },
    shareLink: value.shareLink,
    qrTarget: value.qrTarget,
    ...(pickedUpAt ? { pickedUpAt } : {}),
  };
}

function decodeMonitorPairingInvitation(value: string): MonitorPairingInvitationState | null {
  try {
    const candidate = JSON.parse(value) as Partial<MonitorPairingInvitationState> & { version?: unknown };
    if (candidate.version !== 1
      || !candidate.room
      || !candidate.connectionProfile
      || typeof candidate.shareLink !== "string"
      || typeof candidate.qrTarget !== "string"
      || (candidate.pickedUpAt !== undefined && typeof candidate.pickedUpAt !== "string")) return null;
    return {
      room: candidate.room,
      connectionProfile: candidate.connectionProfile,
      shareLink: candidate.shareLink,
      qrTarget: candidate.qrTarget,
      ...(typeof candidate.pickedUpAt === "string" ? { pickedUpAt: candidate.pickedUpAt } : {}),
    };
  } catch {
    return null;
  }
}

function isConnectionProfile(value: ConnectionProfile) {
  if (value?.mode === "local") return value.relayUrl === null;
  return (value?.mode === "direct" || value?.mode === "relayed")
    && typeof value.relayUrl === "string"
    && normaliseConnectionServer(value.relayUrl) === value.relayUrl;
}

function connectionProfilesMatch(first: ConnectionProfile, second: ConnectionProfile) {
  return isConnectionProfile(first)
    && isConnectionProfile(second)
    && first.mode === second.mode
    && first.relayUrl === second.relayUrl;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function monitorPairingStorage(storageOverride?: MonitorPairingStorage | null) {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
