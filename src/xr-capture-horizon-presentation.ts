import type {
  XrCaptureHorizonRunControlPresentation,
  XrCaptureHorizonRunIcon,
} from "./xr-capture-horizon-hud.js";
import type {
  XrTaskHudControl,
  XrTaskHudControlAction,
} from "./xr-task-hud.js";

export const XR_CAPTURE_HORIZON_ACTION_PRESENTATION: Readonly<Record<
  XrTaskHudControlAction,
  Readonly<{ label: string; icon: XrCaptureHorizonRunIcon }>
>> = Object.freeze({
  "start-sequence": Object.freeze({ label: "Start", icon: "play" }),
  start: Object.freeze({ label: "Record", icon: "record" }),
  pause: Object.freeze({ label: "Pause", icon: "pause" }),
  stop: Object.freeze({ label: "Stop", icon: "stop" }),
  finish: Object.freeze({ label: "Finish", icon: "stop" }),
  success: Object.freeze({ label: "Pass", icon: "pass" }),
  fail: Object.freeze({ label: "Fail", icon: "fail" }),
  retry: Object.freeze({ label: "Retry", icon: "retry" }),
  resume: Object.freeze({ label: "Resume", icon: "play" }),
  next: Object.freeze({ label: "Next", icon: "next" }),
});

export interface XrCaptureHorizonRunControlContext {
  operatingMode: "paired" | "solo";
  soloStartAvailable: boolean;
}

export const XR_HAND_SPEED_WARNING_PRESENTATION = Object.freeze({
  dangerRatio: .18,
  tapeOpacity: .22,
  pulseIntervalMs: 920,
});

export function xrCaptureHorizonRunControlPresentation(
  control: Readonly<XrTaskHudControl>,
  context: Readonly<XrCaptureHorizonRunControlContext>,
): XrCaptureHorizonRunControlPresentation {
  const soloTaskSelector = context.operatingMode === "solo"
    && control.action === "start-sequence";
  const action = XR_CAPTURE_HORIZON_ACTION_PRESENTATION[control.action];
  return {
    id: control.action,
    label: soloTaskSelector ? "Start run" : action.label,
    icon: action.icon,
    tone: soloTaskSelector ? "primary" : control.tone,
    enabled: soloTaskSelector
      ? context.soloStartAvailable && control.enabled
      : control.enabled,
    selected: control.pressed,
  };
}

export const XR_CAPTURE_HORIZON_UI_CONTRACT = Object.freeze({
  root: "capture-hud-root",
  taskPanel: "capture-task-panel",
  identity: "capture-identity",
  uploadStatus: "capture-upload-status",
  uploadLabel: "capture-upload-label",
  uploadProgress: "capture-upload-progress",
  uploadPercentage: "capture-upload-percentage",
  timing: "capture-task-timing",
  taskState: "capture-task-state",
  taskTitle: "capture-task-title",
  taskDescription: "capture-task-description",
  progressLabel: "progress-0-label",
  progressBar: "progress-0-bar",
  controlPanel: "capture-control-panel",
  runControlPrefix: "run-",
  systemControls: Object.freeze([
    Object.freeze({ id: "capture-menu", label: "Configure" }),
    Object.freeze({ id: "capture-retread", label: "Retread" }),
    Object.freeze({ id: "capture-exit", label: "Exit XR" }),
  ]),
  appearance: Object.freeze([
    Object.freeze({
      key: "handMode",
      id: "hand-handMode",
      labelId: "hand-handMode-label",
      valueId: "hand-handMode-value",
    }),
    Object.freeze({
      key: "handShading",
      id: "hand-handShading",
      labelId: "hand-handShading-label",
      valueId: "hand-handShading-value",
    }),
    Object.freeze({
      key: "handTrail",
      id: "hand-handTrail",
      labelId: "hand-handTrail-label",
      valueId: "hand-handTrail-value",
    }),
  ]),
});
