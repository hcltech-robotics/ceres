import { isRepetitionTask, type RunProgress, type SessionSnapshot } from "../shared/protocol.js";

export interface RunStagePresentation {
  complete: boolean;
  title: string;
  detail: string;
  cycle: number;
  taskIndex: number;
  repetition: number;
}

export type RunControlSlot = "run" | "record" | "retry" | "next" | "pass" | "fail";
export type RunControlAction = "start-sequence" | "start" | "pause" | "stop" | "finish" | "success" | "fail" | "retry" | "resume" | "next";

export interface RunControlPresentation {
  slot: RunControlSlot;
  action: RunControlAction;
  label: string;
  tone: "primary" | "neutral" | "record" | "success" | "danger";
  enabled: boolean;
  pressed: boolean;
  state: "idle" | "ready" | "armed" | "sync-lock" | "countdown" | "active" | "latched";
}

export interface RunStatePresentation {
  stateLabel: string;
  title: string;
  detail: string;
  selectedStartTaskId?: string | null;
  startCountdownDeadlineMs?: number | null;
}

export interface SoloRunStartPresentation {
  state: "select-task" | "awaiting-hands" | "countdown" | "arming" | "recording" | "active";
  selectedStartTaskId: string | null;
  startCountdownDeadlineMs: number | null;
  remainingMs: number | null;
  countdownValue: number | null;
}

function stagePresentation(snapshot: SessionSnapshot, cycle: number, taskIndex: number, repetition: number): RunStagePresentation {
  const task = snapshot.configuration.tasks[taskIndex];
  if (!task) return {
    complete: true,
    title: "Run complete",
    detail: `${snapshot.configuration.totalCycles} cycles completed.`,
    cycle,
    taskIndex,
    repetition,
  };
  const position = `Cycle ${cycle}/${snapshot.configuration.totalCycles}, task ${taskIndex + 1}/${snapshot.configuration.tasks.length}`;
  return {
    complete: false,
    title: task.label,
    detail: task.type === "pause"
      ? `${position}. Pause for ${task.durationS} seconds.`
      : `${position}, rep ${repetition}/${Math.max(1, task.repeatCount)}.`,
    cycle,
    taskIndex,
    repetition,
  };
}

function nextCursor(snapshot: SessionSnapshot) {
  const { run } = snapshot;
  const task = snapshot.configuration.tasks[run.activeTaskIndex];
  if (task && isRepetitionTask(task) && run.repetition < Math.max(1, task.repeatCount)) {
    return { cycle: run.cycle, taskIndex: run.activeTaskIndex, repetition: run.repetition + 1 };
  }
  if (run.activeTaskIndex + 1 < snapshot.configuration.tasks.length) {
    return { cycle: run.cycle, taskIndex: run.activeTaskIndex + 1, repetition: 1 };
  }
  if (run.cycle < Math.max(1, snapshot.configuration.totalCycles)) {
    return { cycle: run.cycle + 1, taskIndex: 0, repetition: 1 };
  }
  return { cycle: run.cycle, taskIndex: snapshot.configuration.tasks.length, repetition: 1 };
}

export function currentRunStage(snapshot: SessionSnapshot): RunStagePresentation {
  return stagePresentation(snapshot, snapshot.run.cycle, snapshot.run.activeTaskIndex, snapshot.run.repetition);
}

export function nextRunStage(snapshot: SessionSnapshot): RunStagePresentation | null {
  if (snapshot.run.status !== "running") return null;
  const next = nextCursor(snapshot);
  return stagePresentation(snapshot, next.cycle, next.taskIndex, next.repetition);
}

export type RunControlActor = "director" | "demonstrator" | "solo";

