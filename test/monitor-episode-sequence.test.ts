import assert from "node:assert/strict";
import test from "node:test";

import { episodeDisplayCycles } from "../src/monitor-episode-sequence.js";

test("numbers a restarted C01 T01 episode as the next visible cycle", () => {
  assert.deepEqual(episodeDisplayCycles([
    { cycle: 1, taskIndex: 0, repetition: 1 },
    { cycle: 1, taskIndex: 0, repetition: 1 },
    { cycle: 2, taskIndex: 0, repetition: 1 },
  ]), [1, 2, 3]);
});

test("keeps tasks and repetitions within one source cycle", () => {
  assert.deepEqual(episodeDisplayCycles([
    { cycle: 1, taskIndex: 0, repetition: 1 },
    { cycle: 1, taskIndex: 0, repetition: 2 },
    { cycle: 1, taskIndex: 1, repetition: 1 },
    { cycle: 2, taskIndex: 0, repetition: 1 },
  ]), [1, 1, 1, 2]);
});
