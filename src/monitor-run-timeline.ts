import type { CaptureConfiguration, Episode, EpisodeSegment, SessionSnapshot, TaskDefinition } from "../shared/protocol.js";
import { CYCLE_PAUSE_MS, taskResetDurationMs } from "../shared/run-sequencing.js";
import { takeElapsedMs } from "./run-presentation.js";

export interface MonitorRunTimelineOptions {
  configuration?: CaptureConfiguration;
  draft?: boolean;
  now?: number;
}

export type RunTimelineState = "upcoming" | "current" | "completed" | "partial";
export interface RunTimelineSegment {
  key: string;
  kind: "cycle" | "task" | "rep" | "rest" | "pause" | "cycle-rest" | "summary";
  label: string;
  title: string;
  cycle: number;
  task?: number;
  rep?: number;
  durationMs: number;
  estimated: boolean;
  state: RunTimelineState;
  progress: number;
  pulsing: boolean;
  start: number;
  span: number;
}

export interface MonitorRunTimelinePresentation {
  cycles: RunTimelineSegment[];
  tasks: RunTimelineSegment[];
  steps: RunTimelineSegment[];
  durationMs: number;
  description: string;
}

const boundedCount = (value: number) => Number.isFinite(value) ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 1;
const duration = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value)) : 0;
const fraction = (value: number) => Math.max(0, Math.min(1, value));
const seconds = (value: number) => `${Math.round(value / 100) / 10}s`;
const rangeLabel = (label: string, first: number, last: number) => first === last ? `${label} ${first}` : `${label}s ${first}-${last}`;

function recordedSegments(snapshot: SessionSnapshot | null | undefined) {
  const latest = new Map<string, EpisodeSegment>();
  const episodes = new Map<string, Episode>();
  const startedAt = snapshot?.run.startedAtMs;
  if (startedAt == null) return { latest, episodes };
  for (const episode of [...snapshot!.attempts, ...snapshot!.episodes, snapshot!.pendingEpisode, snapshot!.currentEpisode]) {
    if (!episode || Date.parse(episode.startedAt) < startedAt || !Number.isFinite(Date.parse(episode.startedAt))) continue;
    episodes.set(episode.id, episode);
  }
  for (const episode of episodes.values()) {
    for (const segment of episode.segments ?? []) {
      const key = `${episode.cycle}:${segment.taskId}:${segment.repetition}`;
      const previous = latest.get(key);
      if (!previous || segment.take >= previous.take) latest.set(key, segment);
    }
  }
  return { latest, episodes };
}

