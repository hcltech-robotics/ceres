import assert from "node:assert/strict";
import test from "node:test";
import {
  episodeExportFrameContribution,
  episodeExportSegmentAtTimestamp,
  episodeExportTimeline,
  episodeTaskIndexAtTimestamp,
  episodeTaskTexts,
  isExportableEpisode,
} from "../shared/lerobot-export.js";
import type { Episode } from "../shared/protocol.js";

const episode = {
  id: "episode-cycle-1",
  runTitle: "Cycle run",
  runDescription: "Two task cycle",
  taskId: null,
  taskLabel: "Cycle run",
  taskDescription: "Two task cycle",
  cycle: 1,
  repetition: 1,
  take: 1,
  startedAt: "2026-07-20T12:00:00.000Z",
  outcome: "completed",
  annotation: null,
  accepted: true,
  integrity: "valid",
  frameCount: 2,
  gapCount: 0,
  recorderSlotCount: 2,
  mediaChunkCount: 0,
  qualitySummary: {
    decision: "go",
    reasons: [],
    frameCount: 2,
    gapCount: 0,
    maxLeftHandSpeedMps: 0,
    maxRightHandSpeedMps: 0,
    slowHandEvents: 0,
    trackingLossEvents: 0,
  },
  qualityEvents: [],
  segments: [
    {
      id: "segment-0001",
      taskId: "task-a",
      taskLabel: "Pick sample",
      taskDescription: "Pick the sample",
      repetition: 1,
      take: 1,
      startedAt: "2026-07-20T12:00:00.000Z",
      endedAt: "2026-07-20T12:00:01.000Z",
      startSourceTimestampUs: 1_000_000,
      endSourceTimestampUs: 1_500_000,
      frameCount: 1,
      gapCount: 0,
      recorderSlotCount: 1,
      outcome: "completed",
      accepted: true,
      annotations: [],
    },
    {
      id: "segment-0002",
      taskId: "task-b",
      taskLabel: "Place sample",
      taskDescription: "Place the sample",
      repetition: 1,
      take: 1,
      startedAt: "2026-07-20T12:00:02.000Z",
      endedAt: "2026-07-20T12:00:03.000Z",
      startSourceTimestampUs: 2_000_000,
      endSourceTimestampUs: 2_500_000,
      frameCount: 1,
      gapCount: 0,
      recorderSlotCount: 1,
      outcome: "completed",
      accepted: true,
      annotations: [],
    },
  ],
} satisfies Episode;

test("cycle episodes catalogue segment tasks and exclude reset or boundary frames", () => {
  const tasks = [
    { index: 0, text: "Pick sample" },
    { index: 1, text: "Place sample" },
  ];
  assert.deepEqual(episodeTaskTexts(episode), ["Pick sample", "Place sample"]);
  assert.equal(episodeTaskIndexAtTimestamp(episode, tasks, 500), null);
  assert.equal(episodeTaskIndexAtTimestamp(episode, tasks, 1_200), 0);
  assert.equal(episodeTaskIndexAtTimestamp(episode, tasks, 1_700), null);
  assert.equal(episodeTaskIndexAtTimestamp(episode, tasks, 2_200), 1);
  assert.equal(episodeTaskIndexAtTimestamp(episode, tasks, 3_000), null);
});

test("legacy task episodes retain their single task index", () => {
  const legacy = { ...episode, taskLabel: "Legacy task", segments: undefined };
  assert.deepEqual(episodeTaskTexts(legacy), ["Legacy task"]);
  assert.equal(episodeTaskIndexAtTimestamp(legacy, [{ index: 3, text: "Legacy task" }], 123), 3);
});

