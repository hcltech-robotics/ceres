import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultConfiguration } from "../shared/protocol.js";
import {
  CERES_TASK_SPEC_SCHEMA,
  CERES_TASK_SPEC_VERSION,
  taskSpecificationSha256Hex,
} from "../shared/task-specification.js";
import {
  loadCatalogueImport,
  loadGistImportCandidates,
  normaliseTaskCatalogue,
  parseGistId,
  parseTaskImportText,
  type TaskCatalogueEntry,
} from "../src/task-import.js";

const specification = {
  schema: CERES_TASK_SPEC_SCHEMA,
  version: CERES_TASK_SPEC_VERSION,
  runTitle: "Sample workflow",
  runDescription: "A catalogue sample",
  cycleCount: 2,
  tasks: [
    {
      id: "place-object",
      type: "timed",
      label: "Place object",
      instructions: "Pick up the object.\nPlace it in the marked container.",
      durationS: 30,
      repeatCount: 3,
      resetTimeS: 5,
    },
  ],
};

test("prepares a versioned task specification without changing non-task settings", async () => {
  const current = structuredClone(defaultConfiguration);
  current.hfRepository = "team/existing-dataset";
  current.uploadAfterEpisode = true;
  const before = structuredClone(current);
  const preview = await parseTaskImportText(JSON.stringify(specification), current, {
    sourceLabel: "Local file",
    fileName: "task.json",
  });

  assert.equal(preview.format, "task-specification");
  assert.equal(preview.configuration.runTitle, "Sample workflow");
  assert.equal(preview.configuration.totalCycles, 2);
  assert.equal(preview.configuration.tasks[0].instructions, specification.tasks[0].instructions);
  assert.equal(preview.configuration.hfRepository, "team/existing-dataset");
  assert.equal(preview.configuration.uploadAfterEpisode, true);
  assert.match(preview.taskSpecHash, /^[0-9a-f]{64}$/);
  assert.equal(preview.publicSource, undefined);
  assert.deepEqual(current, before);
});

test("normalises a legacy run file and warns that only task semantics are imported", async () => {
  const legacy = structuredClone(defaultConfiguration);
  legacy.runTitle = "Legacy run";
  legacy.runDescription = "Imported from a saved run";
  legacy.totalCycles = 4;
  const preview = await parseTaskImportText(JSON.stringify({
    schema: "ceres-run-v5",
    configuration: legacy,
  }), defaultConfiguration, {
    sourceLabel: "Local file",
    fileName: "legacy.json",
  });

  assert.equal(preview.format, "legacy-run");
  assert.equal(preview.configuration.runTitle, "Legacy run");
  assert.equal(preview.configuration.totalCycles, 4);
  assert.deepEqual(preview.warnings, [
    "Only run and task fields will be imported. Capture and export settings remain unchanged.",
  ]);
});

test("parses GitHub Gist IDs and URLs and rejects other hosts", () => {
  const gistId = "2507021ca8403d75f4a817acbff564e2";
  assert.equal(parseGistId(gistId), gistId);
  assert.equal(parseGistId(`https://gist.github.com/chrisvoncsefalvay/${gistId}`), gistId);
  assert.throws(() => parseGistId(`https://example.com/${gistId}`), /public gist.github.com URL/);
  assert.throws(() => parseGistId("not a gist"), /GitHub Gist URL or Gist ID/);
});

test("finds every valid CERES JSON candidate in a multi-file Gist", async () => {
  const gistId = "2507021ca8403d75f4a817acbff564e2";
  const second = {
    ...specification,
    runTitle: "Second workflow",
    tasks: [{
      ...specification.tasks[0],
      id: "second-task",
      label: "Second task",
    }],
  };
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    assert.equal(String(input), `https://api.github.com/gists/${gistId}`);
    return Response.json({
      public: true,
      html_url: `https://gist.github.com/chrisvoncsefalvay/${gistId}`,
      files: {
        "README.md": { filename: "README.md", content: "Notes" },
        "broken.json": { filename: "broken.json", content: "{nope" },
        "first.json": { filename: "first.json", content: JSON.stringify(specification) },
        "second.json": { filename: "second.json", content: JSON.stringify(second) },
      },
    });
  };

  const candidates = await loadGistImportCandidates(gistId, defaultConfiguration, fetchImpl);
  assert.deepEqual(candidates.map((candidate) => candidate.fileName), ["first.json", "second.json"]);
  assert.deepEqual(candidates.map((candidate) => candidate.preview.specification.runTitle), [
    "Sample workflow",
    "Second workflow",
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.preview.publicSource), [
    "public_gist",
    "public_gist",
  ]);
});

