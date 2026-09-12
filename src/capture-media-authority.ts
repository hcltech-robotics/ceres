export interface CaptureMediaResources {
  cameraStream: MediaStream | null;
  captureStream: MediaStream | null;
  microphoneStream: MediaStream | null;
}

type MediaPreview = Pick<HTMLVideoElement, "pause" | "srcObject">;

export function releaseCaptureMediaResources(
  resources: CaptureMediaResources,
  preview?: MediaPreview | null,
): CaptureMediaResources {
  const tracks = new Set<MediaStreamTrack>();
  for (const stream of [resources.captureStream, resources.microphoneStream, resources.cameraStream]) {
    for (const track of stream?.getTracks() ?? []) tracks.add(track);
  }
  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      // Continue releasing the remaining tracks if one browser source has already failed.
    }
  }
  if (preview) {
    try {
      preview.pause();
    } catch {
      // A detached preview may already be unavailable during terminal teardown.
    }
    preview.srcObject = null;
  }
  return {
    cameraStream: null,
    captureStream: null,
    microphoneStream: null,
  };
}
