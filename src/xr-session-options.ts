import { SessionMode, type XROptions } from "@iwsdk/core/dist/init/xr.js";

export interface XrSideRecognition {
  left: boolean;
  right: boolean;
}

export type XrHandRecognition = XrSideRecognition;
export type XrControllerRecognition = XrSideRecognition;

export type CaptureRecordingState = "idle" | "arming" | "recording" | "paused" | "stopping";

type XrInputSourceLike = {
  hand?: unknown;
  targetRayMode?: unknown;
};

type CaptureXrInputManager = {
  multiPointers?: Partial<Record<"left" | "right", {
    ray?: {
      visual?: {
        ray?: {
          scale?: { z: number };
        };
      };
    };
  }>>;
  updateActiveInputSources?: (session: {
    inputSources: Iterable<XrInputSourceLike>;
    trackedSources?: Iterable<XrInputSourceLike>;
  }) => void;
};

type CaptureXrInputSession = {
  inputSources: Iterable<XrInputSourceLike>;
  trackedSources?: Iterable<XrInputSourceLike>;
};

export interface CaptureControllerInputPolicy {
  readonly ignoringControllers: boolean;
  setIgnoringControllers(ignored: boolean): void;
  dispose(): void;
}

const captureControllerInputPolicies = new WeakMap<object, CaptureControllerInputPolicy>();

/** The visual ray is scaled so it visibly reaches capture HUDs placed behind the reticle. */
export const XR_CAPTURE_HAND_RAY_VISUAL_SCALE = 1.9;

export function recogniseXrHands(inputSources: Iterable<{ handedness?: unknown; hand?: unknown }> | null | undefined): XrHandRecognition {
  const recognition: XrHandRecognition = { left: false, right: false };
  if (!inputSources) return recognition;
  for (const source of inputSources) {
    if (!source.hand || (source.handedness !== "left" && source.handedness !== "right")) continue;
    recognition[source.handedness] = true;
  }
  return recognition;
}

/**
 * Recognises the controllers a demonstrator is holding. A controller is an
 * input source with a left or right handedness, no hand joint collection and
 * the tracked-pointer ray mode used by controllers.
 */
export function recogniseXrControllers(
  inputSources: Iterable<{ handedness?: unknown; hand?: unknown; targetRayMode?: unknown }> | null | undefined,
): XrControllerRecognition {
  const recognition: XrControllerRecognition = { left: false, right: false };
  if (!inputSources) return recognition;
  for (const source of inputSources) {
    if (source.hand
      || source.targetRayMode !== "tracked-pointer"
      || (source.handedness !== "left" && source.handedness !== "right")) continue;
    recognition[source.handedness] = true;
  }
  return recognition;
}

export function handOnlyXrInputSources<T extends XrInputSourceLike>(
  sources: Iterable<T> | null | undefined,
) {
  return sources ? Array.from(sources).filter((source) => source.hand != null) : [];
}

/**
 * Installs a reversible IWSDK input policy. Non-Solo capture remains hand-only,
 * while Solo can make controllers available between recordings.
 */
export function configureCaptureControllerInputPolicy(input: unknown): CaptureControllerInputPolicy | null {
  if (!input || typeof input !== "object") return null;
  const manager = input as CaptureXrInputManager;
  const existing = captureControllerInputPolicies.get(manager);
  if (existing) return existing;
  const updateActiveInputSources = manager.updateActiveInputSources;
  if (typeof updateActiveInputSources !== "function") return null;

  let ignoringControllers = false;
  let lastSession: CaptureXrInputSession | null = null;
  let disposed = false;

  const apply = (session: CaptureXrInputSession) => {
    if (!ignoringControllers) {
      updateActiveInputSources.call(manager, session);
      return;
    }

    const handOnlySession = Object.create(session) as typeof session;
    Object.defineProperty(handOnlySession, "inputSources", {
      configurable: true,
      value: handOnlyXrInputSources(session.inputSources),
    });
    if (session.trackedSources) {
      Object.defineProperty(handOnlySession, "trackedSources", {
        configurable: true,
        value: handOnlyXrInputSources(session.trackedSources),
      });
    }
    updateActiveInputSources.call(manager, handOnlySession);
  };

  const wrappedUpdateActiveInputSources = (session: CaptureXrInputSession) => {
    lastSession = session;
    apply(session);
  };
  manager.updateActiveInputSources = wrappedUpdateActiveInputSources;

  const policy: CaptureControllerInputPolicy = {
    get ignoringControllers() {
      return ignoringControllers;
    },
    setIgnoringControllers(ignored) {
      if (disposed || ignored === ignoringControllers) return;
      ignoringControllers = ignored;
      if (lastSession) apply(lastSession);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (manager.updateActiveInputSources === wrappedUpdateActiveInputSources) {
        manager.updateActiveInputSources = updateActiveInputSources;
      }
      captureControllerInputPolicies.delete(manager);
      lastSession = null;
    },
  };
  captureControllerInputPolicies.set(manager, policy);
  return policy;
}

export function soloCaptureIgnoresControllers(
  recordingState: CaptureRecordingState | null | undefined,
  recordingFinalising = false,
) {
  return recordingFinalising || (recordingState !== undefined
    && recordingState !== null
    && recordingState !== "idle");
}

export function captureIgnoresControllers(
  solo: boolean,
  recordingState: CaptureRecordingState | null | undefined,
  recordingFinalising = false,
) {
  return !solo || soloCaptureIgnoresControllers(recordingState, recordingFinalising);
}

/** A controller drives the Solo menus only while the input policy accepts it. */
export function soloControllerMenuInputActive(
  controllers: XrControllerRecognition,
  ignoringControllers: boolean,
) {
  return !ignoringControllers && (controllers.left || controllers.right);
}

/**
 * Quest stops tracking a hand that is holding a controller, so menu-scoped
 * controller input must not raise the hand-loss alert. Suppression uses the
 * same boundary as controller availability, so a demonstrator is alarmed again
 * the moment capture leaves idle and the controllers are released.
 */
export function soloSuppressesHandTrackingAlerts(
  solo: boolean,
  controllers: XrControllerRecognition,
  recordingState: CaptureRecordingState | null | undefined,
  recordingFinalising = false,
) {
  if (!solo) return false;
  return soloControllerMenuInputActive(
    controllers,
    captureIgnoresControllers(solo, recordingState, recordingFinalising),
  );
}

export function configureCaptureHandRayVisuals(input: unknown) {
  if (!input || typeof input !== "object") return false;
  const manager = input as CaptureXrInputManager;
  let configured = false;
  for (const handedness of ["left", "right"] as const) {
    const scale = manager.multiPointers?.[handedness]?.ray?.visual?.ray?.scale;
    if (!scale) continue;
    scale.z = XR_CAPTURE_HAND_RAY_VISUAL_SCALE;
    configured = true;
  }
  return configured;
}

export const CERES_XR_SESSION_OPTIONS = {
  sessionMode: SessionMode.ImmersiveAR,
  features: {
    handTracking: true,
    planeDetection: true,
    meshDetection: true,
    anchors: true,
  },
} satisfies XROptions;

export const CERES_SOLO_XR_SESSION_OPTIONS = {
  ...CERES_XR_SESSION_OPTIONS,
  features: {
    ...CERES_XR_SESSION_OPTIONS.features,
    handTracking: true,
  },
} satisfies XROptions;
