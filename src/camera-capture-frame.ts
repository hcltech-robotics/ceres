import type { CameraCaptureFrame } from "../shared/camera-capture-frame.js";

export {
  CAMERA_CAPTURE_OUTPUT_WIDTH,
  CAMERA_CAPTURE_SOURCE_SCALE,
  CAMERA_CAPTURE_VERTICAL_CENTRE,
  cameraCaptureFrame,
  cameraCaptureFrameKey,
  cameraRegistrationForCaptureFrame,
  normaliseCameraCaptureFrame,
  type CameraCaptureFrame,
} from "../shared/camera-capture-frame.js";

type VideoFrameCallback = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class CameraCaptureComposer {
  readonly canvas: HTMLCanvasElement;
  readonly frame: CameraCaptureFrame;
  readonly stream: MediaStream;
  private readonly context: CanvasRenderingContext2D;
  private readonly onFailure: (error: Error) => void;
  private outputTrack: MediaStreamTrack | null = null;
  private readonly source: FrameCallbackVideo;
  private readonly sourceTrack: MediaStreamTrack;
  private animationFrame: number | null = null;
  private failureReported = false;
  private videoFrameCallback: number | null = null;
  private disposed = false;

  private readonly handleSourceEnded = () => {
    this.fail(new Error("The camera source ended while preparing the recording frame"));
  };

  private readonly handleSourceMuted = () => {
    this.fail(new Error("The camera source stopped delivering video frames"));
  };

  private readonly handleSourceError = () => {
    this.fail(new Error("The camera preview failed while preparing the recording frame"));
  };

  private readonly handleOutputEnded = () => {
    this.fail(new Error("The composed camera recording track ended"));
  };

  constructor(
    source: HTMLVideoElement,
    sourceTrack: MediaStreamTrack,
    frame: CameraCaptureFrame,
    frameRate: number,
    onFailure: (error: Error) => void,
  ) {
    this.source = source;
    this.sourceTrack = sourceTrack;
    this.frame = frame;
    this.onFailure = onFailure;
    if (sourceTrack.readyState !== "live" || sourceTrack.muted) {
      throw new Error("The camera source is not delivering live video frames");
    }
    this.canvas = document.createElement("canvas");
    this.canvas.width = frame.outputWidth;
    this.canvas.height = frame.outputHeight;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The camera capture surface is unavailable");
    this.context = context;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";
    const requestedFrameRate = Number.isFinite(frameRate)
      ? Math.max(1, Math.min(60, frameRate))
      : 30;
    this.stream = this.canvas.captureStream(requestedFrameRate);
    const outputTracks = this.stream.getVideoTracks();
    if (outputTracks.length !== 1) {
      this.dispose();
      throw new Error("The camera capture surface did not provide a video track");
    }
    this.outputTrack = outputTracks[0];
    this.sourceTrack.addEventListener("ended", this.handleSourceEnded);
    this.sourceTrack.addEventListener("mute", this.handleSourceMuted);
    this.source.addEventListener("error", this.handleSourceError);
    this.outputTrack.addEventListener("ended", this.handleOutputEnded);
    try {
      this.drawFrame();
      this.scheduleFrame();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.videoFrameCallback !== null) {
      this.source.cancelVideoFrameCallback?.(this.videoFrameCallback);
      this.videoFrameCallback = null;
    }
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.sourceTrack.removeEventListener("ended", this.handleSourceEnded);
    this.sourceTrack.removeEventListener("mute", this.handleSourceMuted);
    this.source.removeEventListener("error", this.handleSourceError);
    this.outputTrack?.removeEventListener("ended", this.handleOutputEnded);
    this.stream?.getTracks().forEach((track) => track.stop());
  }

  isLive() {
    return !this.disposed
      && this.sourceTrack.readyState === "live"
      && !this.sourceTrack.muted
      && this.outputTrack?.readyState === "live";
  }

  private drawFrame() {
    if (this.disposed || this.source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const frame = this.frame;
    this.context.drawImage(
      this.source,
      frame.sourceX,
      frame.sourceY,
      frame.sourceCropWidth,
      frame.sourceCropHeight,
      0,
      0,
      frame.outputWidth,
      frame.outputHeight,
    );
  }

  private scheduleFrame() {
    if (this.disposed) return;
    if (typeof this.source.requestVideoFrameCallback === "function") {
      this.videoFrameCallback = this.source.requestVideoFrameCallback(() => {
        this.videoFrameCallback = null;
        try {
          this.drawFrame();
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("The camera frame could not be composed"));
          return;
        }
        this.scheduleFrame();
      });
      return;
    }
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      try {
        this.drawFrame();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("The camera frame could not be composed"));
        return;
      }
      this.scheduleFrame();
    });
  }

  private fail(error: Error) {
    if (this.disposed || this.failureReported) return;
    this.failureReported = true;
    this.dispose();
    this.onFailure(error);
  }
}
