import assert from "node:assert/strict";
import test from "node:test";
import { episodeExportTimeline } from "../shared/lerobot-export.js";
import type { Episode } from "../shared/protocol.js";
import { prepareEpisodeExportRow } from "../src/lerobot-export/timeline.js";

const episode = {
  id: "episode-retry",
  runTitle: "Retry run",
  runDescription: "Replace a failed attempt",
  taskId: null,
  taskLabel: "Retry run",
  taskDescription: "Replace a failed attempt",
  cycle: 1,
  repetition: 1,
  take: 1,
  startedAt: "2026-08-01T12:00:00.000Z",
  endedAt: "2026-08-01T12:00:04.000Z",
  outcome: "completed",
  annotation: "pass",
  accepted: true,
  integrity: "valid",
  frameCount: 2,
  gapCount: 1,
  recorderSlotCount: 3,
  mediaChunkCount: 1,
  qualitySummary: {
    decision: "caution",
    reasons: ["1 recorder gap"],
    frameCount: 2,
    gapCount: 1,
    maxLeftHandSpeedMps: 0,
    maxRightHandSpeedMps: 0,
    slowHandEvents: 0,
    trackingLossEvents: 1,
  },
  qualityEvents: [],
  segments: [
    {
      id: "failed-attempt",
      taskId: "task-pick",
      taskLabel: "Pick",
      taskDescription: "Pick the sample",
      repetition: 1,
      take: 1,
      startedAt: "2026-08-01T12:00:00.000Z",
      endedAt: "2026-08-01T12:00:01.000Z",
      startSourceTimestampUs: 1_000_000,
      endSourceTimestampUs: 1_000_000,
      frameCount: 1,
      gapCount: 0,
      recorderSlotCount: 1,
      outcome: "retry",
      accepted: false,
      annotations: [],
    },
    {
      id: "replacement-attempt",
      taskId: "task-pick",
      taskLabel: "Pick",
      taskDescription: "Pick the sample",
      repetition: 1,
      take: 2,
      startedAt: "2026-08-01T12:00:02.000Z",
      endedAt: "2026-08-01T12:00:04.000Z",
      startSourceTimestampUs: 2_000_000,
      endSourceTimestampUs: 2_033_333,
      frameCount: 1,
      gapCount: 1,
      recorderSlotCount: 2,
      outcome: "completed",
      accepted: true,
      annotations: [],
    },
  ],
} satisfies Episode;

test("drops retry rows and marks retained gaps as untracked", () => {
  const timeline = episodeExportTimeline(episode);
  const tasks = [{ index: 0, text: "Pick" }];
  const retry = prepareEpisodeExportRow(JSON.stringify({
    timestampMs: 1_000,
    frameIndex: 0,
    head: null,
    leftHand: { tracked: true, joints: {}, pinch: 0.2 },
    rightHand: { tracked: true, joints: {}, pinch: 0.3 },
  }), episode, timeline, tasks);
  assert.equal(retry, null);

  const gap = prepareEpisodeExportRow(JSON.stringify({
    timestampMs: 2_033.333,
    frameIndex: 2,
    gap: true,
    reason: "xr-callback-missed",
  }), episode, timeline, tasks);
  assert.ok(gap);
  assert.equal(gap.sourceGap, true);
  assert.equal(gap.taskIndex, 0);
  assert.deepEqual(JSON.parse(gap.json), {
    timestampMs: 2_033.333,
    frameIndex: 2,
    head: null,
    leftHand: { tracked: false, joints: {}, pinch: 0 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
    gap: true,
    reason: "xr-callback-missed",
  });
});

test("marks valid retained rows as explicit non-gaps", () => {
  const timeline = episodeExportTimeline(episode);
  const row = prepareEpisodeExportRow(JSON.stringify({
    timestampMs: 2_000,
    frameIndex: 1,
    head: null,
    leftHand: { tracked: true, joints: {}, pinch: 0.2 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  }), episode, timeline, [{ index: 0, text: "Pick" }]);
  assert.ok(row);
  assert.equal(row.sourceGap, false);
  assert.equal(JSON.parse(row.json).gap, false);
});

test("preserves legacy source-index gap inference when no source slots are omitted", () => {
  const legacyEpisode = {
    ...episode,
    id: "legacy-episode",
    frameCount: 2,
    gapCount: undefined,
    recorderSlotCount: undefined,
    segments: undefined,
  } satisfies Episode;
  const timeline = episodeExportTimeline(legacyEpisode);
  const row = prepareEpisodeExportRow(JSON.stringify({
    timestampMs: 2_000,
    frameIndex: 4,
    head: null,
    leftHand: { tracked: true, joints: {}, pinch: 0.2 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  }), legacyEpisode, timeline, [{ index: 0, text: "Retry run" }]);
  assert.ok(row);
  assert.equal(Object.hasOwn(JSON.parse(row.json), "gap"), false);
});
