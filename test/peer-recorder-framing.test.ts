import assert from "node:assert/strict";
import test from "node:test";
import { PeerRecorderAssembler, fragmentPeerRecorderBlock } from "../src/recorder/peer-recorder-framing.js";

test("reassembles a recorder block across bounded peer fragments", () => {
  const source = new Uint8Array(31_117).map((_, index) => index % 251);
  const fragments = fragmentPeerRecorderBlock(42, source, 4_096);
  assert.equal(fragments.length, 8);
  const assembler = new PeerRecorderAssembler();
  let complete = null;
  for (const fragment of fragments) complete = assembler.accept(fragment);
  assert.ok(complete);
  assert.equal(complete.sequence, 42);
  assert.deepEqual(complete.block, source);
});

test("rejects a conflicting recorder fragment", () => {
  const fragments = fragmentPeerRecorderBlock(7, new Uint8Array([1, 2, 3, 4]), 2);
  const assembler = new PeerRecorderAssembler();
  assembler.accept(fragments[0]);
  const conflicting = fragments[0].slice();
  conflicting[24] ^= 0xff;
  assert.throws(() => assembler.accept(conflicting), /conflicts/i);
});
