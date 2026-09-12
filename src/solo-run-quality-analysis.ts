import { HandSpeedTracker } from "../shared/capture-quality.js";
import {
  RECORDER_BLOCK_HEADER_BYTES,
  RECORDER_BLOCK_MAGIC,
  RECORDER_BLOCK_VERSION,
  RecorderBlockFlags,
  decodeRecorderBlock,
  type SensorFrame,
} from "../shared/protocol.js";
import {
  assertSoloRunQualityWorkerRequest,
  type SoloRunQualityBin,
  type SoloRunQualityDelineation,
  type SoloRunQualityEpisode,
  type SoloRunQualityResult,
  type SoloRunQualityWorkerRequest,
} from "./solo-run-quality.js";

interface EpisodeWindow {
  episode: SoloRunQualityEpisode;
  startMs: number;
  endMs: number;
}

interface CoverageInterval {
  startMs: number;
  endMs: number;
}

interface MutableBin {
  leftSpeedTotal: number;
  leftSpeedCount: number;
  rightSpeedTotal: number;
  rightSpeedCount: number;
  leftVisibleCount: number;
  rightVisibleCount: number;
  recordedFrameCount: number;
  recorderGapCount: number;
}

interface EpisodeBlockAccounting {
  sensorFrameCount: number;
  recorderGapCount: number;
}

const sensorDecoder = new TextDecoder("utf-8", { fatal: true });

