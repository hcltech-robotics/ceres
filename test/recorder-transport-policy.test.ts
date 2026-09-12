import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
  CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE,
  PAIRING_CONNECTION_ACTIVE_CLOSE_CODE,
} from "../shared/protocol.js";
import {
  isTerminalRecorderPairingClose,
  shouldReconnectRecorderTransport,
} from "../src/recorder/recorder-transport-policy.js";

test("reconnects only for a registered capture and preserves terminal pairing failures", () => {
  assert.equal(isTerminalRecorderPairingClose(CAPTURE_PAIRING_REJECTED_CLOSE_CODE), true);
  assert.equal(isTerminalRecorderPairingClose(CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE), true);
  assert.equal(isTerminalRecorderPairingClose(PAIRING_CONNECTION_ACTIVE_CLOSE_CODE), false);
  assert.equal(isTerminalRecorderPairingClose(1006), false);
  assert.equal(shouldReconnectRecorderTransport(false, false, true, true, true), false);
  assert.equal(shouldReconnectRecorderTransport(false, true, false, true, true), false);
  assert.equal(shouldReconnectRecorderTransport(true, false, false, true, true), false);
  assert.equal(shouldReconnectRecorderTransport(false, false, false, false, true), false);
  assert.equal(shouldReconnectRecorderTransport(false, false, false, true, false), false);
  assert.equal(shouldReconnectRecorderTransport(false, false, false, true, true), true);
});
