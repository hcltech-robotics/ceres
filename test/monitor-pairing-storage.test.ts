import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionProfile } from "../src/connection-profile.js";
import {
  clearStoredMonitorPairingInvitation,
  monitorPairingRetentionMs,
  storedMonitorPairingInvitation,
  storeMonitorPairingInvitation,
  type MonitorPairingInvitationState,
} from "../src/monitor-pairing-storage.js";
import { createPairingRoomCredentials, demonstratorInvite, pairingInviteUrl, shareablePairingInviteUrl } from "../src/pairing-invite.js";

const applicationOrigin = "https://ceres.example.test";
const localProfile: ConnectionProfile = { mode: "local", relayUrl: null };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

function pairingState(
  sessionId = "monitorrestore1",
  now = Date.parse("2026-07-18T12:00:00.000Z"),
  connectionProfile = localProfile,
): MonitorPairingInvitationState {
  const room = createPairingRoomCredentials(sessionId, now);
  const invite = demonstratorInvite(room);
  return {
    room,
    connectionProfile,
    shareLink: shareablePairingInviteUrl(invite, applicationOrigin, connectionProfile),
    qrTarget: pairingInviteUrl(invite, applicationOrigin, connectionProfile),
  };
}

test("restores the director capability and exact invitation only for the same session and profile", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const storage = memoryStorage();
  const state = pairingState("monitorrestore1", now);

  assert.equal(storeMonitorPairingInvitation(state, storage, applicationOrigin, now), true);
  assert.deepEqual(
    storedMonitorPairingInvitation(state.room.sessionId, localProfile, storage, applicationOrigin, now + 1_000),
    state,
  );
  assert.match([...storage.values.values()][0]!, new RegExp(state.room.monitorCapability));
});

test("discards stored director pairing on a session or connection-profile mismatch", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const directProfile: ConnectionProfile = { mode: "direct", relayUrl: "https://relay.example.test/" };
  for (const mismatch of [
    { sessionId: "anothermonitor1", profile: localProfile },
    { sessionId: "monitorrestore1", profile: directProfile },
  ]) {
    const storage = memoryStorage();
    const state = pairingState("monitorrestore1", now);
    assert.equal(storeMonitorPairingInvitation(state, storage, applicationOrigin, now), true);
    assert.equal(storedMonitorPairingInvitation(mismatch.sessionId, mismatch.profile, storage, applicationOrigin, now), null);
    assert.equal(storage.values.size, 0);
  }
});

test("renews an expired unclaimed invitation but retains a claimed invitation for 24 hours", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const expiredAt = now + 5 * 60 * 1_000 + 1;
  const state = pairingState("monitorrestore1", now);
  const unclaimedStorage = memoryStorage();
  assert.equal(storeMonitorPairingInvitation(state, unclaimedStorage, applicationOrigin, now), true);
  assert.equal(storedMonitorPairingInvitation(state.room.sessionId, localProfile, unclaimedStorage, applicationOrigin, expiredAt), null);
  assert.equal(unclaimedStorage.values.size, 0);

  const pickedUpAt = new Date(now + 30_000).toISOString();
  const claimed = { ...state, pickedUpAt };
  const claimedStorage = memoryStorage();
  assert.equal(storeMonitorPairingInvitation(claimed, claimedStorage, applicationOrigin, now + 30_000), true);
  assert.deepEqual(
    storedMonitorPairingInvitation(state.room.sessionId, localProfile, claimedStorage, applicationOrigin, expiredAt),
    claimed,
  );
  assert.equal(
    storedMonitorPairingInvitation(
      state.room.sessionId,
      localProfile,
      claimedStorage,
      applicationOrigin,
      Date.parse(pickedUpAt) + monitorPairingRetentionMs,
    ),
    null,
  );
  assert.equal(claimedStorage.values.size, 0);
});

test("retains a relay-authenticated pickup acknowledged just after the public deadline", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const state = pairingState("monitorrestore1", now);
  const storage = memoryStorage();
  const pickedUpAt = Date.parse(state.room.expiresAt) + 1;
  const claimed = { ...state, pickedUpAt: new Date(pickedUpAt).toISOString() };

  assert.equal(storeMonitorPairingInvitation(state, storage, applicationOrigin, now), true);
  assert.equal(storeMonitorPairingInvitation(claimed, storage, applicationOrigin, pickedUpAt), true);
  assert.deepEqual(
    storedMonitorPairingInvitation(state.room.sessionId, localProfile, storage, applicationOrigin, pickedUpAt),
    claimed,
  );
  assert.deepEqual(
    storedMonitorPairingInvitation(
      state.room.sessionId,
      localProfile,
      storage,
      applicationOrigin,
      pickedUpAt + monitorPairingRetentionMs - 1,
    ),
    claimed,
  );
  assert.equal(
    storedMonitorPairingInvitation(
      state.room.sessionId,
      localProfile,
      storage,
      applicationOrigin,
      pickedUpAt + monitorPairingRetentionMs,
    ),
    null,
  );
});

test("rejects modified share targets and clears explicitly", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const storage = memoryStorage();
  const state = pairingState("monitorrestore1", now);
  assert.equal(storeMonitorPairingInvitation({ ...state, qrTarget: `${state.qrTarget}x` }, storage, applicationOrigin, now), false);
  assert.equal(storage.values.size, 0);
  assert.equal(storeMonitorPairingInvitation(state, storage, applicationOrigin, now), true);
  const [storageKey, encoded] = [...storage.values.entries()][0]!;
  const modified = JSON.parse(encoded) as { pickedUpAt?: string };
  modified.pickedUpAt = new Date(now + 60_001).toISOString();
  storage.setItem(storageKey, JSON.stringify(modified));
  assert.equal(storedMonitorPairingInvitation(state.room.sessionId, localProfile, storage, applicationOrigin, now), null);
  assert.equal(storeMonitorPairingInvitation(state, storage, applicationOrigin, now), true);
  clearStoredMonitorPairingInvitation(storage);
  assert.equal(storage.values.size, 0);
});
