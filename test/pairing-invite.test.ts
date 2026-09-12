import assert from "node:assert/strict";
import test from "node:test";

import {
  createPairingRoomCredentials,
  clearStoredPairingInvitationTarget,
  createPairingRoom,
  demonstratorInvite,
  pairingInvitationTargetFromUrl,
  pairingInvitationIdentityFromUrl,
  markStoredPairingInvitationTargetBound,
  normaliseShortPairingCode,
  pairingInviteFromUrl,
  pairingInviteUrl,
  resolvePairingInvitationTarget,
  shareablePairingInviteUrl,
  storedPairingInvitationTarget,
  storePairingInvitationTarget,
  shortPairingInviteFromUrl,
  shortPairingInviteUrl,
} from "../src/pairing-invite.js";

class MemoryPairingStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("a demonstrator invitation carries one capability in its fragment", () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const url = new URL(pairingInviteUrl(demonstratorInvite(room), "https://ceres.example.test", { mode: "direct", relayUrl: "https://relay.example.test/" }));

  assert.equal(url.pathname, "/launch/capture/");
  assert.equal(url.searchParams.get("session"), "a1b2c3d4");
  assert.equal(url.searchParams.get("connection"), "direct");
  assert.equal(url.searchParams.get("relay"), "https://relay.example.test/");
  assert.equal(url.search.includes(room.demonstratorCapability), false);
  assert.equal(url.hash.includes(room.demonstratorCapability), false);
  assert.deepEqual(pairingInviteFromUrl(url.toString()), demonstratorInvite(room));
  assert.match(room.roomId, /^[A-Z2-9]{8}$/);
  assert.equal(Date.parse(room.expiresAt) - Date.now() <= 5 * 60 * 1_000, true);
  assert.equal(Date.parse(room.expiresAt) - Date.now() > 4 * 60 * 1_000, true);
  assert.equal(url.toString().length < 300, true);
});

test("a short invitation is human-scale and same-origin", () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const shortUrl = shortPairingInviteUrl(demonstratorInvite(room), "https://ceres.example.test");
  assert.equal(shortUrl, `https://ceres.example.test/j/${room.roomId}`);
  assert.equal(shortPairingInviteFromUrl(shortUrl, "https://ceres.example.test"), shortUrl);
  assert.equal(shortPairingInviteFromUrl(shortUrl, "https://other.example.test"), null);
});

test("a typed join code is normalised without accepting ambiguous characters", () => {
  assert.equal(normaliseShortPairingCode(" abcd-2345 "), "ABCD2345");
  assert.equal(normaliseShortPairingCode("ABCD 2345"), "ABCD2345");
  assert.equal(normaliseShortPairingCode("ABCDO345"), null);
  assert.equal(normaliseShortPairingCode("TOO-SHORT"), null);
});

test("a custom relay invitation shares the self-contained target", () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const invite = demonstratorInvite(room);
  const baseUrl = "https://ceres.example.test";
  const customProfile = { mode: "direct" as const, relayUrl: "https://relay.example.test/" };
  const customUrl = shareablePairingInviteUrl(invite, baseUrl, customProfile);

  assert.equal(customUrl, pairingInviteUrl(invite, baseUrl, customProfile));
  assert.deepEqual(pairingInvitationTargetFromUrl(customUrl, baseUrl), {
    invite,
    connectionProfile: customProfile,
  });
  assert.equal(
    shareablePairingInviteUrl(invite, baseUrl, { mode: "local", relayUrl: null }),
    shortPairingInviteUrl(invite, baseUrl),
  );
});

test("a short invitation resolves to a validated target and connection profile", async () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const invite = demonstratorInvite(room);
  const applicationOrigin = "https://ceres.example.test";
  const relayUrl = "https://relay.example.test";
  const targetUrl = pairingInviteUrl(invite, applicationOrigin, { mode: "direct", relayUrl: `${relayUrl}/` });
  const shortUrl = shortPairingInviteUrl(invite, applicationOrigin);
  let requestedUrl = "";

  const target = await resolvePairingInvitationTarget(shortUrl, relayUrl, applicationOrigin, async (input, init) => {
    requestedUrl = String(input);
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    return Response.json({ joinUrl: targetUrl, expiresAt: room.expiresAt });
  });

  assert.equal(requestedUrl, `${relayUrl}/api/v1/invitations/${room.roomId}`);
  assert.deepEqual(target, {
    invite,
    connectionProfile: { mode: "direct", relayUrl: `${relayUrl}/` },
  });
  assert.deepEqual(pairingInvitationTargetFromUrl(targetUrl, applicationOrigin), target);
});

