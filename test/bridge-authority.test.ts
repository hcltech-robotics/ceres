import assert from "node:assert/strict";
import test from "node:test";
import { authenticateBridge, bridgeSession, claimBridge, BRIDGE_ROOM_MS, type BridgeBinding } from "../shared/bridge-authority.js";

const initial = (): BridgeBinding => ({ version: 1, id: "binding", label: "Robot", appOrigin: "https://ceres.cam", receiver: { id: "receiver", hash: "receiver-hash" }, sender: null, invitation: { code: "ABCDEFGH", hash: "claim-hash", expiresAt: 1000 }, epoch: 1, expiresAt: 2000, revoked: false });

test("first Bridge claim is exclusive and idempotent across a lost response", () => {
  const identity = { id: "headset", hash: "headset-hash" };
  const bound = claimBridge(initial(), "claim-hash", identity, 100);
  assert.deepEqual(claimBridge(bound, "expired-claim", identity, 9999), bound);
  assert.throws(() => claimBridge(bound, "claim-hash", { id: "other", hash: "other" }, 100), /unavailable/);
  assert.throws(() => claimBridge(initial(), "wrong", identity, 100), /invitation/);
  assert.throws(() => claimBridge(initial(), "claim-hash", identity, 1000), /expired/);
});

test("Bridge binding survives room expiry and simultaneous restarts converge", () => {
  const binding = initial();
  const first = bridgeSession(binding, 100, 1);
  assert.equal(first.epoch, 2);
  assert.deepEqual(bridgeSession(first, 101, 1), first);
  assert.deepEqual(first.receiver, binding.receiver);
  const expired = bridgeSession(first, first.expiresAt);
  assert.equal(expired.epoch, 3);
  assert.equal(expired.expiresAt, first.expiresAt + BRIDGE_ROOM_MS);
});

test("Bridge rejects foreign and revoked identities", () => {
  authenticateBridge(initial(), "receiver", { id: "receiver", hash: "receiver-hash" });
  assert.throws(() => authenticateBridge(initial(), "receiver", { id: "receiver", hash: "wrong" }), /unavailable/);
  const revoked = { ...initial(), revoked: true };
  assert.throws(() => authenticateBridge(revoked, "receiver", revoked.receiver), /revoked/);
  assert.throws(() => bridgeSession(revoked, 10), /revoked/);
});
