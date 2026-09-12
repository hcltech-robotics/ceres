import type { SessionSnapshot } from "../shared/protocol.js";
import type { SoloXrConsolePage } from "./solo-xr-console-presentation.js";

export const SOLO_SYSTEM_TRANSITION_VERSION = 1 as const;
export const SOLO_SYSTEM_TRANSITION_STORAGE_PREFIX = "ceres.solo.system-transition.";

export type SoloSystemTransitionKind = "file-import" | "folder-export" | "hf-oauth";
export type SoloSystemTransitionPhase = "pending-exit" | "outside-xr" | "awaiting-xr-reentry";

export interface SoloSystemTransitionRequest {
  kind: SoloSystemTransitionKind;
  sessionId: string;
  returnPage: SoloXrConsolePage;
  continuationId?: string;
}

export interface PendingSoloSystemTransition {
  version: typeof SOLO_SYSTEM_TRANSITION_VERSION;
  id: string;
  kind: SoloSystemTransitionKind;
  sessionId: string;
  returnPage: SoloXrConsolePage;
  continuationId?: string;
  requestedAtMs: number;
  phase: SoloSystemTransitionPhase;
  requiresXrReentry: true;
}

export interface SoloSystemTransitionStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface SoloSystemTransitionGuard {
  finalising?: boolean;
}

export function requestSoloSystemTransition(
  request: SoloSystemTransitionRequest,
  snapshot: SessionSnapshot,
  guard: SoloSystemTransitionGuard = {},
  now = Date.now,
  allocateId: () => string = () => crypto.randomUUID(),
): PendingSoloSystemTransition {
  if (request.sessionId !== snapshot.sessionId) {
    throw new Error("The system transition does not belong to this Solo session");
  }
  if (request.continuationId !== undefined && !isSoloContinuationId(request.continuationId)) {
    throw new Error("The Solo system transition continuation identity is invalid");
  }
  const blocker = soloSystemTransitionBlocker(snapshot, guard);
  if (blocker) throw new Error(blocker);
  const transitionId = allocateId();
  if (!isSoloSystemTransitionId(transitionId)) {
    throw new Error("The Solo system transition identity is invalid");
  }
  return Object.freeze({
    version: SOLO_SYSTEM_TRANSITION_VERSION,
    id: transitionId,
    kind: request.kind,
    sessionId: request.sessionId,
    returnPage: request.returnPage,
    ...(request.continuationId ? { continuationId: request.continuationId } : {}),
    requestedAtMs: now(),
    phase: "pending-exit",
    requiresXrReentry: true,
  });
}

export function soloSystemTransitionBlocker(
  snapshot: SessionSnapshot,
  guard: SoloSystemTransitionGuard = {},
): string | null {
  if (guard.finalising || snapshot.run.recordingState === "stopping") {
    return "Finish finalising the current Solo capture before leaving immersive mode";
  }
  if (snapshot.run.status === "running") {
    return "Stop or complete the active Solo run before leaving immersive mode";
  }
  if (snapshot.solo?.startCountdownDeadlineMs != null) {
    return "Cancel the Solo countdown before leaving immersive mode";
  }
  if (snapshot.run.recordingState !== "idle"
    || snapshot.currentEpisode !== null
    || snapshot.pendingEpisode !== null) {
    return "Stop and finalise the current Solo recording before leaving immersive mode";
  }
  return null;
}

export function markSoloSystemTransitionOutsideXr(
  pending: PendingSoloSystemTransition,
): PendingSoloSystemTransition {
  if (pending.phase !== "pending-exit") {
    throw new Error("The Solo system transition has already left immersive mode");
  }
  return Object.freeze({ ...pending, phase: "outside-xr" });
}

export function requireSoloSystemTransitionXrReentry(
  pending: PendingSoloSystemTransition,
): PendingSoloSystemTransition {
  if (pending.phase !== "outside-xr") {
    throw new Error("The Solo system transition is not outside immersive mode");
  }
  return Object.freeze({ ...pending, phase: "awaiting-xr-reentry" });
}

