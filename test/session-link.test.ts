import assert from "node:assert/strict";
import test from "node:test";
import { captureSessionUrl } from "../src/session-client.js";

test("capture QR target is a complete session-bearing URL", () => {
  const target = new URL(captureSessionUrl("abcd1234", "https://capture.example.test:8081/monitor/?old=1"));
  assert.equal(target.origin, "https://capture.example.test:8081");
  assert.equal(target.pathname, "/");
  assert.equal(target.searchParams.get("session"), "abcd1234");
  assert.equal(target.searchParams.has("old"), false);
});