export function runControls(
  snapshot: SessionSnapshot | null | undefined,
  controlConnected = true,
  actor: RunControlActor = "director",
): RunControlPresentation[] {
  const run = snapshot?.run;
  const controlsConnected = controlConnected && snapshot?.captureConnected === true;
  const running = run?.status === "running";
  const soloAwaitingHands = snapshot?.operatingMode === "solo"
    && snapshot.solo?.selectedStartTaskId != null
    && snapshot.solo?.startCountdownDeadlineMs == null
    && run?.status === "stopped";
  const soloCountdown = snapshot?.operatingMode === "solo"
    && (snapshot.solo?.startCountdownDeadlineMs != null || soloAwaitingHands);
  const locallyReady = actor === "solo" || snapshot?.operatingMode === "solo"
    ? soloCountdown
    : actor === "director" ? run?.directorReady === true : run?.demonstratorReady === true;
  const syncLock = !running && run?.syncLockStartedAtMs != null;
  const finalising = run?.recordingState === "stopping";
  const finishArming = running && actor !== "director" && run?.recordingState === "arming";
  const pausing = run?.recordingState === "recording";
  const paused = run?.recordingState === "paused" && run.phase === "active-task";
  const recordAction: RunControlAction = pausing ? "pause" : paused ? "resume" : "start";
  const recordLabel = pausing ? "Pause recording" : paused ? "Resume recording" : "Recording starts automatically";
  const annotatable = Boolean(running && !finalising && run?.phase === "post-task-pause");
  const activeTask = Boolean(running && !finalising && run?.phase === "active-task"
    && (run.recordingState === "recording" || run.recordingState === "paused"));

  return [
    {
      slot: "run",
      action: running ? actor === "director" ? "stop" : "finish" : soloCountdown ? "stop" : "start-sequence",
      label: running
        ? actor === "director" ? "Stop run" : "Finish"
        : soloAwaitingHands
          ? "Show both hands"
          : soloCountdown
            ? "Cancel countdown"
            : snapshot?.operatingMode === "solo"
              ? "Select a task"
              : syncLock ? "Sync lock" : locallyReady ? "READY" : "PRESS TO READY",
      tone: running ? "primary" : "success",
      enabled: controlsConnected
        && !finalising
        && !finishArming
        && (running
          || soloCountdown
          || (snapshot?.operatingMode === "solo"
            ? snapshot.sequenceReadiness.ready === true
            : locallyReady || snapshot?.sequenceReadiness.ready === true)),
      pressed: running || locallyReady,
      state: running ? "active" : soloCountdown ? "countdown" : syncLock ? "sync-lock" : locallyReady ? "armed" : "ready",
    },
    {
      slot: "record",
      action: recordAction,
      label: running ? recordLabel : "Recording starts with capture",
      tone: "record",
      enabled: controlsConnected && !finalising && Boolean(running && (pausing || paused)),
      pressed: pausing,
      state: pausing ? "active" : "idle",
    },
    {
      slot: "retry",
      action: "retry",
      label: "Retry task",
      tone: "neutral",
      enabled: controlsConnected && (activeTask || annotatable),
      pressed: false,
      state: "idle",
    },
    {
      slot: "next",
      action: "next",
      label: "Advance",
      tone: "neutral",
      enabled: controlsConnected && !finalising && Boolean(running && run?.phase
        && ((run.phase === "active-task" && (run.recordingState === "recording" || run.recordingState === "paused"))
          || run.phase === "post-task-pause"
          || run.phase === "task-pause"
          || run.phase === "cycle-pause")),
      pressed: false,
      state: "idle",
    },
    {
      slot: "pass",
      action: "success",
      label: "Annotate pass",
      tone: "success",
      enabled: controlsConnected && annotatable,
      pressed: false,
      state: "idle",
    },
    {
      slot: "fail",
      action: "fail",
      label: "Annotate fail",
      tone: "danger",
      enabled: controlsConnected && annotatable,
      pressed: false,
      state: "idle",
    },
  ];
}