/** Three aligned tracks use the same duration-weighted leaves and authoritative run cursor. */
export function buildMonitorRunTimeline(
  snapshot: SessionSnapshot | null | undefined,
  options: MonitorRunTimelineOptions = {},
): MonitorRunTimelinePresentation {
  const running = snapshot?.run.status === "running";
  const preview = !running && options.draft === true;
  const configuration = running ? snapshot!.configuration : options.configuration ?? snapshot?.configuration;
  const model: MonitorRunTimelinePresentation = { cycles: [], tasks: [], steps: [], durationMs: 0, description: "Run timeline. Add tasks to begin." };
  if (!configuration?.tasks.length) return model;
  const evidence = recordedSegments(preview ? null : snapshot);
  let run = snapshot?.run;
  if (run?.status === "stopped" && run.startedAtMs != null) {
    const last = Array.from(evidence.episodes.values()).sort((left, right) => right.cycle - left.cycle
      || Date.parse(right.startedAt) - Date.parse(left.startedAt)).find((episode) => episode.segments?.length);
    const segment = last?.segments?.at(-1);
    const taskIndex = segment ? configuration.tasks.findIndex((task) => task.id === segment.taskId) : -1;
    if (last && segment && taskIndex >= 0) run = { ...run, cycle: last.cycle, activeTaskIndex: taskIndex, repetition: segment.repetition };
  }
  const hasRun = !preview && run?.startedAtMs != null;
  const cycles = boundedCount(configuration.totalCycles);
  const activeCycle = Math.min(cycles, boundedCount(run?.cycle ?? 1));
  const activeTask = Math.max(0, Math.min(configuration.tasks.length, run?.activeTaskIndex ?? 0));
  const activeRep = boundedCount(run?.repetition ?? 1);
  const now = options.now ?? Date.now();
  const timed = configuration.tasks.filter((task) => task.type === "timed").map((task) => duration(task.durationS * 1_000));
  const fallback = timed.length ? timed.reduce((sum, value) => sum + value, 0) / timed.length : 30_000;
  const estimates = new Map<string, { total: number; count: number }>();
  for (const segment of evidence.latest.values()) {
    if (segment.outcome !== "completed" || !segment.endedAt) continue;
    const milliseconds = Date.parse(segment.endedAt) - Date.parse(segment.startedAt);
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      const values = estimates.get(segment.taskId) ?? { total: 0, count: 0 };
      values.total += milliseconds;
      values.count += 1;
      estimates.set(segment.taskId, values);
    }
  }
  const repDuration = (task: TaskDefinition) => {
    const estimate = estimates.get(task.id);
    return task.type === "open" ? estimate ? estimate.total / estimate.count : Math.max(1_000, fallback) : duration(task.durationS * 1_000);
  };
  const taskDuration = (task: TaskDefinition) => task.type === "pause" ? repDuration(task)
    : boundedCount(task.repeatCount) * (repDuration(task) + taskResetDurationMs(task.resetTimeS));
  const cycleDuration = configuration.tasks.reduce((sum, task) => sum + taskDuration(task), CYCLE_PAUSE_MS);
  const plannedLeaves = cycles * configuration.tasks.reduce((sum, task) => sum + (task.type === "pause" ? 1 : boundedCount(task.repeatCount) * 2), 1);
  const compact = plannedLeaves > 512;
  const cycleGroups = new Map<string, RunTimelineSegment>();
  const taskGroups = new Map<string, RunTimelineSegment>();
  const isPulsing = running && run!.recordingState !== "arming" && run!.recordingState !== "stopping"
    && !(run!.phase === "active-task" && run!.recordingState === "paused");
  const taskIndices = new Map(configuration.tasks.map((task, index) => [task.id, index]));
  const unfinished = Array.from(evidence.latest, ([key, segment]) => ({
    cycle: Number(key.slice(0, key.indexOf(":"))), task: taskIndices.get(segment.taskId) ?? -1,
    rep: segment.repetition, outcome: segment.outcome,
  })).filter(({ outcome }) => outcome === "retry" || outcome === "stopped");
  const interruptedRange = (firstCycle: number, lastCycle: number, firstTask = 0, lastTask = configuration.tasks.length - 1, firstRep = 1, lastRep = Number.MAX_SAFE_INTEGER) => unfinished.some((item) =>
    item.cycle >= firstCycle && item.cycle <= lastCycle && item.task >= firstTask && item.task <= lastTask && item.rep >= firstRep && item.rep <= lastRep);
  const position = (cycle: number, task: number, rep = 1) => cycle !== activeCycle ? Math.sign(cycle - activeCycle)
    : task !== activeTask ? Math.sign(task - activeTask) : Math.sign(rep - activeRep);
  const stateFor = (cycle: number, taskIndex: number, rep: number, kind: RunTimelineSegment["kind"]): RunTimelineState => {
    if (!hasRun) return "upcoming";
    const before = position(cycle, taskIndex, rep);
    const task = configuration.tasks[taskIndex];
    const segment = task ? evidence.latest.get(`${cycle}:${task.id}:${rep}`) : undefined;
    if (kind === "rep" && before <= 0 && (segment?.outcome === "retry" || segment?.outcome === "stopped")) return "partial";
    if (before < 0) return "completed";
    if (before > 0) return "upcoming";
    if (kind === "rep") {
      if (segment?.outcome === "completed") return "completed";
      if (segment?.outcome === "retry" || segment?.outcome === "stopped") return "partial";
      if (running && run!.phase === "post-task-pause") return "completed";
      if (running && run!.phase === "active-task") return "current";
      return "upcoming";
    }
    const phase = kind === "rest" ? "post-task-pause" : kind === "pause" ? "task-pause" : "cycle-pause";
    if (running && run!.phase === phase) return "current";
    if (kind === "cycle-rest" && run!.status === "complete") {
      const finishedEarly = Array.from(evidence.episodes.values()).some((episode) => episode.cycle === cycle && episode.runFinalisation);
      if (cycle === cycles && activeTask === configuration.tasks.length && !finishedEarly) return "completed";
    }
    return "upcoming";
  };
  const add = (leaf: Omit<RunTimelineSegment, "start" | "span" | "progress" | "pulsing">, cycleKey: string, cycleLabel: string, taskKey: string, taskLabel: string) => {
    let progress = leaf.state === "completed" ? 1 : 0;
    if (leaf.state === "current") {
      progress = leaf.kind === "rep" ? fraction(takeElapsedMs(run!, now) / Math.max(1, leaf.durationMs))
        : run!.resetDeadlineMs == null ? 0 : fraction(1 - (run!.resetDeadlineMs - now) / Math.max(1, leaf.durationMs));
    }
    const item: RunTimelineSegment = { ...leaf, start: model.steps.length, span: 1, progress, pulsing: leaf.state === "current" && isPulsing };
    model.steps.push(item);
    for (const [groups, key, label, kind] of [[cycleGroups, cycleKey, cycleLabel, "cycle"], [taskGroups, taskKey, taskLabel, "task"]] as const) {
      let group = groups.get(key);
      if (!group) {
        group = { ...item, key, kind, label, title: label, durationMs: 0, estimated: false, span: 0, progress: 0, pulsing: false };
        groups.set(key, group);
      }
      group.span += 1;
      group.durationMs += item.durationMs;
      group.estimated ||= item.estimated;
    }
  };
  const addCycles = (first: number, last: number) => {
    const label = rangeLabel("Cycle", first, last);
    add({ key: `cycles:${first}-${last}`, kind: "summary", label, title: `${label}, all tasks and rests`, cycle: first,
      durationMs: cycleDuration * (last - first + 1), estimated: configuration.tasks.some((task) => task.type === "open"),
      state: hasRun && last < activeCycle ? interruptedRange(first, last) ? "partial" : "completed" : "upcoming" }, label, label, `${label}:tasks`, "Tasks and rests");
  };
  const cycleNumbers = compact ? [hasRun ? activeCycle : 1] : Array.from({ length: cycles }, (_, index) => index + 1);
  if (compact && cycleNumbers[0]! > 1) addCycles(1, cycleNumbers[0]! - 1);
  for (const cycle of cycleNumbers) {
    const cycleKey = `cycle:${cycle}`;
    const cycleLabel = `Cycle ${cycle}/${cycles}`;
    const addTaskRange = (first: number, last: number) => {
      const tasks = configuration.tasks.slice(first, last + 1);
      const label = rangeLabel("Task", first + 1, last + 1);
      add({ key: `${cycleKey}:tasks:${first}-${last}`, kind: "summary", label, title: `${cycleLabel}, ${label.toLowerCase()}, all reps and rests`,
        cycle, task: first + 1, durationMs: tasks.reduce((sum, task) => sum + taskDuration(task), 0), estimated: tasks.some((task) => task.type === "open"),
        state: hasRun && position(cycle, last) < 0 ? interruptedRange(cycle, cycle, first, last) ? "partial" : "completed" : "upcoming" }, cycleKey, cycleLabel, `${cycleKey}:${label}`, label);
    };
    const limitedTasks = compact && configuration.tasks.length > 64;
    const focusTask = hasRun ? Math.min(activeTask, configuration.tasks.length - 1) : 0;
    const firstTask = limitedTasks ? focusTask : 0;
    const lastTask = limitedTasks ? focusTask : configuration.tasks.length - 1;
    if (firstTask > 0) addTaskRange(0, firstTask - 1);
    for (let taskIndex = firstTask; taskIndex <= lastTask; taskIndex += 1) {
      const task = configuration.tasks[taskIndex]!;
      const taskKey = `${cycleKey}:task:${taskIndex}`;
      const taskLabel = `Task ${taskIndex + 1}: ${task.label || (task.type === "pause" ? "Pause" : "Capture")}`;
      const reps = task.type === "pause" ? 1 : boundedCount(task.repeatCount);
      const focusRep = hasRun && cycle === activeCycle && taskIndex === activeTask ? Math.min(reps, activeRep) : 1;
      const compressedReps = compact && reps > 3;
      const addRepRange = (first: number, last: number) => {
        const label = rangeLabel("Rep", first, last);
        add({ key: `${taskKey}:reps:${first}-${last}`, kind: "summary", label, title: `${cycleLabel}, ${taskLabel.toLowerCase()}, ${label.toLowerCase()} and rests`,
          cycle, task: taskIndex + 1, rep: first, durationMs: (repDuration(task) + taskResetDurationMs(task.type === "pause" ? 0 : task.resetTimeS)) * (last - first + 1),
          estimated: task.type === "open", state: hasRun && position(cycle, taskIndex, last) < 0
            ? interruptedRange(cycle, cycle, taskIndex, taskIndex, first, last) ? "partial" : "completed" : "upcoming" }, cycleKey, cycleLabel, taskKey, taskLabel);
      };
      if (compressedReps && focusRep > 1) addRepRange(1, focusRep - 1);
      for (let rep = compressedReps ? focusRep : 1; rep <= (compressedReps ? focusRep : reps); rep += 1) {
        const kind = task.type === "pause" ? "pause" : "rep";
        const label = task.type === "pause" ? "Pause" : `R${rep}`;
        add({ key: `${taskKey}:${kind}:${rep}`, kind, label,
          title: `${cycleLabel}, ${taskLabel.toLowerCase()}, ${task.type === "pause" ? "pause" : `rep ${rep}/${reps}`}`,
          cycle, task: taskIndex + 1, ...(task.type === "pause" ? {} : { rep }), durationMs: repDuration(task),
          estimated: task.type === "open", state: stateFor(cycle, taskIndex, rep, kind) }, cycleKey, cycleLabel, taskKey, taskLabel);
        if (task.type !== "pause") add({ key: `${taskKey}:rest:${rep}`, kind: "rest", label: "Rest",
          title: `${cycleLabel}, ${taskLabel.toLowerCase()}, rest after rep ${rep}/${reps}`, cycle, task: taskIndex + 1, rep,
          durationMs: taskResetDurationMs(task.resetTimeS), estimated: false, state: stateFor(cycle, taskIndex, rep, "rest") }, cycleKey, cycleLabel, taskKey, taskLabel);
      }
      if (compressedReps && focusRep < reps) addRepRange(focusRep + 1, reps);
    }
    if (lastTask < configuration.tasks.length - 1) addTaskRange(lastTask + 1, configuration.tasks.length - 1);
    add({ key: `${cycleKey}:rest`, kind: "cycle-rest", label: "Rest", title: `${cycleLabel}, cycle rest`, cycle,
      durationMs: CYCLE_PAUSE_MS, estimated: false, state: stateFor(cycle, configuration.tasks.length, 1, "cycle-rest") },
    cycleKey, cycleLabel, `${cycleKey}:rest`, "Cycle rest");
  }
  if (compact && cycleNumbers[0]! < cycles) addCycles(cycleNumbers[0]! + 1, cycles);
  const groupState = (group: RunTimelineSegment) => {
    const children = model.steps.slice(group.start, group.start + group.span);
    group.state = children.some((leaf) => leaf.state === "current") ? "current"
      : children.every((leaf) => leaf.state === "completed") ? "completed"
        : children.some((leaf) => leaf.state === "completed" || leaf.state === "partial") ? "partial" : "upcoming";
    group.progress = children.reduce((sum, leaf) => sum + leaf.progress * leaf.durationMs, 0) / Math.max(1, group.durationMs);
    group.pulsing = children.some((leaf) => leaf.pulsing);
    return group;
  };
  model.cycles = Array.from(cycleGroups.values(), groupState);
  model.tasks = Array.from(taskGroups.values(), groupState);
  model.durationMs = model.steps.reduce((sum, leaf) => sum + leaf.durationMs, 0);
  const current = model.steps.find((leaf) => leaf.state === "current");
  model.description = `Run timeline, ${cycles} ${cycles === 1 ? "cycle" : "cycles"}. ${current?.title ?? (running ? "Waiting for capture" : hasRun ? "Capture ended" : "Ready to begin")}.`;
  return model;
}

