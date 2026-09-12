import assert from "node:assert/strict";
import test from "node:test";

import { SerialOperationQueue } from "../src/recorder/serial-operation-queue.js";

test("serialises recorder operations and closes after accepted work", async () => {
  const events: string[] = [];
  let releaseOpen = () => {};
  const open = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const errors: string[] = [];
  const queue = new SerialOperationQueue((error) => errors.push(String(error)));

  assert.equal(queue.enqueue(async () => {
    events.push("open-start");
    await open;
    events.push("open-finish");
  }, "open failed"), true);
  assert.equal(queue.enqueue(() => { events.push("snapshot"); }, "snapshot failed"), true);
  assert.equal(queue.finish(() => { events.push("close"); }, "close failed"), true);
  assert.equal(queue.enqueue(() => { events.push("late"); }, "late failed"), false);

  await Promise.resolve();
  assert.deepEqual(events, ["open-start"]);
  releaseOpen();
  await queue.idle();
  assert.deepEqual(events, ["open-start", "open-finish", "snapshot", "close"]);
  assert.deepEqual(errors, []);
});

test("reports one failed operation and continues the ordered queue", async () => {
  const events: string[] = [];
  const errors: Array<{ error: unknown; fallback: string }> = [];
  const queue = new SerialOperationQueue((error, fallback) => errors.push({ error, fallback }));

  queue.enqueue(() => { throw new Error("open rejected"); }, "open failed");
  queue.enqueue(() => { events.push("snapshot"); }, "snapshot failed");
  await queue.idle();

  assert.equal(errors.length, 1);
  assert.equal((errors[0].error as Error).message, "open rejected");
  assert.equal(errors[0].fallback, "open failed");
  assert.deepEqual(events, ["snapshot"]);
});
