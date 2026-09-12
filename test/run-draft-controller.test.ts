import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultConfiguration,
  isRepetitionTask,
} from "../shared/protocol.js";
import { MINIMUM_TASK_RESET_SECONDS } from "../shared/run-sequencing.js";
import {
  RunDraftController,
  convertRunDraftTaskType,
} from "../src/run-draft-controller.js";

test("keeps task editing separate from deliberate Solo start selection", () => {
  const draft = new RunDraftController(defaultConfiguration);
  const first = draft.snapshot.configuration.tasks[0]!;

  draft.focusTask(first.id);
  draft.updateTask(first.id, (task) => ({ ...task, label: "Edited task" }));

  assert.equal(draft.snapshot.focusedTaskId, first.id);
  assert.equal(draft.snapshot.selectedStartTaskId, null);
  assert.equal(draft.snapshot.configuration.tasks[0]?.label, "Edited task");

  draft.selectStartTask(first.id);
  assert.equal(draft.snapshot.selectedStartTaskId, first.id);
});

test("normalises metadata, task values and type transitions", () => {
  const draft = new RunDraftController(defaultConfiguration);
  const first = draft.snapshot.configuration.tasks[0]!;

  draft.setMetadata({
    runTitle: " ",
    runDescription: "  Headset run  ",
    totalCycles: 2.9,
  });
  draft.updateTask(first.id, (task) => {
    if (!isRepetitionTask(task)) return task;
    return {
      ...task,
      label: " ",
      instructions: " ",
      repeatCount: 0,
      resetTimeS: 0,
      ...(task.type === "timed" ? { durationS: -5 } : {}),
    };
  });

  const snapshot = draft.snapshot;
  const task = snapshot.configuration.tasks[0]!;
  assert.equal(snapshot.configuration.runTitle, defaultConfiguration.runTitle);
  assert.equal(snapshot.configuration.runDescription, "Headset run");
  assert.equal(snapshot.configuration.totalCycles, 2);
  assert.equal(task.label, first.label);
  assert.equal(task.instructions, "--");
  assert.ok(isRepetitionTask(task));
  if (isRepetitionTask(task)) {
    assert.equal(task.repeatCount, 1);
    assert.ok(task.resetTimeS > 0);
  }
  if (task.type === "timed") assert.equal(task.durationS, 0);

  const pause = convertRunDraftTaskType(first, "pause");
  const reopened = convertRunDraftTaskType(pause, "open");
  assert.equal(pause.type, "pause");
  assert.equal(reopened.type, "open");
  if (reopened.type === "open") {
    assert.equal(reopened.repeatCount, 1);
    assert.ok(reopened.resetTimeS > 0);
  }
});

test("keeps optional study metadata separate from raw-audio retention", () => {
  const draft = new RunDraftController({ ...defaultConfiguration, recordAudio: true });
  draft.setStudyMetadata({
    headsetId: " quest-rig-9e ",
    demonstratorId: " ",
    projectId: " project-canterbury ",
    consentDate: "2026-08-02",
    consentDocumentId: " consent-v4-042 ",
  });

  assert.equal(draft.snapshot.configuration.recordAudio, true);
  assert.deepEqual(draft.snapshot.configuration.studyMetadata, {
    headsetId: "quest-rig-9e",
    demonstratorId: "",
    projectId: "project-canterbury",
    consentDate: "2026-08-02",
    consentDocumentId: "consent-v4-042",
  });
});

