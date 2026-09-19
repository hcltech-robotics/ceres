import { nextRunControlCursor, type CaptureConfiguration, type SessionSnapshot } from "../shared/protocol.js";
import { CYCLE_PAUSE_MS, taskResetDurationMs } from "../shared/run-sequencing.js";
import { runControls, takeElapsedMs } from "./run-presentation.js";

export interface MonitorRunStackOptions {
  configuration?: CaptureConfiguration;
  draft?: boolean;
  controlConnected?: boolean;
  wrapUpPending?: boolean;
  now?: number;
}

export interface MonitorRunCard {
  key: string;
  kind: "task" | "reset" | "pause" | "cycle-break";
  current: boolean;
  position: string;
  title: string;
  instructions: string;
  timing: string;
  progress: number | null;
  finish: { enabled: boolean; cursor: string; label: "Finish rep" | "Finish task" } | null;
}

export interface MonitorRunStackPresentation {
  identity: string;
  active: boolean;
  cycle: string;
  status: string;
  wrapUp: { visible: boolean; enabled: boolean; pending: boolean };
  cards: MonitorRunCard[];
  message: string;
  more: boolean;
}

const maximumCards = 120;
const wrapUpHoldMs = 3_000;
const seconds = (milliseconds: number) => `${Math.max(0, Math.ceil(milliseconds / 1_000))}s`;
const count = (value: number) => Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