test("a Vercel-canonicalised capture path preserves the invitation target", () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const invite = demonstratorInvite(room);
  const applicationOrigin = "https://ceres.example.test";
  const targetUrl = new URL(pairingInviteUrl(invite, applicationOrigin, { mode: "direct", relayUrl: "https://relay.example.test/" }));
  targetUrl.pathname = "/launch/capture";

  assert.deepEqual(pairingInvitationTargetFromUrl(targetUrl.toString(), applicationOrigin), {
    invite,
    connectionProfile: { mode: "direct", relayUrl: "https://relay.example.test/" },
  });

  targetUrl.pathname = "/launch/capture-copy";
  assert.equal(pairingInvitationTargetFromUrl(targetUrl.toString(), applicationOrigin), null);
});

test("a validated in-place invitation survives a same-tab reload without entering the URL", () => {
  const storage = new MemoryPairingStorage();
  const applicationOrigin = "https://ceres.example.test";
  const room = createPairingRoomCredentials("a1b2c3d4");
  const target = {
    invite: demonstratorInvite(room),
    connectionProfile: { mode: "direct" as const, relayUrl: "https://relay.example.test/" },
  };

  assert.equal(storePairingInvitationTarget(target, storage, applicationOrigin), true);
  assert.deepEqual(storedPairingInvitationTarget(storage, applicationOrigin), target);
  assert.equal(markStoredPairingInvitationTargetBound(storage, applicationOrigin), true);
  const restoredBound = storedPairingInvitationTarget(storage, applicationOrigin);
  assert.deepEqual(restoredBound?.invite, target.invite);
  assert.deepEqual(restoredBound?.connectionProfile, target.connectionProfile);
  assert.match(restoredBound?.boundAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  clearStoredPairingInvitationTarget(storage);
  assert.equal(storedPairingInvitationTarget(storage, applicationOrigin), null);
});

test("a bound tab can restore its private signalling target after the public code expires", () => {
  const storage = new MemoryPairingStorage();
  const applicationOrigin = "https://ceres.example.test";
  const createdAt = Date.parse("2026-07-18T12:00:00.000Z");
  const room = createPairingRoomCredentials("a1b2c3d4", createdAt);
  const target = {
    invite: demonstratorInvite(room),
    connectionProfile: { mode: "direct" as const, relayUrl: "https://relay.example.test/" },
  };
  assert.equal(storePairingInvitationTarget(target, storage, applicationOrigin, createdAt), true);
  assert.equal(markStoredPairingInvitationTargetBound(storage, applicationOrigin, createdAt + 1_000), true);
  const restored = storedPairingInvitationTarget(storage, applicationOrigin, createdAt + 6 * 60 * 1_000);
  assert.deepEqual(restored?.invite, target.invite);
  assert.deepEqual(restored?.connectionProfile, target.connectionProfile);
  assert.equal(restored?.boundAt, new Date(createdAt + 1_000).toISOString());
  assert.equal(storedPairingInvitationTarget(storage, applicationOrigin, createdAt + 24 * 60 * 60 * 1_000 + 1_001), null);
});

test("an authenticated pickup can bind just after the public deadline", () => {
  const storage = new MemoryPairingStorage();
  const applicationOrigin = "https://ceres.example.test";
  const createdAt = Date.parse("2026-07-18T12:00:00.000Z");
  const room = createPairingRoomCredentials("a1b2c3d4", createdAt);
  const target = {
    invite: demonstratorInvite(room),
    connectionProfile: { mode: "direct" as const, relayUrl: "https://relay.example.test/" },
  };
  const acknowledgedAt = Date.parse(room.expiresAt) + 1;

  assert.equal(storePairingInvitationTarget(target, storage, applicationOrigin, createdAt), true);
  assert.equal(markStoredPairingInvitationTargetBound(storage, applicationOrigin, acknowledgedAt, {
    ...target.invite,
    roomId: target.invite.roomId === "22222222" ? "33333333" : "22222222",
  }), false);
  assert.equal(markStoredPairingInvitationTargetBound(storage, applicationOrigin, acknowledgedAt), true);
  assert.equal(storedPairingInvitationTarget(storage, applicationOrigin, acknowledgedAt)?.boundAt, new Date(acknowledgedAt).toISOString());
  assert.equal(markStoredPairingInvitationTargetBound(
    storage,
    applicationOrigin,
    acknowledgedAt + 60_000,
    target.invite,
    new Date(acknowledgedAt + 60_000).toISOString(),
  ), true);
  assert.equal(storedPairingInvitationTarget(storage, applicationOrigin, acknowledgedAt + 60_000)?.boundAt, new Date(acknowledgedAt).toISOString());
});

test("stored invitations are discarded after expiry or on another application origin", () => {
  const storage = new MemoryPairingStorage();
  const firstOrigin = "https://ceres.example.test";
  const expiredRoom = createPairingRoomCredentials("a1b2c3d4", Date.now() - 5 * 60 * 1_000 - 1);
  const expiredTarget = {
    invite: demonstratorInvite(expiredRoom),
    connectionProfile: { mode: "direct" as const, relayUrl: "https://relay.example.test/" },
  };

  assert.equal(storePairingInvitationTarget(expiredTarget, storage, firstOrigin), false);
  const liveRoom = createPairingRoomCredentials("a1b2c3d4");
  assert.equal(storePairingInvitationTarget({ ...expiredTarget, invite: demonstratorInvite(liveRoom) }, storage, firstOrigin), true);
  assert.equal(storedPairingInvitationTarget(storage, "https://other.example.test"), null);
  assert.equal(storedPairingInvitationTarget(storage, firstOrigin), null);
});

test("an unavailable or expired short invitation reports its actual failure", async () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const shortUrl = shortPairingInviteUrl(demonstratorInvite(room), "https://ceres.example.test");

  await assert.rejects(
    resolvePairingInvitationTarget(shortUrl, "https://relay.example.test", "https://ceres.example.test", async () => new Response(null, { status: 410 })),
    { message: "The pairing invitation has expired" },
  );
  await assert.rejects(
    resolvePairingInvitationTarget(shortUrl, "https://relay.example.test", "https://ceres.example.test", async () => new Response(null, { status: 503 })),
    { message: "The pairing invitation service is unavailable" },
  );
});

