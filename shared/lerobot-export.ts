import type { CaptureMetadata } from "./capture-metadata.js";
import type { Episode, EpisodeSegment } from "./protocol.js";
import type { CeresTaskSpecification } from "./task-specification.js";

export const LEROBOT_EXPORT_MANIFEST_VERSION = 1 as const;
export const CERES_EPISODE_EXPORT_METADATA_SCHEMA = "ceres-episode-export-metadata" as const;
export const CERES_EPISODE_EXPORT_METADATA_VERSION = 3 as const;
export const CERES_EXPORT_CAPABILITY_HEADER = "X-CERES-Export-Capability";
export const CERES_LEROBOT_ACTION_NAMES = [
  "left_hand.pinch_distance",
  "right_hand.pinch_distance",
] as const;

export type EpisodeExportBlobId = "sensors" | "video";

export interface EpisodeExportBlob {
  id: EpisodeExportBlobId;
  path: string;
  url: string;
  mediaType: string;
  byteLength: number;
}

export interface EpisodeExportTask {
  index: number;
  text: string;
}

export interface CeresEpisodeExportMetadataV3 {
  schema: typeof CERES_EPISODE_EXPORT_METADATA_SCHEMA;
  version: typeof CERES_EPISODE_EXPORT_METADATA_VERSION;
  episodeId: string;
  episodeIndex: number;
  captureMetadata: CaptureMetadata | null;
  segments: EpisodeSegment[] | null;
  taskSpecVersion?: number;
  taskSpecHash?: string;
  taskSpecificationPath?: string;
}

export interface EpisodeExportManifest {
  schemaVersion: typeof LEROBOT_EXPORT_MANIFEST_VERSION;
  sessionId: string;
  episode: Episode;
  episodeIndex: number;
  globalFrameIndex: number;
  fps: number;
  task: EpisodeExportTask;
  tasks: EpisodeExportTask[];
  taskSpecVersion?: number;
  taskSpecHash?: string;
  taskSpecification?: CeresTaskSpecification;
  blobs: EpisodeExportBlob[];
}

export interface EpisodeExportFrameRange {
  startFrameIndex: number;
  endFrameIndex: number;
}

export interface EpisodeExportTimeline {
  mode: "legacy" | "segmented";
  frameCount: number;
  sourceSlotCount: number;
  segments: EpisodeSegment[] | null;
  frameRanges: EpisodeExportFrameRange[];
}

export function isExportableEpisode(episode: Episode): boolean {
  if (!Number.isSafeInteger(episode.frameCount) || episode.frameCount <= 0) return false;
  const retainedSlotCount = completeRetainedSlotCount(episode);
  return retainedSlotCount === null || retainedSlotCount > 0;
}

export function episodeTaskTexts(episode: Episode): string[] {
  const segmentLabels = episode.segments
    ?.filter((segment) => segment.outcome !== "retry")
    ?.map((segment) => segment.taskLabel.trim())
    .filter((label) => label.length > 0) ?? [];
  if (segmentLabels.length > 0) return [...new Set(segmentLabels)];
  const legacyLabel = episode.taskLabel.trim();
  return legacyLabel ? [legacyLabel] : [];
}

export function episodeTaskIndexAtTimestamp(
  episode: Episode,
  tasks: EpisodeExportTask[],
  timestampMs: number,
): number | null {
  const segments = episode.segments ?? [];
  if (segments.length === 0) {
    const label = episodeTaskTexts(episode)[0];
    const task = tasks.find((entry) => entry.text === label);
    if (!task) throw new Error("Episode task is missing from the export catalogue");
    return task.index;
  }
  let selected = null as (typeof segments)[number] | null;
  let incompleteBounds = false;
  for (const segment of segments) {
    if (segment.outcome === "retry") continue;
    if (segment.startSourceTimestampUs === undefined) {
      incompleteBounds = true;
      continue;
    }
    const startMs = segment.startSourceTimestampUs / 1_000;
    const endMs = segment.endSourceTimestampUs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(startMs, segment.endSourceTimestampUs / 1_000);
    if (segment.endSourceTimestampUs === undefined || segment.endSourceTimestampUs < segment.startSourceTimestampUs) incompleteBounds = true;
    if (timestampMs >= startMs && timestampMs <= endMs) selected = segment;
  }
  if (!selected && incompleteBounds) {
    selected = segments.find((segment) => segment.outcome !== "retry" && (segment.frameCount ?? 0) > 0)
      ?? segments.find((segment) => segment.outcome !== "retry")
      ?? null;
  }
  if (!selected) return null;
  const label = selected.taskLabel.trim();
  const task = tasks.find((entry) => entry.text === label);
  if (!task) throw new Error("Episode task segment is missing from the export catalogue");
  return task.index;
}