export class MonitorRunTimeline {
  private readonly surface: HTMLElement;
  private readonly tracks: Map<"cycles" | "tasks" | "steps", HTMLElement>;
  private readonly nodes = new Map<string, HTMLElement>();
  private columns = "";
  private disposed = false;

  constructor(options: { surface: HTMLElement }) {
    this.surface = options.surface;
    this.surface.classList.add("monitor-run-timeline");
    this.surface.setAttribute("role", "group");
    this.tracks = new Map();
    for (const [track, label] of [["cycles", "Cycles"], ["tasks", "Tasks"], ["steps", "Reps and rests"]] as const) {
      const row = this.surface.ownerDocument.createElement("div");
      row.className = "run-timeline-track";
      row.dataset.timelineTrack = track;
      row.setAttribute("role", "list");
      row.setAttribute("aria-label", label);
      this.tracks.set(track, row);
    }
    this.surface.replaceChildren(...this.tracks.values());
  }

  render(snapshot: SessionSnapshot | null | undefined, options: MonitorRunTimelineOptions = {}) {
    if (this.disposed) return;
    const model = buildMonitorRunTimeline(snapshot, options);
    this.surface.setAttribute("aria-label", model.description);
    this.surface.hidden = model.steps.length === 0;
    const columns = model.steps.map((step) => `minmax(0, ${Math.max(Number.EPSILON, step.durationMs / Math.max(1, model.durationMs)) * 1_000}fr)`).join(" ");
    if (columns !== this.columns) {
      for (const row of this.tracks.values()) row.style.gridTemplateColumns = columns;
      this.columns = columns;
    }
    const desired = new Set<string>();
    for (const [track, row] of this.tracks) {
      let index = 0;
      for (const segment of model[track]) {
        const key = `${track}:${segment.key}`;
        desired.add(key);
        let node = this.nodes.get(key);
        if (!node) {
          node = this.surface.ownerDocument.createElement("span");
          node.className = "run-timeline-segment";
          node.setAttribute("role", "listitem");
          this.nodes.set(key, node);
        }
        if (node.textContent !== segment.label) node.textContent = segment.label;
        const state = { upcoming: "Upcoming", current: "Current", completed: "Completed", partial: "Partly complete" }[segment.state];
        const title = `${segment.title}. ${segment.estimated ? "Estimated " : ""}${seconds(segment.durationMs)}. ${state}.`;
        const attribute = (name: string, value: string) => { if (node!.getAttribute(name) !== value) node!.setAttribute(name, value); };
        attribute("title", title);
        attribute("aria-label", title);
        attribute("data-kind", segment.kind);
        attribute("data-state", segment.state);
        attribute("data-cycle", String(segment.cycle));
        attribute("data-task", segment.task == null ? "" : String(segment.task));
        attribute("data-rep", segment.rep == null ? "" : String(segment.rep));
        attribute("data-progress", String(segment.progress));
        attribute("data-pulsing", String(segment.pulsing));
        attribute("data-duration-ms", String(segment.durationMs));
        if (segment.state === "current") attribute("aria-current", "step");
        else if (node.hasAttribute("aria-current")) node.removeAttribute("aria-current");
        const column = `${segment.start + 1} / span ${segment.span}`;
        if (node.style.gridColumn !== column) node.style.gridColumn = column;
        const progress = String(segment.progress);
        if (node.style.getPropertyValue("--timeline-progress") !== progress) node.style.setProperty("--timeline-progress", progress);
        if (row.children[index] !== node) row.insertBefore(node, row.children[index] ?? null);
        index += 1;
      }
    }
    for (const [key, node] of this.nodes) if (!desired.has(key)) { node.remove(); this.nodes.delete(key); }
  }

  dispose() {
    this.disposed = true;
    this.nodes.clear();
    this.surface.replaceChildren();
  }
}
