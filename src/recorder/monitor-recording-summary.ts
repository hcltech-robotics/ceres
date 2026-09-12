import type { RecorderRunEvent } from "../../shared/protocol.js";

export interface MonitorRecordingSegmentSummary {
  frameCount: number;
  gapCount: number;
  recorderSlotCount: number;
}

export interface MonitorRecordingSummary {
  frameCount: number;
  gapCount: number;
  mediaChunkCount: number;
  recorderSlotCount: number;
  firstRecorderSequence: number | null;
  lastRecorderSequence: number | null;
  segmentSummaries?: Record<string, MonitorRecordingSegmentSummary>;
  runEvents?: Array<{
    sequence: number;
    sourceTimestampUs: number;
    event: RecorderRunEvent;
  }>;
}

export function emptyMonitorRecordingSummary(): MonitorRecordingSummary {
  return {
    frameCount: 0,
    gapCount: 0,
    mediaChunkCount: 0,
    recorderSlotCount: 0,
    firstRecorderSequence: null,
    lastRecorderSequence: null,
    segmentSummaries: Object.create(null) as Record<string, MonitorRecordingSegmentSummary>,
    runEvents: [],
  };
}

export class MonitorRecordingSummaryAccumulator {
  readonly summary = emptyMonitorRecordingSummary();
  private activeSegmentId: string | null = null;

  recordSequence(sequence: number) {
    this.summary.firstRecorderSequence ??= sequence;
    this.summary.lastRecorderSequence = sequence;
  }

  recordSensorFrame() {
    this.summary.frameCount += 1;
    this.summary.recorderSlotCount += 1;
    this.recordSegmentSlot("frame");
  }

  recordGap() {
    this.summary.gapCount += 1;
    this.summary.recorderSlotCount += 1;
    this.recordSegmentSlot("gap");
  }

  recordMediaChunk() {
    this.summary.mediaChunkCount += 1;
  }

  recordRunEvent(sequence: number, sourceTimestampUs: number, event: RecorderRunEvent) {
    (this.summary.runEvents ??= []).push({ sequence, sourceTimestampUs, event });
    if (event.type === "segment-start") {
      this.segmentSummary(event.segmentId);
      this.activeSegmentId = event.segmentId;
    } else if (event.type === "segment-end" && this.activeSegmentId === event.segmentId) {
      this.activeSegmentId = null;
    }
  }

  private recordSegmentSlot(kind: "frame" | "gap") {
    if (!this.activeSegmentId) return;
    const segment = this.segmentSummary(this.activeSegmentId);
    if (kind === "frame") segment.frameCount += 1;
    else segment.gapCount += 1;
    segment.recorderSlotCount += 1;
  }

  private segmentSummary(segmentId: string) {
    const summaries = this.summary.segmentSummaries
      ??= Object.create(null) as Record<string, MonitorRecordingSegmentSummary>;
    return summaries[segmentId] ??= {
      frameCount: 0,
      gapCount: 0,
      recorderSlotCount: 0,
    };
  }
}
