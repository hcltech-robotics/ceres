import type { RecordingState, SensorFrame } from "../shared/protocol.js";

export function episodeSelectionAvailable(recordingState: RecordingState) {
  return recordingState === "idle";
}

export class MonitorEpisodeReplaySource {
  private latestLiveFrameValue: SensorFrame | null = null;
  private replayFrameValue: SensorFrame | null = null;
  private activeValue = false;

  get active() {
    return this.activeValue;
  }

  get displayedFrame() {
    return this.activeValue ? this.replayFrameValue : this.latestLiveFrameValue;
  }

  get latestLiveFrame() {
    return this.latestLiveFrameValue;
  }

  observeLiveFrame(frame: SensorFrame) {
    this.latestLiveFrameValue = frame;
  }

  begin(frames: SensorFrame[]) {
    if (frames.length === 0) throw new Error("Episode has no durable sensor frames");
    this.activeValue = true;
    this.replayFrameValue = frames.at(-1) ?? null;
  }

  clear() {
    this.activeValue = false;
    this.replayFrameValue = null;
    return this.latestLiveFrameValue;
  }
}
