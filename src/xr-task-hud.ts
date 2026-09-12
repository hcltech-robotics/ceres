import { canvasFont } from "./typography.js";
import { handRenderModes, handShadingModes, handTrailModes, type HandDisplaySettings, type HandMeshStatus } from "../shared/hand-display.js";
import { isRepetitionTask, type Episode, type SessionSnapshot } from "../shared/protocol.js";
import { CYCLE_PAUSE_MS, taskResetDurationMs } from "../shared/run-sequencing.js";
import { colourWithAlpha, semanticColours } from "../shared/semantic-colours.js";
import type { LocalVoiceCommandStatus } from "./local-voice-command.js";
import {
  recordingElapsedMs,
  runControls,
  sessionElapsedMs,
  soloRunStartPresentation,
  takeElapsedMs,
  taskRemainingMs,
  type RunControlAction,
  type RunControlPresentation,
} from "./run-presentation.js";

export type XrTaskHudAnchor = "left" | "above" | "right";

export const XR_TASK_HUD_WIDTH_M = .49;
export const XR_TASK_HUD_HEIGHT_M = .255;
export const XR_TASK_HUD_DISTANCE_M = 1.65;
export const XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M = .066;
export const XR_TASK_HUD_CONTROL_BOTTOM_INSET_M = .020;
export const XR_TASK_HUD_CONTROL_HORIZONTAL_INSET_M = .027;
export const XR_TASK_HUD_CONTROL_GAP_M = .006;
export const XR_TASK_HUD_CONTROL_CENTRE_Y_M = -XR_TASK_HUD_HEIGHT_M / 2
  + XR_TASK_HUD_CONTROL_BOTTOM_INSET_M
  + XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M / 2;
export const XR_TASK_HUD_PANEL_OPACITY = .98;

export const xrCaptureHudColours = Object.freeze({
  panel: colourWithAlpha(semanticColours.onAction, .94),
  panelSoft: colourWithAlpha(semanticColours.onAction, .78),
  panelQuiet: colourWithAlpha(semanticColours.onAction, .42),
  panelBeam: colourWithAlpha(semanticColours.onAction, .72),
  accentStrong: colourWithAlpha(semanticColours.accent, .94),
  accentBorder: colourWithAlpha(semanticColours.accent, .72),
  accentBorderSoft: colourWithAlpha(semanticColours.accent, .48),
  accentHover: colourWithAlpha(semanticColours.accent, .16),
  accentPressed: colourWithAlpha(semanticColours.accent, .72),
  control: colourWithAlpha(semanticColours.onAction, .08),
  controlHover: colourWithAlpha(semanticColours.accent, .16),
  controlSelected: colourWithAlpha(semanticColours.accent, .16),
  controlPressed: colourWithAlpha(semanticColours.action, .50),
  controlDisabled: colourWithAlpha(semanticColours.textMuted, .08),
  information: colourWithAlpha(semanticColours.onAction, .04),
  outline: colourWithAlpha(semanticColours.textSecondary, .24),
  outlineMuted: colourWithAlpha(semanticColours.textSecondary, .12),
  dangerSurface: colourWithAlpha(semanticColours.danger, .12),
  dangerOutline: colourWithAlpha(semanticColours.danger, .82),
  separator: colourWithAlpha(semanticColours.textSecondary, .18),
  label: colourWithAlpha(semanticColours.text, .58),
  textStrong: semanticColours.text,
  textSoft: colourWithAlpha(semanticColours.text, .82),
  textActive: colourWithAlpha(semanticColours.text, .84),
  textDisabled: colourWithAlpha(semanticColours.textDisabled, .46),
  connected: colourWithAlpha(semanticColours.success, .92),
  disconnected: colourWithAlpha(semanticColours.danger, .98),
  recording: semanticColours.danger,
  recordingSoft: colourWithAlpha(semanticColours.danger, .72),
  readySoft: colourWithAlpha(semanticColours.success, .82),
  disabledFill: colourWithAlpha(semanticColours.textDisabled, .36),
  disabledOutline: colourWithAlpha(semanticColours.textDisabled, .28),
  progressTrack: colourWithAlpha(semanticColours.textSecondary, .12),
  action: semanticColours.action,
  success: semanticColours.success,
  warning: semanticColours.warning,
} as const);

export const xrCaptureControlColours: Record<
  RunControlPresentation["tone"],
  Readonly<{ fill: string; outline: string; hover: string }>
> = Object.freeze({
  primary: Object.freeze({
    fill: colourWithAlpha(semanticColours.action, .94),
    outline: colourWithAlpha(semanticColours.action, .98),
    hover: colourWithAlpha(semanticColours.action, .30),
  }),
  success: Object.freeze({
    fill: colourWithAlpha(semanticColours.success, .48),
    outline: colourWithAlpha(semanticColours.success, .98),
    hover: colourWithAlpha(semanticColours.success, .30),
  }),
  danger: Object.freeze({
    fill: colourWithAlpha(semanticColours.danger, .30),
    outline: colourWithAlpha(semanticColours.danger, .98),
    hover: colourWithAlpha(semanticColours.danger, .30),
  }),
  record: Object.freeze({
    fill: colourWithAlpha(semanticColours.danger, .55),
    outline: colourWithAlpha(semanticColours.danger, .98),
    hover: colourWithAlpha(semanticColours.danger, .30),
  }),
  neutral: Object.freeze({
    fill: colourWithAlpha(semanticColours.surfaceInteractive, .90),
    outline: colourWithAlpha(semanticColours.textSecondary, .92),
    hover: colourWithAlpha(semanticColours.textSecondary, .30),
  }),
});

