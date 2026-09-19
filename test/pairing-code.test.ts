import assert from "node:assert/strict";
import test from "node:test";
import { createPairingCode, normalisePairingCode, pairingCodeAlphabet, pairingCodeLength, pairingCodePattern, pairingRoomIdPattern } from "../shared/pairing-code.js";
import { receiverCodeFromQr } from "../src/bridge/qr.js";
import { pairReceiver } from "../src/bridge/pairing.js";

test("new codes use the complete canonical alphabet and retain the previous code space", () => {
  assert.equal(pairingCodeAlphabet, "ABCDEFGHJKMNPQRSTUVWXYZ");
  assert.equal(pairingCodeLength, 9);
  assert.ok(pairingCodeAlphabet.length ** pairingCodeLength >= 31 ** 8);
  const characters = new Set<string>();
  for (let index = 0; index < 1_000; index++) {
    const code = createPairingCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{9}$/);
    for (const character of code) characters.add(character);
  }
  assert.equal([...characters].sort().join(""), pairingCodeAlphabet);
});

test("generation rejects biased bytes and refills without shortening the code", context => {
  let calls = 0;
  context.mock.method(crypto, "getRandomValues", (bytes: Uint8Array) => {
    bytes.fill(calls++ === 0 ? 255 : 0);
    return bytes;
  });
  assert.equal(createPairingCode(), "AAAAAAAAA");
  assert.equal(calls, 2);
});

test("normalisation folds ASCII case and trims only surrounding whitespace", () => {
  assert.equal(normalisePairingCode(" \tAbCdEfGhJ\r\n"), "ABCDEFGHJ");
  for (const code of ["ABCDEFGH2", "ABCDEFGHI", "ABCDEFGHL", "ABCDEFGHO", "ABCD-EFGHJ", "ABCD EFGHJ", "ABCD\tEFGHJ", "ABCDEF!HJ", "", "ABCDEFGHJK", "ABCDEFGH\u0131", "ABCDEF\u00dfJ"]) {
    assert.equal(normalisePairingCode(code), null, code);
    assert.equal(pairingCodePattern.test(code), false, code);
  }
});

test("previous eight-character codes and opaque room identities remain resolvable", () => {
  for (const code of ["ABCD2345", "ABCDEFGH", "ABCDL789"]) {
    assert.equal(normalisePairingCode(` ${code.toLowerCase()} `), code);
    assert.equal(pairingRoomIdPattern.test(code), true);
  }
  assert.equal(pairingRoomIdPattern.test("opaque_room_identity_123456"), true);
  assert.equal(normalisePairingCode("opaque_room_identity_123456"), null);
});

test("Bridge QR entry uses the same normalisation and rejects foreign origins", () => {
  const origin = "https://ceres.example.test";
  assert.equal(receiverCodeFromQr(" abCDefGHj ", origin), "ABCDEFGHJ");
  assert.equal(receiverCodeFromQr(`${origin}/bridge/?code=abcDefghj`, origin), "ABCDEFGHJ");
  assert.equal(receiverCodeFromQr(`${origin}/j/abcDefghj?mode=bridge`, origin), "ABCDEFGHJ");
  assert.equal(receiverCodeFromQr(`${origin}/bridge/?code=ABCD2345`, origin), "ABCD2345");
  assert.equal(receiverCodeFromQr("https://other.example.test/bridge/?code=ABCDEFGHJ", origin), null);
  assert.equal(receiverCodeFromQr(`${origin}/bridge/?code=ABCD-EFGHJ`, origin), null);
});

test("invalid Bridge entry fails before accessing an existing receiver binding", async () => {
  for (const code of ["ABCDEFGH2", "ABCDEFGHI", "ABCDEFGHL", "ABCDEFGHO", "ABCD-EFGHJ"]) {
    await assert.rejects(pairReceiver(code), /Enter nine letters, without I, L or O/);
  }
});
