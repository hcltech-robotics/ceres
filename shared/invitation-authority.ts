export interface InvitationCaptureRegistrationDecision {
  accepted: boolean;
  waitForActiveRelease: boolean;
}

export interface InvitationCaptureAuthorityDecision {
  accepted: boolean;
  bindPairingId: boolean;
}

export const pairedInvitationRetentionMs = 24 * 60 * 60 * 1_000;
export const publicInvitationLifetimeMs = 5 * 60 * 1_000;
export const invitationCreationClockSkewMs = 30 * 1_000;

export function invitationExpiryAllowed(expiresAt: string, now = Date.now()) {
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline)
    && deadline > now
    && deadline <= now + publicInvitationLifetimeMs + invitationCreationClockSkewMs;
}

export function decideInvitationCaptureRegistration(
  boundPairingId: string | null,
  activePairingId: string | null,
  candidatePairingId: string,
): InvitationCaptureRegistrationDecision {
  if ((boundPairingId && boundPairingId !== candidatePairingId)
    || (activePairingId && activePairingId !== candidatePairingId)) {
    return { accepted: false, waitForActiveRelease: false };
  }
  if (activePairingId) {
    return { accepted: false, waitForActiveRelease: true };
  }
  return { accepted: true, waitForActiveRelease: false };
}

export function decideInvitationCaptureAuthority(
  boundPairingId: string | null,
  activePairingId: string | null,
  candidatePairingId: string,
): InvitationCaptureAuthorityDecision {
  if ((boundPairingId && boundPairingId !== candidatePairingId)
    || (activePairingId && activePairingId !== candidatePairingId)) {
    return { accepted: false, bindPairingId: false };
  }
  return { accepted: true, bindPairingId: !boundPairingId };
}

export function invitationSignallingAvailable(expiresAt: string, pickedUpAt: string | null, now = Date.now()) {
  if (Date.parse(expiresAt) > now) return true;
  if (!pickedUpAt) return false;
  return Date.parse(pickedUpAt) + pairedInvitationRetentionMs > now;
}
