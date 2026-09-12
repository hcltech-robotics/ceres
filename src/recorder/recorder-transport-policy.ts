import {
  CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
  CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE,
} from "../../shared/protocol.js";

export function isTerminalRecorderPairingClose(code: number) {
  return code === CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE || code === CAPTURE_PAIRING_REJECTED_CLOSE_CODE;
}

export function shouldReconnectRecorderTransport(
  closed: boolean,
  failed: boolean,
  terminalPairingFailure: boolean,
  captureRegistered: boolean,
  journalReady: boolean,
) {
  return captureRegistered && journalReady && !closed && !failed && !terminalPairingFailure;
}
