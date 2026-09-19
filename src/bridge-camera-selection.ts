import { openSelectedCamera, stopStream, type CameraChoice } from "./quest-camera.js";

export interface OpenBridgeCamera {
  choice: CameraChoice;
  stream: MediaStream;
  track: MediaStreamTrack;
}

export function bridgeSelectedCameraChoice(choices: readonly CameraChoice[], selection: string): CameraChoice {
  // Restore old paired-camera preferences as one camera, independent of enumeration order.
  const camera = selection === "bridge-both-cameras"
    ? choices.find((choice) => choice.side === "right")
      ?? choices.find((choice) => choice.side === "left") ?? choices[0]
    : choices.find((choice) => choice.deviceId === selection);
  if (!camera) throw new Error("The selected camera is unavailable");
  return camera;
}

/** Releases the acquired track if acquisition fails or the selection changes. */
export async function openBridgeCamera(
  choice: CameraChoice,
  signal: AbortSignal,
  openCamera: (deviceId: string) => Promise<MediaStream> = openSelectedCamera,
): Promise<OpenBridgeCamera | null> {
  let stream: MediaStream | null = null;
  const release = () => stopStream(stream);
  signal.addEventListener("abort", release, { once: true });
  try {
    if (signal.aborted) return null;
    stream = await openCamera(choice.deviceId);
    const tracks = stream.getVideoTracks();
    const track = tracks[0];
    if (signal.aborted || tracks.length !== 1 || !track || track.readyState !== "live") {
      release();
      if (signal.aborted) return null;
      throw new Error("The selected camera must provide one live video track");
    }
    return { choice, stream, track };
  } catch (error) {
    release();
    if (signal.aborted) return null;
    throw error;
  } finally {
    signal.removeEventListener("abort", release);
    if (signal.aborted) release();
  }
}
