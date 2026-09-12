import assert from "node:assert/strict";
import test from "node:test";

import {
  decideInvitationCaptureAuthority,
  decideInvitationCaptureRegistration,
  invitationCreationClockSkewMs,
  invitationExpiryAllowed,
  invitationSignallingAvailable,
  pairedInvitationRetentionMs,
  publicInvitationLifetimeMs,
} from "../shared/invitation-authority.js";

test("keeps capture registration provisional until XR becomes active", () => {
  assert.deepEqual(decideInvitationCaptureRegistration(null, null, "capture-one"), {
    accepted: true,
    waitForActiveRelease: false,
  });
  assert.deepEqual(decideInvitationCaptureRegistration(null, null, "capture-two"), {
    accepted: true,
    waitForActiveRelease: false,
  });
  assert.deepEqual(decideInvitationCaptureRegistration("capture-one", "capture-one", "capture-one"), {
    accepted: false,
    waitForActiveRelease: true,
  });
  assert.deepEqual(decideInvitationCaptureRegistration("capture-one", null, "capture-one"), {
    accepted: true,
    waitForActiveRelease: false,
  });
  assert.deepEqual(decideInvitationCaptureRegistration("capture-one", null, "capture-two"), {
    accepted: false,
    waitForActiveRelease: false,
  });
});

test("locks the invitation to the first XR-active capture across races and reconnects", () => {
  const first = decideInvitationCaptureAuthority(null, null, "capture-one");
  assert.deepEqual(first, { accepted: true, bindPairingId: true });
  const boundPairingId = first.bindPairingId ? "capture-one" : null;

  assert.deepEqual(decideInvitationCaptureAuthority(boundPairingId, "capture-one", "capture-two"), {
    accepted: false,
    bindPairingId: false,
  });
  assert.deepEqual(decideInvitationCaptureAuthority(boundPairingId, null, "capture-two"), {
    accepted: false,
    bindPairingId: false,
  });
  assert.deepEqual(decideInvitationCaptureAuthority(boundPairingId, null, "capture-one"), {
    accepted: true,
    bindPairingId: false,
  });
});

test("accepts only the intended public invitation lifetime at room creation", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  assert.equal(invitationExpiryAllowed(new Date(now).toISOString(), now), false);
  assert.equal(invitationExpiryAllowed(new Date(now + publicInvitationLifetimeMs).toISOString(), now), true);
  assert.equal(invitationExpiryAllowed(
    new Date(now + publicInvitationLifetimeMs + invitationCreationClockSkewMs).toISOString(),
    now,
  ), true);
  assert.equal(invitationExpiryAllowed(
    new Date(now + publicInvitationLifetimeMs + invitationCreationClockSkewMs + 1).toISOString(),
    now,
  ), false);
  assert.equal(invitationExpiryAllowed("not-a-date", now), false);
});

test("keeps signalling available for a bound tab after the public code expires", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const pickedUpAt = new Date(now - 60_000).toISOString();
  assert.equal(invitationSignallingAvailable(new Date(now + 1).toISOString(), null, now), true);
  assert.equal(invitationSignallingAvailable(new Date(now - 1).toISOString(), null, now), false);
  assert.equal(invitationSignallingAvailable(new Date(now - 1).toISOString(), pickedUpAt, now), true);
  assert.equal(invitationSignallingAvailable(
    new Date(now - pairedInvitationRetentionMs - 1).toISOString(),
    new Date(now - pairedInvitationRetentionMs - 1).toISOString(),
    now,
  ), false);
});
