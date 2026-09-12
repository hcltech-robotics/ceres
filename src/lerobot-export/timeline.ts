import {
  episodeExportSegmentAtTimestamp,
  episodeTaskIndexAtTimestamp,
  type EpisodeExportTask,
  type EpisodeExportTimeline,
} from "../../shared/lerobot-export.js";
import type { Episode } from "../../shared/protocol.js";

export interface PreparedEpisodeExportRow {
  json: string;
  sourceGap: boolean;
  taskIndex: number;
}

export function prepareEpisodeExportRow(
  line: string,
  episode: Episode,
  timeline: EpisodeExportTimeline,
  tasks: EpisodeExportTask[],
): PreparedEpisodeExportRow | null {
  const record = parseTimelineRecord(line);
  const timestampMs = requiredFiniteNumber(record.timestampMs, "Episode sensor row source timestamp");
  const frameIndex = requiredSafeInteger(record.frameIndex, "Episode sensor row source frame index");
  const segment = episodeExportSegmentAtTimestamp(timeline, timestampMs);
  if (timeline.mode === "segmented" && !segment) return null;

  const taskIndex = segment
    ? tasks.find((entry) => entry.text === segment.taskLabel.trim())?.index
    : episodeTaskIndexAtTimestamp(episode, tasks, timestampMs);
  if (taskIndex === undefined || taskIndex === null) {
    throw new Error("Episode sensor row is missing its retained task catalogue entry");
  }

  const sourceGap = record.gap === true;
  if (sourceGap) {
    return {
      json: JSON.stringify({
        timestampMs,
        frameIndex,
        head: null,
        leftHand: { tracked: false, joints: {}, pinch: 0 },
        rightHand: { tracked: false, joints: {}, pinch: 0 },
        sceneStatus: { planes: false, meshes: false, anchors: false },
        gap: true,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(isRecord(record.recorder) ? { recorder: record.recorder } : {}),
      }),
      sourceGap,
      taskIndex,
    };
  }

  if (!isRecord(record.leftHand) || !isRecord(record.rightHand)) {
    throw new Error("Episode sensor row is missing required hand telemetry");
  }
  return {
    json: JSON.stringify({
      ...record,
      timestampMs,
      frameIndex,
      ...(timeline.frameCount < timeline.sourceSlotCount ? { gap: false } : {}),
    }),
    sourceGap,
    taskIndex,
  };
}

function parseTimelineRecord(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Episode sensor row is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("Episode sensor row is not an object");
  return value;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
