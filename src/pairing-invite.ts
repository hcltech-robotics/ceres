import { applyConnectionProfile, connectionProfileFromSearch, defaultCeresRelayUrl, type ConnectionProfile } from "./connection-profile.js";

export interface PairingRoomCredentials {
  version: 1;
  sessionId: string;
  roomId: string;
  monitorCapability: string;
  demonstratorCapability: string;
  expiresAt: string;
}

export interface DemonstratorPairingInvite {
  version: 1;
  sessionId: string;
  roomId: string;
  demonstratorCapability: string;
  expiresAt: string;
}

export interface PairingSignalCredentials {
  roomId: string;
  capability: string;
}

export interface PairingInvitationTarget {
  invite: DemonstratorPairingInvite;
  connectionProfile: ConnectionProfile;
  boundAt?: string;
}

type PairingInvitationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const sessionIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const roomIdPattern = /^(?:[A-Z2-9]{8}|[A-Za-z0-9_-]{20,128})$/;
const opaqueIdPattern = /^[A-Za-z0-9_-]{20,128}$/;
export const pairingInvitationLifetimeMs = 5 * 60 * 1_000;
const readableCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const shortPairingCodePattern = /^[A-Z2-9]{8}$/;
const typedPairingCodePattern = /^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const capturePairingInvitationStorageKey = "ceres.capture-pairing-invitation.v1";
const boundPairingInvitationRetentionMs = 24 * 60 * 60 * 1_000;

export function isPairingSessionId(value: unknown): value is string {
  return typeof value === "string" && sessionIdPattern.test(value);
}

export function createPairingRoomCredentials(sessionId: string, now = Date.now()): PairingRoomCredentials {
  if (!isPairingSessionId(sessionId)) throw new Error("The pairing session ID is invalid");
  return {
    version: 1,
    sessionId,
    roomId: randomReadableCode(8),
    monitorCapability: randomOpaqueId(32),
    demonstratorCapability: randomOpaqueId(32),
    expiresAt: new Date(now + pairingInvitationLifetimeMs).toISOString(),
  };
}

export function demonstratorInvite(credentials: PairingRoomCredentials): DemonstratorPairingInvite {
  return {
    version: credentials.version,
    sessionId: credentials.sessionId,
    roomId: credentials.roomId,
    demonstratorCapability: credentials.demonstratorCapability,
    expiresAt: credentials.expiresAt,
  };
}

export function monitorSignalCredentials(credentials: PairingRoomCredentials): PairingSignalCredentials {
  return { roomId: credentials.roomId, capability: credentials.monitorCapability };
}

export function demonstratorSignalCredentials(invite: DemonstratorPairingInvite): PairingSignalCredentials {
  return { roomId: invite.roomId, capability: invite.demonstratorCapability };
}

export function pairingInviteUrl(
  invite: DemonstratorPairingInvite,
  baseUrl = typeof location === "undefined" ? "" : location.origin,
  profile: ConnectionProfile = connectionProfileFromSearch(),
) {
  if (!baseUrl) throw new Error("A capture base URL is required to create an invitation");
  assertInvite(invite);
  const url = new URL("/launch/capture/", baseUrl);
  url.searchParams.set("session", invite.sessionId);
  applyConnectionProfile(url.searchParams, profile);
  url.hash = new URLSearchParams({ invite: encodeInvite(invite) }).toString();
  return url.toString();
}

export function shortPairingInviteUrl(
  invite: DemonstratorPairingInvite,
  baseUrl = typeof location === "undefined" ? "" : location.origin,
) {
  if (!baseUrl) throw new Error("A capture base URL is required to create an invitation");
  assertInvite(invite);
  return new URL(`/j/${invite.roomId}`, baseUrl).toString();
}

export function normaliseShortPairingCode(value: string) {
  const code = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  return typedPairingCodePattern.test(code) ? code : null;
}

