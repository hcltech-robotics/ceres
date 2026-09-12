import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_CONFIGURATION_SCHEMA_VERSION,
  defaultConfiguration,
  normaliseCaptureConfiguration,
  normaliseTasks,
  soloHandsReadyToRecord,
  taskDurationS,
} from "../shared/protocol.js";

test("default run contains one cycle of a durationless open task", () => {
  assert.equal(CAPTURE_CONFIGURATION_SCHEMA_VERSION, 5);
  assert.equal(defaultConfiguration.schemaVersion, 5);
  assert.equal(defaultConfiguration.totalCycles, 1);
  assert.equal(defaultConfiguration.recordAudio, false);
  assert.equal(defaultConfiguration.tasks.length, 1);
  assert.equal(defaultConfiguration.tasks[0].label, "Open task");
  assert.equal(defaultConfiguration.tasks[0].type, "open");
  assert.equal(taskDurationS(defaultConfiguration.tasks[0]), null);
  assert.equal("durationS" in defaultConfiguration.tasks[0], false);
  assert.equal("setCount" in defaultConfiguration.tasks[0], false);
  assert.equal("repeatMode" in defaultConfiguration.tasks[0], false);
  assert.equal("holdAfterEach" in defaultConfiguration.tasks[0], false);
  assert.equal("taskControlsLocked" in defaultConfiguration, false);
  assert.equal("captureDepth" in defaultConfiguration, false);
});

test("legacy open tasks lose duration and duplicate identifiers are repaired once", () => {
  let sequence = 0;
  const allocateId = () => `task-generated-${++sequence}`;
  const configuration = normaliseCaptureConfiguration({
    taskDescription: "Move the red block into the tray",
    taskControlsLocked: true,
    captureDepth: true,
    tasks: [
      { id: "task-reused", label: "Open move", instructions: "Move until complete", type: "open", durationS: 60 },
      { id: "task-reused", label: "Timed move", instructions: "Move once", type: "timed", durationS: 30 },
      { id: "", label: "Reset", instructions: "Reset the scene", type: "pause", durationS: 15 },
    ],
  }, allocateId);

  assert.equal(configuration.schemaVersion, CAPTURE_CONFIGURATION_SCHEMA_VERSION);
  assert.equal(configuration.runTitle, "Open capture");
  assert.equal(configuration.runDescription, "Move the red block into the tray");
  assert.deepEqual(configuration.tasks.map((task) => task.id), [
    "task-reused",
    "task-generated-1",
    "task-generated-2",
  ]);
  assert.equal(configuration.tasks[0].type, "open");
  assert.equal("durationS" in configuration.tasks[0], false);
  assert.equal(JSON.stringify(configuration.tasks[0]).includes("durationS"), false);
  assert.equal("taskControlsLocked" in configuration, false);
  assert.equal("captureDepth" in configuration, false);

  const secondPass = normaliseCaptureConfiguration(configuration, allocateId);
  assert.deepEqual(secondPass.tasks.map((task) => task.id), configuration.tasks.map((task) => task.id));
  assert.equal(sequence, 2);
});

test("legacy set counts are flattened into repetitions exactly once", () => {
  const [task] = normaliseTasks([{
    id: "task-legacy-sets",
    label: "Legacy sets",
    instructions: "Repeat the task",
    type: "timed",
    durationS: 10,
    repeatMode: "successes",
    repeatCount: 2,
    setCount: 3,
    resetTimeS: 4,
    holdAfterEach: true,
  }]);

  assert.notEqual(task.type, "pause");
  if (task.type === "pause") assert.fail("Expected a repetition task");
  assert.equal(task.repeatCount, 6);
  assert.equal(task.resetTimeS, 5);
  assert.equal("setCount" in task, false);
  assert.equal("repeatMode" in task, false);
  assert.equal("holdAfterEach" in task, false);

  const [secondPass] = normaliseTasks([task]);
  assert.deepEqual(secondPass, task);
});

test("task normalisation preserves valid unique identifiers across editing order", () => {
  const tasks = normaliseTasks([
    { id: "task-alpha", label: "Alpha", instructions: "A", type: "timed", durationS: 5 },
    { id: "task-beta", label: "Beta", instructions: "B", type: "open", durationS: 99 },
  ]);
  const reordered = normaliseTasks([tasks[1], tasks[0]]);

  assert.deepEqual(reordered.map((task) => task.id), ["task-beta", "task-alpha"]);
  assert.equal(reordered[0].type, "open");
  assert.equal("durationS" in reordered[0], false);
});

test("task normalisation never permits zero repetitions", () => {
  const tasks = normaliseTasks([
    { id: "task-zero", label: "Zero", instructions: "A", type: "timed", durationS: 5, repeatCount: 0 },
    { id: "task-fraction", label: "Fraction", instructions: "B", type: "open", repeatCount: .5 },
  ]);
  assert.equal(tasks[0].type === "pause" ? null : tasks[0].repeatCount, 1);
  assert.equal(tasks[1].type === "pause" ? null : tasks[1].repeatCount, 1);
});

test("speech settings survive configuration normalisation", () => {
  const configuration = normaliseCaptureConfiguration({
    sttProvider: "gateway",
    promptAudio: {
      enabled: true,
      required: false,
      useTextToSpeech: true,
      ttsProvider: "browser",
      taskStartAssetUrl: "/audio/start.mp3",
      resetAssetUrl: "",
      completionAssetUrl: "",
    },
  });
  const secondPass = normaliseCaptureConfiguration(configuration);

  assert.equal(secondPass.sttProvider, "gateway");
  assert.equal(secondPass.promptAudio.enabled, true);
  assert.equal(secondPass.promptAudio.useTextToSpeech, true);
  assert.equal(secondPass.promptAudio.ttsProvider, "browser");
});

test("study metadata is optional, bounded and normalised with audio retention", () => {
  const configuration = normaliseCaptureConfiguration({
    recordAudio: false,
    studyMetadata: {
      headsetId: "  quest-rig-9e  ",
      demonstratorId: "  demonstrator-042  ",
      projectId: "  project-canterbury  ",
      consentDate: "2026-02-29",
      consentDocumentId: "  consent-v4-042  ",
    },
  });

  assert.equal(configuration.recordAudio, false);
  assert.deepEqual(configuration.studyMetadata, {
    headsetId: "quest-rig-9e",
    demonstratorId: "demonstrator-042",
    projectId: "project-canterbury",
    consentDate: "",
    consentDocumentId: "consent-v4-042",
  });
});

test("field-less legacy configurations retain audio capture", () => {
  assert.equal(normaliseCaptureConfiguration({}).recordAudio, true);
});

test("Solo is ready to record only when both hands are tracked", () => {
  assert.equal(soloHandsReadyToRecord({ leftHandTracked: true, rightHandTracked: true }), true);
  assert.equal(soloHandsReadyToRecord({ leftHandTracked: true, rightHandTracked: false }), false);
  assert.equal(soloHandsReadyToRecord({ leftHandTracked: false, rightHandTracked: true }), false);
  assert.equal(soloHandsReadyToRecord({ leftHandTracked: false, rightHandTracked: false }), false);
  // A capture status from before this field existed must not read as ready.
  assert.equal(soloHandsReadyToRecord({}), false);
});
