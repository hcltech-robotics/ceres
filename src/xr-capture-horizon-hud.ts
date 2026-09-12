import {
  PokeInteractable,
  RayInteractable,
} from "@iwsdk/core/dist/input/state-tags.js";
import { PanelDocument, PanelUI } from "@iwsdk/core/dist/ui/ui.js";
import { theme } from "@pmndrs/uikit-horizon";
import { Group } from "three";
import type { HandDisplaySettings } from "../shared/hand-display.js";
import { colourWithAlpha, semanticColours } from "../shared/semantic-colours.js";
import {
  XR_CAMERA_EDGES_DISTANCE_M,
  XR_CAMERA_EDGES_CANVAS_SIZE,
  XR_CAMERA_EDGES_PLANE_SIZE_M,
  XR_CAPTURE_CENTRE_Y_M,
  type XrCameraEdgesPresentation,
} from "./xr-task-hud.js";

export const XR_CAPTURE_HORIZON_HUD_WIDTH_M = 1.62;
export const XR_CAPTURE_HORIZON_HUD_HEIGHT_M = 0.28;
export const XR_CAPTURE_HORIZON_HUD_DISTANCE_M = 1.28;
export const XR_CAPTURE_HORIZON_HUD_VERTICAL_OFFSET_M = 0.38;
export const XR_CAPTURE_HORIZON_HUD_TILT_RAD = .35;
export const XR_CAPTURE_HORIZON_HUD_MIN_TARGET_M = 0.064;
export const XR_CAPTURE_HORIZON_HUD_CONFIG = "/ui/capture-hud.json";

export const XR_CAPTURE_HORIZON_APPEARANCE_WIDTH_M = 0.47;
export const XR_CAPTURE_HORIZON_APPEARANCE_HEIGHT_M = 0.09;
export const XR_CAPTURE_HORIZON_APPEARANCE_CONFIG = "/ui/capture-appearance.json";
export const XR_CAPTURE_HORIZON_APPEARANCE_FRAME_INSET_M = .018;
export const XR_CAPTURE_HORIZON_APPEARANCE_POSITION = Object.freeze({
  x: .32,
  y: -.58,
  z: -XR_CAMERA_EDGES_DISTANCE_M,
});
export const XR_CAPTURE_HORIZON_APPEARANCE_TILT_RAD = 0;

export const xrCaptureHorizonAppearanceFramePosition = (
  frame: Pick<XrCameraEdgesPresentation, "right" | "bottom">,
  canvasWidth: number,
  canvasHeight: number,
  framePlaneSizeM: number,
  frameCentreYM: number,
  frameDistanceM: number,
) => {
  const safeWidth = Math.max(1, canvasWidth);
  const safeHeight = Math.max(1, canvasHeight);
  const safeDistance = Math.max(.001, frameDistanceM);
  const frameRightM = ((frame.right / safeWidth) - .5) * framePlaneSizeM;
  const frameBottomM = ((.5 - frame.bottom / safeHeight) * framePlaneSizeM)
    + frameCentreYM;
  return {
    x: frameRightM
      - XR_CAPTURE_HORIZON_APPEARANCE_WIDTH_M / 2
      - XR_CAPTURE_HORIZON_APPEARANCE_FRAME_INSET_M,
    y: frameBottomM
      + XR_CAPTURE_HORIZON_APPEARANCE_HEIGHT_M / 2
      + XR_CAPTURE_HORIZON_APPEARANCE_FRAME_INSET_M,
    z: -safeDistance,
  };
};

const DOCUMENT_WAIT_MS = 50;
const RUN_CONTROL_COUNT = 5;
const PROGRESS_COUNT = 1;
const RUN_CONTROLS_MAX_WIDTH_PX = 480;
const RUN_CONTROL_MAX_WIDTH_PX = 160;
const RUN_CONTROL_GAP_PX = 10;

export type XrCaptureHorizonTone = "muted" | "action" | "success" | "warning" | "danger";
export type XrCaptureHorizonRunTone = "primary" | "neutral" | "record" | "success" | "danger";
export type XrCaptureHorizonRunIcon =
  | "play"
  | "pause"
  | "stop"
  | "record"
  | "retry"
  | "next"
  | "pass"
  | "fail";
export type XrCaptureHorizonHandControlKey = keyof HandDisplaySettings;

export interface XrCaptureHorizonTaskPresentation {
  state: string;
  title: string;
  description: string;
  timing: string;
  stateTone?: XrCaptureHorizonTone;
  timingTone?: XrCaptureHorizonTone;
}

export interface XrCaptureHorizonProgressPresentation {
  label: string;
  value: number | null;
}

export interface XrCaptureHorizonUploadPresentation {
  stage: "preparing" | "uploading" | "finalising";
  label: string;
  value: number | null;
}

export interface XrCaptureHorizonRunControlPresentation {
  id: string;
  label: string;
  icon: XrCaptureHorizonRunIcon;
  tone: XrCaptureHorizonRunTone;
  enabled: boolean;
  selected?: boolean;
}

export interface XrCaptureHorizonHandControlPresentation {
  key: XrCaptureHorizonHandControlKey;
  label: string;
  value: string;
  enabled: boolean;
  selected: boolean;
}

