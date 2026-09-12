import type { World } from "@iwsdk/core/dist/ecs/world.js";
import { attachBrowserCameraRestore } from "@iwsdk/core/dist/init/browser-camera.js";
import {
  buildSessionInit,
  normalizeReferenceSpec,
  resolveReferenceSpaceType,
  SessionMode,
} from "@iwsdk/core/dist/init/xr.js";

const xrLaunchAbortError = () => new DOMException(
  "XR launch was cancelled",
  "AbortError",
);

function throwIfXrLaunchAborted(signal: AbortSignal) {
  if (signal.aborted) throw xrLaunchAbortError();
}

async function endXrSession(session: XRSession) {
  try {
    await session.end();
  } catch {
    // The session may already be ending after a failed launch.
  }
}

/**
 * Launches the pinned IWSDK 0.4.2 XR path while retaining the complete promise.
 * IWSDK's public launchXR method returns before requestSession and reference-space
 * initialisation settle, so capture cannot otherwise make launch single-flight.
 */
export async function launchIwsdkXrSession(
  world: World,
  signal: AbortSignal,
) {
  throwIfXrLaunchAborted(signal);
  if (world.session || world.renderer.xr.getSession()) {
    throw new DOMException("An immersive XR session is already active", "InvalidStateError");
  }

  const xr = navigator.xr;
  if (!xr || typeof xr.requestSession !== "function") {
    throw new Error("WebXR session requests are unavailable");
  }

  const options = world.xrDefaults ?? {};
  const sessionMode = options.sessionMode ?? SessionMode.ImmersiveVR;
  const referenceSpace = normalizeReferenceSpec(options.referenceSpace);
  world.renderer.xr.enabled = true;
  const session = await xr.requestSession(sessionMode, buildSessionInit(options));

  const onSessionEnd = () => {
    session.removeEventListener("end", onSessionEnd);
    if (world.session === session) world.session = undefined;
  };
  const onAbort = () => {
    void endXrSession(session);
  };
  session.addEventListener("end", onSessionEnd);
  signal.addEventListener("abort", onAbort, { once: true });

  let started = false;
  try {
    throwIfXrLaunchAborted(signal);
    const resolvedReferenceSpace = await resolveReferenceSpaceType(
      session,
      referenceSpace.type,
      referenceSpace.required ? [] : referenceSpace.fallbackOrder,
    );
    throwIfXrLaunchAborted(signal);
    world.renderer.xr.getDepthSensingMesh = () => null;
    world.renderer.xr.setReferenceSpaceType(resolvedReferenceSpace);
    if (options.restoreCameraOnExit !== false) {
      attachBrowserCameraRestore(world.camera, session);
    }
    await world.renderer.xr.setSession(session);
    throwIfXrLaunchAborted(signal);
    if (!world.renderer.xr.getReferenceSpace()) {
      throw new Error("XR session started without a reference space");
    }
    world.session = session;
    started = true;
    return session;
  } catch (error) {
    await endXrSession(session);
    if (world.session === session) world.session = undefined;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!started) session.removeEventListener("end", onSessionEnd);
  }
}