export const XR_CAPTURE_CONTROL_PRESSED = colourWithAlpha(semanticColours.action, .50);

export interface XrTaskHudControlBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
  centreX: number;
  centreY: number;
}

export const xrTaskHudControlBounds = (
  controlCount: number,
): ReadonlyArray<Readonly<XrTaskHudControlBounds>> => {
  if (!Number.isSafeInteger(controlCount) || controlCount < 1) return [];
  const controlWidth = (
    XR_TASK_HUD_WIDTH_M
    - XR_TASK_HUD_CONTROL_HORIZONTAL_INSET_M * 2
    - XR_TASK_HUD_CONTROL_GAP_M * (controlCount - 1)
  ) / controlCount;
  if (controlWidth <= 0) return [];
  const bottom = -XR_TASK_HUD_HEIGHT_M / 2 + XR_TASK_HUD_CONTROL_BOTTOM_INSET_M;
  const top = bottom + XR_TASK_HUD_CONTROL_TARGET_HEIGHT_M;
  return Array.from({ length: controlCount }, (_, index) => {
    const left = -XR_TASK_HUD_WIDTH_M / 2
      + XR_TASK_HUD_CONTROL_HORIZONTAL_INSET_M
      + index * (controlWidth + XR_TASK_HUD_CONTROL_GAP_M);
    return {
      left,
      right: left + controlWidth,
      bottom,
      top,
      centreX: left + controlWidth / 2,
      centreY: XR_TASK_HUD_CONTROL_CENTRE_Y_M,
    };
  });
};

export const xrTaskHudControlIndexAtPoint = (
  localX: number,
  localY: number,
  controlCount: number,
): number | null => {
  const index = xrTaskHudControlBounds(controlCount).findIndex(
    ({ left, right, bottom, top }) => (
      localX >= left
      && localX <= right
      && localY >= bottom
      && localY <= top
    ),
  );
  return index >= 0 ? index : null;
};

export const XR_HAND_DISPLAY_HUD_WIDTH_M = .39;
export const XR_HAND_DISPLAY_HUD_HEIGHT_M = .076;
export const XR_HAND_DISPLAY_HUD_POSITION = Object.freeze({ x: .53, y: -.37, z: -1.02 });
export const XR_HAND_DISPLAY_HUD_IDLE_OPACITY = .24;
export const XR_HAND_DISPLAY_HUD_HOVER_OPACITY = .72;
export const XR_HAND_DISPLAY_HUD_PRESS_OPACITY = .94;

export const XR_EXIT_HUD_DIAMETER_M = .076;
export const XR_EXIT_HUD_POSITION = Object.freeze({ x: -.53, y: -.37, z: -1.02 });

export const XR_PROGRESS_RETICLE_RADIUS = 48;
export const XR_PROGRESS_RETICLE_INNER_RADIUS = 41;
export const XR_PROGRESS_RETICLE_OUTER_RADIUS = 55;
export const XR_CAMERA_EDGES_FULL_MS = 1_800;
export const XR_CAMERA_EDGES_SETTLE_MS = 700;
export const XR_CAMERA_EDGES_CANVAS_SIZE = 1_536;
export const XR_CAMERA_EDGES_PLANE_SIZE_M = 1.2;
export const XR_CAMERA_EDGES_DISTANCE_M = 1.05;
export const XR_CAPTURE_CENTRE_Y_M = -.18;
export const XR_TRACKING_ALERT_POSITION = Object.freeze({ x: 0, y: -.30, z: -.98 });
export const XR_TRACKING_ALERT_WIDTH_M = .68;
export const XR_TRACKING_ALERT_HEIGHT_M = .065;

export const xrTrackingAlertPresentation = (sequenceStarted: boolean) => ({
  squareTape: true,
  tapeOpacity: sequenceStarted ? .76 : .62,
  dangerRatio: 1,
  pulseIntervalMs: 260,
});

export type XrHandDisplayControlKey = keyof HandDisplaySettings;

export const XR_HAND_DISPLAY_CONTROLS: ReadonlyArray<Readonly<{
  key: XrHandDisplayControlKey;
  label: string;
}>> = [
  { key: "handMode", label: "MESH" },
  { key: "handShading", label: "SHADE" },
  { key: "handTrail", label: "TRAIL" },
];

const handDisplayModes: Record<XrHandDisplayControlKey, readonly string[]> = {
  handMode: handRenderModes,
  handShading: handShadingModes,
  handTrail: handTrailModes,
};

export const cycleXrHandDisplaySetting = (
  settings: HandDisplaySettings,
  key: XrHandDisplayControlKey,
): HandDisplaySettings => {
  const modes = handDisplayModes[key];
  const currentIndex = modes.indexOf(settings[key]);
  return { ...settings, [key]: modes[(currentIndex + 1) % modes.length] };
};

export const xrHandDisplayValue = (
  settings: HandDisplaySettings,
  key: XrHandDisplayControlKey,
  meshStatus: HandMeshStatus,
) => key === "handMode" && settings.handMode === "mesh" && meshStatus === "outline-fallback"
  ? "OUTLINE FALLBACK"
  : settings[key] === "keypoints" ? "POINTS" : settings[key].toUpperCase();