/** Projects the director's remaining work without changing the authoritative run cursor. */
export function buildMonitorRunStack(
  snapshot: SessionSnapshot | null | undefined,
  options: MonitorRunStackOptions = {},
): MonitorRunStackPresentation {
  const activeRun = snapshot?.run.status === "running";
  const configuration = activeRun ? snapshot!.configuration : options.configuration ?? snapshot?.configuration;
  const live = activeRun;
  const complete = Boolean(snapshot && !options.draft && snapshot.run.status === "complete");
  const run = snapshot?.run;
  const wrapUpPending = (activeRun || !options.draft) && (options.wrapUpPending === true || run?.recordingState === "stopping");
  const now = options.now ?? Date.now();
  const totalCycles = count(configuration?.totalCycles ?? 1);
  const cycle = live || complete ? Math.min(totalCycles, count(run!.cycle)) : 1;
  const cards: MonitorRunCard[] = [];
  const model: MonitorRunStackPresentation = {
    identity: `${snapshot?.sessionId ?? "draft"}:${run?.startedAtMs ?? "draft"}`,
    active: live,
    cycle: `Cycle ${cycle}/${totalCycles}`,
    status: complete ? "Run complete" : live ? "In progress" : options.draft ? "Draft" : "Ready",
    wrapUp: {
      visible: activeRun || wrapUpPending,
      enabled: activeRun && !wrapUpPending && run?.recordingState !== "arming"
        && snapshot?.captureConnected === true && options.controlConnected !== false,
      pending: wrapUpPending,
    },
    cards,
    message: complete ? "Capture complete" : "Add tasks to build the run",
    more: false,
  };
  if (!configuration?.tasks.length || complete) return model;

  const tasks = configuration.tasks;
  const activeIndex = live ? Math.max(0, run!.activeTaskIndex) : 0;
  const inCycleBreak = live && run!.phase === "cycle-pause";
  const isRetry = run?.phase === "post-task-pause"
    && (snapshot?.currentEpisode ?? snapshot?.pendingEpisode)?.segments?.at(-1)?.outcome === "retry";
  const nextControl = runControls(snapshot, options.controlConnected ?? true).find(({ slot }) => slot === "next");
  const push = (card: MonitorRunCard) => {
    if (cards.length >= maximumCards) { model.more = true; return false; }
    cards.push(card);
    return true;
  };
  const remaining = (durationMs: number) => run?.resetDeadlineMs == null
    ? durationMs
    : Math.max(0, run.resetDeadlineMs - now);
  const cycleBreak = (forCycle: number, current: boolean): MonitorRunCard => {
    const left = current ? remaining(CYCLE_PAUSE_MS) : CYCLE_PAUSE_MS;
    const finalCycle = forCycle >= totalCycles;
    return {
      key: `${forCycle}:cycle-break`, kind: "cycle-break", current,
      position: `Cycle ${forCycle}/${totalCycles}`,
      title: finalCycle ? "Finish cycle" : "Cycle break",
      instructions: finalCycle ? "Finalise this capture" : `Prepare for cycle ${forCycle + 1}/${totalCycles}`,
      timing: current && run?.recordingState === "stopping" ? "Saving capture" : `${seconds(left)}${current ? " remaining" : ""}`,
      progress: current ? Math.max(0, Math.min(1, 1 - left / CYCLE_PAUSE_MS)) : null,
      finish: null,
    };
  };
  if (inCycleBreak) {
    push(cycleBreak(cycle, true));
    if (cycle >= totalCycles) return model;
  }
  const displayCycle = inCycleBreak ? cycle + 1 : cycle;
  const startIndex = inCycleBreak ? 0 : activeIndex;
  for (let index = startIndex; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    const atTask = live && !inCycleBreak && index === activeIndex;
    const reps = task.type === "pause" ? 1 : count(task.repeatCount);
    const startRep = atTask ? Math.min(reps, count(run!.repetition)) : 1;
    for (let rep = startRep; rep <= reps; rep += 1) {
      const atRep = atTask && rep === startRep;
      const resetNow = atRep && run!.phase === "post-task-pause";
      const key = `${displayCycle}:${index}:${task.id}:${rep}`;
      const position = task.type === "pause"
        ? `Task ${index + 1}/${tasks.length}`
        : `Task ${index + 1}/${tasks.length}, rep ${rep}/${reps}`;
      const reset = (current: boolean): MonitorRunCard => {
        const duration = task.type === "pause" ? 0 : taskResetDurationMs(task.resetTimeS);
        const left = current ? remaining(duration) : duration;
        return {
          key: `${key}:${isRetry && current ? "retry-reset" : "reset"}`, kind: "reset", current, position,
          title: isRetry && current ? "Reset before retry" : "Reset",
          instructions: `After ${task.label || `task ${index + 1}`}`,
          timing: `${seconds(left)}${current ? " remaining" : " break"}`,
          progress: current && duration > 0 ? Math.max(0, Math.min(1, 1 - left / duration)) : null,
          finish: null,
        };
      };
      if (resetNow && !push(reset(true))) return model;
      if (!resetNow || isRetry) {
        const current = atRep && !resetNow;
        const duration = task.type === "open" ? null : task.durationS * 1_000;
        const left = current
          ? task.type === "pause" ? remaining(duration!) : duration === null ? null : Math.max(0, duration - takeElapsedMs(run!, now))
          : duration;
        const paused = current && task.type !== "pause" && run!.recordingState === "paused";
        const finish = current && task.type === "open" && snapshot ? {
          enabled: nextControl?.enabled === true,
          cursor: nextRunControlCursor(snapshot),
          label: rep < reps ? "Finish rep" as const : "Finish task" as const,
        } : null;
        if (!push({
          key, kind: task.type === "pause" ? "pause" : "task", current, position,
          title: task.label || (task.type === "pause" ? "Pause" : `Task ${index + 1}`),
          instructions: task.instructions === "--" ? "" : task.instructions,
          timing: paused ? "Recording paused" : left === null ? "Open task" : `${seconds(left)}${current ? " remaining" : task.type === "pause" ? " pause" : ""}`,
          progress: current && duration && left !== null ? Math.max(0, Math.min(1, 1 - left / duration)) : null,
          finish,
        })) return model;
        if (task.type !== "pause" && !push(reset(false))) return model;
      }
    }
  }
  if (!inCycleBreak || displayCycle !== cycle) push(cycleBreak(displayCycle, false));
  return model;
}

interface CardElements {
  root: HTMLLIElement;
  position: HTMLElement;
  title: HTMLElement;
  instructions: HTMLElement;
  timing: HTMLElement;
  progress: HTMLProgressElement;
  finish: HTMLButtonElement;
}

/** A keyed, scrollable queue. Only completed rows and displaced survivors animate. */
export class MonitorRunStack {
  private readonly surface: HTMLElement;
  private readonly onAdvance: (cursor: string) => void;
  private readonly onWrapUp: (() => boolean) | undefined;
  private readonly cycle: HTMLOutputElement;
  private readonly status: HTMLElement;
  private readonly wrapUp: HTMLButtonElement;
  private readonly wrapUpLabel: HTMLElement;
  private readonly scroll: HTMLDivElement;
  private readonly list: HTMLOListElement;
  private readonly message: HTMLElement;
  private readonly more: HTMLElement;
  private readonly reducedMotion: MediaQueryList;
  private readonly elements = new Map<string, CardElements>();
  private readonly animations = new Set<Animation>();
  private readonly ghosts = new Set<HTMLElement>();
  private previous: MonitorRunStackPresentation | null = null;
  private disposed = false;
  private wrapUpDispatched = false;
  private completedHold: { pointerId?: number; key?: string } | null = null;
  private hold: { startedAt: number; identity: string; pointerId?: number; key?: string } | null = null;
  private holdTimer: number | null = null;
  private holdFrame: number | null = null;