test("episode export eligibility keeps durable attempts unless every complete segment was retried", () => {
  assert.equal(isExportableEpisode(episode), true);
  assert.equal(isExportableEpisode({ ...episode, frameCount: 3, accepted: false, annotation: "fail", outcome: "failed" }), true);
  assert.equal(isExportableEpisode({
    ...episode,
    segments: episode.segments.map((segment, index) => index === 0
      ? { ...segment, recorderSlotCount: 2 }
      : segment),
  }), true);
  assert.equal(isExportableEpisode({
    ...episode,
    segments: episode.segments.map((segment, index) => index === 0
      ? { ...segment, endSourceTimestampUs: undefined }
      : segment),
  }), true);
  assert.equal(isExportableEpisode({
    ...episode,
    segments: episode.segments.map((segment, index) => index === 0
      ? { ...segment, startSourceTimestampUs: 1_600_000 }
      : segment),
  }), true);
  assert.equal(isExportableEpisode({ ...episode, frameCount: 0 }), false);
  assert.equal(isExportableEpisode({ ...episode, segments: undefined }), true);
});

test("completed all-retry episodes contribute no output frames and are not exportable", () => {
  const allRetry = {
    ...episode,
    segments: episode.segments.map((segment) => ({
      ...segment,
      outcome: "retry" as const,
      accepted: false,
    })),
  } satisfies Episode;
  assert.equal(isExportableEpisode(allRetry), false);
  assert.equal(episodeExportFrameContribution(allRetry), 0);
  assert.throws(() => episodeExportTimeline(allRetry), /no retained task segments/);
});

test("task indexing falls back deterministically for incomplete stopped segments", () => {
  const stopped = {
    ...episode,
    accepted: false,
    outcome: "stopped" as const,
    segments: episode.segments.map((segment, index) => index === 1
      ? { ...segment, startSourceTimestampUs: undefined, endSourceTimestampUs: undefined, frameCount: 1 }
      : segment),
  };
  assert.equal(episodeTaskIndexAtTimestamp(stopped, [
    { index: 0, text: "Pick sample" },
    { index: 1, text: "Place sample" },
  ], 9_000), 0);
});

test("export timelines retain gaps and overwrite retried attempts", () => {
  const retried = {
    ...episode,
    frameCount: 5,
    gapCount: 2,
    recorderSlotCount: 7,
    segments: [
      {
        ...episode.segments[0],
        id: "segment-completed-1",
        frameCount: 1,
        gapCount: 1,
        recorderSlotCount: 2,
      },
      {
        ...episode.segments[0],
        id: "segment-retry",
        taskLabel: "Place sample",
        startSourceTimestampUs: 1_600_000,
        endSourceTimestampUs: 1_900_000,
        frameCount: 2,
        gapCount: 1,
        recorderSlotCount: 3,
        outcome: "retry" as const,
        accepted: false,
      },
      {
        ...episode.segments[1],
        id: "segment-completed-2",
        frameCount: 2,
        gapCount: 0,
        recorderSlotCount: 2,
      },
    ],
  } satisfies Episode;

  const timeline = episodeExportTimeline(retried);
  assert.equal(timeline.mode, "segmented");
  assert.equal(timeline.sourceSlotCount, 7);
  assert.equal(timeline.frameCount, 4);
  assert.deepEqual(timeline.segments?.map((segment) => segment.id), ["segment-completed-1", "segment-completed-2"]);
  assert.deepEqual(timeline.frameRanges, [
    { startFrameIndex: 0, endFrameIndex: 2 },
    { startFrameIndex: 5, endFrameIndex: 7 },
  ]);
  assert.equal(episodeExportSegmentAtTimestamp(timeline, 1_700), null);
  assert.equal(episodeExportSegmentAtTimestamp(timeline, 2_200)?.id, "segment-completed-2");
});

test("legacy export timelines retain explicit recorder gaps", () => {
  const timeline = episodeExportTimeline({
    ...episode,
    segments: undefined,
    frameCount: 2,
    gapCount: 3,
    recorderSlotCount: 5,
  });
  assert.equal(timeline.frameCount, 5);
  assert.equal(timeline.sourceSlotCount, 5);
  assert.deepEqual(timeline.frameRanges, []);
});

test("prior episode frame contributions do not require complete segment bounds", () => {
  const incomplete = {
    ...episode,
    segments: episode.segments.map((segment, index) => index === 0
      ? { ...segment, startSourceTimestampUs: undefined, endSourceTimestampUs: undefined }
      : segment),
  } satisfies Episode;
  assert.equal(episodeExportFrameContribution(incomplete), 2);
  assert.throws(() => episodeExportTimeline(incomplete), /incomplete durable source bounds/);
});
