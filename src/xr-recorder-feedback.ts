export { CYCLE_PAUSE_MS } from "../shared/run-sequencing.js";
export const HAND_TRACKING_ALERT_DELAY_MS = 0;
export const HAND_TRACKING_ALERT_ESCALATION_MS = 10_000;
export const WRITE_INDICATOR_HOLD_MS = 800;

export interface HandTrackingAlertPresentation {
  label: "LEFT HAND" | "RIGHT HAND" | "HANDS NOT DETECTED";
  pulseIntervalMs: number;
  dangerRatio: number;
  tapeOpacity: number;
  missingDurationMs: number;
}

export class HandTrackingAlertTracker {
  private leftMissingSince: number | null = null;
  private rightMissingSince: number | null = null;

  update(nowMs: number, leftTracked: boolean, rightTracked: boolean) {
    this.leftMissingSince = leftTracked ? null : this.leftMissingSince ?? nowMs;
    this.rightMissingSince = rightTracked ? null : this.rightMissingSince ?? nowMs;
  }

  reset() {
    this.leftMissingSince = null;
    this.rightMissingSince = null;
  }

  presentation(nowMs: number): HandTrackingAlertPresentation | null {
    const leftMissingMs = this.leftMissingSince === null ? 0 : Math.max(0, nowMs - this.leftMissingSince);
    const rightMissingMs = this.rightMissingSince === null ? 0 : Math.max(0, nowMs - this.rightMissingSince);
    const leftAlert = leftMissingMs >= HAND_TRACKING_ALERT_DELAY_MS
      && this.leftMissingSince !== null;
    const rightAlert = rightMissingMs >= HAND_TRACKING_ALERT_DELAY_MS
      && this.rightMissingSince !== null;
    if (!leftAlert && !rightAlert) return null;
    const missingDurationMs = Math.max(leftAlert ? leftMissingMs : 0, rightAlert ? rightMissingMs : 0);
    const dangerRatio = Math.min(1, missingDurationMs / HAND_TRACKING_ALERT_ESCALATION_MS);
    return {
      label: leftAlert && rightAlert ? "HANDS NOT DETECTED" : leftAlert ? "LEFT HAND" : "RIGHT HAND",
      pulseIntervalMs: Math.round(1_250 - dangerRatio * 1_000),
      dangerRatio,
      tapeOpacity: .16 + dangerRatio * .34,
      missingDurationMs,
    };
  }
}

export function cycleWorkProgress(
  cycle: number,
  completedTaskItems: number,
  taskItemCount: number,
  totalCycles: number,
) {
  const tasks = Math.max(1, Math.trunc(taskItemCount));
  const cycles = Math.max(1, Math.trunc(totalCycles));
  const completedCycles = Math.max(0, Math.min(cycles, Math.trunc(cycle) - 1));
  const completed = completedCycles * tasks + Math.max(0, Math.min(tasks, Math.trunc(completedTaskItems)));
  return Math.min(1, completed / (tasks * cycles));
}

export function recorderWriteIndicatorVisible(
  pendingBlocks: number,
  nowMs: number,
  drainedAtMs: number | null,
) {
  return pendingBlocks > 0 || (drainedAtMs !== null && nowMs - drainedAtMs <= WRITE_INDICATOR_HOLD_MS);
}