test("does not mark an unlisted Gist as a public protocol source", async () => {
  const gistId = "2507021ca8403d75f4a817acbff564e2";
  const fetchImpl = async (): Promise<Response> => Response.json({
    public: false,
    html_url: `https://gist.github.com/chrisvoncsefalvay/${gistId}`,
    files: {
      "task.json": { filename: "task.json", content: JSON.stringify(specification) },
    },
  });

  const candidates = await loadGistImportCandidates(gistId, defaultConfiguration, fetchImpl);
  assert.equal(candidates[0]?.preview.publicSource, undefined);
});

test("loads truncated Gist JSON from its raw URL", async () => {
  const gistId = "2507021ca8403d75f4a817acbff564e2";
  const rawUrl = `https://gist.githubusercontent.com/user/${gistId}/raw/revision/task.json`;
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    if (String(input).includes("api.github.com")) {
      return Response.json({
        files: {
          "task.json": {
            filename: "task.json",
            truncated: true,
            raw_url: rawUrl,
            size: 400,
          },
        },
      });
    }
    return new Response(JSON.stringify(specification), {
      headers: { "content-type": "application/json" },
    });
  };

  const candidates = await loadGistImportCandidates(gistId, defaultConfiguration, fetchImpl);
  assert.deepEqual(calls, [`https://api.github.com/gists/${gistId}`, rawUrl]);
  assert.equal(candidates[0].preview.specification.runTitle, "Sample workflow");
});

test("validates the bundled catalogue and verifies sample content by hash", async () => {
  const catalogue = normaliseTaskCatalogue(JSON.parse(await readFile(
    new URL("../public/task-catalogue.json", import.meta.url),
    "utf8",
  )));
  assert.equal(catalogue.entries.length, 8);
  assert.deepEqual(new Set(catalogue.entries.map((entry) => entry.category)), new Set([
    "repeatable",
    "open-ended",
    "multi-step",
  ]));

  const taskSpecHash = await taskSpecificationSha256Hex(specification);
  const entry: TaskCatalogueEntry = {
    id: "sample",
    title: "Sample",
    summary: "Sample workflow.",
    category: "repeatable",
    tags: ["sample"],
    gistId: "2507021ca8403d75f4a817acbff564e2",
    gistUrl: "https://gist.github.com/2507021ca8403d75f4a817acbff564e2",
    rawUrl: "https://gist.githubusercontent.com/user/2507021ca8403d75f4a817acbff564e2/raw/revision/ceres-task-specification.json",
    fileName: "ceres-task-specification.json",
    taskCount: 1,
    taskSpecVersion: CERES_TASK_SPEC_VERSION,
    taskSpecHash,
  };
  const fetchImpl = async () => new Response(JSON.stringify(specification), {
    headers: { "content-type": "application/json" },
  });
  const preview = await loadCatalogueImport(entry, defaultConfiguration, fetchImpl);
  assert.equal(preview.taskSpecHash, taskSpecHash);
  assert.equal(preview.publicSource, "public_catalogue");

  await assert.rejects(
    loadCatalogueImport({ ...entry, taskSpecHash: "0".repeat(64) }, defaultConfiguration, fetchImpl),
    /does not match its catalogue hash/,
  );
});

test("rejects malformed and unsupported files without mutating the current draft", async () => {
  const current = structuredClone(defaultConfiguration);
  const before = structuredClone(current);
  await assert.rejects(
    parseTaskImportText("{", current, {
      sourceLabel: "Local file",
      fileName: "broken.json",
    }),
    /not valid JSON/,
  );
  await assert.rejects(
    parseTaskImportText(JSON.stringify({ schema: "other" }), current, {
      sourceLabel: "Local file",
      fileName: "other.json",
    }),
    /not a supported CERES/,
  );
  assert.deepEqual(current, before);
});