export function soloRunStartPresentation(
  snapshot: SessionSnapshot,
  now = Date.now(),
): SoloRunStartPresentation | null {
  if (snapshot.operatingMode !== "solo" || !snapshot.solo) return null;
  const selectedStartTaskId = snapshot.solo.selectedStartTaskId;
  const startCountdownDeadlineMs = snapshot.solo.startCountdownDeadlineMs;
  if (snapshot.run.recordingState === "arming") {
    return {
      state: "arming",
      selectedStartTaskId,
      startCountdownDeadlineMs,
      remainingMs: null,
      countdownValue: null,
    };
  }
  if (snapshot.run.recordingState === "recording") {
    return {
      state: "recording",
      selectedStartTaskId,
      startCountdownDeadlineMs,
      remainingMs: null,
      countdownValue: null,
    };
  }
  if (snapshot.run.status === "stopped"
    && selectedStartTaskId !== null
    && startCountdownDeadlineMs === null) {
    // The start task was committed while a controller was still held. The
    // countdown waits for both hands rather than recording without them.
    return {
      state: "awaiting-hands",
      selectedStartTaskId,
      startCountdownDeadlineMs,
      remainingMs: null,
      countdownValue: null,
    };
  }
  if (snapshot.run.status === "stopped" && startCountdownDeadlineMs !== null) {
    const remainingMs = Math.max(0, startCountdownDeadlineMs - now);
    return {
      state: "countdown",
      selectedStartTaskId,
      startCountdownDeadlineMs,
      remainingMs,
      countdownValue: Math.max(1, Math.ceil(remainingMs / 1_000)),
    };
  }
  return {
    state: snapshot.run.status === "stopped" ? "select-task" : "active",
    selectedStartTaskId,
    startCountdownDeadlineMs,
    remainingMs: null,
    countdownValue: null,
  };
}

