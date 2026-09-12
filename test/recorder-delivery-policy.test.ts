import assert from "node:assert/strict";
import test from "node:test";

import {
  canAcceptSoloPeerBlock,
  SOLO_PEER_WINDOW_MAX_BYTES,
  SOLO_PEER_WINDOW_SIZE,
} from "../src/recorder/recorder-delivery-policy.js";

test("bounds Solo peer delivery by block count", () => {
  assert.equal(canAcceptSoloPeerBlock(SOLO_PEER_WINDOW_SIZE - 1, 0, 1), true);
  assert.equal(canAcceptSoloPeerBlock(SOLO_PEER_WINDOW_SIZE, 0, 1), false);
});

test("bounds Solo peer delivery by accepted bytes", () => {
  assert.equal(canAcceptSoloPeerBlock(1, SOLO_PEER_WINDOW_MAX_BYTES - 1, 1), true);
  assert.equal(canAcceptSoloPeerBlock(1, SOLO_PEER_WINDOW_MAX_BYTES - 1, 2), false);
});

test("allows one block to drain alone at the byte limit", () => {
  assert.equal(canAcceptSoloPeerBlock(0, 0, SOLO_PEER_WINDOW_MAX_BYTES), true);
});