test("restores type-specific task values after switching task type", () => {
  const draft = new RunDraftController(defaultConfiguration);
  const first = draft.snapshot.configuration.tasks[0]!;
  draft.setTaskProperties(first.id, {
    label: first.label,
    instructions: first.instructions,
    type: "timed",
    durationS: 83,
    repeatCount: 4,
    resetTimeS: 7,
  });

  draft.convertTaskType(first.id, "pause");
  const pause = draft.snapshot.configuration.tasks[0]!;
  assert.deepEqual(pause, {
    id: first.id,
    label: first.label,
    instructions: first.instructions,
    type: "pause",
    durationS: 15,
  });

  draft.updateTask(first.id, (task) => task.type === "pause"
    ? { ...task, durationS: 23 }
    : task);
  draft.convertTaskType(first.id, "timed");
  assert.deepEqual(draft.snapshot.configuration.tasks[0], {
    id: first.id,
    label: first.label,
    instructions: first.instructions,
    type: "timed",
    durationS: 83,
    repeatCount: 4,
    resetTimeS: 7,
  });

  draft.convertTaskType(first.id, "pause");
  assert.equal(draft.snapshot.configuration.tasks[0]?.durationS, 23);
  draft.applyConfiguration(draft.readConfiguration());
  draft.convertTaskType(first.id, "timed");
  assert.equal(draft.snapshot.configuration.tasks[0]?.durationS, 83);
  draft.convertTaskType(first.id, "pause");

  const replacement = structuredClone(draft.readConfiguration());
  replacement.tasks[0] = {
    id: first.id,
    label: "Imported task",
    instructions: "Use imported values",
    type: "timed",
    durationS: 47,
    repeatCount: 6,
    resetTimeS: 9,
  };
  draft.applyConfiguration(replacement);
  draft.convertTaskType(first.id, "pause");
  assert.equal(draft.snapshot.configuration.tasks[0]?.durationS, 15);
  draft.convertTaskType(first.id, "timed");
  assert.deepEqual(draft.snapshot.configuration.tasks[0], replacement.tasks[0]);
});

test("preserves ordering, focus and start identity across task mutations", () => {
  const draft = new RunDraftController(defaultConfiguration);
  const first = draft.snapshot.configuration.tasks[0]!;
  draft.selectStartTask(first.id);

  const added = draft.addTask();
  assert.equal(draft.snapshot.focusedTaskId, added.id);
  assert.equal(draft.moveTask(added.id, -1), 0);
  assert.equal(draft.snapshot.configuration.tasks[0]?.id, added.id);
  assert.equal(draft.snapshot.selectedStartTaskId, first.id);

  assert.equal(draft.deleteFocusedTask(), added.id);
  assert.equal(draft.snapshot.configuration.tasks.some((task) => task.id === added.id), false);
  assert.equal(draft.snapshot.selectedStartTaskId, first.id);

  draft.focusTask(first.id);
  assert.equal(draft.deleteFocusedTask(), first.id);
  assert.equal(draft.snapshot.selectedStartTaskId, null);
});

test("applies task properties as one normalised shared update", () => {
  const draft = new RunDraftController(defaultConfiguration);
  const first = draft.snapshot.configuration.tasks[0]!;

  const configuration = draft.setTaskProperties(first.id, {
    label: "  Inspect the item  ",
    instructions: "  Check every marked face  ",
    type: "open",
    durationS: 40,
    repeatCount: 3,
    resetTimeS: 0,
  });

  assert.deepEqual(configuration.tasks[0], {
    id: first.id,
    label: "Inspect the item",
    instructions: "Check every marked face",
    type: "open",
    repeatCount: 3,
    resetTimeS: MINIMUM_TASK_RESET_SECONDS,
  });
});

test("locks every configuration mutation while capture is active", () => {
  const draft = new RunDraftController(defaultConfiguration);
  const first = draft.snapshot.configuration.tasks[0]!;
  draft.setLocked(true);

  assert.throws(() => draft.setMetadata({
    runTitle: "Blocked",
    runDescription: "",
    totalCycles: 1,
  }), /locked/);
  assert.throws(() => draft.updateTask(first.id, (task) => ({ ...task, label: "Blocked" })), /locked/);
  assert.throws(() => draft.addTask(), /locked/);
  assert.throws(() => draft.selectStartTask(first.id), /locked/);
});