export function episodeExportTimeline(episode: Episode): EpisodeExportTimeline {
  const segments = episode.segments ?? [];
  if (segments.length === 0) {
    assertNonNegativeSafeInteger(episode.frameCount, "Episode frame count");
    const gapCount = episode.gapCount
      ?? (episode.recorderSlotCount === undefined ? 0 : episode.recorderSlotCount - episode.frameCount);
    assertNonNegativeSafeInteger(gapCount, "Episode gap count");
    const sourceSlotCount = episode.recorderSlotCount ?? episode.frameCount + gapCount;
    assertNonNegativeSafeInteger(sourceSlotCount, "Episode recorder slot count");
    if (sourceSlotCount !== episode.frameCount + gapCount) {
      throw new Error("Episode recorder accounting is inconsistent");
    }
    if (sourceSlotCount === 0) throw new Error("Episode export timeline has no recorder frames");
    return {
      mode: "legacy",
      frameCount: sourceSlotCount,
      sourceSlotCount,
      segments: null,
      frameRanges: [],
    };
  }

  let sourceSlotCount = 0;
  let sourceFrameCount = 0;
  let sourceGapCount = 0;
  let outputFrameCount = 0;
  const retainedSegments: EpisodeSegment[] = [];
  const frameRanges: EpisodeExportFrameRange[] = [];
  for (const segment of segments) {
    const frameCount = requiredSegmentCount(segment.frameCount, segment.taskLabel, "frame");
    const gapCount = requiredSegmentCount(segment.gapCount, segment.taskLabel, "gap");
    const slotCount = requiredSegmentCount(segment.recorderSlotCount, segment.taskLabel, "recorder slot");
    if (slotCount !== frameCount + gapCount) {
      throw new Error(`Task segment ${segment.taskLabel} recorder accounting is inconsistent`);
    }
    if (slotCount > 0) assertSegmentBounds(segment);

    const startFrameIndex = sourceSlotCount;
    const endFrameIndex = startFrameIndex + slotCount;
    sourceSlotCount += slotCount;
    sourceFrameCount += frameCount;
    sourceGapCount += gapCount;
    if (segment.outcome === "retry" || slotCount === 0) continue;

    retainedSegments.push(segment);
    outputFrameCount += slotCount;
    appendFrameRange(frameRanges, { startFrameIndex, endFrameIndex });
  }

  if (sourceFrameCount !== episode.frameCount) {
    throw new Error("Episode sensor frames are not fully attributed to durable task segments");
  }
  if (episode.gapCount !== undefined && sourceGapCount !== episode.gapCount) {
    throw new Error("Episode recorder gaps are not fully attributed to durable task segments");
  }
  if (episode.recorderSlotCount !== undefined && sourceSlotCount !== episode.recorderSlotCount) {
    throw new Error("Episode recorder slots are not fully attributed to durable task segments");
  }
  if (outputFrameCount === 0 || retainedSegments.length === 0) {
    throw new Error("Episode export timeline has no retained task segments");
  }

  return {
    mode: "segmented",
    frameCount: outputFrameCount,
    sourceSlotCount,
    segments: retainedSegments,
    frameRanges,
  };
}

export function episodeExportFrameContribution(episode: Episode): number {
  const retainedSlotCount = completeRetainedSlotCount(episode);
  if (retainedSlotCount !== null) return retainedSlotCount;

  const gapCount = episode.gapCount ?? 0;
  const sourceSlotCount = episode.recorderSlotCount ?? episode.frameCount + gapCount;
  assertNonNegativeSafeInteger(sourceSlotCount, "Episode recorder slot count");
  if (sourceSlotCount === 0) throw new Error("Episode export timeline has no recorder frames");
  return sourceSlotCount;
}

export function episodeExportSegmentAtTimestamp(
  timeline: EpisodeExportTimeline,
  timestampMs: number,
): EpisodeSegment | null {
  if (timeline.mode === "legacy") return null;
  if (!Number.isFinite(timestampMs)) return null;
  return timeline.segments?.find((segment) => (
    segment.startSourceTimestampUs !== undefined
      && segment.endSourceTimestampUs !== undefined
      && timestampMs >= segment.startSourceTimestampUs / 1_000
      && timestampMs <= segment.endSourceTimestampUs / 1_000
  )) ?? null;
}

function requiredSegmentCount(value: number | undefined, taskLabel: string, label: string): number {
  if (value === undefined) throw new Error(`Task segment ${taskLabel} has no durable ${label} count`);
  assertNonNegativeSafeInteger(value, `Task segment ${taskLabel} ${label} count`);
  return value;
}

function assertSegmentBounds(segment: EpisodeSegment): void {
  const start = segment.startSourceTimestampUs;
  const end = segment.endSourceTimestampUs;
  if (start === undefined || end === undefined) {
    throw new Error(`Task segment ${segment.taskLabel} has incomplete durable source bounds`);
  }
  assertNonNegativeSafeInteger(start, `Task segment ${segment.taskLabel} start source timestamp`);
  assertNonNegativeSafeInteger(end, `Task segment ${segment.taskLabel} end source timestamp`);
  if (end < start) throw new Error(`Task segment ${segment.taskLabel} ends before it starts`);
}

function appendFrameRange(ranges: EpisodeExportFrameRange[], range: EpisodeExportFrameRange): void {
  if (range.endFrameIndex <= range.startFrameIndex) return;
  const previous = ranges.at(-1);
  if (previous?.endFrameIndex === range.startFrameIndex) {
    previous.endFrameIndex = range.endFrameIndex;
    return;
  }
  ranges.push(range);
}

function completeRetainedSlotCount(episode: Episode): number | null {
  const segments = episode.segments ?? [];
  if (segments.length === 0) return null;
  let retainedSlotCount = 0;
  for (const segment of segments) {
    const slotCount = segment.recorderSlotCount;
    if (typeof slotCount !== "number" || !Number.isSafeInteger(slotCount) || slotCount < 0) return null;
    if (segment.outcome !== "retry") retainedSlotCount += slotCount;
  }
  return retainedSlotCount;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

export function episodeShardPath(episodeIndex: number): string {
  if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 0) throw new Error("Episode index must be a non-negative safe integer");
  return `shards/episode-${String(episodeIndex).padStart(6, "0")}`;
}