export const xrHandDisplayControlAtLocalX = (localX: number): XrHandDisplayControlKey | null => {
  if (localX < -XR_HAND_DISPLAY_HUD_WIDTH_M / 2 || localX > XR_HAND_DISPLAY_HUD_WIDTH_M / 2) return null;
  const normalised = localX / XR_HAND_DISPLAY_HUD_WIDTH_M + .5;
  const index = Math.min(XR_HAND_DISPLAY_CONTROLS.length - 1, Math.floor(normalised * XR_HAND_DISPLAY_CONTROLS.length));
  return XR_HAND_DISPLAY_CONTROLS[index]?.key ?? null;
};

export const xrHandDisplayHudOpacity = (hovered: boolean, pressed: boolean) => pressed
  ? XR_HAND_DISPLAY_HUD_PRESS_OPACITY
  : hovered ? XR_HAND_DISPLAY_HUD_HOVER_OPACITY : XR_HAND_DISPLAY_HUD_IDLE_OPACITY;

export type XrHudPressEvent<T> =
  | { type: "press"; action: T; enabled: boolean }
  | { type: "release" }
  | { type: "cancel" };

export type XrHudPressTransition<T> = Readonly<{
  pressed: T | null;
  committed: T | null;
}>;

export const advanceXrHudPress = <T>(
  pressed: T | null,
  event: XrHudPressEvent<T>,
): XrHudPressTransition<T> => {
  if (event.type === "press") {
    return {
      pressed: pressed ?? (event.enabled ? event.action : null),
      committed: null,
    };
  }
  if (event.type === "release") return { pressed: null, committed: pressed };
  return { pressed: null, committed: null };
};

export const XR_TASK_HUD_ANCHORS: Record<XrTaskHudAnchor, Readonly<{ x: number; y: number; z: number }>> = {
  left: { x: -.40, y: .015, z: -XR_TASK_HUD_DISTANCE_M },
  above: { x: 0, y: .28, z: -XR_TASK_HUD_DISTANCE_M },
  right: { x: .40, y: .015, z: -XR_TASK_HUD_DISTANCE_M },
};

export const isXrTaskHudAnchor = (value: unknown): value is XrTaskHudAnchor =>
  value === "left" || value === "above" || value === "right";

export const nearestXrTaskHudAnchor = (x: number, y: number): XrTaskHudAnchor => {
  let nearest: XrTaskHudAnchor = "above";
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of ["left", "above", "right"] as const) {
    const position = XR_TASK_HUD_ANCHORS[anchor];
    const distance = (x - position.x) ** 2 + (y - position.y) ** 2;
    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }
  return nearest;
};

export const clampXrTaskHudDragPosition = (x: number, y: number) => ({
  x: Math.min(XR_TASK_HUD_ANCHORS.right.x, Math.max(XR_TASK_HUD_ANCHORS.left.x, x)),
  y: Math.min(XR_TASK_HUD_ANCHORS.above.y, Math.max(XR_TASK_HUD_ANCHORS.left.y, y)),
  z: -XR_TASK_HUD_DISTANCE_M,
});

export const xrTaskProgress = (elapsedMs: number, durationMs: number | null) => durationMs && durationMs > 0
  ? Math.min(1, Math.max(0, elapsedMs / durationMs))
  : null;

export interface XrTaskHudTiming {
  leftMs: number | null;
  sessionMs: number;
  takeMs: number;
  recordingMs: number;
  taskProgress: number | null;
}

export const xrTaskHudTiming = (snapshot: SessionSnapshot, now = Date.now()): XrTaskHudTiming => {
  const task = snapshot.configuration.tasks[snapshot.run.activeTaskIndex];
  const durationMs = task?.type === "timed" ? task.durationS * 1_000 : null;
  const takeMs = takeElapsedMs(snapshot.run, now);
  return {
    leftMs: taskRemainingMs(snapshot, now),
    sessionMs: sessionElapsedMs(snapshot.run, now),
    takeMs,
    recordingMs: recordingElapsedMs(snapshot.run, now),
    taskProgress: xrTaskProgress(takeMs, durationMs),
  };
};

export type XrTaskHudSemanticTone = "muted" | "action" | "warning" | "danger";
export type XrTaskHudCentreLineRole = "state" | "timing" | "metrics";

export interface XrTaskHudCentreLine {
  text: string;
  role: XrTaskHudCentreLineRole;
  tone: XrTaskHudSemanticTone;
}