export function completeSoloSystemTransition(
  pending: PendingSoloSystemTransition,
  activeSessionId: string,
  xrActive: boolean,
) {
  if (pending.sessionId !== activeSessionId) {
    throw new Error("The returned system transition belongs to another Solo session");
  }
  if (pending.phase !== "awaiting-xr-reentry" || !xrActive) {
    throw new Error("Explicit XR re-entry is required before resuming the Solo console");
  }
  return pending.returnPage;
}

export function persistSoloSystemTransition(
  storage: SoloSystemTransitionStorage,
  pending: PendingSoloSystemTransition,
) {
  storage.setItem(
    soloSystemTransitionStorageKey(pending.sessionId),
    JSON.stringify(pending),
  );
}

export function restoreSoloSystemTransition(
  storage: SoloSystemTransitionStorage,
  sessionId: string,
): PendingSoloSystemTransition | null {
  const raw = storage.getItem(soloSystemTransitionStorageKey(sessionId));
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    storage.removeItem(soloSystemTransitionStorageKey(sessionId));
    return null;
  }
  if (!isPendingSoloSystemTransition(value) || value.sessionId !== sessionId) {
    storage.removeItem(soloSystemTransitionStorageKey(sessionId));
    return null;
  }
  return Object.freeze({ ...value });
}

export function resumeSoloSystemTransitionAfterReload(
  pending: PendingSoloSystemTransition,
): PendingSoloSystemTransition {
  return pending.phase === "pending-exit"
    ? markSoloSystemTransitionOutsideXr(pending)
    : pending;
}

export function isSoloSystemTransitionOauthReturn(
  pending: PendingSoloSystemTransition,
  result: string | null,
) {
  return pending.kind === "hf-oauth"
    && pending.phase === "outside-xr"
    && (result === "connected" || result === "failed");
}

export function isSoloSystemTransitionContinuation(
  pending: PendingSoloSystemTransition | null,
  kind: SoloSystemTransitionKind,
  continuationId: string,
) {
  return pending?.kind === kind && pending.continuationId === continuationId;
}

export function clearSoloSystemTransition(
  storage: SoloSystemTransitionStorage,
  sessionId: string,
) {
  storage.removeItem(soloSystemTransitionStorageKey(sessionId));
}

export function soloSystemTransitionStorageKey(sessionId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(sessionId)) {
    throw new Error("The Solo session identity is invalid");
  }
  return `${SOLO_SYSTEM_TRANSITION_STORAGE_PREFIX}${sessionId}`;
}

export function isPendingSoloSystemTransition(value: unknown): value is PendingSoloSystemTransition {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingSoloSystemTransition>;
  return pending.version === SOLO_SYSTEM_TRANSITION_VERSION
    && typeof pending.id === "string"
    && isSoloSystemTransitionId(pending.id)
    && typeof pending.sessionId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(pending.sessionId)
    && isSoloSystemTransitionKind(pending.kind)
    && isSoloXrConsolePage(pending.returnPage)
    && (pending.continuationId === undefined || isSoloContinuationId(pending.continuationId))
    && Number.isSafeInteger(pending.requestedAtMs)
    && (pending.requestedAtMs ?? -1) >= 0
    && isSoloSystemTransitionPhase(pending.phase)
    && pending.requiresXrReentry === true;
}

export function isSoloSystemTransitionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isSoloContinuationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isSoloSystemTransitionKind(value: unknown): value is SoloSystemTransitionKind {
  return value === "file-import" || value === "folder-export" || value === "hf-oauth";
}

function isSoloSystemTransitionPhase(value: unknown): value is SoloSystemTransitionPhase {
  return value === "pending-exit" || value === "outside-xr" || value === "awaiting-xr-reentry";
}

function isSoloXrConsolePage(value: unknown): value is SoloXrConsolePage {
  return value === "run"
    || value === "tasks"
    || value === "import"
    || value === "episodes"
    || value === "export";
}
