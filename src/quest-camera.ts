import type { CameraSide } from "../shared/protocol.js";
import { inferCameraSide } from "./camera-projection.js";
import { withErrorContext } from "./worker-errors.js";

export interface CameraChoice {
  deviceId: string;
  label: string;
  side: CameraSide;
}

type CameraMediaDevices = Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;

export interface CameraAccessEnvironment {
  secureContext: boolean;
  mediaDevices?: Partial<CameraMediaDevices> | null;
}

export interface CameraAccessCapability {
  available: boolean;
  message: string | null;
}

const browserCameraEnvironment = (): CameraAccessEnvironment => ({
  secureContext: globalThis.isSecureContext,
  mediaDevices: navigator.mediaDevices,
});

export function cameraAccessCapability(environment: CameraAccessEnvironment = browserCameraEnvironment()): CameraAccessCapability {
  if (!environment.secureContext) {
    return {
      available: false,
      message: "Camera access requires HTTPS. Open the secure capture link from the capture director.",
    };
  }
  if (typeof environment.mediaDevices?.enumerateDevices !== "function" || typeof environment.mediaDevices?.getUserMedia !== "function") {
    return {
      available: false,
      message: "Camera access is unavailable in this browser. Open the secure capture link in Meta Quest Browser.",
    };
  }
  return { available: true, message: null };
}

function requireMediaDevices(
  environment: CameraAccessEnvironment = browserCameraEnvironment(),
): CameraMediaDevices {
  const capability = cameraAccessCapability(environment);
  if (!capability.available) throw new Error(capability.message!);
  return environment.mediaDevices as CameraMediaDevices;
}

export const isQuestBrowser = (
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent || "",
) => /OculusBrowser/.test(userAgent);

const trimDeviceSuffix = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "").trim();

function requestTemporaryCameraPermission(mediaDevices: CameraMediaDevices) {
  return mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
}

function cameraDevicesNeedRefresh(devices: MediaDeviceInfo[]) {
  const videoInputs = devices.filter((device) => device.kind === "videoinput");
  return videoInputs.length === 0
    || videoInputs.some((device) => !device.deviceId || !device.label.trim());
}

function stopProvisionalCameraStream(stream: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // Cleanup must not replace the original camera permission or enumeration error.
    }
  }
}

/**
 * Mirrors NVIDIA XR AI's Quest selection policy.
 *
 * Quest Browser can expose physical front-facing cameras alongside passthrough.
 * NVIDIA excludes labels containing `front`, because selecting one can leave the
 * browser media stack unusable until the headset is restarted. The selected
 * outward camera is later requested by its exact deviceId.
 */
export async function enumerateOutwardCameras(
  environment: CameraAccessEnvironment = browserCameraEnvironment(),
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent || "",
): Promise<CameraChoice[]> {
  let mediaDevices: CameraMediaDevices;
  try {
    mediaDevices = requireMediaDevices(environment);
  } catch (error) {
    throw withErrorContext(error, { stage: "permission_request" });
  }
  let provisionalStream: MediaStream | null = null;
  try {
    // Start the permission request in the direct user-activation call stack. A fresh
    // origin may expose no devices, or only anonymous devices, until this succeeds.
    try {
      provisionalStream = await requestTemporaryCameraPermission(mediaDevices);
    } catch (error) {
      throw withErrorContext(error, { stage: "permission_request" });
    }
    let devices: MediaDeviceInfo[];
    try {
      devices = await mediaDevices.enumerateDevices();
      if (cameraDevicesNeedRefresh(devices)) {
        devices = await mediaDevices.enumerateDevices();
      }
    } catch (error) {
      throw withErrorContext(error, { stage: "device_enumeration" });
    }
    const questBrowser = isQuestBrowser(userAgent);
    const isOutwardCamera = (device: Pick<MediaDeviceInfo, "deviceId" | "label">) => (
      device.deviceId.trim().length > 0
      && (!questBrowser || (device.label.trim().length > 0 && !/\bfront\b/i.test(device.label)))
    );
    const outward: Pick<MediaDeviceInfo, "deviceId" | "label">[] = devices
      .filter((device) => device.kind === "videoinput")
      .filter(isOutwardCamera);
    if (!outward.length) {
      // The permission stream can identify a camera before the device list does.
      // Preserve exact selection and the Quest front-camera exclusion on fallback.
      for (const track of provisionalStream.getVideoTracks()) {
        if (track.readyState !== "live") continue;
        const camera = { deviceId: track.getSettings().deviceId ?? "", label: track.label };
        const listedCamera = devices.find((device) => device.kind === "videoinput" && device.deviceId === camera.deviceId);
        if (!isOutwardCamera(camera) || (questBrowser && /\bfront\b/i.test(listedCamera?.label ?? ""))) continue;
        outward.push(camera);
        break;
      }
    }
    return outward.map((device, index) => {
      const label = trimDeviceSuffix(device.label) || `Outward camera ${index + 1}`;
      return {
        deviceId: device.deviceId,
        label,
        side: inferCameraSide(label, index, outward.length, questBrowser),
      };
    });
  } finally {
    stopProvisionalCameraStream(provisionalStream);
  }
}

export async function openSelectedCamera(deviceId: string) {
  return requireMediaDevices().getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false,
  });
}

export async function openMicrophone() {
  return requireMediaDevices().getUserMedia({ video: false, audio: true });
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}