export function runStatePresentation(
  snapshot: SessionSnapshot | null | undefined,
  controlConnected = true,
  now = Date.now(),
): RunStatePresentation {
  if (!controlConnected) {
    const recordingState = snapshot?.run.recordingState;
    if (recordingState === "recording" || recordingState === "paused") return {
      stateLabel: "OFFLINE",
      title: "Capture director offline",
      detail: recordingState === "recording"
        ? "Recording is continuing locally. Reconnect the capture director to restore run controls."
        : "Recording remains paused locally. Reconnect the capture director to restore run controls.",
    };
    if (recordingState === "arming" || recordingState === "stopping") return {
      stateLabel: "OFFLINE",
      title: "Capture director offline",
      detail: recordingState === "arming"
        ? "Recorder arming is waiting for the capture director to reconnect."
        : "Recorder finalisation is waiting for the capture director to reconnect.",
    };
    if (snapshot?.run.status === "running") return {
      stateLabel: "OFFLINE",
      title: "Capture director offline",
      detail: "The active run remains loaded locally. Reconnect the capture director to restore run controls.",
    };
    return {
      stateLabel: "OFFLINE",
      title: "Capture director offline",
      detail: "Connect to the capture director to receive the active run and instructions.",
    };
  }
  if (!snapshot) return {
    stateLabel: "WAITING",
    title: "Waiting for run state",
    detail: "Waiting for the capture director to send the active run.",
  };
  const { run, configuration } = snapshot;
  const task = configuration.tasks[run.activeTaskIndex];
  const soloStart = soloRunStartPresentation(snapshot, now);
  if (soloStart?.state === "countdown") return {
    stateLabel: String(soloStart.countdownValue),
    title: task?.label ?? configuration.runTitle,
    detail: "Hold position. Recording has not started.",
    selectedStartTaskId: soloStart.selectedStartTaskId,
    startCountdownDeadlineMs: soloStart.startCountdownDeadlineMs,
  };
  if (soloStart?.state === "select-task") return {
    stateLabel: "SELECT TASK",
    title: configuration.runTitle,
    detail: "Select a runnable task to begin the Solo countdown.",
    selectedStartTaskId: null,
    startCountdownDeadlineMs: null,
  };
  if (soloStart?.state === "arming") return {
    stateLabel: "ARMING",
    title: task?.label ?? configuration.runTitle,
    detail: "Hold position.",
    selectedStartTaskId: soloStart.selectedStartTaskId,
    startCountdownDeadlineMs: null,
  };
  if (soloStart?.state === "recording") return {
    stateLabel: "REC",
    title: task?.label ?? configuration.runTitle,
    detail: `Cycle ${run.cycle}, rep ${run.repetition}.`,
    selectedStartTaskId: soloStart.selectedStartTaskId,
    startCountdownDeadlineMs: null,
  };
  if (run.status === "stopped" && run.syncLockStartedAtMs != null) return {
    stateLabel: "SYNC LOCK",
    title: configuration.runTitle,
    detail: "Director and demonstrator are locked. The run starts in 2.5 seconds.",
  };
  if (run.status === "stopped" && (run.directorReady === true || run.demonstratorReady === true)) return {
    stateLabel: "READY",
    title: configuration.runTitle,
    detail: run.directorReady === true && run.demonstratorReady !== true
      ? "Waiting for the demonstrator."
      : "Waiting for the capture director.",
  };
  if (run.status === "stopped") return {
    stateLabel: "READY?",
    title: configuration.runTitle,
    detail: configuration.tasks.length ? "Mark ready when prepared to begin." : "Add at least one task to start.",
  };
  if (run.status === "complete") return {
    stateLabel: "COMPLETE",
    title: "Run complete",
    detail: `${configuration.totalCycles} cycle${configuration.totalCycles === 1 ? "" : "s"} completed.`,
  };
  if (run.status === "error") return {
    stateLabel: "ERROR",
    title: "Run stopped",
    detail: run.error ?? "Resolve the capture error before restarting.",
  };
  if (run.recordingState === "arming" || run.recordingState === "stopping") return {
    stateLabel: run.recordingState.toUpperCase(),
    title: task?.label ?? configuration.runTitle,
    detail: run.recordingState === "arming" ? "Starting the recorder." : "Finalising the recorder.",
  };
  if (run.phase === "post-task-pause") return {
    stateLabel: "RESET",
    title: task?.label ?? "Task reset",
    detail: "Pass and fail add annotations. Retry repeats this task and Next advances. The reset timer continues automatically.",
  };
  if (run.phase === "task-pause") return {
    stateLabel: "PAUSE",
    title: task?.label ?? "Configured pause",
    detail: "The next run item begins when the pause ends. Next advances immediately.",
  };
  if (run.phase === "cycle-pause") return {
    stateLabel: "CYCLE COMPLETE",
    title: `Cycle ${run.cycle}/${configuration.totalCycles} complete`,
    detail: run.cycle < configuration.totalCycles
      ? `Cycle ${run.cycle + 1}/${configuration.totalCycles} begins after the 15 second pause. Next advances immediately.`
      : "The run completes after the 15 second pause. Next completes it immediately.",
  };
  if (run.recordingState === "paused") return {
    stateLabel: "PAUSED",
    title: task?.label ?? configuration.runTitle,
    detail: "Recording, take time and task countdown are paused. Session time continues.",
  };
  if (run.recordingState === "recording") return {
    stateLabel: "RECORDING",
    title: task?.label ?? configuration.runTitle,
    detail: `Cycle ${run.cycle}, rep ${run.repetition}.`,
  };
  return {
    stateLabel: "ACTIVE",
    title: task?.label ?? configuration.runTitle,
    detail: `Cycle ${run.cycle}/${configuration.totalCycles}, rep ${run.repetition}/${task && isRepetitionTask(task) ? Math.max(1, task.repeatCount) : 1}.`,
  };
}

export function sessionElapsedMs(run: RunProgress, now = Date.now()): number {
  if (run.startedAtMs === null) return 0;
  return Math.max(0, (run.endedAtMs ?? now) - run.startedAtMs);
}

export function takeElapsedMs(run: RunProgress, now = Date.now()): number {
  return Math.max(0, run.takeElapsedMs + (run.takeStartedAtMs === null ? 0 : now - run.takeStartedAtMs));
}

export function recordingElapsedMs(run: RunProgress, now = Date.now()): number {
  return Math.max(0, run.recordingElapsedMs + (run.recordingStartedAtMs === null ? 0 : now - run.recordingStartedAtMs));
}

export function taskRemainingMs(snapshot: SessionSnapshot, now = Date.now()): number | null {
  const { run } = snapshot;
  if (run.status !== "running") return null;
  if (run.resetDeadlineMs !== null) return Math.max(0, run.resetDeadlineMs - now);
  const task = snapshot.configuration.tasks[run.activeTaskIndex];
  if (!task || task.type === "open") return null;
  return Math.max(0, task.durationS * 1_000 - takeElapsedMs(run, now));
}