export interface XrCaptureHorizonHudPresentation {
  identity: string;
  upload: XrCaptureHorizonUploadPresentation | null;
  menuAvailable: boolean;
  retreadAvailable: boolean;
  task: XrCaptureHorizonTaskPresentation;
  progress: readonly XrCaptureHorizonProgressPresentation[];
  runControls: readonly XrCaptureHorizonRunControlPresentation[];
  handControls: readonly XrCaptureHorizonHandControlPresentation[];
}

export interface XrCaptureHorizonHudCallbacks {
  onMenu: () => void;
  onRetread: () => void;
  onExit: () => void;
  onRunControl: (
    control: Readonly<XrCaptureHorizonRunControlPresentation>,
    index: number,
  ) => void;
  onHandControl: (
    control: Readonly<XrCaptureHorizonHandControlPresentation>,
  ) => void;
}

export type XrCaptureHorizonRunVariant = "primary" | "secondary" | "positive" | "negative";

export const xrCaptureHorizonRunControlVariant = (
  control: XrCaptureHorizonRunControlPresentation | undefined,
): XrCaptureHorizonRunVariant => {
  if (!control) return "secondary";
  const annotationToggle = control.id === "success" || control.id === "fail";
  if (annotationToggle && !control.selected) return "secondary";
  if (control.tone === "danger" || control.tone === "record") return "negative";
  if (control.tone === "success") return "positive";
  if (control.tone === "primary" || control.selected) return "primary";
  return "secondary";
};

interface UIKitElement {
  name: string;
  visible: boolean;
  addEventListener: (type: string, listener: (event: any) => void) => void;
  setProperties: (properties: Record<string, unknown>) => void;
}

interface CaptureHudDocument {
  intersectChildren: boolean;
  getElementById: (id: string) => UIKitElement | null;
}

const STATUS_TONE_COLOURS: Readonly<Record<XrCaptureHorizonTone, unknown>> = {
  muted: theme.component.semantic.icon.secondary,
  action: theme.component.semantic.icon.primary,
  success: theme.component.semantic.icon.positive,
  warning: theme.component.semantic.icon.warning,
  danger: theme.component.semantic.icon.negative,
};

const RUN_ICONS: readonly XrCaptureHorizonRunIcon[] = [
  "play",
  "pause",
  "stop",
  "record",
  "retry",
  "next",
  "pass",
  "fail",
];

const HAND_CONTROL_KEYS: readonly XrCaptureHorizonHandControlKey[] = [
  "handMode",
  "handShading",
  "handTrail",
];

type XrCaptureHorizonPointerEvent = Readonly<{
  pointerId?: unknown;
  pointerType?: unknown;
  timeStamp?: unknown;
}>;

const xrCaptureHorizonPointerId = (event: XrCaptureHorizonPointerEvent) => (
  typeof event.pointerId === "number" && Number.isInteger(event.pointerId)
    ? event.pointerId
    : null
);

const xrCaptureHorizonPointerTime = (event: XrCaptureHorizonPointerEvent) => (
  typeof event.timeStamp === "number" && Number.isFinite(event.timeStamp)
    ? event.timeStamp
    : null
);

export const xrCaptureHorizonIsPrimaryHandRay = (
  world: any,
  event: XrCaptureHorizonPointerEvent,
) => {
  if (event.pointerType !== "ray") return false;
  const pointerId = xrCaptureHorizonPointerId(event);
  if (pointerId === null) return false;
  const xr = world?.input?.xr;
  for (const handedness of ["left", "right"] as const) {
    const rayPointer = xr?.multiPointers?.[handedness]?.getPointer?.("ray");
    if (rayPointer?.id !== pointerId) continue;
    return xr?.getPrimaryInputSource?.(handedness)?.hand != null;
  }
  return false;
};

export class XrCaptureHorizonHandReleaseActivation {
  private readonly pressed = new Map<number, XrCaptureHorizonHandControlKey>();
  private readonly releaseActivations = new Map<number, Readonly<{
    key: XrCaptureHorizonHandControlKey;
    timeStamp: number;
  }>>();

  press(pointerId: number, key: XrCaptureHorizonHandControlKey) {
    this.releaseActivations.delete(pointerId);
    this.pressed.set(pointerId, key);
  }

  cancel(pointerId: number, key: XrCaptureHorizonHandControlKey) {
    if (this.pressed.get(pointerId) === key) this.pressed.delete(pointerId);
  }

  release(pointerId: number, key: XrCaptureHorizonHandControlKey) {
    const releasedOnPressedControl = this.pressed.get(pointerId) === key;
    this.pressed.delete(pointerId);
    return releasedOnPressedControl;
  }

  recordReleaseActivation(
    pointerId: number,
    key: XrCaptureHorizonHandControlKey,
    timeStamp: number,
  ) {
    this.releaseActivations.set(pointerId, { key, timeStamp });
  }

  consumeReleaseClick(
    pointerId: number,
    key: XrCaptureHorizonHandControlKey,
    timeStamp: number,
  ) {
    const activation = this.releaseActivations.get(pointerId);
    if (activation?.key !== key || activation.timeStamp !== timeStamp) return false;
    this.releaseActivations.delete(pointerId);
    return true;
  }

  clear() {
    this.pressed.clear();
    this.releaseActivations.clear();
  }
}

export const XR_CAPTURE_HORIZON_HUD_IDLE_OPACITY = .46;
const HUD_HOVER_OPACITY = .98;
const APPEARANCE_IDLE_OPACITY = .18;
const HUD_ATTENTION_HOLD_MS = 3_500;
const HUD_HOVER_LEAVE_DELAY_MS = 140;
const VOICE_ACTION_GLOW_MS = 650;
const VOICE_ACTION_GLOW_REDUCED_MOTION_MS = 900;
const VOICE_ACTION_GLOW_OPACITY = .36;

