import assert from "node:assert/strict";
import test from "node:test";
import { MonitorLoadController, monitorOverloadOrder } from "../src/monitor-load-controller.js";

test("monitor overload controls engage in the required order", () => {
  const controller = new MonitorLoadController();
  for (let expectedStage = 1; expectedStage <= monitorOverloadOrder.length; expectedStage += 1) {
    for (let sample = 0; sample < 4; sample += 1) controller.observe(20, 0);
    assert.equal(controller.stage, expectedStage);
    assert.equal(monitorOverloadOrder[expectedStage - 1], [
      "reduce-render-rate",
      "drop-mirror-frames",
      "disable-history",
      "reduce-dom-rate",
      "suspend-secondary-work",
    ][expectedStage - 1]);
  }
  assert.equal(controller.renderIntervalMs, 66);
  assert.equal(controller.dropMirrorFrames, true);
  assert.equal(controller.keepHistory, false);
  assert.equal(controller.domIntervalMs, 500);
  assert.equal(controller.runSecondaryWork, false);
});

test("WebSocket buffering sheds monitor work without changing recorder state", () => {
  const controller = new MonitorLoadController();
  for (let sample = 0; sample < 8; sample += 1) controller.observe(1, 512 * 1024);
  assert.equal(controller.stage, 2);
  assert.equal(controller.dropMirrorFrames, true);
});
