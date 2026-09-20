import assert from "node:assert/strict";
import test from "node:test";
import type { Transcript } from "@moonshine-ai/moonshine-wasm";
import { transcribeLocalVoiceUtterance } from "../src/local-voice-transcriber.js";

test("finalises a fresh stream for each short command and preserves its sample rate", () => {
  const calls: unknown[] = [];
  let streamId = 0;
  const transcriber = {
    createStream() {
      const id = ++streamId;
      let stopped = false;
      return {
        start() { calls.push([id, "start"]); },
        addAudio(audio: Float32Array, rate: number) { calls.push([id, audio.length, rate]); },
        stop() { stopped = true; calls.push([id, "stop"]); },
        transcribe() {
          assert.ok(stopped);
          return { lines: [{ text: "pause", isComplete: true }, { text: "unfinished", isComplete: false }] } as Transcript;
        },
        close() { calls.push([id, "close"]); },
      };
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(transcribeLocalVoiceUtterance(transcriber, new Float32Array(4_800), 48_000), "pause");
  }
  assert.deepEqual(calls, [
    [1, "start"], [1, 4_800, 48_000], [1, "stop"], [1, "close"],
    [2, "start"], [2, 4_800, 48_000], [2, "stop"], [2, "close"],
  ]);
});

test("closes an unsuccessful stream so the loaded model can accept another utterance", () => {
  let closed = 0;
  const transcriber = {
    createStream() {
      return {
        start() {},
        addAudio() { throw new Error("transient decode failure"); },
        stop() {},
        transcribe(): Transcript { return { lines: [] }; },
        close() { closed++; },
      };
    },
  };
  assert.throws(() => transcribeLocalVoiceUtterance(transcriber, new Float32Array(16_000), 16_000), /decode failure/);
  assert.equal(closed, 1);
});
