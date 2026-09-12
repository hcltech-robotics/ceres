import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfiguration } from "../shared/protocol.js";
import {
  clearInterruptedBeamDeliveries,
  DirectSessionReducer,
  isCurrentTaskPresentation,
} from "../src/direct-session-reducer.js";

test("clearing interrupted Beam deliveries does not overwrite a newer acknowledgement", () => {
  const olderDelivery = "9b9f1e4c-a58d-4d27-a21b-6d9d2ae8b761";
  const displayedDelivery = "a2f71cbf-bfbe-43db-87b1-42a451cb885e";
  const pending = new Set([olderDelivery]);

  assert.deepEqual(clearInterruptedBeamDeliveries(pending, displayedDelivery), {
    hadPending: true,
    displayedDeliveryInterrupted: false,
  });
  assert.equal(pending.size, 0);
});

test("clearing interrupted Beam deliveries marks the displayed pending delivery", () => {
  const displayedDelivery = "a2f71cbf-bfbe-43db-87b1-42a451cb885e";
  const pending = new Set([displayedDelivery]);

  assert.deepEqual(clearInterruptedBeamDeliveries(pending, displayedDelivery), {
    hadPending: true,
    displayedDeliveryInterrupted: true,
  });
  assert.equal(pending.size, 0);
});

test("clearing interrupted Beam deliveries is idempotent for an empty set", () => {
  const pending = new Set<string>();
  const expected = { hadPending: false, displayedDeliveryInterrupted: false };

  assert.deepEqual(clearInterruptedBeamDeliveries(pending, null), expected);
  assert.deepEqual(clearInterruptedBeamDeliveries(pending, "a2f71cbf-bfbe-43db-87b1-42a451cb885e"), expected);
});

test("task presentation acknowledgement must match the current task and phase", () => {
  const reducer = new DirectSessionReducer("presentation-test");
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    { ...configuration.tasks[0]!, id: "task-one", label: "Task one" },
    { ...configuration.tasks[0]!, id: "task-two", label: "Task two" },
  ];
  reducer.configure(configuration);
  reducer.configurationApplied(1, "direct-1");
  const snapshot = reducer.snapshot;
  snapshot.run.status = "running";
  snapshot.run.phase = "active-task";
  snapshot.run.activeTaskIndex = 1;

  assert.equal(isCurrentTaskPresentation(snapshot, {
    type: "task-presented",
    revision: 1,
    taskId: "task-two",
    state: "active",
  }), true);
  assert.equal(isCurrentTaskPresentation(snapshot, {
    type: "task-presented",
    revision: 1,
    taskId: "task-one",
    state: "active",
  }), false);
  assert.equal(isCurrentTaskPresentation(snapshot, {
    type: "task-presented",
    revision: 1,
    taskId: "task-two",
    state: "assigned",
  }), false);
  assert.equal(isCurrentTaskPresentation(snapshot, {
    type: "task-presented",
    revision: 0,
    taskId: "task-two",
    state: "active",
  }), false);

  snapshot.run.status = "idle";
  snapshot.run.phase = null;
  assert.equal(isCurrentTaskPresentation(snapshot, {
    type: "task-presented",
    revision: 1,
    taskId: "task-two",
    state: "assigned",
  }), true);
});
