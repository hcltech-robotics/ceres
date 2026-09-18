import { openSelectedCamera, stopStream, type CameraChoice } from "./quest-camera.js";

export const BRIDGE_BOTH_CAMERAS = "bridge-both-cameras";

export interface OpenBridgeCamera {
  choice: CameraChoice;
  stream: MediaStream;
  track: MediaStreamTrack;
}

export function bridgeStereoCameraChoices(choices: readonly CameraChoice[]): CameraChoice[] {
  const right = choices.find((choice) => choice.side === "right");
  const left = choices.find((choice) => choice.side === "left" && choice.deviceId !== right?.deviceId);
  return right && left ? [right, left] : [];
}

export function bridgeSelectedCameraChoices(choices: readonly CameraChoice[], selection: string): CameraChoice[] {
  if (selection === BRIDGE_BOTH_CAMERAS) {
    const stereo = bridgeStereoCameraChoices(choices);
    if (stereo.length !== 2) throw new Error("Both left and right cameras must be available");
    return stereo;
  }
  const camera = choices.find((choice) => choice.deviceId === selection);
  if (!camera) throw new Error("The selected camera is unavailable");
  return [camera];
}

/** Releases every acquired track if acquisition fails or the selection changes. */
export async function openBridgeCameraSelection(
  choices: readonly CameraChoice[],
  signal: AbortSignal,
  openCamera: (deviceId: string) => Promise<MediaStream> = openSelectedCamera,
): Promise<OpenBridgeCamera[] | null> {
  const cameras: OpenBridgeCamera[] = [];
  const release = () => cameras.forEach(({ stream }) => stopStream(stream));
  signal.addEventListener("abort", release, { once: true });
  try {
    for (const choice of choices) {
      if (signal.aborted) return null;
      const stream = await openCamera(choice.deviceId);
      const track = stream.getVideoTracks()[0];
      if (signal.aborted || !track || track.readyState !== "live") {
        stopStream(stream);
        if (signal.aborted) return null;
        throw new Error(`The ${choice.side === "unknown" ? "selected" : choice.side} camera did not provide a live video track`);
      }
      cameras.push({ choice, stream, track });
    }
    if (cameras.some(({ track }) => track.readyState !== "live")) {
      throw new Error("A selected camera stopped while the cameras were opening");
    }
    return cameras;
  } catch (error) {
    release();
    if (signal.aborted) return null;
    throw error;
  } finally {
    signal.removeEventListener("abort", release);
    if (signal.aborted) release();
  }
}