export function xrCaptureHorizonVoiceActionIndex(
  controls: readonly XrCaptureHorizonRunControlPresentation[],
  actionId: string | null,
) {
  if (!actionId) return -1;
  return controls.findIndex((control) => control.id === actionId && control.enabled);
}

export function xrCaptureHorizonVoiceHandControlEnabled(
  controls: readonly XrCaptureHorizonHandControlPresentation[],
  key: XrCaptureHorizonHandControlKey | null,
) {
  if (!key) return false;
  return controls.some((control) => control.key === key && control.enabled);
}

export class XrCaptureHorizonHud {
  readonly group = new Group();
  readonly appearanceGroup = new Group();

  private readonly entity: any;
  private readonly appearanceEntity: any;
  private document: CaptureHudDocument | null = null;
  private appearanceDocument: CaptureHudDocument | null = null;
  private documentTimer: number | null = null;
  private mainHoverTimer: number | null = null;
  private appearanceHoverTimer: number | null = null;
  private mainAttentionTimer: number | null = null;
  private voiceActionTimer: number | null = null;
  private presentation: XrCaptureHorizonHudPresentation | null = null;
  private taskPresentationSignature = "";
  private voiceActionId: string | null = null;
  private voiceHandControlKey: XrCaptureHorizonHandControlKey | null = null;
  private mainHovered = false;
  private appearanceHovered = false;
  private mainAttentionVisible = false;
  private sessionActive = false;
  private requestedVisible = true;
  private disposed = false;
  private readonly handReleaseActivation = new XrCaptureHorizonHandReleaseActivation();
  private bridgeFrameTime: number | null = null;
  private readonly bridgeSettings = ["hand-handMode", "hand-handShading", "hand-handTrail", "bridge-hud-mode"].map(id => ({
    id,
    hovered: false,
    reveal: 0,
    control: null as UIKitElement | null,
    detail: null as UIKitElement | null,
  }));

  constructor(
    private readonly world: any,
    private readonly callbacks: XrCaptureHorizonHudCallbacks,
    private readonly bridge?: { onPause: () => void; onHudMode: () => void; onAudio: () => void },
  ) {
    this.group.name = "ceres-demonstrator-task-hud";
    this.group.position.set(
      0,
      XR_CAPTURE_HORIZON_HUD_VERTICAL_OFFSET_M,
      -XR_CAPTURE_HORIZON_HUD_DISTANCE_M,
    );
    this.group.rotation.x = XR_CAPTURE_HORIZON_HUD_TILT_RAD;
    this.group.visible = false;
    if (bridge) {
      this.group.name = "ceres-bridge-reticle-controls";
      this.group.position.set(0, XR_CAPTURE_CENTRE_Y_M, -XR_CAMERA_EDGES_DISTANCE_M + .005);
      this.group.rotation.x = 0;
    }
    this.entity = world.createTransformEntity(this.group, {
      parent: world.cameraEntity,
      persistent: true,
    });
    this.entity.addComponent(PanelUI, {
      config: bridge ? "/ui/bridge-hud.json" : XR_CAPTURE_HORIZON_HUD_CONFIG,
      maxWidth: bridge ? XR_CAMERA_EDGES_PLANE_SIZE_M : XR_CAPTURE_HORIZON_HUD_WIDTH_M,
      maxHeight: bridge ? XR_CAMERA_EDGES_PLANE_SIZE_M : XR_CAPTURE_HORIZON_HUD_HEIGHT_M,
    });
    this.entity.addComponent(RayInteractable);
    this.entity.addComponent(PokeInteractable);

    this.appearanceGroup.name = "ceres-capture-appearance-controls";
    this.appearanceGroup.position.set(
      XR_CAPTURE_HORIZON_APPEARANCE_POSITION.x,
      XR_CAPTURE_HORIZON_APPEARANCE_POSITION.y,
      XR_CAPTURE_HORIZON_APPEARANCE_POSITION.z,
    );
    this.appearanceGroup.rotation.x = XR_CAPTURE_HORIZON_APPEARANCE_TILT_RAD;
    if (bridge) this.appearanceGroup.position.copy(this.group.position);
    this.appearanceGroup.visible = false;
    this.appearanceEntity = world.createTransformEntity(this.appearanceGroup, {
      parent: world.cameraEntity,
      persistent: true,
    });
    this.appearanceEntity.addComponent(PanelUI, {
      config: bridge ? "/ui/bridge-appearance.json" : XR_CAPTURE_HORIZON_APPEARANCE_CONFIG,
      maxWidth: bridge ? XR_CAMERA_EDGES_PLANE_SIZE_M : XR_CAPTURE_HORIZON_APPEARANCE_WIDTH_M,
      maxHeight: bridge ? XR_CAMERA_EDGES_PLANE_SIZE_M : XR_CAPTURE_HORIZON_APPEARANCE_HEIGHT_M,
    });
    this.appearanceEntity.addComponent(RayInteractable);
    this.appearanceEntity.addComponent(PokeInteractable);

    this.waitForDocuments();
  }

  get visible() {
    return this.group.visible;
  }