test("an unrelated scanned code is ignored so another detected code can be checked", async () => {
  assert.equal(
    await resolvePairingInvitationTarget("https://example.test/not-a-pairing-code", "https://relay.example.test", "https://ceres.example.test"),
    null,
  );
});

test("a resolved invitation target must use the application origin", () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const targetUrl = pairingInviteUrl(demonstratorInvite(room), "https://other.example.test");

  assert.equal(pairingInvitationTargetFromUrl(targetUrl, "https://ceres.example.test"), null);
});

test("a resolved invitation target session must match its capability", () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  const targetUrl = new URL(pairingInviteUrl(demonstratorInvite(room), "https://ceres.example.test"));
  targetUrl.searchParams.set("session", "mismatch1");

  assert.equal(pairingInvitationTargetFromUrl(targetUrl.toString(), "https://ceres.example.test"), null);
});

test("a short invitation rejects a target for another room", async () => {
  const scannedRoom = createPairingRoomCredentials("a1b2c3d4");
  const returnedInvite = {
    ...demonstratorInvite(scannedRoom),
    roomId: scannedRoom.roomId === "22222222" ? "33333333" : "22222222",
  };
  const applicationOrigin = "https://ceres.example.test";
  const shortUrl = shortPairingInviteUrl(demonstratorInvite(scannedRoom), applicationOrigin);
  const targetUrl = pairingInviteUrl(returnedInvite, applicationOrigin);

  await assert.rejects(
    resolvePairingInvitationTarget(shortUrl, "https://relay.example.test", applicationOrigin, async () => Response.json({
      joinUrl: targetUrl,
      expiresAt: returnedInvite.expiresAt,
    })),
    { message: "The pairing invitation does not match the scanned code" },
  );
});

test("an expired invitation is rejected", () => {
  const room = createPairingRoomCredentials("a1b2c3d4", -15 * 60 * 1_000 - 1);
  const url = pairingInviteUrl(demonstratorInvite(room), "https://ceres.example.test", { mode: "local", relayUrl: null });
  assert.equal(pairingInviteFromUrl(url), null);
  assert.equal(pairingInvitationTargetFromUrl(url, "https://ceres.example.test"), null);
  assert.deepEqual(pairingInvitationIdentityFromUrl(url, "https://ceres.example.test")?.invite, demonstratorInvite(room));
});

test("a room creation request carries the invitation protocol version", async () => {
  const room = createPairingRoomCredentials("a1b2c3d4");
  let payload: Record<string, unknown> | null = null;
  const joinUrl = pairingInviteUrl(demonstratorInvite(room), "https://ceres.example.test");
  await createPairingRoom("https://relay.example.test", room, joinUrl, async (_input, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 201 });
  });
  assert.equal(payload?.version, 1);
  assert.equal(payload?.roomId, room.roomId);
  assert.equal(payload?.joinUrl, joinUrl);
});