export interface SoloRunQualityRecorderFile {
  readonly size: number;
  slice(start?: number, end?: number): Blob;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Reads complete bytes only for sensor and explicit-gap recorder blocks. */
export async function readSoloRunQualityRecorderBlock(
  file: SoloRunQualityRecorderFile,
  expectedSequence: number,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(file.size) || file.size < RECORDER_BLOCK_HEADER_BYTES) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} is shorter than its fixed header`);
  }
  const header = new Uint8Array(await file.slice(0, RECORDER_BLOCK_HEADER_BYTES).arrayBuffer());
  if (header.byteLength !== RECORDER_BLOCK_HEADER_BYTES) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} has a truncated header`);
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== RECORDER_BLOCK_MAGIC) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} has invalid magic`);
  }
  if (view.getUint8(4) !== RECORDER_BLOCK_VERSION) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} has an unsupported version`);
  }
  if (view.getUint8(5) !== RECORDER_BLOCK_HEADER_BYTES) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} has an invalid header length`);
  }
  if (view.getUint32(44, true) !== 0) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} has invalid reserved data`);
  }
  const sequenceValue = view.getBigUint64(8, true);
  if (sequenceValue > BigInt(Number.MAX_SAFE_INTEGER) || Number(sequenceValue) !== expectedSequence) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} does not match its filename`);
  }
  const totalByteLength = RECORDER_BLOCK_HEADER_BYTES
    + view.getUint16(36, true)
    + view.getUint16(38, true)
    + view.getUint32(32, true);
  if (totalByteLength !== file.size) {
    throw new Error(`Solo run quality recorder block ${expectedSequence} length does not match its header`);
  }
  const flags = view.getUint16(6, true);
  if ((flags & (RecorderBlockFlags.SensorFrameJson | RecorderBlockFlags.Gap)) === 0) return null;
  return new Uint8Array(await file.arrayBuffer());
}

export class SoloRunQualityAccumulator {
  private readonly windows: EpisodeWindow[];
  private readonly windowByEpisodeId: Map<string, EpisodeWindow>;
  private readonly coverageByEpisodeId: Map<string, readonly CoverageInterval[]>;
  private readonly bins: MutableBin[];
  private readonly accountingByEpisodeId: Map<string, EpisodeBlockAccounting>;
  private readonly trackers = new Map<string, HandSpeedTracker>();
  private readonly trackerCoverageIndex = new Map<string, number>();
  private readonly startedAtMs: number;
  private readonly endedAtMs: number;
  private sourceBlockCount = 0;
  private recordedFrameCount = 0;
  private recorderGapCount = 0;

  constructor(private readonly request: SoloRunQualityWorkerRequest) {
    assertSoloRunQualityWorkerRequest(request);
    this.windows = request.episodes.map((episode) => episodeWindow(episode, request.recorderRateHz))
      .sort((left, right) => left.startMs - right.startMs || left.episode.id.localeCompare(right.episode.id));
    this.windowByEpisodeId = new Map(this.windows.map((window) => [window.episode.id, window]));
    this.coverageByEpisodeId = new Map(this.windows.map((window) => [
      window.episode.id,
      episodeCoverage(window),
    ]));
    this.accountingByEpisodeId = new Map(this.windows.map(({ episode }) => [
      episode.id,
      { sensorFrameCount: 0, recorderGapCount: 0 },
    ]));
    this.startedAtMs = Math.min(...this.windows.map(({ startMs }) => startMs));
    this.endedAtMs = Math.max(...this.windows.map(({ endMs }) => endMs));
    this.bins = Array.from({ length: request.maximumBinCount }, createMutableBin);
  }

  recordEncodedBlock(data: Uint8Array): void {
    const block = decodeRecorderBlock(data);
    if (block.sessionId !== this.request.sessionId) {
      throw new Error(`Solo run quality recorder block ${block.sequence} has the wrong session`);
    }
    const window = this.windowByEpisodeId.get(block.episodeId);
    if (!window || !sequenceBelongsToEpisode(block.sequence, window.episode)) return;
    this.sourceBlockCount += 1;
    const timestampMs = block.sourceTimestampUs / 1_000;
    if (!Number.isFinite(timestampMs)) return;
    const bin = this.bins[binIndex(timestampMs, this.startedAtMs, this.endedAtMs, this.bins.length)]!;
    if ((block.flags & RecorderBlockFlags.SensorFrameJson) !== 0) {
      const frame = decodeSensorFrame(block.payload, timestampMs, block.recorderFrameIndex);
      if (!frame) {
        this.trackers.get(block.episodeId)?.reset();
        throw new Error(`Solo run quality recorder block ${block.sequence} has an invalid sensor payload`);
      }
      this.accountingByEpisodeId.get(block.episodeId)!.sensorFrameCount += 1;
      const tracker = this.trackers.get(block.episodeId) ?? new HandSpeedTracker();
      this.trackers.set(block.episodeId, tracker);
      const coverageIndex = intervalIndex(
        timestampMs,
        this.coverageByEpisodeId.get(block.episodeId) ?? [],
      );
      const previousCoverageIndex = this.trackerCoverageIndex.get(block.episodeId);
      if (previousCoverageIndex !== undefined && previousCoverageIndex !== coverageIndex) tracker.reset();
      this.trackerCoverageIndex.set(block.episodeId, coverageIndex);
      const speed = tracker.update(frame);
      bin.recordedFrameCount += 1;
      this.recordedFrameCount += 1;
      if (speed.leftTracked) {
        bin.leftVisibleCount += 1;
        if (Number.isFinite(speed.leftMps)) {
          bin.leftSpeedTotal += speed.leftMps;
          bin.leftSpeedCount += 1;
        }
      }
      if (speed.rightTracked) {
        bin.rightVisibleCount += 1;
        if (Number.isFinite(speed.rightMps)) {
          bin.rightSpeedTotal += speed.rightMps;
          bin.rightSpeedCount += 1;
        }
      }
      return;
    }
    if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
      this.accountingByEpisodeId.get(block.episodeId)!.recorderGapCount += 1;
      bin.recorderGapCount += 1;
      this.recorderGapCount += 1;
      this.trackers.get(block.episodeId)?.reset();
      this.trackerCoverageIndex.delete(block.episodeId);
    }
  }

  finish(): SoloRunQualityResult {
    this.assertCompleteRecorderAccounting();
    const mergedCoverage = mergeCoverage([...this.coverageByEpisodeId.values()].flat());
    return {
      requestId: this.request.requestId,
      episodeIds: this.windows.map(({ episode }) => episode.id),
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      bins: this.bins.map((bin, index) => this.materialiseBin(bin, index, mergedCoverage)),
      delineations: delineations(this.windows),
      sourceBlockCount: this.sourceBlockCount,
      recordedFrameCount: this.recordedFrameCount,
      recorderGapCount: this.recorderGapCount,
    };
  }

  private assertCompleteRecorderAccounting() {
    for (const { episode } of this.windows) {
      const observed = this.accountingByEpisodeId.get(episode.id)!;
      const expectedGapCount = episode.gapCount
        ?? Math.max(0, (episode.recorderSlotCount ?? episode.frameCount) - episode.frameCount);
      const expectedSlotCount = episode.recorderSlotCount
        ?? episode.frameCount + expectedGapCount;
      if (expectedSlotCount !== episode.frameCount + expectedGapCount) {
        throw new Error(`Solo run quality episode ${episode.id} has inconsistent recorder accounting`);
      }
      if (observed.sensorFrameCount !== episode.frameCount
        || observed.recorderGapCount !== expectedGapCount
        || observed.sensorFrameCount + observed.recorderGapCount !== expectedSlotCount) {
        throw new Error(
          `Solo run quality episode ${episode.id} recorder accounting is incomplete: `
          + `expected ${episode.frameCount} frames and ${expectedGapCount} gaps, `
          + `read ${observed.sensorFrameCount} frames and ${observed.recorderGapCount} gaps`,
        );
      }
    }
  }

  private materialiseBin(
    bin: MutableBin,
    index: number,
    coverage: readonly Pick<EpisodeWindow, "startMs" | "endMs">[],
  ): SoloRunQualityBin {
    const startMs = binBoundary(index, this.startedAtMs, this.endedAtMs, this.bins.length);
    const endMs = binBoundary(index + 1, this.startedAtMs, this.endedAtMs, this.bins.length);
    const durationMs = Math.max(1, endMs - startMs);
    const recordedDurationMs = coverage.reduce((total, interval) => (
      total + intervalOverlapMs(startMs, endMs, interval.startMs, interval.endMs)
    ), 0);
    const expectedActiveSlots = recordedDurationMs * this.request.recorderRateHz / 1_000;
    return {
      index,
      startMs,
      endMs,
      leftHandSpeedMps: mean(bin.leftSpeedTotal, bin.leftSpeedCount),
      rightHandSpeedMps: mean(bin.rightSpeedTotal, bin.rightSpeedCount),
      leftVisibility: ratio(bin.leftVisibleCount, bin.recordedFrameCount),
      rightVisibility: ratio(bin.rightVisibleCount, bin.recordedFrameCount),
      recorderGapFraction: expectedActiveSlots > 0
        ? clamp01(bin.recorderGapCount / expectedActiveSlots)
        : 0,
      unrecordedFraction: clamp01(1 - recordedDurationMs / durationMs),
      recordedFrameCount: bin.recordedFrameCount,
      recorderGapCount: bin.recorderGapCount,
    };
  }
}

function createMutableBin(): MutableBin {
  return {
    leftSpeedTotal: 0,
    leftSpeedCount: 0,
    rightSpeedTotal: 0,
    rightSpeedCount: 0,
    leftVisibleCount: 0,
    rightVisibleCount: 0,
    recordedFrameCount: 0,
    recorderGapCount: 0,
  };
}

function episodeWindow(episode: SoloRunQualityEpisode, recorderRateHz: number): EpisodeWindow {
  const segmentStarts = episode.segments
    ?.map((segment) => sourceOrWallTimestamp(segment.startSourceTimestampUs, segment.startedAt))
    .filter(Number.isFinite) ?? [];
  const segmentEnds = episode.segments
    ?.map((segment) => sourceOrWallTimestamp(segment.endSourceTimestampUs, segment.endedAt))
    .filter(Number.isFinite) ?? [];
  const wallStart = Date.parse(episode.startedAt);
  const wallEnd = episode.endedAt ? Date.parse(episode.endedAt) : Number.NaN;
  const startMs = segmentStarts.length > 0 ? Math.min(...segmentStarts) : wallStart;
  if (!Number.isFinite(startMs)) throw new Error(`Solo run quality episode ${episode.id} has no valid start time`);
  const estimatedSlotCount = episode.recorderSlotCount
    ?? Math.max(episode.frameCount + (episode.gapCount ?? 0), 1);
  const estimatedEndMs = startMs + Math.max(1, estimatedSlotCount / recorderRateHz * 1_000);
  const candidateEndMs = segmentEnds.length > 0 ? Math.max(...segmentEnds) : wallEnd;
  const endMs = Number.isFinite(candidateEndMs) && candidateEndMs > startMs
    ? candidateEndMs
    : estimatedEndMs;
  return { episode, startMs, endMs };
}

function sourceOrWallTimestamp(sourceTimestampUs: number | undefined, wallTimestamp: string | undefined) {
  if (sourceTimestampUs !== undefined && Number.isSafeInteger(sourceTimestampUs) && sourceTimestampUs >= 0) {
    return sourceTimestampUs / 1_000;
  }
  return wallTimestamp ? Date.parse(wallTimestamp) : Number.NaN;
}

function decodeSensorFrame(payload: Uint8Array, timestampMs: number, frameIndex: number): SensorFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(sensorDecoder.decode(payload));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const frame = value as Partial<SensorFrame>;
  if (!validHand(frame.leftHand) || !validHand(frame.rightHand)) return null;
  return {
    ...frame,
    timestampMs,
    frameIndex,
    head: frame.head ?? null,
    leftHand: frame.leftHand,
    rightHand: frame.rightHand,
    sceneStatus: frame.sceneStatus ?? { planes: false, meshes: false, anchors: false },
  };
}

function validHand(hand: SensorFrame["leftHand"] | undefined): hand is SensorFrame["leftHand"] {
  return Boolean(hand)
    && typeof hand?.tracked === "boolean"
    && typeof hand?.joints === "object"
    && hand.joints !== null;
}

function sequenceBelongsToEpisode(sequence: number, episode: SoloRunQualityEpisode) {
  return (episode.firstRecorderSequence === undefined || sequence >= episode.firstRecorderSequence)
    && (episode.lastRecorderSequence === undefined || sequence <= episode.lastRecorderSequence);
}

function binIndex(timestampMs: number, startedAtMs: number, endedAtMs: number, count: number) {
  if (endedAtMs <= startedAtMs) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((timestampMs - startedAtMs) / (endedAtMs - startedAtMs) * count)));
}

function binBoundary(index: number, startedAtMs: number, endedAtMs: number, count: number) {
  return startedAtMs + Math.max(1, endedAtMs - startedAtMs) * index / count;
}

function episodeCoverage(window: EpisodeWindow): readonly CoverageInterval[] {
  const segments = window.episode.segments?.filter(({ outcome }) => outcome !== "recording") ?? [];
  const intervals = segments.map((segment) => ({
    startMs: sourceOrWallTimestamp(segment.startSourceTimestampUs, segment.startedAt),
    endMs: sourceOrWallTimestamp(segment.endSourceTimestampUs, segment.endedAt),
  })).filter(({ startMs, endMs }) => Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)
    .sort((left, right) => left.startMs - right.startMs);
  return intervals.length > 0
    ? intervals
    : [{ startMs: window.startMs, endMs: window.endMs }];
}

function mergeCoverage(values: readonly CoverageInterval[]) {
  const merged: CoverageInterval[] = [];
  for (const interval of [...values].sort((left, right) => left.startMs - right.startMs)) {
    const previous = merged.at(-1);
    if (!previous || interval.startMs > previous.endMs) {
      merged.push({ ...interval });
      continue;
    }
    previous.endMs = Math.max(previous.endMs, interval.endMs);
  }
  return merged;
}

function intervalIndex(timestampMs: number, intervals: readonly CoverageInterval[]) {
  return intervals.findIndex(({ startMs, endMs }) => timestampMs >= startMs && timestampMs <= endMs);
}

function delineations(windows: readonly EpisodeWindow[]): SoloRunQualityDelineation[] {
  const raw = windows.flatMap(({ episode, startMs }) => {
    const segments = episode.segments?.filter(({ outcome }) => outcome !== "recording") ?? [];
    if (segments.length === 0) {
      return [{
        timestampMs: startMs,
        cycle: episode.cycle,
        taskId: episode.taskId,
        taskLabel: episode.taskLabel,
        repetition: episode.repetition,
        take: episode.take,
      }];
    }
    return segments.map((segment) => ({
      timestampMs: sourceOrWallTimestamp(segment.startSourceTimestampUs, segment.startedAt),
      cycle: episode.cycle,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
      repetition: segment.repetition,
      take: segment.take,
    }));
  }).filter(({ timestampMs }) => Number.isFinite(timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs || left.cycle - right.cycle);
  return raw.map((entry, index) => {
    const previous = raw[index - 1];
    const startsCycle = !previous || previous.cycle !== entry.cycle;
    const startsTask = startsCycle
      || previous.taskId !== entry.taskId
      || previous.taskLabel !== entry.taskLabel;
    return {
      ...entry,
      startsCycle,
      startsTask,
      startsRepetition: startsTask || previous.repetition !== entry.repetition,
    };
  });
}

function intervalOverlapMs(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function mean(total: number, count: number) {
  return count > 0 ? total / count : null;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? clamp01(numerator / denominator) : null;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
