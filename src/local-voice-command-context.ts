import { nextRunControlCursor, type SessionSnapshot } from "../shared/protocol.js";

/** Ignores elapsed-time telemetry but changes whenever a command's target changes. */
export function localVoiceCommandContext(
  sessionKey: string,
  snapshot: SessionSnapshot | null,
  bridgePaused: boolean | null = null,
) {
  return JSON.stringify([
    sessionKey,
    snapshot?.sessionId ?? null,
    snapshot?.startedAt ?? null,
    snapshot?.configurationStatus.revision ?? null,
    snapshot?.configurationStatus.appliedRevision ?? null,
    snapshot ? nextRunControlCursor(snapshot, "success") : null,
    snapshot?.run.demonstratorReady ?? false,
    snapshot?.run.directorReady ?? false,
    snapshot?.solo?.selectedStartTaskId ?? null,
    snapshot?.solo?.startCountdownDeadlineMs ?? null,
    bridgePaused,
  ]);
}