  setSessionActive(active: boolean) {
    if (this.disposed) return;
    this.sessionActive = active;
    if (!active) {
      this.handReleaseActivation.clear();
      this.bridgeFrameTime = null;
      for (const setting of this.bridgeSettings) {
        setting.hovered = false;
        setting.reveal = 0;
        setting.detail?.setProperties({ opacity: 0 });
      }
    }
    this.applyVisibility();
    if (this.document && this.appearanceDocument) this.renderDocuments();
  }

  setRequestedVisible(visible: boolean) {
    if (this.disposed) return;
    this.requestedVisible = visible;
    if (!visible) this.handReleaseActivation.clear();
    this.applyVisibility();
  }

  setAppearanceFramePosition(position: Readonly<{ x: number; y: number; z: number }>) {
    if (this.disposed || this.bridge) return;
    this.appearanceGroup.position.set(position.x, position.y, position.z);
  }

  setBridgeFrame(frame: XrCameraEdgesPresentation, now: number, paused: boolean, connected: boolean, reducedMotion: boolean,
    hudMode: "off" | "light" | "full", audioEnabled = false) {
    if (!this.bridge || !this.document) return;
    const scale = 1024 / XR_CAMERA_EDGES_CANVAS_SIZE;
    const left = frame.left * scale;
    const right = frame.right * scale;
    const top = frame.top * scale;
    const bottom = frame.bottom * scale;
    this.requireMainElement("bridge-status").setProperties({ positionLeft: left + 8, positionTop: top + 8 });
    this.requireMainElement("capture-exit").setProperties({ positionLeft: right - 64, positionTop: top + 8 });
    this.requireMainElement("bridge-pause").setProperties({ positionLeft: right - 64, positionTop: top + 68 });
    this.requireMainElement("bridge-audio").setProperties({ positionLeft: right - 64, positionTop: top + 128 });
    this.requireMainElement("bridge-rec").setProperties({ opacity: paused
      ? reducedMotion ? .2 : .14 + .12 * (1 + Math.sin(now * Math.PI / 900)) / 2
      : connected ? .9 : .14 });
    this.setMainDisplay("bridge-pause-icon", !paused);
    this.setMainDisplay("bridge-resume-icon", paused);
    this.setMainDisplay("bridge-audio-muted", !audioEnabled);
    this.setMainDisplay("bridge-audio-live", audioEnabled);
    this.setAppearanceText("bridge-hud-mode-value", hudMode.toUpperCase());
    const elapsed = this.bridgeFrameTime === null ? 0 : Math.max(0, Math.min(50, now - this.bridgeFrameTime));
    this.bridgeFrameTime = now;
    for (let index = 0; index < this.bridgeSettings.length; index++) {
      const setting = this.bridgeSettings[index];
      const settingTop = bottom - 64 - index * 60;
      setting.control?.setProperties({ positionLeft: right - 64, positionTop: settingTop });
      const reveal = setting.hovered || setting.id === `hand-${this.voiceHandControlKey}`;
      setting.reveal = reducedMotion ? Number(reveal)
        : Math.max(0, Math.min(1, setting.reveal + (reveal ? elapsed / 120 : -elapsed / 100)));
      setting.detail?.setProperties({
        positionLeft: right - 264,
        positionTop: settingTop,
        opacity: setting.reveal * setting.reveal * (3 - 2 * setting.reveal),
      });
    }
  }

  update(presentation: XrCaptureHorizonHudPresentation) {
    if (this.disposed) return;
    this.presentation = {
      ...presentation,
      task: { ...presentation.task },
      progress: presentation.progress
        .slice(0, PROGRESS_COUNT)
        .map((progress) => ({ ...progress })),
      runControls: presentation.runControls
        .slice(0, RUN_CONTROL_COUNT)
        .map((control) => ({ ...control })),
      handControls: presentation.handControls
        .slice(0, HAND_CONTROL_KEYS.length)
        .map((control) => ({ ...control })),
    };
    this.applyVisibility();
    if (this.document && this.appearanceDocument) this.renderDocuments();
  }

  flashVoiceAction(actionId: string, reducedMotion: boolean) {
    if (
      this.disposed
      || !this.sessionActive
      || !this.requestedVisible
      || !this.presentation
      || xrCaptureHorizonVoiceActionIndex(this.presentation.runControls, actionId) < 0
    ) return false;
    if (this.voiceActionTimer !== null) window.clearTimeout(this.voiceActionTimer);
    this.voiceActionId = actionId;
    this.voiceHandControlKey = null;
    if (this.document && this.appearanceDocument) this.renderDocuments();
    this.voiceActionTimer = window.setTimeout(() => {
      this.voiceActionTimer = null;
      this.voiceActionId = null;
      this.voiceHandControlKey = null;
      if (this.document && this.appearanceDocument) this.renderDocuments();
    }, reducedMotion ? VOICE_ACTION_GLOW_REDUCED_MOTION_MS : VOICE_ACTION_GLOW_MS);
    return true;
  }

