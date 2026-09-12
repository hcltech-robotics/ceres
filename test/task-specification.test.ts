import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CERES_TASK_SPEC_SCHEMA,
  CERES_TASK_SPEC_VERSION,
  canonicalTaskSpecification,
  canonicalTaskSpecificationBytes,
  normaliseTaskSpecification,
  taskSpecificationSha256Hex,
} from "../shared/task-specification.js";

const validSpecification = {
  schema: CERES_TASK_SPEC_SCHEMA,
  version: CERES_TASK_SPEC_VERSION,
  runTitle: "Sample transfer",
  runDescription: "Move each sample into the rack",
  cycleCount: 2,
  tasks: [
    {
      id: "pick",
      type: "timed",
      label: "Pick sample",
      instructions: "Pick one sample",
      durationS: 12.5,
      repeatCount: 3,
      resetTimeS: 5,
    },
    {
      id: "inspect",
      type: "open",
      label: "Inspect sample",
      instructions: "Inspect until complete",
      repeatCount: 1,
      resetTimeS: 5,
    },
    {
      id: "pause",
      type: "pause",
      label: "Inter-cycle pause",
      instructions: "Wait",
      durationS: 2,
    },
  ],
};

test("canonical task specification has stable UTF-8 JSON and SHA-256 test vectors", async () => {
  const canonical = canonicalTaskSpecification(validSpecification);
  assert.equal(canonical, "{\"schema\":\"ceres-task-specification\",\"version\":1,\"runTitle\":\"Sample transfer\",\"runDescription\":\"Move each sample into the rack\",\"cycleCount\":2,\"tasks\":[{\"id\":\"pick\",\"type\":\"timed\",\"label\":\"Pick sample\",\"instructions\":\"Pick one sample\",\"durationS\":12.5,\"repeatCount\":3,\"resetTimeS\":5},{\"id\":\"inspect\",\"type\":\"open\",\"label\":\"Inspect sample\",\"instructions\":\"Inspect until complete\",\"repeatCount\":1,\"resetTimeS\":5},{\"id\":\"pause\",\"type\":\"pause\",\"label\":\"Inter-cycle pause\",\"instructions\":\"Wait\",\"durationS\":2}]}");
  const bytes = canonicalTaskSpecificationBytes(validSpecification);
  assert.deepEqual(bytes, new TextEncoder().encode(canonical));
  const serverHash = createHash("sha256").update(bytes).digest("hex");
  const browserHash = await taskSpecificationSha256Hex(validSpecification);
  assert.equal(serverHash, browserHash);
  assert.equal(browserHash, "5c9c6718f6ac3283d36dd5787165a9173ab22c70085540a460b779123428f841");
});

test("canonicalisation ignores object key insertion order but preserves task array order", () => {
  const reorderedKeys = {
    tasks: validSpecification.tasks.map((task) => Object.fromEntries(Object.entries(task).reverse())),
    cycleCount: 2,
    runDescription: "Move each sample into the rack",
    runTitle: "Sample transfer",
    version: 1,
    schema: "ceres-task-specification",
  };
  assert.equal(canonicalTaskSpecification(reorderedKeys), canonicalTaskSpecification(validSpecification));
  assert.notEqual(
    canonicalTaskSpecification({ ...validSpecification, tasks: [...validSpecification.tasks].reverse() }),
    canonicalTaskSpecification(validSpecification),
  );
});

test("hash changes with semantic task fields and omits empty optional fields", async () => {
  const baseHash = await taskSpecificationSha256Hex(validSpecification);
  const changedDuration = structuredClone(validSpecification);
  changedDuration.tasks[0].durationS = 13;
  const changedCycles = { ...validSpecification, cycleCount: 3 };
  assert.notEqual(await taskSpecificationSha256Hex(changedDuration), baseHash);
  assert.notEqual(await taskSpecificationSha256Hex(changedCycles), baseHash);

  const withoutDescription = normaliseTaskSpecification({
    ...validSpecification,
    runDescription: "  ",
  });
  assert.equal("runDescription" in withoutDescription, false);
  assert.equal("durationS" in withoutDescription.tasks[1], false);
});

test("task specification validation rejects ambiguous or invalid semantics", () => {
  assert.throws(
    () => normaliseTaskSpecification({ ...validSpecification, version: 2 }),
    /version must be 1/,
  );
  assert.throws(
    () => normaliseTaskSpecification({ ...validSpecification, unknown: true }),
    /unknown field unknown/,
  );
  assert.throws(
    () => normaliseTaskSpecification({
      ...validSpecification,
      tasks: [validSpecification.tasks[0], { ...validSpecification.tasks[0] }],
    }),
    /duplicated/,
  );
  assert.throws(
    () => normaliseTaskSpecification({
      ...validSpecification,
      tasks: [{ ...validSpecification.tasks[1], durationS: 10 }],
    }),
    /unknown field durationS/,
  );
  assert.throws(
    () => normaliseTaskSpecification({
      ...validSpecification,
      tasks: [{ ...validSpecification.tasks[0], repeatCount: 0 }],
    }),
    /positive safe integer/,
  );
});
