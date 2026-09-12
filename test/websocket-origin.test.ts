import assert from "node:assert/strict";
import test from "node:test";

test("accepts only the configured browser origin behind a TLS proxy", () => {
  assert.equal(isWebSocketOriginAllowed("https://capture.example.test", "127.0.0.1:4317", false, "https://capture.example.test"), true);
  assert.equal(isWebSocketOriginAllowed("https://foreign.example.test", "127.0.0.1:4317", false, "https://capture.example.test"), false);
});
import { isWebSocketOriginAllowed } from "../server/websocket-origin.js";

test("browser WebSocket upgrades require the server origin", () => {
  assert.equal(isWebSocketOriginAllowed("https://ceres.example.test:4317", "ceres.example.test:4317", true), true);
  assert.equal(isWebSocketOriginAllowed("https://other.example.test:4317", "ceres.example.test:4317", true), false);
  assert.equal(isWebSocketOriginAllowed("http://ceres.example.test:4317", "ceres.example.test:4317", true), false);
  assert.equal(isWebSocketOriginAllowed("not-a-url", "ceres.example.test:4317", true), false);
});

test("non-browser clients without an Origin header remain supported", () => {
  assert.equal(isWebSocketOriginAllowed(undefined, "127.0.0.1:4317", false), true);
});
