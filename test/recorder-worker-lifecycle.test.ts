import assert from "node:assert/strict";
import test from "node:test";
import { RecorderWorkerLifecycle } from "../src/recorder/recorder-worker-lifecycle.js";

test("serialises recorder arming and waits for it before closing", async () => {
  let releaseFirstArm = () => undefined;
  const firstArmGate = new Promise<void>((resolve) => { releaseFirstArm = resolve; });
  const operations: string[] = [];
  const errors: unknown[] = [];
  const lifecycle = new RecorderWorkerLifecycle((error) => errors.push(error));

  assert.equal(lifecycle.queueArm(async () => {
    operations.push("arm-1-start");
    await firstArmGate;
    operations.push("arm-1-end");
  }), true);
  assert.equal(lifecycle.queueArm(async () => {
    operations.push("arm-2");
  }), true);

  await Promise.resolve();
  assert.deepEqual(operations, ["arm-1-start"]);

  const closed = lifecycle.queueClose(async () => {
    operations.push("close");
  });
  assert.equal(lifecycle.queueArm(async () => {
    operations.push("late-arm");
  }), false);

  releaseFirstArm();
  await closed;

  assert.deepEqual(operations, ["arm-1-start", "arm-1-end", "arm-2", "close"]);
  assert.deepEqual(errors, []);
});

test("closes after reporting an arming failure", async () => {
  const operations: string[] = [];
  const errors: unknown[] = [];
  const lifecycle = new RecorderWorkerLifecycle((error) => errors.push(error));

  lifecycle.queueArm(async () => {
    throw new Error("arm failed");
  });
  await lifecycle.queueClose(async () => {
    operations.push("close");
  });

  assert.deepEqual(operations, ["close"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /arm failed/);
});
