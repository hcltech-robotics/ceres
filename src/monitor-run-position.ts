import type { CaptureConfiguration, SessionSnapshot } from "../shared/protocol.js";

export interface MonitorRunPositionOptions {
  configuration?: CaptureConfiguration;
  draft?: boolean;
  now?: number;
}

export interface MonitorRunPositionPresentation {
  text: string;
  label: string;
  state: "ready" | "active" | "waiting" | "complete";
  deadlineMs: number | null;
}

export const RUN_POSITION_BLINK_WINDOW_MS = 1_500;

const count = (value: number | undefined) => Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : 1;
const position = (value: number, total: number) => Math.max(1, Math.min(total, count(value)));

export function buildMonitorRunPosition(
  snapshot: SessionSnapshot | null | undefined,
  options: MonitorRunPositionOptions = {},
): MonitorRunPositionPresentation {
  const run = snapshot?.run;
  const complete = run?.status === "complete" && !options.draft;
  const authoritative = run?.status === "running" || complete;
  const configuration = authoritative ? snapshot!.configuration : options.configuration ?? snapshot?.configuration;
  const cycles = configuration ? count(configuration.totalCycles) : 0;
  const cycle = cycles ? authoritative ? position(run!.cycle, cycles) : 1 : 0;
  const tasks = configuration?.tasks ?? [];
  const beyondLastTask = authoritative && run!.activeTaskIndex >= tasks.length;
  const taskIndex = tasks.length ? authoritative ? Math.max(0, Math.min(tasks.length - 1, run!.activeTaskIndex)) : 0 : -1;
  const task = tasks[taskIndex];
  const repetitions = task ? task.type === "pause" ? 1 : count(task.repeatCount) : 0;
  const repetition = repetitions ? beyondLastTask ? repetitions : authoritative ? position(run!.repetition, repetitions) : 1 : 0;
  const waiting = run?.status === "running" && (
    (run.recordingState === "paused" && run.phase === "active-task")
    || run.phase === "post-task-pause"
    || run.phase === "task-pause"
    || run.phase === "cycle-pause"
  );
  const state = waiting ? "waiting" : run?.status === "running" ? "active" : complete ? "complete" : "ready";
  const deadlineMs = waiting && run?.phase !== "active-task" && Number.isFinite(run?.resetDeadlineMs)
    ? run!.resetDeadlineMs
    : null;
  return {
    text: `C${cycle}/${cycles} T${taskIndex + 1}/${tasks.length} R${repetition}/${repetitions}`,
    label: `Cycle ${cycle} of ${cycles}, task ${taskIndex + 1} of ${tasks.length}, rep ${repetition} of ${repetitions}${waiting ? ", paused" : ""}`,
    state,
    deadlineMs,
  };
}

/** Integrates an increasing blink frequency against the shared countdown clock. */
export function runPositionBlinkOpacity(remainingMs: number): number {
  if (remainingMs <= 0 || remainingMs > RUN_POSITION_BLINK_WINDOW_MS || !Number.isFinite(remainingMs)) return 1;
  const elapsed = (RUN_POSITION_BLINK_WINDOW_MS - remainingMs) / 1_000;
  const phase = 2 * elapsed + (5 / 3) * elapsed * elapsed;
  return phase % 1 < 0.55 ? 1 : 0.18;
}

export class MonitorRunPosition {
  private readonly view: Window;
  private readonly reducedMotion: MediaQueryList;
  private deadlineMs: number | null = null;
  private clockOffsetMs = 0;
  private frame: number | null = null;
  private wake: number | null = null;
  private disposed = false;

  constructor(private readonly element: HTMLElement) {
    this.view = element.ownerDocument.defaultView!;
    this.reducedMotion = this.view.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.refreshAnimation);
    element.classList.add("monitor-run-position");
    element.setAttribute("aria-live", "off");
  }

  update(snapshot: SessionSnapshot | null | undefined, options: MonitorRunPositionOptions = {}): void {
    if (this.disposed) return;
    const presentation = buildMonitorRunPosition(snapshot, options);
    if (this.element.textContent !== presentation.text) this.element.textContent = presentation.text;
    this.element.setAttribute("aria-label", presentation.label);
    this.element.dataset.state = presentation.state;
    this.deadlineMs = presentation.deadlineMs;
    this.clockOffsetMs = options.now == null ? 0 : options.now - Date.now();
    this.refreshAnimation();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAnimation();
    this.reducedMotion.removeEventListener("change", this.refreshAnimation);
    this.element.dataset.blinking = "false";
    this.element.style.removeProperty("--run-position-opacity");
  }

  private cancelAnimation(): void {
    if (this.frame !== null) this.view.cancelAnimationFrame(this.frame);
    if (this.wake !== null) this.view.clearTimeout(this.wake);
    this.frame = null;
    this.wake = null;
  }

  private readonly refreshAnimation = (): void => {
    this.cancelAnimation();
    this.paint();
  };

  private readonly paint = (): void => {
    this.frame = null;
    this.wake = null;
    if (this.disposed) return;
    const remainingMs = this.deadlineMs === null ? 0 : this.deadlineMs - Date.now() - this.clockOffsetMs;
    const blinking = !this.reducedMotion.matches && remainingMs > 0 && remainingMs <= RUN_POSITION_BLINK_WINDOW_MS;
    this.element.dataset.blinking = String(blinking);
    this.element.style.setProperty("--run-position-opacity", String(blinking ? runPositionBlinkOpacity(remainingMs) : 1));
    if (this.reducedMotion.matches || remainingMs <= 0) return;
    if (remainingMs > RUN_POSITION_BLINK_WINDOW_MS) {
      this.wake = this.view.setTimeout(this.paint, remainingMs - RUN_POSITION_BLINK_WINDOW_MS);
    } else {
      this.frame = this.view.requestAnimationFrame(this.paint);
    }
  };
}