  constructor(options: { surface: HTMLElement; onAdvance: (cursor: string) => void; onWrapUp?: () => boolean }) {
    this.surface = options.surface;
    this.onAdvance = options.onAdvance;
    this.onWrapUp = options.onWrapUp;
    const doc = this.surface.ownerDocument;
    this.surface.classList.add("monitor-run-stack");
    const header = doc.createElement("div");
    header.className = "run-stack-header";
    this.cycle = doc.createElement("output");
    this.cycle.className = "run-stack-cycle";
    this.status = doc.createElement("span");
    this.status.className = "run-stack-status";
    const summary = doc.createElement("div");
    summary.className = "run-stack-summary";
    summary.append(this.cycle, this.status);
    this.wrapUp = doc.createElement("button");
    this.wrapUp.type = "button";
    this.wrapUp.className = "run-stack-wrap-up";
    this.wrapUp.hidden = true;
    this.wrapUp.disabled = true;
    this.wrapUp.setAttribute("aria-label", "Hold for 3 seconds to wrap up the run");
    this.wrapUp.title = "Hold for 3 seconds to wrap up the run. Releasing cancels.";
    this.wrapUpLabel = doc.createElement("span");
    this.wrapUpLabel.textContent = "Wrap up";
    this.wrapUp.append(this.wrapUpLabel);
    header.append(summary, this.wrapUp);
    this.scroll = doc.createElement("div");
    this.scroll.className = "run-stack-scroll";
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("role", "region");
    this.scroll.setAttribute("aria-label", "Current and upcoming tasks");
    this.list = doc.createElement("ol");
    this.list.className = "run-stack-list";
    this.message = doc.createElement("p");
    this.message.className = "run-stack-message";
    this.more = doc.createElement("p");
    this.more.className = "run-stack-more";
    this.more.textContent = "More steps follow in this cycle";
    this.scroll.append(this.list, this.message, this.more);
    this.surface.replaceChildren(header, this.scroll);
    this.surface.addEventListener("click", this.handleClick);
    this.wrapUp.addEventListener("pointerdown", this.startPointerHold);
    this.wrapUp.addEventListener("pointerleave", this.cancelHold);
    this.wrapUp.addEventListener("keydown", this.startKeyHold);
    this.wrapUp.addEventListener("blur", this.cancelHold);
    doc.addEventListener("pointerup", this.endPointerHold);
    doc.addEventListener("pointercancel", this.endPointerHold);
    doc.addEventListener("pointermove", this.checkPointerHold);
    doc.addEventListener("keyup", this.endKeyHold);
    doc.addEventListener("visibilitychange", this.visibilityChanged);
    doc.defaultView!.addEventListener("blur", this.cancelHold);
    this.reducedMotion = doc.defaultView!.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.motionChanged);
  }

  private readonly handleClick = (event: Event) => {
    if (this.wrapUp.contains(event.target as Node | null)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-run-stack-finish]");
    if (button && this.surface.contains(button) && !button.disabled && button.dataset.cursor) {
      this.onAdvance(button.dataset.cursor);
    }
  };

  private canHold() {
    return !this.disposed && this.previous?.wrapUp.enabled === true && Boolean(this.onWrapUp)
      && !this.completedHold && !this.wrapUp.hidden && !this.wrapUp.disabled
      && this.surface.ownerDocument.visibilityState === "visible";
  }

  private readonly startPointerHold = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || !this.canHold()) return;
    event.preventDefault();
    this.wrapUp.focus({ preventScroll: true });
    this.startHold({ pointerId: event.pointerId });
  };

  private readonly endPointerHold = (event: PointerEvent) => {
    if (this.hold?.pointerId === event.pointerId) this.cancelHold();
    if (this.completedHold?.pointerId === event.pointerId) this.completedHold = null;
  };

  private readonly checkPointerHold = (event: PointerEvent) => {
    if (this.hold?.pointerId !== event.pointerId) return;
    const rect = this.wrapUp.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) {
      this.cancelHold();
    }
  };

  private readonly startKeyHold = (event: KeyboardEvent) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat && this.canHold()) this.startHold({ key: event.key });
  };

  private readonly endKeyHold = (event: KeyboardEvent) => {
    if (this.hold?.key === event.key) {
      event.preventDefault();
      this.cancelHold();
    }
    if (this.completedHold?.key === event.key) {
      event.preventDefault();
      this.completedHold = null;
    }
  };

  private readonly visibilityChanged = () => {
    if (this.surface.ownerDocument.visibilityState !== "visible") this.cancelHold();
  };

  private startHold(input: { pointerId?: number; key?: string }) {
    if (this.hold || !this.canHold()) return;
    const win = this.surface.ownerDocument.defaultView!;
    this.hold = { ...input, startedAt: win.performance.now(), identity: this.previous!.identity };
    this.wrapUp.classList.add("is-holding");
    this.holdTimer = win.setTimeout(this.finishHold, wrapUpHoldMs);
    this.paintHold();
  }

  private readonly paintHold = () => {
    if (!this.hold) return;
    const win = this.surface.ownerDocument.defaultView!;
    const elapsed = win.performance.now() - this.hold.startedAt;
    this.wrapUp.style.setProperty("--hold-progress", String(Math.min(1, elapsed / wrapUpHoldMs)));
    this.wrapUpLabel.textContent = `Hold ${seconds(wrapUpHoldMs - elapsed)}`;
    this.holdFrame = win.requestAnimationFrame(this.paintHold);
  };

  private readonly finishHold = () => {
    const hold = this.hold;
    if (!hold) return;
    const doc = this.surface.ownerDocument;
    const rect = this.wrapUp.getBoundingClientRect();
    if (!this.canHold() || hold.identity !== this.previous?.identity || doc.activeElement !== this.wrapUp || rect.width <= 0 || rect.height <= 0) {
      this.cancelHold();
      return;
    }
    this.completedHold = { pointerId: hold.pointerId, key: hold.key };
    this.cancelHold();
    let accepted = false;
    try {
      accepted = this.onWrapUp?.() === true;
    } finally {
      this.wrapUpDispatched = accepted;
      this.renderWrapUp(this.previous!);
    }
  };

  private readonly cancelHold = () => {
    const win = this.surface.ownerDocument.defaultView!;
    if (this.holdTimer !== null) win.clearTimeout(this.holdTimer);
    if (this.holdFrame !== null) win.cancelAnimationFrame(this.holdFrame);
    this.holdTimer = null;
    this.holdFrame = null;
    this.hold = null;
    this.wrapUp.classList.remove("is-holding");
    this.wrapUp.style.removeProperty("--hold-progress");
    this.wrapUpLabel.textContent = this.previous?.wrapUp.pending || this.wrapUpDispatched ? "Finalising" : "Wrap up";
  };

  private renderWrapUp(model: MonitorRunStackPresentation) {
    const pending = model.wrapUp.pending || (model.wrapUp.visible && this.wrapUpDispatched);
    this.wrapUp.hidden = !model.wrapUp.visible;
    this.wrapUp.disabled = !model.wrapUp.enabled || pending || !this.onWrapUp;
    this.wrapUp.setAttribute("aria-label", pending ? "Finalising the run" : "Hold for 3 seconds to wrap up the run");
    this.wrapUp.setAttribute("aria-busy", String(pending));
    if (!this.hold) this.wrapUpLabel.textContent = pending ? "Finalising" : "Wrap up";
  }

  private readonly motionChanged = () => {
    if (this.reducedMotion.matches) this.clearAnimations();
  };

  private clearAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const ghost of this.ghosts) ghost.remove();
    this.ghosts.clear();
  }

  private animate(element: HTMLElement, frames: Keyframe[], duration: number, done?: () => void) {
    const animation = element.animate(frames, { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    this.animations.add(animation);
    const finish = () => { this.animations.delete(animation); done?.(); };
    void animation.finished.then(finish, finish);
  }

  private createCard(): CardElements {
    const doc = this.surface.ownerDocument;
    const root = doc.createElement("li");
    const position = doc.createElement("p");
    position.className = "run-card-position";
    const title = doc.createElement("h3");
    title.className = "run-card-title";
    const instructions = doc.createElement("p");
    instructions.className = "run-card-instructions";
    const timing = doc.createElement("span");
    timing.className = "run-card-timing";
    const progress = doc.createElement("progress");
    progress.className = "run-card-progress";
    progress.max = 1;
    progress.setAttribute("aria-label", "Current step progress");
    const finish = doc.createElement("button");
    finish.type = "button";
    finish.className = "run-card-finish";
    finish.dataset.runStackFinish = "true";
    finish.textContent = "Finish task";
    root.append(position, title, instructions, timing, progress, finish);
    return { root, position, title, instructions, timing, progress, finish };
  }

  render(snapshot: SessionSnapshot | null | undefined, options: MonitorRunStackOptions = {}) {
    if (this.disposed) return;
    const model = buildMonitorRunStack(snapshot, options);
    this.wrapUpDispatched = model.wrapUp.pending;
    if (this.hold && (!model.wrapUp.enabled || model.identity !== this.hold.identity)) this.cancelHold();
    this.renderWrapUp(model);
    const keys = model.cards.map(({ key }) => key);
    const structureChanged = keys.join("\n") !== this.previous?.cards.map(({ key }) => key).join("\n");
    const move = structureChanged && this.previous?.active && (model.active || model.status === "Run complete")
      && model.identity === this.previous.identity && !this.reducedMotion.matches
      && this.surface.getBoundingClientRect().height > 0 && typeof this.surface.animate === "function";
    const oldRects = new Map<string, DOMRect>();
    if (structureChanged) {
      this.clearAnimations();
      if (move) for (const [key, card] of this.elements) oldRects.set(key, card.root.getBoundingClientRect());
    }
    this.cycle.textContent = model.cycle;
    this.status.textContent = model.status;
    this.message.textContent = model.message;
    this.message.hidden = model.cards.length > 0;
    this.more.hidden = !model.more;
    const desired = new Set(keys);
    let removedFocus = false;
    for (const [key, card] of this.elements) {
      if (desired.has(key)) continue;
      removedFocus ||= card.root.contains(this.surface.ownerDocument.activeElement);
      const rect = oldRects.get(key);
      if (move && rect && rect.bottom > this.scroll.getBoundingClientRect().top && rect.top < this.scroll.getBoundingClientRect().bottom) {
        const ghost = card.root.cloneNode(true) as HTMLElement;
        const listRect = this.list.getBoundingClientRect();
        ghost.classList.add("run-card-exiting");
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        Object.assign(ghost.style, { top: `${rect.top - listRect.top}px`, left: "0", width: `${rect.width}px` });
        this.list.append(ghost);
        this.ghosts.add(ghost);
        this.animate(ghost, [{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(104%)", opacity: 0 }], 220, () => {
          ghost.remove();
          this.ghosts.delete(ghost);
        });
      }
      card.root.remove();
      this.elements.delete(key);
    }
    for (const modelCard of model.cards) {
      let card = this.elements.get(modelCard.key);
      if (!card) { card = this.createCard(); this.elements.set(modelCard.key, card); }
      card.root.className = `run-stack-card run-card-${modelCard.kind}${modelCard.current ? " is-current" : ""}`;
      card.root.dataset.cardKey = modelCard.key;
      card.root.dataset.kind = modelCard.kind;
      if (modelCard.current) card.root.setAttribute("aria-current", "step");
      else card.root.removeAttribute("aria-current");
      card.position.textContent = modelCard.position;
      card.title.textContent = modelCard.title;
      card.instructions.textContent = modelCard.instructions;
      card.instructions.hidden = !modelCard.instructions;
      card.timing.textContent = modelCard.timing;
      card.progress.hidden = modelCard.progress === null;
      card.progress.value = modelCard.progress ?? 0;
      card.finish.hidden = modelCard.finish === null;
      card.finish.disabled = modelCard.finish?.enabled !== true;
      card.finish.dataset.cursor = modelCard.finish?.cursor ?? "";
      card.finish.textContent = modelCard.finish?.label ?? "Finish task";
      if (structureChanged) this.list.append(card.root);
    }
    if (move) {
      for (const [key, card] of this.elements) {
        const before = oldRects.get(key);
        const after = card.root.getBoundingClientRect();
        const distance = before ? before.top - after.top : 0;
        if (Math.abs(distance) > 1) this.animate(card.root, [{ transform: `translateY(${distance}px)` }, { transform: "translateY(0)" }], 300);
      }
    }
    if (removedFocus) this.scroll.focus({ preventScroll: true });
    this.previous = model;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelHold();
    this.clearAnimations();
    this.surface.removeEventListener("click", this.handleClick);
    this.wrapUp.removeEventListener("pointerdown", this.startPointerHold);
    this.wrapUp.removeEventListener("pointerleave", this.cancelHold);
    this.wrapUp.removeEventListener("keydown", this.startKeyHold);
    this.wrapUp.removeEventListener("blur", this.cancelHold);
    const doc = this.surface.ownerDocument;
    doc.removeEventListener("pointerup", this.endPointerHold);
    doc.removeEventListener("pointercancel", this.endPointerHold);
    doc.removeEventListener("pointermove", this.checkPointerHold);
    doc.removeEventListener("keyup", this.endKeyHold);
    doc.removeEventListener("visibilitychange", this.visibilityChanged);
    doc.defaultView!.removeEventListener("blur", this.cancelHold);
    this.reducedMotion.removeEventListener("change", this.motionChanged);
    this.elements.clear();
    this.surface.replaceChildren();
  }
}
