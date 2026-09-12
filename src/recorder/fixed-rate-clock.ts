export interface RecorderSlotAssignment {
  gapCount: number;
  frameIndex: number;
  slotTimestampUs: number;
}

export class FixedRateRecorderClock {
  readonly periodUs: number;
  private nextFrameIndex = 0;
  private pausedAtTimestampUs: number | null = null;
  private readonly segments: Array<{ frameIndex: number; startTimestampUs: number }>;

  constructor(
    readonly startTimestampUs: number,
    rateHz: number,
  ) {
    if (!Number.isFinite(rateHz) || rateHz <= 0) throw new Error("Recorder rate must be positive");
    this.periodUs = Math.round(1_000_000 / rateHz);
    this.segments = [{ frameIndex: 0, startTimestampUs }];
  }

  get frameIndex() {
    return this.nextFrameIndex;
  }

  get isPaused() {
    return this.pausedAtTimestampUs !== null;
  }

  slotTimestampUs(frameIndex: number) {
    const segment = this.segmentForFrame(frameIndex);
    return segment.startTimestampUs + (frameIndex - segment.frameIndex) * this.periodUs;
  }

  assignSample(sourceTimestampUs: number): RecorderSlotAssignment | null {
    if (this.isPaused) return null;
    const targetFrameIndex = this.frameIndexAt(sourceTimestampUs);
    if (targetFrameIndex < this.nextFrameIndex || targetFrameIndex < 0) return null;
    const assignment = {
      gapCount: targetFrameIndex - this.nextFrameIndex,
      frameIndex: targetFrameIndex,
      slotTimestampUs: this.slotTimestampUs(targetFrameIndex),
    };
    this.nextFrameIndex = targetFrameIndex + 1;
    return assignment;
  }

  claimExpiredGaps(nowTimestampUs: number) {
    if (this.isPaused) return 0;
    const expiredThrough = this.frameIndexAt(nowTimestampUs) - 1;
    const count = Math.max(0, expiredThrough - this.nextFrameIndex + 1);
    this.nextFrameIndex += count;
    return count;
  }

  claimThrough(stopTimestampUs: number) {
    if (this.isPaused) return 0;
    const finalFrameIndex = this.frameIndexAt(stopTimestampUs);
    const count = Math.max(0, finalFrameIndex - this.nextFrameIndex + 1);
    this.nextFrameIndex += count;
    return count;
  }

  pause(pauseTimestampUs: number) {
    if (this.isPaused || !Number.isFinite(pauseTimestampUs)) return false;
    this.pausedAtTimestampUs = pauseTimestampUs;
    return true;
  }

  resume(resumeTimestampUs: number) {
    if (!this.isPaused || !Number.isFinite(resumeTimestampUs)) return false;
    this.segments.push({
      frameIndex: this.nextFrameIndex,
      startTimestampUs: Math.max(resumeTimestampUs, this.pausedAtTimestampUs!),
    });
    this.pausedAtTimestampUs = null;
    return true;
  }

  private frameIndexAt(timestampUs: number) {
    const segment = this.segments[this.segments.length - 1];
    return segment.frameIndex + Math.floor((timestampUs - segment.startTimestampUs) / this.periodUs);
  }

  private segmentForFrame(frameIndex: number) {
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      if (frameIndex >= this.segments[index].frameIndex) return this.segments[index];
    }
    return this.segments[0];
  }
}
