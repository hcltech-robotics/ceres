export const CYCLE_PAUSE_MS = 15_000;
export const MINIMUM_TASK_RESET_SECONDS = 5;

export function taskResetDurationMs(resetTimeS: number) {
  const seconds = Number.isFinite(resetTimeS) ? Math.max(0, resetTimeS) : 0;
  return Math.max(MINIMUM_TASK_RESET_SECONDS, seconds) * 1_000;
}