  flashVoiceHandControl(
    key: XrCaptureHorizonHandControlKey,
    reducedMotion: boolean,
  ) {
    if (
      this.disposed
      || !this.sessionActive
      || !this.requestedVisible
      || !this.presentation
      || !xrCaptureHorizonVoiceHandControlEnabled(this.presentation.handControls, key)
    ) return false;
    if (this.voiceActionTimer !== null) window.clearTimeout(this.voiceActionTimer);
    this.voiceActionId = null;
    this.voiceHandControlKey = key;
    if (this.document && this.appearanceDocument) this.renderDocuments();
    this.voiceActionTimer = window.setTimeout(() => {
      this.voiceActionTimer = null;
      this.voiceActionId = null;
      this.voiceHandControlKey = null;
      if (this.document && this.appearanceDocument) this.renderDocuments();
    }, reducedMotion ? VOICE_ACTION_GLOW_REDUCED_MOTION_MS : VOICE_ACTION_GLOW_MS);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.documentTimer !== null) window.clearTimeout(this.documentTimer);
    this.documentTimer = null;
    if (this.mainHoverTimer !== null) window.clearTimeout(this.mainHoverTimer);
    if (this.appearanceHoverTimer !== null) window.clearTimeout(this.appearanceHoverTimer);
    if (this.mainAttentionTimer !== null) window.clearTimeout(this.mainAttentionTimer);
    if (this.voiceActionTimer !== null) window.clearTimeout(this.voiceActionTimer);
    this.mainHoverTimer = null;
    this.appearanceHoverTimer = null;
    this.mainAttentionTimer = null;
    this.voiceActionTimer = null;
    this.voiceActionId = null;
    this.voiceHandControlKey = null;
    this.handReleaseActivation.clear();
    this.document = null;
    this.appearanceDocument = null;
    this.presentation = null;
    try {
      this.entity.dispose();
    } catch {
      this.group.removeFromParent();
    }
    try {
      this.appearanceEntity.dispose();
    } catch {
      this.appearanceGroup.removeFromParent();
    }
  }

  private waitForDocuments() {
    if (this.disposed) return;
    const document = PanelDocument.data.document[this.entity.index] as CaptureHudDocument | undefined;
    const appearanceDocument = PanelDocument.data.document[
      this.appearanceEntity.index
    ] as CaptureHudDocument | undefined;
    if (!document || !appearanceDocument) {
      this.documentTimer = window.setTimeout(
        () => this.waitForDocuments(),
        DOCUMENT_WAIT_MS,
      );
      return;
    }
    this.documentTimer = null;
    this.document = document;
    this.appearanceDocument = appearanceDocument;
    this.configureDocuments();
    this.bindInteractions();
    this.applyVisibility();
    this.renderDocuments();
  }

  private configureDocuments() {
    const root = this.requireMainElement("capture-hud-root");
    root.name = "ceres-demonstrator-task-hud-panel";
    root.setProperties({ color: theme.component.semantic.text.primary });
    if (this.bridge) {
      root.name = "ceres-bridge-reticle-panel";
      this.requireMainElement("bridge-pause").name = "ceres-bridge-pause";
      this.requireMainElement("bridge-audio").name = "ceres-bridge-audio";
      this.requireMainElement("bridge-rec").name = "ceres-bridge-rec";
      this.requireMainElement("bridge-status").name = "ceres-bridge-status";
      this.requireMainElement("capture-exit").name = "ceres-capture-overlay:exit";
    } else {
      this.requireMainElement("capture-task-panel").name = "ceres-capture-task-panel";
      this.requireMainElement("capture-control-panel").name = "ceres-capture-run-panel";
      this.requireMainElement("capture-menu").name = "ceres-capture-overlay:menu";
      this.requireMainElement("capture-retread").name = "ceres-capture-overlay:retread";
      this.requireMainElement("capture-exit").name = "ceres-capture-overlay:exit";
      this.requireMainElement("capture-identity").setProperties({
        color: theme.component.semantic.text.secondary,
      });
      this.requireMainElement("capture-upload-status").name = "ceres-capture-upload-status";
      this.requireMainElement("capture-upload-icon").setProperties({
        color: theme.component.semantic.icon.primary,
      });
      this.requireMainElement("capture-upload-label").setProperties({
        color: theme.component.semantic.text.primary,
      });
      this.requireMainElement("capture-upload-percentage").setProperties({
        color: theme.component.semantic.text.secondary,
      });
      this.requireMainElement("capture-task-timing").setProperties({
        color: theme.component.semantic.text.secondary,
      });
      this.requireMainElement("capture-task-state").setProperties({
        color: theme.component.semantic.text.link,
      });
      this.requireMainElement("capture-task-description").setProperties({
        color: theme.component.semantic.text.secondary,
      });
      this.requireMainElement("progress-0-label").setProperties({
        color: theme.component.semantic.text.secondary,
      });
      for (let index = 0; index < RUN_CONTROL_COUNT; index += 1) {
        this.requireMainElement(`run-${index}`).name = `ceres-capture-control:${index}`;
        const voiceGlow = this.requireMainElement(`run-${index}-voice-glow`);
        voiceGlow.name = `ceres-capture-control:${index}:voice-glow`;
        voiceGlow.setProperties({
          backgroundColor: STATUS_TONE_COLOURS.warning,
        });
      }
    }
    const appearanceRoot = this.requireAppearanceElement("capture-appearance-root");
    appearanceRoot.name = "ceres-capture-appearance-panel";
    appearanceRoot.setProperties({ color: theme.component.semantic.text.primary });
    if (this.bridge) {
      for (const setting of this.bridgeSettings) {
        setting.control = this.requireAppearanceElement(setting.id);
        setting.detail = this.requireAppearanceElement(`${setting.id}-setting`);
        setting.detail.name = `ceres-bridge-setting:${setting.id}`;
        setting.control.addEventListener("pointerenter", () => { setting.hovered = true; });
        setting.control.addEventListener("pointerleave", () => { setting.hovered = false; });
        setting.control.addEventListener("pointercancel", () => { setting.hovered = false; });
      }
      const mode = this.requireAppearanceElement("bridge-hud-mode");
      mode.name = "ceres-bridge-hud-mode";
      this.setAppearanceDisplay("bridge-hud-mode", true);
      mode.addEventListener("click", (event: any) => {
        if (this.disposed || !this.sessionActive || !this.requestedVisible) return;
        event.stopPropagation?.();
        this.bridge?.onHudMode();
      });
    }
    for (const key of HAND_CONTROL_KEYS) {
      this.requireAppearanceElement(`hand-${key}`).name = `ceres-capture-hand:${key}`;
      const voiceGlow = this.requireAppearanceElement(`hand-${key}-voice-glow`);
      voiceGlow.name = `ceres-capture-hand:${key}:voice-glow`;
      voiceGlow.setProperties({
        backgroundColor: STATUS_TONE_COLOURS.warning,
      });
    }
    this.updatePanelOpacity();
  }

  private bindInteractions() {
    const bindMainHover = (id: string) => {
      const element = this.requireMainElement(id);
      element.addEventListener("pointerenter", () => this.setMainHovered(true));
      element.addEventListener("pointerleave", () => this.setMainHovered(false));
    };
    if (this.bridge) {
      this.requireMainElement("bridge-audio").addEventListener("click", (event: any) => {
        if (this.disposed || !this.sessionActive || !this.requestedVisible) return;
        event.stopPropagation?.();
        this.bridge?.onAudio();
      });
      this.requireMainElement("bridge-pause").addEventListener("click", (event: any) => {
        if (this.disposed || !this.sessionActive || !this.requestedVisible) return;
        event.stopPropagation?.();
        this.bridge?.onPause();
      });
    } else {
      bindMainHover("capture-menu");
      bindMainHover("capture-retread");
      bindMainHover("capture-exit");
      for (let index = 0; index < RUN_CONTROL_COUNT; index += 1) bindMainHover(`run-${index}`);
      this.requireMainElement("capture-menu").addEventListener("click", (event: any) => {
        if (this.disposed
          || !this.sessionActive
          || !this.requestedVisible
          || !this.presentation?.menuAvailable) return;
        event.stopPropagation?.();
        this.callbacks.onMenu();
      });
      this.requireMainElement("capture-retread").addEventListener("click", (event: any) => {
        if (this.disposed
          || !this.sessionActive
          || !this.requestedVisible
          || !this.presentation?.retreadAvailable) return;
        event.stopPropagation?.();
        this.callbacks.onRetread();
      });
    }
    this.requireMainElement("capture-exit").addEventListener("click", (event: any) => {
      if (this.disposed || !this.sessionActive || !this.requestedVisible) return;
      event.stopPropagation?.();
      this.callbacks.onExit();
    });
    if (!this.bridge) for (let index = 0; index < RUN_CONTROL_COUNT; index += 1) {
      this.requireMainElement(`run-${index}`).addEventListener("click", (event: any) => {
        if (this.disposed || !this.sessionActive || !this.requestedVisible) return;
        const control = this.presentation?.runControls[index];
        if (!control?.enabled) return;
        event.stopPropagation?.();
        if (control.selected && (control.id === "success" || control.id === "fail")) return;
        this.callbacks.onRunControl({ ...control }, index);
      });
    }
    for (const key of HAND_CONTROL_KEYS) {
      const element = this.requireAppearanceElement(`hand-${key}`);
      element.addEventListener("pointerenter", () => { if (!this.bridge) this.setAppearanceHovered(true); });
      element.addEventListener("pointerleave", (event: any) => {
        if (!this.bridge) this.setAppearanceHovered(false);
        const pointerId = xrCaptureHorizonPointerId(event);
        if (pointerId !== null) this.handReleaseActivation.cancel(pointerId, key);
      });
      element.addEventListener("pointercancel", (event: any) => {
        const pointerId = xrCaptureHorizonPointerId(event);
        if (pointerId !== null) this.handReleaseActivation.cancel(pointerId, key);
      });
      element.addEventListener("pointerdown", (event: any) => {
        if (!this.activatableHandControl(key)) return;
        if (!xrCaptureHorizonIsPrimaryHandRay(this.world, event)) return;
        const pointerId = xrCaptureHorizonPointerId(event);
        if (pointerId !== null) this.handReleaseActivation.press(pointerId, key);
      });
      element.addEventListener("pointerup", (event: any) => {
        const pointerId = xrCaptureHorizonPointerId(event);
        if (pointerId === null || !this.handReleaseActivation.release(pointerId, key)) return;
        if (!this.activateHandControl(key, event)) return;
        const timeStamp = xrCaptureHorizonPointerTime(event);
        if (timeStamp !== null) {
          this.handReleaseActivation.recordReleaseActivation(pointerId, key, timeStamp);
        }
      });
      element.addEventListener(
        "click",
        (event: any) => {
          const pointerId = xrCaptureHorizonPointerId(event);
          const timeStamp = xrCaptureHorizonPointerTime(event);
          if (
            pointerId !== null
            && timeStamp !== null
            && this.handReleaseActivation.consumeReleaseClick(pointerId, key, timeStamp)
          ) {
            event.stopPropagation?.();
            return;
          }
          this.activateHandControl(key, event);
        },
      );
    }
  }

  private activatableHandControl(key: XrCaptureHorizonHandControlKey) {
    if (this.disposed || !this.sessionActive || !this.requestedVisible) return null;
    const control = this.presentation?.handControls.find(
      (candidate) => candidate.key === key,
    );
    return control?.enabled ? control : null;
  }

  private activateHandControl(key: XrCaptureHorizonHandControlKey, event: any) {
    const control = this.activatableHandControl(key);
    if (!control) return false;
    event.stopPropagation?.();
    this.callbacks.onHandControl({ ...control });
    return true;
  }

  private renderDocuments() {
    const presentation = this.presentation;
    if (!this.document || !this.appearanceDocument || !presentation) return;

    if (!this.bridge) {
      const taskSignature = [
        presentation.task.state,
        presentation.task.title,
        presentation.task.description,
        presentation.upload?.stage ?? "",
        presentation.upload?.label ?? "",
      ].join("\u0000");
      if (taskSignature !== this.taskPresentationSignature) {
        this.taskPresentationSignature = taskSignature;
        this.revealMainHud();
      }
      const upload = presentation.upload;
      const uploadProgress = upload?.value === null || upload?.value === undefined
        ? null
        : Math.min(1, Math.max(0, upload.value));
      this.setMainDisplay("capture-identity", upload === null);
      this.setMainText("capture-identity", presentation.identity);
      this.setMainDisplay("capture-upload-status", upload !== null);
      this.setMainText("capture-upload-label", upload?.label ?? "");
      this.setMainDisplay("capture-upload-progress", uploadProgress !== null);
      this.setMainDisplay("capture-upload-percentage", uploadProgress !== null);
      this.setMainText(
        "capture-upload-percentage",
        uploadProgress === null ? "" : `${Math.round(uploadProgress * 100)}%`,
      );
      this.requireMainElement("capture-upload-progress").setProperties({
        value: uploadProgress === null ? 0 : Math.round(uploadProgress * 100),
      });
      this.requireMainElement("capture-upload-icon").setProperties({
        color: STATUS_TONE_COLOURS[upload?.stage === "finalising" ? "warning" : "action"],
      });
      this.setMainDisplay("capture-menu", presentation.menuAvailable);
      this.setMainDisplay("capture-retread", presentation.retreadAvailable);

      this.setMainText("capture-task-state", presentation.task.state);
      this.setMainText("capture-task-title", presentation.task.title);
      this.setMainText("capture-task-description", presentation.task.description);
      this.setMainText("capture-task-timing", presentation.task.timing);
      this.requireMainElement("capture-task-state").setProperties({
        color: STATUS_TONE_COLOURS[presentation.task.stateTone ?? "action"],
      });
      this.requireMainElement("capture-task-timing").setProperties({
        color: STATUS_TONE_COLOURS[presentation.task.timingTone ?? "muted"],
      });

      for (let index = 0; index < PROGRESS_COUNT; index += 1) {
        const progress = presentation.progress[index];
        this.setMainDisplay(`progress-${index}`, Boolean(progress));
        this.setMainText(`progress-${index}-label`, progress?.label ?? "");
        this.requireMainElement(`progress-${index}-bar`).setProperties({
          value: progress?.value === null || progress?.value === undefined
            ? 0
            : Math.round(Math.min(1, Math.max(0, progress.value)) * 100),
        });
      }

      const visibleControlCount = Math.max(
        1,
        Math.min(RUN_CONTROL_COUNT, presentation.runControls.length),
      );
      const controlRowWidth = Math.min(
        RUN_CONTROLS_MAX_WIDTH_PX,
        visibleControlCount * RUN_CONTROL_MAX_WIDTH_PX
          + (visibleControlCount - 1) * RUN_CONTROL_GAP_PX,
      );
      this.requireMainElement("capture-control-row").setProperties({
        width: controlRowWidth,
      });
      const voiceActionIndex = xrCaptureHorizonVoiceActionIndex(
        presentation.runControls,
        this.voiceActionId,
      );

      for (let index = 0; index < RUN_CONTROL_COUNT; index += 1) {
        const control = presentation.runControls[index];
        const element = this.requireMainElement(`run-${index}`);
        this.setMainDisplay(`run-${index}`, Boolean(control));
        this.setMainText(`run-${index}-label`, control?.label ?? "");
        element.setProperties({
          disabled: control?.enabled !== true,
          opacity: !control ? 0 : control.enabled ? 1 : 0.46,
          variant: xrCaptureHorizonRunControlVariant(control),
          width: Math.min(
            RUN_CONTROL_MAX_WIDTH_PX,
            (controlRowWidth - (visibleControlCount - 1) * RUN_CONTROL_GAP_PX)
              / visibleControlCount,
          ),
        });
        for (const icon of RUN_ICONS) {
          this.setMainDisplay(`run-${index}-icon-${icon}`, control?.icon === icon);
        }
        const voiceGlowVisible = index === voiceActionIndex;
        this.setMainDisplay(`run-${index}-voice-glow`, voiceGlowVisible);
        this.requireMainElement(`run-${index}-voice-glow`).setProperties({
          opacity: voiceGlowVisible ? VOICE_ACTION_GLOW_OPACITY : 0,
        });
      }
    }
    for (const key of HAND_CONTROL_KEYS) {
      const control = presentation.handControls.find((candidate) => candidate.key === key);
      const element = this.requireAppearanceElement(`hand-${key}`);
      this.setAppearanceDisplay(`hand-${key}`, Boolean(control));
      this.setAppearanceText(`hand-${key}-label`, control?.label ?? "");
      this.setAppearanceText(`hand-${key}-value`, control?.value ?? "");
      element.setProperties({
        disabled: control?.enabled !== true,
        opacity: !control ? 0 : control.enabled ? 1 : 0.46,
        variant: "onMedia",
        backgroundColor: this.bridge ? "#00000000" : control?.selected
          ? colourWithAlpha(semanticColours.accent, .42)
          : colourWithAlpha(semanticColours.onAction, .06),
        color: control?.selected
          ? semanticColours.text
          : colourWithAlpha(semanticColours.textSecondary, .88),
      });
      const voiceGlowVisible = control?.enabled === true && this.voiceHandControlKey === key;
      this.setAppearanceDisplay(`hand-${key}-voice-glow`, voiceGlowVisible);
      this.requireAppearanceElement(`hand-${key}-voice-glow`).setProperties({
        opacity: voiceGlowVisible ? VOICE_ACTION_GLOW_OPACITY : 0,
      });
    }
    this.updatePanelOpacity();
  }

  private setMainText(id: string, text: string) {
    this.requireMainElement(id).setProperties({ text });
  }

  private setAppearanceText(id: string, text: string) {
    this.requireAppearanceElement(id).setProperties({ text });
  }

  private setMainDisplay(id: string, visible: boolean) {
    this.setElementDisplay(this.requireMainElement(id), visible);
  }

  private setAppearanceDisplay(id: string, visible: boolean) {
    this.setElementDisplay(this.requireAppearanceElement(id), visible);
  }

  private setElementDisplay(element: UIKitElement, visible: boolean) {
    element.visible = visible;
    element.setProperties({ display: visible ? "flex" : "none" });
  }

  private setMainHovered(hovered: boolean) {
    if (this.mainHoverTimer !== null) window.clearTimeout(this.mainHoverTimer);
    if (hovered) {
      this.mainHoverTimer = null;
      this.mainHovered = true;
      this.updatePanelOpacity();
      return;
    }
    this.mainHoverTimer = window.setTimeout(() => {
      this.mainHoverTimer = null;
      this.mainHovered = false;
      this.updatePanelOpacity();
    }, HUD_HOVER_LEAVE_DELAY_MS);
  }

  private setAppearanceHovered(hovered: boolean) {
    if (this.appearanceHoverTimer !== null) window.clearTimeout(this.appearanceHoverTimer);
    if (hovered) {
      this.appearanceHoverTimer = null;
      this.appearanceHovered = true;
      this.updatePanelOpacity();
      return;
    }
    this.appearanceHoverTimer = window.setTimeout(() => {
      this.appearanceHoverTimer = null;
      this.appearanceHovered = false;
      this.updatePanelOpacity();
    }, HUD_HOVER_LEAVE_DELAY_MS);
  }

  private revealMainHud() {
    if (this.mainAttentionTimer !== null) window.clearTimeout(this.mainAttentionTimer);
    this.mainAttentionVisible = true;
    this.updatePanelOpacity();
    this.mainAttentionTimer = window.setTimeout(() => {
      this.mainAttentionTimer = null;
      this.mainAttentionVisible = false;
      this.updatePanelOpacity();
    }, HUD_ATTENTION_HOLD_MS);
  }

  private updatePanelOpacity() {
    this.document?.getElementById("capture-hud-root")?.setProperties({
      opacity: this.bridge ? 1 : this.mainHovered || this.mainAttentionVisible
        ? HUD_HOVER_OPACITY
        : XR_CAPTURE_HORIZON_HUD_IDLE_OPACITY,
    });
    const appearanceOpacity = this.bridge ? .5 : this.appearanceHovered || this.voiceHandControlKey !== null
      ? HUD_HOVER_OPACITY
      : APPEARANCE_IDLE_OPACITY;
    this.appearanceDocument?.getElementById("capture-appearance-root")?.setProperties({
      opacity: this.bridge ? 1 : appearanceOpacity,
    });
    if (this.bridge) {
      // Keep the icons at half opacity while each sibling setting label fades independently.
      for (const key of HAND_CONTROL_KEYS) {
        const control = this.presentation?.handControls.find((candidate) => candidate.key === key);
        this.appearanceDocument?.getElementById(`hand-${key}`)?.setProperties({
          opacity: !control ? 0 : appearanceOpacity * (control.enabled ? 1 : .46),
        });
      }
      this.appearanceDocument?.getElementById("bridge-hud-mode")?.setProperties({ opacity: appearanceOpacity });
    }
  }

  private requireMainElement(id: string) {
    const element = this.document?.getElementById(id);
    if (!element) throw new Error(`The Horizon capture HUD element ${id} is missing`);
    return element;
  }

  private requireAppearanceElement(id: string) {
    const element = this.appearanceDocument?.getElementById(id);
    if (!element) {
      throw new Error(`The Horizon capture appearance element ${id} is missing`);
    }
    return element;
  }

  private applyVisibility() {
    const active = this.sessionActive
      && this.requestedVisible
      && this.presentation !== null;
    this.group.visible = active;
    this.appearanceGroup.visible = active;
    if (this.document) this.document.intersectChildren = active;
    if (this.appearanceDocument) this.appearanceDocument.intersectChildren = active;
    this.updatePanelOpacity();
  }
}