export interface XrTaskHudRunPresentation {
  state: "open" | "timed" | "pause";
  metrics: string;
  timing: string;
  timingTone: XrTaskHudSemanticTone;
  taskProgress: number | null;
  runProgress: number;
  centreLines: readonly XrTaskHudCentreLine[];
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const formatXrTaskHudClock = (durationMs: number, round: "elapsed" | "remaining") => {
  const secondsValue = Math.max(0, durationMs) / 1_000;
  const totalSeconds = round === "remaining"
    ? Math.ceil(secondsValue)
    : Math.floor(secondsValue);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const formatXrTaskHudElapsed = (elapsedMs: number) =>
  formatXrTaskHudClock(elapsedMs, "elapsed");

export const formatXrTaskHudRemaining = (remainingMs: number) =>
  `-${formatXrTaskHudClock(remainingMs, "remaining")}`;

const xrTaskHudPauseDurationMs = (snapshot: SessionSnapshot) => {
  const { run } = snapshot;
  const task = snapshot.configuration.tasks[run.activeTaskIndex];
  if (run.phase === "cycle-pause") return CYCLE_PAUSE_MS;
  if (run.phase === "task-pause" && task?.type === "pause") return task.durationS * 1_000;
  if (run.phase === "post-task-pause" && task && isRepetitionTask(task)) {
    return taskResetDurationMs(task.resetTimeS);
  }
  return null;
};

const xrTaskHudPauseProgress = (snapshot: SessionSnapshot, now: number) => {
  const durationMs = xrTaskHudPauseDurationMs(snapshot);
  const deadlineMs = snapshot.run.resetDeadlineMs;
  if (!durationMs || deadlineMs === null) return 0;
  return clampUnit(1 - Math.max(0, deadlineMs - now) / durationMs);
};

export const xrTaskHudRunProgress = (snapshot: SessionSnapshot, now = Date.now()) => {
  const { configuration, run } = snapshot;
  const totalCycles = Math.max(1, configuration.totalCycles ?? 1);
  if (run.status === "complete") return 1;
  if (run.status === "stopped") return 0;
  const completedCycles = Math.min(totalCycles - 1, Math.max(0, run.cycle - 1));
  if (configuration.tasks.length === 0) return completedCycles / totalCycles;
  if (run.phase === "cycle-pause") return clampUnit(run.cycle / totalCycles);

  const taskIndex = Math.min(
    configuration.tasks.length - 1,
    Math.max(0, run.activeTaskIndex),
  );
  const task = configuration.tasks[taskIndex];
  let currentTaskProgress = 0;
  if (task && isRepetitionTask(task)) {
    const repeatCount = Math.max(1, task.repeatCount);
    const completedRepetitions = Math.min(
      repeatCount - 1,
      Math.max(0, run.repetition - 1),
    );
    const repetitionProgress = run.phase === "post-task-pause"
      ? 1
      : task.type === "timed"
        ? xrTaskProgress(takeElapsedMs(run, now), task.durationS * 1_000) ?? 0
        : 0;
    currentTaskProgress = (completedRepetitions + repetitionProgress) / repeatCount;
  } else if (task?.type === "pause" && run.phase === "task-pause") {
    currentTaskProgress = xrTaskHudPauseProgress(snapshot, now);
  }

  const cycleProgress = (taskIndex + currentTaskProgress) / configuration.tasks.length;
  return clampUnit((completedCycles + cycleProgress) / totalCycles);
};

export const xrTaskHudRunPresentation = (
  snapshot: SessionSnapshot,
  now = Date.now(),
): XrTaskHudRunPresentation | null => {
  const { configuration, run } = snapshot;
  if (run.status !== "running" || run.phase === null || configuration.tasks.length === 0) return null;
  const totalCycles = Math.max(1, configuration.totalCycles ?? 1);
  const cycle = Math.min(totalCycles, Math.max(1, run.cycle));
  const taskIndex = Math.min(
    configuration.tasks.length - 1,
    Math.max(0, run.activeTaskIndex),
  );
  const task = configuration.tasks[taskIndex];
  const taskNumber = Math.min(configuration.tasks.length, taskIndex + 1);
  const runProgress = xrTaskHudRunProgress(snapshot, now);
  const sequencePaused = run.phase === "post-task-pause"
    || run.phase === "task-pause"
    || run.phase === "cycle-pause";

  if (sequencePaused) {
    const remainingMs = run.resetDeadlineMs === null
      ? xrTaskHudPauseDurationMs(snapshot) ?? 0
      : Math.max(0, run.resetDeadlineMs - now);
    const repetitionMetrics = run.phase === "post-task-pause" && task && isRepetitionTask(task)
      ? ` R${Math.min(Math.max(1, run.repetition), Math.max(1, task.repeatCount))}/${Math.max(1, task.repeatCount)}`
      : "";
    const metrics = `C${cycle}/${totalCycles} PAUSE T${taskNumber}/${configuration.tasks.length}${repetitionMetrics}`;
    const timing = formatXrTaskHudRemaining(remainingMs);
    return {
      state: "pause",
      metrics,
      timing,
      timingTone: "warning",
      taskProgress: run.phase === "cycle-pause"
        ? 1
        : run.phase === "post-task-pause"
          ? 1
          : xrTaskHudPauseProgress(snapshot, now),
      runProgress,
      centreLines: [
        { text: metrics, role: "metrics", tone: "warning" },
        { text: timing, role: "timing", tone: "warning" },
      ],
    };
  }

  if (!task || !isRepetitionTask(task)) return null;
  const repeatCount = Math.max(1, task.repeatCount);
  const repetition = Math.min(repeatCount, Math.max(1, run.repetition));
  const metrics = `C${cycle}/${totalCycles} T${taskNumber}/${configuration.tasks.length} R${repetition}/${repeatCount}`;
  const takeMs = takeElapsedMs(run, now);
  if (task.type === "open") {
    const timing = formatXrTaskHudElapsed(takeMs);
    return {
      state: "open",
      metrics,
      timing,
      timingTone: "muted",
      taskProgress: null,
      runProgress,
      centreLines: [
        { text: "OPEN", role: "state", tone: "action" },
        { text: timing, role: "timing", tone: "muted" },
        { text: metrics, role: "metrics", tone: "muted" },
      ],
    };
  }

  const durationMs = task.durationS * 1_000;
  const remainingMs = Math.max(0, durationMs - takeMs);
  const timing = formatXrTaskHudRemaining(remainingMs);
  const timingTone: XrTaskHudSemanticTone = remainingMs <= durationMs * .1
    ? "danger"
    : "muted";
  return {
    state: "timed",
    metrics,
    timing,
    timingTone,
    taskProgress: xrTaskProgress(takeMs, durationMs),
    runProgress,
    centreLines: [
      { text: timing, role: "timing", tone: timingTone },
      { text: metrics, role: "metrics", tone: "muted" },
    ],
  };
};

export const xrTaskHudChangeSignature = (snapshot: SessionSnapshot) => {
  const task = snapshot.configuration.tasks[snapshot.run.activeTaskIndex];
  if (!task) return "";
  return [
    task.id,
    snapshot.run.activeTaskIndex,
    snapshot.run.cycle,
    snapshot.run.repetition,
    snapshot.solo?.selectedStartTaskId ?? "",
    snapshot.solo?.startCountdownDeadlineMs ?? "",
  ].join("\u0000");
};

export const xrCompletedTaskLabel = (previous: SessionSnapshot | null, next: SessionSnapshot) => {
  if (!previous || previous.run.status !== "running" || previous.run.phase !== "active-task") return null;
  const advanced = next.run.cycle !== previous.run.cycle
    || next.run.activeTaskIndex !== previous.run.activeTaskIndex
    || next.run.repetition !== previous.run.repetition
    || next.run.phase !== previous.run.phase;
  if (!advanced) return null;
  return previous.configuration.tasks[previous.run.activeTaskIndex]?.label ?? null;
};

export const xrHandSpeedAlertLabel = (leftWarning: boolean, rightWarning: boolean) => leftWarning && rightWarning
  ? "HANDS TOO FAST"
  : leftWarning
    ? "LEFT HAND TOO FAST"
    : rightWarning
      ? "RIGHT HAND TOO FAST"
      : null;

export type XrTaskHudControlAction = RunControlAction;
export type XrTaskHudControl = Omit<RunControlPresentation, "action" | "slot"> & {
  action: XrTaskHudControlAction;
  slot: RunControlPresentation["slot"];
};

const xrTaskHudReviewEpisode = (snapshot: SessionSnapshot | null | undefined) => {
  const reviewEpisodeId = snapshot?.run.reviewEpisodeId;
  if (!snapshot || snapshot.run.phase !== "post-task-pause" || !reviewEpisodeId) return null;
  if (snapshot.currentEpisode?.id === reviewEpisodeId) return snapshot.currentEpisode;
  if (snapshot.pendingEpisode?.id === reviewEpisodeId) return snapshot.pendingEpisode;
  return snapshot.episodes?.find(({ id }) => id === reviewEpisodeId)
    ?? snapshot.attempts?.find(({ id }) => id === reviewEpisodeId)
    ?? null;
};

const xrTaskHudEpisodeAnnotation = (episode: Episode | null): "pass" | "fail" | null => {
  if (!episode) return null;
  const latestSegment = episode.segments?.at(-1);
  if (latestSegment) {
    const latestSegmentAction = latestSegment.annotations.at(-1)?.action;
    return latestSegmentAction === "pass" || latestSegmentAction === "fail"
      ? latestSegmentAction
      : null;
  }
  return episode.annotation === "pass" || episode.annotation === "fail"
    ? episode.annotation
    : null;
};

export const xrTaskHudReviewAnnotation = (
  snapshot: SessionSnapshot | null | undefined,
): "pass" | "fail" | null => xrTaskHudEpisodeAnnotation(xrTaskHudReviewEpisode(snapshot));

export const xrTaskHudControls = (snapshot: Parameters<typeof runControls>[0], connected = true) => {
  const reviewEpisode = xrTaskHudReviewEpisode(snapshot);
  const annotation = xrTaskHudEpisodeAnnotation(reviewEpisode);
  const reviewAvailable = reviewEpisode !== null;
  const controls: RunControlPresentation[] = runControls(
    snapshot,
    connected,
    snapshot?.operatingMode === "solo" ? "solo" : "demonstrator",
  ).map((control) => {
    if (control.slot !== "pass" && control.slot !== "fail") return control;
    const selected = control.slot === annotation;
    return {
      ...control,
      enabled: control.enabled && reviewAvailable,
      pressed: selected,
      state: selected ? "latched" : "idle",
    };
  });
  if (snapshot?.run.status === "stopped") {
    return controls.filter((control) => control.slot === "run");
  }
  if (snapshot?.run.status !== "running") return [];
  if (snapshot.run.phase === "active-task") {
    const order = ["record", "retry", "next", "run"] as const;
    return order.flatMap((slot) => controls.filter((control) => control.slot === slot));
  }
  if (snapshot.run.phase === "post-task-pause") {
    const order = ["pass", "fail", "retry", "next", "run"] as const;
    return order.flatMap((slot) => controls.filter((control) => control.slot === slot));
  }
  if (snapshot.run.phase === "task-pause" || snapshot.run.phase === "cycle-pause") {
    const order = ["next", "run"] as const;
    return order.flatMap((slot) => controls.filter((control) => control.slot === slot));
  }
  return [];
};

export interface XrTaskHudReadinessPresentation {
  label: string;
  detail: string;
  ready: boolean;
}

export interface XrSoloStartPresentation {
  label: string;
  detail: string;
  selectedStartTaskId: string | null;
  remainingMs: number | null;
  recording: boolean;
}

export const xrSoloStartPresentation = (
  snapshot: SessionSnapshot,
  now = Date.now(),
): XrSoloStartPresentation | null => {
  const presentation = soloRunStartPresentation(snapshot, now);
  if (!presentation) return null;
  if (presentation.state === "awaiting-hands") return {
    label: "SHOW BOTH HANDS",
    detail: "Put the controllers down",
    selectedStartTaskId: presentation.selectedStartTaskId,
    remainingMs: null,
    recording: false,
  };
  if (presentation.state === "countdown") return {
    label: String(presentation.countdownValue),
    detail: "Hold position",
    selectedStartTaskId: presentation.selectedStartTaskId,
    remainingMs: presentation.remainingMs,
    recording: false,
  };
  if (presentation.state === "arming") return {
    label: "ARMING",
    detail: "Hold position",
    selectedStartTaskId: presentation.selectedStartTaskId,
    remainingMs: null,
    recording: false,
  };
  if (presentation.state === "recording") return {
    label: "REC",
    detail: "GO",
    selectedStartTaskId: presentation.selectedStartTaskId,
    remainingMs: null,
    recording: true,
  };
  return {
    label: presentation.state === "select-task" ? "SELECT TASK" : "ACTIVE",
    detail: presentation.state === "select-task" ? "Choose a runnable task" : "Solo run active",
    selectedStartTaskId: presentation.selectedStartTaskId,
    remainingMs: null,
    recording: false,
  };
};

export const xrTaskHudReadinessPresentation = (
  snapshot: Parameters<typeof runControls>[0],
  connected = true,
): XrTaskHudReadinessPresentation => {
  if (snapshot?.operatingMode === "solo") {
    const presentation = xrSoloStartPresentation(snapshot);
    return {
      label: presentation?.label ?? "NOT READY",
      detail: presentation?.detail ?? "Choose a runnable task",
      ready: presentation?.recording === true
        || presentation?.label === "ARMING"
        || /^\d+$/.test(presentation?.label ?? ""),
    };
  }
  const directorReady = connected && snapshot?.run.directorReady === true;
  const demonstratorReady = connected && snapshot?.run.demonstratorReady === true;
  return {
    label: demonstratorReady ? "READY" : "NOT READY",
    detail: !directorReady ? "Waiting for director" : !demonstratorReady ? "Waiting for you" : "Starting capture",
    ready: demonstratorReady,
  };
};

export type XrCameraEdgesPhase = "full" | "settling" | "corners";

export interface XrCameraEdgesPresentation {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cornerRadius: number;
  cornerLength: number;
  middleOpacity: number;
  phase: XrCameraEdgesPhase;
}

export type XrCameraVoiceIndicatorState = "active" | "standby" | "unavailable";

export const xrCameraVoiceIndicatorState = (
  runtimeFeaturesLoaded: boolean,
  recognitionEnabled: boolean,
  status: LocalVoiceCommandStatus,
): XrCameraVoiceIndicatorState => {
  if (!runtimeFeaturesLoaded || status === "loading") return "standby";
  if (!recognitionEnabled || status === "error") return "unavailable";
  return "active";
};

export interface XrCameraEdgeIndicatorPresentation {
  recording: boolean;
  voice: XrCameraVoiceIndicatorState;
  uploading: boolean;
}

export interface XrCameraEdgeIndicatorLayout {
  recordingDotX: number;
  recordingTextX: number;
  centreY: number;
  uploadX: number;
  voiceX: number;
}

export const xrCameraEdgeIndicatorLayout = (
  presentation: XrCameraEdgesPresentation,
): XrCameraEdgeIndicatorLayout => {
  const inset = Math.min(48, Math.max(34, (presentation.bottom - presentation.top) * .045));
  const centreY = presentation.top + inset;
  return {
    recordingDotX: presentation.left + inset,
    recordingTextX: presentation.left + inset + 24,
    centreY,
    uploadX: presentation.right - inset - 58,
    voiceX: presentation.right - inset,
  };
};

export const xrCameraEdgesPresentation = (
  width: number,
  height: number,
  cameraAspectRatio: number,
  elapsedMs: number,
  reducedMotion = false,
): XrCameraEdgesPresentation => {
  const aspectRatio = Number.isFinite(cameraAspectRatio) && cameraAspectRatio > 0
    ? cameraAspectRatio
    : 1;
  const maxWidth = width * .78;
  const maxHeight = height * .80;
  const frameWidth = Math.min(maxWidth, maxHeight * aspectRatio);
  const frameHeight = frameWidth / aspectRatio;
  const left = (width - frameWidth) / 2;
  const top = (height - frameHeight) / 2;
  const shortestEdge = Math.min(frameWidth, frameHeight);
  const cornerRadius = Math.min(20, Math.max(12, shortestEdge * .04));
  const cornerLength = Math.min(96, Math.max(cornerRadius * 2.4, shortestEdge * .18));
  const settleElapsed = Math.max(0, elapsedMs - XR_CAMERA_EDGES_FULL_MS);
  const settleProgress = reducedMotion
    ? settleElapsed > 0 ? 1 : 0
    : clampUnit(settleElapsed / XR_CAMERA_EDGES_SETTLE_MS);
  const easedProgress = settleProgress * settleProgress * (3 - 2 * settleProgress);
  return {
    left,
    top,
    right: left + frameWidth,
    bottom: top + frameHeight,
    cornerRadius,
    cornerLength,
    middleOpacity: 1 - easedProgress,
    phase: settleProgress <= 0 ? "full" : settleProgress < 1 ? "settling" : "corners",
  };
};

export const drawXrCameraEdges = (
  context: CanvasRenderingContext2D,
  presentation: XrCameraEdgesPresentation,
) => {
  const {
    left,
    top,
    right,
    bottom,
    cornerRadius,
    cornerLength,
    middleOpacity,
  } = presentation;
  context.save();
  context.strokeStyle = colourWithAlpha(semanticColours.text, .52);
  context.lineWidth = 3;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(left + cornerLength, top);
  context.lineTo(left + cornerRadius, top);
  context.arcTo(left, top, left, top + cornerRadius, cornerRadius);
  context.lineTo(left, top + cornerLength);
  context.moveTo(right - cornerLength, top);
  context.lineTo(right - cornerRadius, top);
  context.arcTo(right, top, right, top + cornerRadius, cornerRadius);
  context.lineTo(right, top + cornerLength);
  context.moveTo(right, bottom - cornerLength);
  context.lineTo(right, bottom - cornerRadius);
  context.arcTo(right, bottom, right - cornerRadius, bottom, cornerRadius);
  context.lineTo(right - cornerLength, bottom);
  context.moveTo(left + cornerLength, bottom);
  context.lineTo(left + cornerRadius, bottom);
  context.arcTo(left, bottom, left, bottom - cornerRadius, cornerRadius);
  context.lineTo(left, bottom - cornerLength);
  context.stroke();

  if (middleOpacity > .001) {
    context.save();
    context.globalAlpha *= middleOpacity;
    context.beginPath();
    context.moveTo(left + cornerLength, top);
    context.lineTo(right - cornerLength, top);
    context.moveTo(right, top + cornerLength);
    context.lineTo(right, bottom - cornerLength);
    context.moveTo(right - cornerLength, bottom);
    context.lineTo(left + cornerLength, bottom);
    context.moveTo(left, bottom - cornerLength);
    context.lineTo(left, top + cornerLength);
    context.stroke();
    context.restore();
  }
  context.restore();
};

export const drawXrCameraEdgeIndicators = (
  context: CanvasRenderingContext2D,
  frame: XrCameraEdgesPresentation,
  presentation: XrCameraEdgeIndicatorPresentation,
) => {
  const layout = xrCameraEdgeIndicatorLayout(frame);
  const iconStroke = (
    colour: string,
    draw: () => void,
  ) => {
    context.save();
    context.strokeStyle = colour;
    context.lineWidth = 4;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    draw();
    context.stroke();
    context.restore();
  };

  context.save();
  if (presentation.recording) {
    context.fillStyle = colourWithAlpha(semanticColours.danger, .98);
    context.beginPath();
    context.arc(layout.recordingDotX, layout.centreY, 9, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = colourWithAlpha(semanticColours.text, .94);
    context.font = canvasFont("body", 700);
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText("REC", layout.recordingTextX, layout.centreY + 1);
  }

  iconStroke(
    presentation.uploading
      ? colourWithAlpha(semanticColours.action, .96)
      : colourWithAlpha(semanticColours.text, .46),
    () => {
      const x = layout.uploadX;
      const y = layout.centreY;
      context.moveTo(x, y + 7);
      context.lineTo(x, y - 13);
      context.moveTo(x - 8, y - 5);
      context.lineTo(x, y - 13);
      context.lineTo(x + 8, y - 5);
      context.moveTo(x - 13, y + 7);
      context.lineTo(x - 13, y + 14);
      context.lineTo(x + 13, y + 14);
      context.lineTo(x + 13, y + 7);
    },
  );

  const voiceColour = presentation.voice === "active"
    ? colourWithAlpha(semanticColours.success, .94)
    : presentation.voice === "unavailable"
      ? colourWithAlpha(semanticColours.danger, .92)
      : colourWithAlpha(semanticColours.text, .46);
  iconStroke(voiceColour, () => {
    const x = layout.voiceX;
    const y = layout.centreY;
    for (const [offset, height] of [[-10, 12], [-3, 24], [4, 30], [11, 18]] as const) {
      context.moveTo(x + offset, y - height / 2);
      context.lineTo(x + offset, y + height / 2);
    }
    if (presentation.voice !== "active") {
      context.moveTo(x - 15, y - 15);
      context.lineTo(x + 16, y + 16);
    }
  });
  context.restore();
};

export const drawXrReticle = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  recording: boolean,
) => {
  const insetX = 120;
  const top = 142;
  const bottom = height - 82;
  const length = 48;
  context.save();
  context.strokeStyle = colourWithAlpha(semanticColours.text, .60);
  context.lineWidth = 3;
  context.shadowColor = colourWithAlpha(semanticColours.success, .34);
  context.shadowBlur = 12;
  const corner = (x: number, y: number, horizontal: number, vertical: number) => {
    context.beginPath();
    context.moveTo(x + horizontal * length, y);
    context.lineTo(x, y);
    context.lineTo(x, y + vertical * length);
    context.stroke();
  };
  corner(insetX, top, 1, 1);
  corner(width - insetX, top, -1, 1);
  corner(insetX, bottom, 1, -1);
  corner(width - insetX, bottom, -1, -1);
  if (recording) {
    context.shadowColor = colourWithAlpha(semanticColours.danger, .52);
    context.shadowBlur = 14;
    context.fillStyle = colourWithAlpha(semanticColours.danger, .98);
    context.beginPath();
    context.arc(insetX + 26, top + 27, 9, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.fillStyle = colourWithAlpha(semanticColours.text, .92);
    context.font = canvasFont("label");
    context.textAlign = "left";
    context.fillText("REC", insetX + 44, top + 34);
  }
  context.restore();
};

export const drawXrBridgeAttitude = (
  context: CanvasRenderingContext2D,
  frame: XrCameraEdgesPresentation,
  width: number,
  height: number,
  pitch: number,
  roll: number,
) => {
  context.save();
  context.beginPath();
  context.rect(frame.left + 4, frame.top + 4, frame.right - frame.left - 8, frame.bottom - frame.top - 8);
  context.clip();
  context.translate(width / 2, height / 2 + XR_CAPTURE_CENTRE_Y_M * height / XR_CAMERA_EDGES_PLANE_SIZE_M);
  context.rotate(roll);
  const focal = height * XR_CAMERA_EDGES_DISTANCE_M / XR_CAMERA_EDGES_PLANE_SIZE_M;
  context.strokeStyle = colourWithAlpha(semanticColours.text, .5);
  context.fillStyle = colourWithAlpha(semanticColours.text, .5);
  context.lineWidth = 1.5;
  context.font = canvasFont("label", 500);
  context.textBaseline = "middle";
  for (let degrees = -80; degrees <= 80; degrees += 10) {
    const offset = pitch - degrees * Math.PI / 180;
    if (Math.abs(offset) > Math.PI * .44) continue;
    const y = focal * Math.tan(offset);
    const span = degrees === 0 ? width : 64;
    context.setLineDash(degrees < 0 ? [8, 6] : []);
    context.beginPath();
    context.moveTo(-span, y);
    context.lineTo(-25, y);
    context.moveTo(25, y);
    context.lineTo(span, y);
    context.stroke();
    if (degrees !== 0) {
      context.textAlign = "right";
      context.fillText(String(degrees), -76, y);
      context.textAlign = "left";
      context.fillText(String(degrees), 76, y);
    }
  }
  context.restore();
};

export const drawXrBridgeReticle = (
  context: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  videoFps: number,
  motionFps: number,
  connected: boolean,
  receiver: string,
  paused = false,
  minimal = false,
) => {
  context.lineWidth = 3;
  context.strokeStyle = colourWithAlpha(semanticColours.text, .52);
  context.beginPath();
  context.arc(centreX, centreY, XR_PROGRESS_RETICLE_RADIUS, 0, Math.PI * 2);
  context.stroke();
  if (minimal) return;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = colourWithAlpha(semanticColours.text, .62);
  context.font = canvasFont("body", 620);
  context.fillText(`${Math.round(videoFps)}`, centreX - 76, centreY - 86);
  context.fillText(`${Math.round(motionFps)}`, centreX + 76, centreY - 86);
  context.fillStyle = colourWithAlpha(semanticColours.text, .32);
  context.font = canvasFont("label", 500);
  context.fillText("VIDEO FPS", centreX - 76, centreY - 115);
  context.fillText("MOTION FPS", centreX + 76, centreY - 115);
  context.fillText(paused ? "PAUSED" : connected ? "CONNECTED" : "CONNECTING", centreX, centreY + 87);
  context.fillText(receiver, centreX, centreY + 117, 360);
};

export const drawXrProgressReticle = (
  context: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  taskProgress: number,
  workProgress: number,
  centreLines: readonly XrTaskHudCentreLine[] = [],
) => {
  context.lineWidth = 3;
  context.strokeStyle = colourWithAlpha(semanticColours.text, .52);
  context.beginPath();
  context.arc(centreX, centreY, XR_PROGRESS_RETICLE_RADIUS, 0, Math.PI * 2);
  context.stroke();
  context.lineCap = "round";
  context.lineWidth = 5;
  context.strokeStyle = semanticColours.warning;
  context.beginPath();
  context.arc(
    centreX,
    centreY,
    XR_PROGRESS_RETICLE_INNER_RADIUS,
    -Math.PI / 2,
    -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, taskProgress)),
    false,
  );
  context.stroke();
  context.strokeStyle = semanticColours.accent;
  context.beginPath();
  context.arc(
    centreX,
    centreY,
    XR_PROGRESS_RETICLE_OUTER_RADIUS,
    -Math.PI / 2,
    -Math.PI / 2 - Math.PI * 2 * Math.max(0, Math.min(1, workProgress)),
    true,
  );
  context.stroke();
  if (centreLines.length === 0) return;

  const lineHeight = 28;
  const firstLineY = centreY + 88;
  context.textAlign = "center";
  context.textBaseline = "middle";
  centreLines.forEach((line, index) => {
    context.fillStyle = line.tone === "danger"
      ? semanticColours.danger
      : line.tone === "warning"
        ? semanticColours.warning
        : line.tone === "action"
          ? semanticColours.action
          : semanticColours.textSecondary;
    context.font = line.role === "timing"
      ? canvasFont("body", 720)
      : canvasFont("label", line.role === "state" ? 720 : 620);
    context.fillText(line.text, centreX, firstLineY + index * lineHeight);
  });
};