export function shareablePairingInviteUrl(
  invite: DemonstratorPairingInvite,
  baseUrl = typeof location === "undefined" ? "" : location.origin,
  profile: ConnectionProfile = connectionProfileFromSearch(),
) {
  const target = pairingInviteUrl(invite, baseUrl, profile);
  return (profile.relayUrl ?? defaultCeresRelayUrl) === defaultCeresRelayUrl
    ? shortPairingInviteUrl(invite, baseUrl)
    : target;
}

export function shortPairingInviteFromUrl(
  value: string,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
) {
  try {
    const url = new URL(value);
    if (!applicationOrigin || url.origin !== new URL(applicationOrigin).origin) return null;
    const code = url.pathname.startsWith("/j/") ? url.pathname.slice("/j/".length) : "";
    return shortPairingCodePattern.test(code) && !url.search && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
}

export function pairingInviteFromUrl(value: string, now = Date.now()): DemonstratorPairingInvite | null {
  const invite = decodedPairingInviteFromUrl(value);
  return invite && Date.parse(invite.expiresAt) > now ? invite : null;
}

export function pairingInvitationTargetFromUrl(
  value: string,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
): PairingInvitationTarget | null {
  return pairingInvitationTargetFromUrlInternal(value, applicationOrigin, now, false);
}

export function pairingInvitationIdentityFromUrl(
  value: string,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
): PairingInvitationTarget | null {
  return pairingInvitationTargetFromUrlInternal(value, applicationOrigin, now, true);
}

function pairingInvitationTargetFromUrlInternal(
  value: string,
  applicationOrigin: string,
  now: number,
  allowExpired: boolean,
): PairingInvitationTarget | null {
  try {
    if (!applicationOrigin) return null;
    const url = new URL(value);
    const capturePath = url.pathname === "/launch/capture/" || url.pathname === "/launch/capture";
    if (url.origin !== new URL(applicationOrigin).origin || !capturePath) return null;
    const invite = decodedPairingInviteFromUrl(url.toString());
    if (!invite || (!allowExpired && Date.parse(invite.expiresAt) <= now)) return null;
    if (!invite || url.searchParams.get("session") !== invite.sessionId) return null;
    return {
      invite,
      connectionProfile: connectionProfileFromSearch(url.search),
    };
  } catch {
    return null;
  }
}

export async function resolvePairingInvitationTarget(
  value: string,
  relayUrl: string,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  fetchImplementation: typeof fetch = fetch,
): Promise<PairingInvitationTarget | null> {
  const embeddedTarget = pairingInvitationTargetFromUrl(value, applicationOrigin);
  if (embeddedTarget) return embeddedTarget;

  const shortInvitation = shortPairingInviteFromUrl(value, applicationOrigin);
  if (!shortInvitation) {
    if (pairingInviteExpired(value)) throw new Error("The pairing invitation has expired");
    if (looksLikePairingInvitationTarget(value)) throw new Error("The pairing invitation target is invalid");
    return null;
  }
  const roomId = new URL(shortInvitation).pathname.slice("/j/".length);
  let response: Response;
  try {
    response = await fetchImplementation(new URL(`/api/v1/invitations/${roomId}`, relayUrl), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new Error("The pairing invitation service is unavailable");
  }
  if (response.status === 404 || response.status === 410) throw new Error("The pairing invitation has expired");
  if (!response.ok) throw new Error("The pairing invitation service is unavailable");

  let payload: { joinUrl?: unknown; expiresAt?: unknown };
  try {
    payload = await response.json() as { joinUrl?: unknown; expiresAt?: unknown };
  } catch {
    throw new Error("The pairing invitation service returned an invalid response");
  }
  if (typeof payload.expiresAt === "string" && Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error("The pairing invitation has expired");
  }
  if (typeof payload.joinUrl !== "string") {
    throw new Error("The pairing invitation service returned an invalid response");
  }
  if (pairingInviteExpired(payload.joinUrl)) throw new Error("The pairing invitation has expired");
  const target = pairingInvitationTargetFromUrl(payload.joinUrl, applicationOrigin);
  if (!target) throw new Error("The pairing invitation target is invalid");
  if (target.invite.roomId !== roomId) throw new Error("The pairing invitation does not match the scanned code");
  return target;
}

export function storedPairingInvitationTarget(
  storageOverride?: PairingInvitationStorage | null,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
) {
  const storage = pairingInvitationStorage(storageOverride);
  if (!storage || !applicationOrigin) return null;
  try {
    const encoded = storage.getItem(capturePairingInvitationStorageKey);
    if (!encoded) return null;
    const record = decodeStoredPairingInvitation(encoded);
    const boundAt = record?.boundAt ? Date.parse(record.boundAt) : Number.NaN;
    const bound = Number.isFinite(boundAt) && boundAt <= now && boundAt + boundPairingInvitationRetentionMs > now;
    const target = record
      ? pairingInvitationTargetFromUrlInternal(record.targetUrl, applicationOrigin, now, bound)
      : null;
    if (target) return {
      ...target,
      ...(bound && record?.boundAt ? { boundAt: record.boundAt } : {}),
    };
    storage.removeItem(capturePairingInvitationStorageKey);
  } catch {
    return null;
  }
  return null;
}

export function storePairingInvitationTarget(
  target: PairingInvitationTarget,
  storageOverride?: PairingInvitationStorage | null,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
) {
  const storage = pairingInvitationStorage(storageOverride);
  if (!storage || !applicationOrigin) return false;
  try {
    const encoded = pairingInviteUrl(target.invite, applicationOrigin, target.connectionProfile);
    if (!pairingInvitationTargetFromUrl(encoded, applicationOrigin, now)) return false;
    storage.setItem(capturePairingInvitationStorageKey, JSON.stringify({ version: 1, targetUrl: encoded }));
    return true;
  } catch {
    return false;
  }
}

export function markStoredPairingInvitationTargetBound(
  storageOverride?: PairingInvitationStorage | null,
  applicationOrigin = typeof location === "undefined" ? "" : location.origin,
  now = Date.now(),
  expectedInvite?: DemonstratorPairingInvite | null,
  authenticatedBoundAt = new Date(now).toISOString(),
) {
  const storage = pairingInvitationStorage(storageOverride);
  if (!storage || !applicationOrigin) return false;
  try {
    const encoded = storage.getItem(capturePairingInvitationStorageKey);
    if (!encoded) return false;
    const record = decodeStoredPairingInvitation(encoded);
    const target = record ? pairingInvitationTargetFromUrlInternal(record.targetUrl, applicationOrigin, now, true) : null;
    if (!record || !target || expectedInvite && !pairingInvitesMatch(target.invite, expectedInvite)) return false;
    const authenticatedBoundAtMs = Date.parse(authenticatedBoundAt);
    if (!Number.isFinite(authenticatedBoundAtMs) || authenticatedBoundAtMs > now + 60_000) return false;
    storage.setItem(capturePairingInvitationStorageKey, JSON.stringify({
      ...record,
      boundAt: record.boundAt ?? new Date(authenticatedBoundAtMs).toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

function pairingInvitesMatch(first: DemonstratorPairingInvite, second: DemonstratorPairingInvite) {
  return first.version === second.version
    && first.sessionId === second.sessionId
    && first.roomId === second.roomId
    && first.demonstratorCapability === second.demonstratorCapability
    && first.expiresAt === second.expiresAt;
}

export function clearStoredPairingInvitationTarget(storageOverride?: PairingInvitationStorage | null) {
  const storage = pairingInvitationStorage(storageOverride);
  if (!storage) return;
  try {
    storage.removeItem(capturePairingInvitationStorageKey);
  } catch {
    // A blocked sessionStorage implementation is equivalent to no persistence.
  }
}

export function pairingInviteFromLocation() {
  if (typeof location === "undefined") return null;
  return pairingInviteFromUrl(location.href);
}

export function clearPairingInviteFragment() {
  if (typeof location === "undefined" || !location.hash) return;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export async function createPairingRoom(
  relayUrl: string,
  credentials: PairingRoomCredentials,
  joinUrl: string,
  fetchImplementation: typeof fetch = fetch,
) {
  const response = await fetchImplementation(new URL("/api/v1/rooms", relayUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: credentials.version,
      roomId: credentials.roomId,
      sessionId: credentials.sessionId,
      monitorCapabilityHash: await hashOpaqueValue(credentials.monitorCapability),
      demonstratorCapabilityHash: await hashOpaqueValue(credentials.demonstratorCapability),
      expiresAt: credentials.expiresAt,
      joinUrl,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("The CERES relay could not create a pairing invitation");
}

export async function hashOpaqueValue(value: string) {
  if (!opaqueIdPattern.test(value)) throw new Error("The pairing capability is invalid");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export function defaultPairingRelay(profile: ConnectionProfile) {
  return profile.relayUrl ?? defaultCeresRelayUrl;
}

function assertInvite(value: unknown): asserts value is DemonstratorPairingInvite {
  const invite = value as Partial<DemonstratorPairingInvite> | null;
  if (invite?.version !== 1
    || !isPairingSessionId(invite.sessionId)
    || typeof invite.roomId !== "string" || !roomIdPattern.test(invite.roomId)
    || typeof invite.demonstratorCapability !== "string" || !opaqueIdPattern.test(invite.demonstratorCapability)
    || typeof invite.expiresAt !== "string" || Number.isNaN(Date.parse(invite.expiresAt))) {
    throw new Error("The pairing invitation is invalid");
  }
}

function decodedPairingInviteFromUrl(value: string): DemonstratorPairingInvite | null {
  try {
    const url = new URL(value);
    const encoded = new URLSearchParams(url.hash.slice(1)).get("invite");
    if (!encoded) return null;
    const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as unknown;
    const invite = Array.isArray(decoded) && decoded.length === 5
      ? {
        version: decoded[0],
        sessionId: decoded[1],
        roomId: decoded[2],
        demonstratorCapability: decoded[3],
        expiresAt: new Date(decoded[4] as number).toISOString(),
      }
      : decoded;
    assertInvite(invite);
    return invite;
  } catch {
    return null;
  }
}

function pairingInviteExpired(value: string) {
  const invite = decodedPairingInviteFromUrl(value);
  return Boolean(invite && Date.parse(invite.expiresAt) <= Date.now());
}

function looksLikePairingInvitationTarget(value: string) {
  try {
    const url = new URL(value);
    return new URLSearchParams(url.hash.slice(1)).has("invite")
      || /^\/j\/[A-Za-z0-9_-]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

function pairingInvitationStorage(storageOverride?: PairingInvitationStorage | null) {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function decodeStoredPairingInvitation(value: string) {
  try {
    const candidate = JSON.parse(value) as { version?: unknown; targetUrl?: unknown; boundAt?: unknown };
    if (candidate.version !== 1 || typeof candidate.targetUrl !== "string") return null;
    if (candidate.boundAt !== undefined && (typeof candidate.boundAt !== "string" || Number.isNaN(Date.parse(candidate.boundAt)))) return null;
    return {
      version: 1 as const,
      targetUrl: candidate.targetUrl,
      ...(typeof candidate.boundAt === "string" ? { boundAt: candidate.boundAt } : {}),
    };
  } catch {
    return null;
  }
}

function randomOpaqueId(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function randomReadableCode(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += readableCodeAlphabet[byte % readableCodeAlphabet.length];
  return code;
}

function encodeInvite(invite: DemonstratorPairingInvite) {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify([
    invite.version,
    invite.sessionId,
    invite.roomId,
    invite.demonstratorCapability,
    Date.parse(invite.expiresAt),
  ])));
}

function encodeBase64Url(bytes: Uint8Array) {
  let encoded = "";
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return btoa(encoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("The invitation encoding is invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
