import type { RunProgress } from "../shared/protocol.js";

export const SOLO_POST_ACQUISITION_QUALITY_VISIBLE_MS = 2_000;
export const SOLO_POST_ACQUISITION_QUALITY_FADE_MS = 600;

export interface SoloPostAcquisitionQualityWindow {
  finalisedAtMs: number;
}

export interface SoloPostAcquisitionQualityFrame {
  opacity: number;
  state: "visible" | "fading" | "hidden";
}

const HIDDEN_QUALITY_FRAME = Object.freeze({
  opacity: 0,
  state: "hidden" as const,
});

export function soloPostAcquisitionQualityFrame(
  elapsedMs: number,
  reducedMotion = false,
): SoloPostAcquisitionQualityFrame {
  if (!Number.isFinite(elapsedMs)) return HIDDEN_QUALITY_FRAME;
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed <= SOLO_POST_ACQUISITION_QUALITY_VISIBLE_MS) {
    return { opacity: 1, state: "visible" };
  }
  if (reducedMotion) return HIDDEN_QUALITY_FRAME;
  const fadeProgress = Math.min(
    1,
    (elapsed - SOLO_POST_ACQUISITION_QUALITY_VISIBLE_MS)
      / SOLO_POST_ACQUISITION_QUALITY_FADE_MS,
  );
  if (fadeProgress >= 1) return HIDDEN_QUALITY_FRAME;
  const easedProgress = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
  return { opacity: 1 - easedProgress, state: "fading" };
}

export class SoloPostAcquisitionQualityTimeline {
  private elapsedMs = 0;
  private lastFrameAtMs: number | null = null;
  private presentationActive = false;
  private surfaceVisible = false;
  private reducedMotion = false;
  private completed = false;
  private disposed = false;

  constructor(private readonly onFrame: (frame: SoloPostAcquisitionQualityFrame) => void) {}

  get needsFrame() {
    return !this.disposed
      && this.presentationActive
      && this.surfaceVisible
      && !this.completed;
  }

  present() {
    if (this.disposed) return;
    this.presentationActive = true;
    this.elapsedMs = 0;
    this.lastFrameAtMs = null;
    this.completed = false;
    this.emitCurrentFrame();
  }

  clear() {
    if (this.disposed) return;
    this.presentationActive = false;
    this.elapsedMs = 0;
    this.lastFrameAtMs = null;
    this.completed = false;
    this.onFrame(HIDDEN_QUALITY_FRAME);
  }

  setSurfaceVisible(visible: boolean, reducedMotion = false) {
    if (this.disposed) return;
    const resample = this.surfaceVisible !== visible || this.reducedMotion !== reducedMotion;
    this.surfaceVisible = visible;
    this.reducedMotion = reducedMotion;
    if (resample) this.lastFrameAtMs = null;
    this.emitCurrentFrame();
  }

  pauseForSession() {
    if (this.disposed) return;
    this.surfaceVisible = false;
    this.lastFrameAtMs = null;
    this.onFrame(HIDDEN_QUALITY_FRAME);
  }

  advance(nowMs: number) {
    if (!this.needsFrame || !Number.isFinite(nowMs)) return;
    if (this.lastFrameAtMs === null) {
      this.lastFrameAtMs = nowMs;
      this.emitCurrentFrame();
      return;
    }
    const elapsedSinceLastFrame = Math.max(0, nowMs - this.lastFrameAtMs);
    this.lastFrameAtMs = nowMs;
    this.elapsedMs += elapsedSinceLastFrame;
    this.emitCurrentFrame();
  }

  dispose() {
    if (this.disposed) return;
    this.presentationActive = false;
    this.surfaceVisible = false;
    this.lastFrameAtMs = null;
    this.disposed = true;
    this.onFrame(HIDDEN_QUALITY_FRAME);
  }

  private emitCurrentFrame() {
    if (!this.presentationActive || !this.surfaceVisible || this.completed) {
      this.onFrame(HIDDEN_QUALITY_FRAME);
      return;
    }
    const frame = soloPostAcquisitionQualityFrame(this.elapsedMs, this.reducedMotion);
    if (frame.state === "hidden") this.completed = true;
    this.onFrame(frame);
  }
}

export function soloPostAcquisitionQualityWindow(
  run: Pick<RunProgress, "status" | "endedAtMs">,
): SoloPostAcquisitionQualityWindow | null {
  if ((run.status !== "complete" && run.status !== "stopped")
    || run.endedAtMs === null) return null;
  return { finalisedAtMs: run.endedAtMs };
}
