import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSignalTransfer, LocalSignalAssembler } from "../src/local-signal-exchange.js";

const description: RTCSessionDescriptionInit = { type: "offer", sdp: `v=0\r\n${"a=candidate:local 1 udp 1 192.168.1.10 50000 typ host\r\n".repeat(80)}` };

test("local signal transfers reassemble a fragmented offer", () => {
  const transfer = createLocalSignalTransfer("local-test", "offer", description);
  assert.ok(transfer.frames.length > 1);
  const assembler = new LocalSignalAssembler();
  let received = null;
  for (const frame of [...transfer.frames].reverse()) received = assembler.accept(frame) ?? received;
  assert.deepEqual(received, {
    version: 1,
    sessionId: "local-test",
    role: "offer",
    signal: { description },
  });
});

test("local signal transfers reject conflicting frames", () => {
  const transfer = createLocalSignalTransfer("local-test", "offer", description);
  const assembler = new LocalSignalAssembler();
  assembler.accept(transfer.frames[0]);
  assert.throws(() => assembler.accept(transfer.frames[0].replace(/.$/, "A")), /conflicting/);
});
