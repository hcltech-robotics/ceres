import {
  BlobSource,
  BufferTarget,
  Conversion,
  type EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  type InputVideoTrack,
  MP4,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  UrlSource,
  WEBM,
  type VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeVideo,
} from "mediabunny";
import {
  episodeExportTimeline,
  type EpisodeExportFrameRange,
  type EpisodeExportManifest,
  type EpisodeExportTimeline,
} from "../../shared/lerobot-export.js";
import { withErrorContext } from "../worker-errors.js";
import { exportHeaders, isMonitorOpfsUrl, readMonitorOpfsEpisodeVideo } from "./episode-source.js";
import type { MonitorExportFfmpegStage } from "./types.js";

export interface ExportVideoMetadata {
  width: number;
  height: number;
  channels: number;
  fps: number;
  frame_count: number;
  duration_s: number;
  codec: string;
  pixel_format: string;
  has_audio: boolean;
  is_depth_map: boolean;
  backend: ExportVideoBackend;
}

export type ExportVideoBackend = "mediabunny-remux" | "mediabunny-webcodecs" | "ffmpeg-wasm";

export const EPISODE_MP4_FAST_START = false as const;

export type ExportVideoRemuxDecision =
  | "exact_alignment"
  | "normalised_prefix"
  | "rejected_frame_selection"
  | "rejected_source_codec"
  | "rejected_packet_shortage"
  | "rejected_keyframe"
  | "rejected_unverified"
  | "failed";

export type ExportVideoHardwareAttempt =
  | "not_needed"
  | "prefer_hardware_succeeded"
  | "prefer_hardware_failed_no_preference_succeeded"
  | "no_preference_only_succeeded"
  | "webcodecs_unavailable_or_failed";

export type ExportVideoFallbackReason =
  | "none"
  | "mediabunny_input_failed"
  | "mediabunny_remux_output_validation_failed"
  | "webcodecs_api_unavailable"
  | "webcodecs_config_unsupported"
  | "webcodecs_conversion_failed"
  | "webcodecs_output_validation_failed";

export interface ExportVideoPreparationProfile {
  backend: ExportVideoBackend;
  remuxDecision: ExportVideoRemuxDecision;
  hardwareAttempt: ExportVideoHardwareAttempt;
  fallbackReason: ExportVideoFallbackReason;
  elapsedMs: number;
}

export interface PreparedExportVideo {
  bytes: Uint8Array;
  metadata: ExportVideoMetadata;
  backend: ExportVideoBackend;
  profile: ExportVideoPreparationProfile;
}

export function canRemuxEpisodeVideo(
  codec: string | null,
  packetCount: number,
  duration: number,
  frameCount: number,
  fps: number,
) {
  const expectedDuration = frameCount / fps;
  return codec === "avc"
    && packetCount === frameCount
    && Math.abs(duration - expectedDuration) <= 1 / fps;
}

export function canNormaliseAvcPacketPrefix(
  packetCount: number,
  frameCount: number,
  fps: number,
) {
  if (!Number.isInteger(packetCount) || !Number.isInteger(frameCount) || frameCount < 1) {
    return false;
  }
  const maximumTailPacketCount = maximumNormalisedAvcTailPacketCount(fps);
  return maximumTailPacketCount !== null
    && packetCount >= frameCount
    && packetCount - frameCount <= maximumTailPacketCount;
}

export function hasNormalisedAvcFrameTiming(
  timestamp: number,
  duration: number,
  firstTimestamp: number,
  frameIndex: number,
  fps: number,
) {
  const frameDuration = normalisedAvcFrameDuration(fps);
  if (
    frameDuration === null
    || !Number.isFinite(timestamp)
    || !Number.isFinite(duration)
    || !Number.isFinite(firstTimestamp)
    || !Number.isInteger(frameIndex)
    || frameIndex < 0
  ) {
    return false;
  }
  const tolerance = frameDuration * 0.2;
  const expectedTimestamp = firstTimestamp + frameIndex * frameDuration;
  return Math.abs(timestamp - expectedTimestamp) <= tolerance
    && Math.abs(duration - frameDuration) <= tolerance;
}

/**
 * Mediabunny's packet statistics are optional for some browser decoders. A
 * missing count must select the verified conversion path rather than make the
 * export fail while formatting the progress result.
 */
export function mediabunnyPacketCount(stats: { packetCount?: unknown } | null | undefined) {
  const packetCount = stats?.packetCount;
  return typeof packetCount === "number"
    && Number.isSafeInteger(packetCount)
    && packetCount >= 0
    ? packetCount
    : null;
}

export function ffmpegCoreLoadConfig(origin: string) {
  const base = new URL("/vendor/ffmpeg-core/", origin);
  return {
    coreURL: new URL("ffmpeg-core.js", base).href,
    wasmURL: new URL("ffmpeg-core.wasm", base).href,
  };
}

export function ffmpegPhaseFailure(
  error: unknown,
  stage: MonitorExportFfmpegStage,
): Error {
  const failure = error instanceof Error
    ? error
    : typeof error === "string"
      ? Object.assign(new Error(error), { name: "StringRejection" })
      : Object.assign(new Error("JavaScript error"), { name: "UnknownError" });
  return withErrorContext(failure, { stage });
}

async function runFfmpegPhase<T>(
  stage: MonitorExportFfmpegStage,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  try {
    return await operation();
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    throw ffmpegPhaseFailure(error, stage);
  }
}

export function mediabunnyDiscardReasons(discardedTracks: unknown): string[] {
  if (!Array.isArray(discardedTracks)) return [];
  return discardedTracks.flatMap((track) => {
    if (!track || typeof track !== "object") return [];
    const reason = (track as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim() ? [reason] : [];
  });
}

export function assertValidMediabunnyConversion(conversion: unknown): asserts conversion is Conversion {
  if (!conversion || typeof conversion !== "object") {
    throw new Error("Mediabunny conversion did not initialise");
  }
  const candidate = conversion as { isValid?: unknown; discardedTracks?: unknown };
  if (candidate.isValid === true) return;
  const reasons = mediabunnyDiscardReasons(candidate.discardedTracks);
  throw new Error(`Mediabunny conversion is invalid${reasons.length ? `: ${reasons.join(", ")}` : ""}`);
}

export function canUseMediabunnyVideoPath(
  canRemux: boolean,
  videoEncoderAvailable = typeof VideoEncoder !== "undefined",
  videoDecoderAvailable = typeof VideoDecoder !== "undefined",
) {
  return canRemux || videoEncoderAvailable && videoDecoderAvailable;
}

export function ffmpegEpisodeVideoArguments(
  inputName: string,
  outputName: string,
  frameCount: number,
  sourceSlotCount: number,
  fps: number,
  frameRanges?: EpisodeExportFrameRange[],
) {
  const selection = frameRanges && frameRanges.length > 0
    ? frameRanges.map((range) => (
        `gte(n\\,${range.startFrameIndex})*lt(n\\,${range.endFrameIndex})`
      )).join("+")
    : null;
  const normalisedSource = `fps=${fps},tpad=stop_mode=clone:stop=-1,trim=end_frame=${sourceSlotCount}`;
  const videoFilter = `${normalisedSource}${selection ? `,select=${selection}` : ""},setpts=N/(${fps}*TB)`;
  return [
    "-i", inputName,
    "-an",
    "-vf", videoFilter,
    "-frames:v", String(frameCount),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    outputName,
  ];
}

export function mediabunnyOutputFrameIndex(
  sourceFrameIndex: number,
  frameRanges: readonly EpisodeExportFrameRange[],
) {
  let outputFrameIndex = 0;
  for (const range of frameRanges) {
    if (sourceFrameIndex < range.startFrameIndex) return null;
    if (sourceFrameIndex < range.endFrameIndex) {
      return outputFrameIndex + sourceFrameIndex - range.startFrameIndex;
    }
    outputFrameIndex += range.endFrameIndex - range.startFrameIndex;
  }
  return null;
}

export function mediabunnyTerminalPaddingTimestamp(
  lastTimestamp: number,
  frameCount: number,
  fps: number,
) {
  if (
    !Number.isFinite(lastTimestamp)
    || !Number.isSafeInteger(frameCount)
    || frameCount < 1
    || !Number.isFinite(fps)
    || fps <= 0
  ) return null;
  const finalTimestamp = (frameCount - 1) / fps;
  return lastTimestamp < finalTimestamp ? finalTimestamp : null;
}

export async function prepareEpisodeVideo(
  manifest: EpisodeExportManifest,
  signal: AbortSignal,
  onProgress: (progress: number, backend: string) => void,
  exportCapability?: string,
): Promise<PreparedExportVideo | null> {
  const startedAt = performance.now();
  const reportProgress = createMonotonicProgressReporter(onProgress);
  const descriptor = manifest.blobs.find((blob) => blob.id === "video");
  if (!descriptor) return null;
  const source = isMonitorOpfsUrl(descriptor.url)
    ? await readMonitorOpfsEpisodeVideo(manifest, signal)
    : new URL(descriptor.url, location.origin);
  if (!source) return null;
  const timeline = episodeExportTimeline(manifest.episode);
  let remuxDecision: ExportVideoRemuxDecision = "failed";
  let fallbackReason: ExportVideoFallbackReason = "mediabunny_input_failed";
  let completedBackend: MediabunnyPreparedVideo["backend"] | null = null;
  try {
    const converted = await convertWithMediabunny(
      source,
      manifest,
      timeline,
      signal,
      reportProgress,
      exportCapability,
    );
    completedBackend = converted.backend;
    remuxDecision = converted.remuxDecision;
    const metadata = await inspectVideo(converted.bytes, manifest, timeline, converted.backend);
    reportProgress(1, converted.backend);
    return {
      bytes: converted.bytes,
      metadata,
      backend: converted.backend,
      profile: {
        backend: converted.backend,
        remuxDecision,
        hardwareAttempt: converted.hardwareAttempt,
        fallbackReason: "none",
        elapsedMs: elapsedMilliseconds(startedAt),
      },
    };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    if (error instanceof MediabunnyVideoPreparationFailure) {
      remuxDecision = error.remuxDecision;
      fallbackReason = error.fallbackReason;
    } else if (completedBackend === "mediabunny-remux") {
      fallbackReason = "mediabunny_remux_output_validation_failed";
    } else if (completedBackend === "mediabunny-webcodecs") {
      fallbackReason = "webcodecs_output_validation_failed";
    }
    console.warn("Mediabunny video preparation failed; using ffmpeg.wasm", error);
    reportProgress(0, "ffmpeg-wasm");
  }
  const bytes = await convertWithFfmpeg(
    source,
    descriptor.mediaType,
    manifest,
    timeline,
    signal,
    (progress) => reportProgress(Math.min(progress, 0.99), "ffmpeg-wasm"),
    exportCapability,
  );
  const metadata = await runFfmpegPhase(
    "ffmpeg_inspect",
    signal,
    () => inspectVideo(bytes, manifest, timeline, "ffmpeg-wasm"),
  );
  reportProgress(1, "ffmpeg-wasm");
  return {
    bytes,
    metadata,
    backend: "ffmpeg-wasm",
    profile: {
      backend: "ffmpeg-wasm",
      remuxDecision,
      hardwareAttempt: "webcodecs_unavailable_or_failed",
      fallbackReason,
      elapsedMs: elapsedMilliseconds(startedAt),
    },
  };
}

interface MediabunnyPreparedVideo {
  bytes: Uint8Array;
  backend: "mediabunny-remux" | "mediabunny-webcodecs";
  remuxDecision: ExportVideoRemuxDecision;
  hardwareAttempt: ExportVideoHardwareAttempt;
}

class MediabunnyVideoPreparationFailure extends Error {
  constructor(
    readonly remuxDecision: ExportVideoRemuxDecision,
    readonly fallbackReason: ExportVideoFallbackReason,
    readonly cause: unknown,
  ) {
    super("Mediabunny video preparation failed");
    this.name = "MediabunnyVideoPreparationFailure";
  }
}

class NormalisedAvcPrefixRejection extends Error {
  constructor(readonly decision: ExportVideoRemuxDecision) {
    super("AVC prefix remux was rejected");
    this.name = "NormalisedAvcPrefixRejection";
  }
}

async function convertWithMediabunny(
  source: URL | Blob,
  manifest: EpisodeExportManifest,
  timeline: EpisodeExportTimeline,
  signal: AbortSignal,
  onProgress: (progress: number, backend: ExportVideoBackend) => void,
  exportCapability?: string,
): Promise<MediabunnyPreparedVideo> {
  const input = createMediabunnyInput(source, exportCapability);
  let remuxDecision: ExportVideoRemuxDecision = "failed";
  let codedWidth = 0;
  let codedHeight = 0;
  let webcodecsDecoderSupported = false;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw new MediabunnyVideoPreparationFailure(
        "rejected_unverified",
        "mediabunny_input_failed",
        new Error("Episode video has no video track"),
      );
    }
    const codec = await track.getCodec();
    const selectFrameRanges = requiresVideoFrameSelection(timeline);
    codedWidth = await track.getCodedWidth();
    codedHeight = await track.getCodedHeight();

    if (selectFrameRanges) {
      remuxDecision = "rejected_frame_selection";
    } else if (codec !== "avc") {
      remuxDecision = "rejected_source_codec";
    } else {
      const [duration, stats] = await Promise.all([
        input.computeDuration(),
        track.computePacketStats(),
      ]);
      const packetCount = mediabunnyPacketCount(stats);
      if (packetCount !== null && canRemuxEpisodeVideo(
        codec,
        packetCount,
        duration,
        timeline.frameCount,
        manifest.fps,
      )) {
        try {
          const bytes = await executeMediabunnyConversion(
            input,
            manifest,
            timeline,
            signal,
            "mediabunny-remux",
            (progress, backend) => onProgress(progress * 0.1, backend),
            false,
            "no-preference",
          );
          return {
            bytes,
            backend: "mediabunny-remux",
            remuxDecision: "exact_alignment",
            hardwareAttempt: "not_needed",
          };
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error;
          remuxDecision = "failed";
        }
      } else {
        const normalised = await tryNormalisedAvcPrefix(
          track,
          timeline.frameCount,
          manifest.fps,
          packetCount,
          signal,
          (progress) => onProgress(progress * 0.1, "mediabunny-remux"),
        );
        if (normalised.bytes) {
          return {
            bytes: normalised.bytes,
            backend: "mediabunny-remux",
            remuxDecision: "normalised_prefix",
            hardwareAttempt: "not_needed",
          };
        }
        remuxDecision = normalised.decision;
      }
    }
    if (canUseMediabunnyVideoPath(false)) {
      webcodecsDecoderSupported = await track.canDecode().catch(() => false);
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    if (error instanceof MediabunnyVideoPreparationFailure) throw error;
    throw new MediabunnyVideoPreparationFailure(
      remuxDecision,
      "mediabunny_input_failed",
      error,
    );
  } finally {
    input.dispose();
  }

  if (!canUseMediabunnyVideoPath(false)) {
    throw new MediabunnyVideoPreparationFailure(
      remuxDecision,
      "webcodecs_api_unavailable",
      new Error("WebCodecs video coding is unavailable for transcoding"),
    );
  }

  const noPreferenceSupported = await canEncodeVideo("avc", {
    width: codedWidth,
    height: codedHeight,
    bitrate: QUALITY_HIGH,
    hardwareAcceleration: "no-preference",
  }).catch(() => false);
  if (!webcodecsDecoderSupported || !noPreferenceSupported) {
    throw new MediabunnyVideoPreparationFailure(
      remuxDecision,
      "webcodecs_config_unsupported",
      new Error("WebCodecs cannot decode the source or encode the required AVC profile"),
    );
  }

  const preferHardwareSupported = await canEncodeVideo("avc", {
    width: codedWidth,
    height: codedHeight,
    bitrate: QUALITY_HIGH,
    hardwareAcceleration: "prefer-hardware",
  }).catch(() => false);
  const hardwarePreferences = mediabunnyHardwarePreferences(preferHardwareSupported);
  let preferHardwareFailed = false;
  let lastFailure: unknown = new Error("Mediabunny WebCodecs transcoding did not run");
  for (let attemptIndex = 0; attemptIndex < hardwarePreferences.length; attemptIndex += 1) {
    const hardwareAcceleration = hardwarePreferences[attemptIndex];
    try {
      const transcodingInput = createMediabunnyInput(source, exportCapability);
      try {
        const bytes = await executeMediabunnyConversion(
          transcodingInput,
          manifest,
          timeline,
          signal,
          "mediabunny-webcodecs",
          (progress, backend) => onProgress(
            mediabunnyAttemptProgress(attemptIndex, hardwarePreferences.length, progress),
            backend,
          ),
          true,
          hardwareAcceleration,
          remuxDecision === "rejected_packet_shortage",
        );
        return {
          bytes,
          backend: "mediabunny-webcodecs",
          remuxDecision,
          hardwareAttempt: hardwareAcceleration === "prefer-hardware"
            ? "prefer_hardware_succeeded"
            : preferHardwareFailed
              ? "prefer_hardware_failed_no_preference_succeeded"
              : "no_preference_only_succeeded",
        };
      } finally {
        transcodingInput.dispose();
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      lastFailure = error;
      if (hardwareAcceleration === "prefer-hardware") preferHardwareFailed = true;
    }
  }
  throw new MediabunnyVideoPreparationFailure(
    remuxDecision,
    "webcodecs_conversion_failed",
    lastFailure,
  );
}

function createMediabunnyInput(source: URL | Blob, exportCapability?: string) {
  return new Input({
    formats: [MP4, WEBM],
    source: source instanceof Blob
      ? new BlobSource(source)
      : new UrlSource(source, {
        maxCacheSize: 8 * 1024 * 1024,
        parallelism: 2,
        getRetryDelay: (attempt) => attempt >= 3 ? null : Math.min(2 ** attempt, 4),
        requestInit: {
          cache: "no-store",
          credentials: "same-origin",
          headers: exportHeaders(exportCapability),
        },
      }),
  });
}

export function mediabunnyHardwarePreferences(preferHardwareSupported: boolean) {
  return preferHardwareSupported
    ? ["prefer-hardware", "no-preference"] as const
    : ["no-preference"] as const;
}

export function mediabunnyAttemptProgress(
  attemptIndex: number,
  attemptCount: number,
  progress: number,
) {
  const boundedAttemptCount = Math.max(1, Math.floor(attemptCount));
  const boundedAttemptIndex = Math.max(0, Math.min(boundedAttemptCount - 1, Math.floor(attemptIndex)));
  const boundedProgress = Math.max(0, Math.min(1, progress));
  return 0.1 + (0.89 / boundedAttemptCount) * (boundedAttemptIndex + boundedProgress);
}

async function executeMediabunnyConversion(
  input: Input,
  manifest: EpisodeExportManifest,
  timeline: EpisodeExportTimeline,
  signal: AbortSignal,
  backend: "mediabunny-remux" | "mediabunny-webcodecs",
  onProgress: (progress: number, backend: ExportVideoBackend) => void,
  forceTranscode: boolean,
  hardwareAcceleration: "prefer-hardware" | "no-preference",
  padTerminalFrame = false,
) {
  if (forceTranscode && padTerminalFrame) {
    return executeMediabunnyPaddedTranscode(
      input,
      manifest,
      timeline,
      signal,
      onProgress,
      hardwareAcceleration,
    );
  }
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: EPISODE_MP4_FAST_START }),
    target,
  });
  let conversion: Conversion | null = null;
  const abort = () => void conversion?.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("Episode video has no video track");
    const selectFrameRanges = requiresVideoFrameSelection(timeline);
    let sourceFrameIndex = 0;
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: !forceTranscode
        ? {
            codec: "avc",
            forceTranscode: false,
          }
        : {
            codec: "avc",
            bitrate: QUALITY_HIGH,
            frameRate: manifest.fps,
            forceTranscode: true,
            hardwareAcceleration,
            keyFrameInterval: 2,
            ...(selectFrameRanges
              ? {
                  process: (sample) => {
                    const outputFrameIndex = mediabunnyOutputFrameIndex(
                      sourceFrameIndex,
                      timeline.frameRanges,
                    );
                    sourceFrameIndex += 1;
                    if (outputFrameIndex === null) return null;
                    sample.setTimestamp(outputFrameIndex / manifest.fps);
                    sample.setDuration(1 / manifest.fps);
                    return sample;
                  },
                }
              : {}),
          },
      audio: { discard: true },
      showWarnings: false,
    });
    assertValidMediabunnyConversion(conversion);
    conversion.onProgress = (progress) => onProgress(progress, backend);
    signal.throwIfAborted();
    await conversion.execute();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error("Mediabunny produced no MP4 bytes");
    return new Uint8Array(target.buffer);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function executeMediabunnyPaddedTranscode(
  input: Input,
  manifest: EpisodeExportManifest,
  timeline: EpisodeExportTimeline,
  signal: AbortSignal,
  onProgress: (progress: number, backend: ExportVideoBackend) => void,
  hardwareAcceleration: "prefer-hardware" | "no-preference",
) {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("Episode video has no video track");
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: EPISODE_MP4_FAST_START }),
    target,
  });
  let outputFrameCount = 0;
  const sampleSource = new VideoSampleSource({
    codec: "avc",
    bitrate: QUALITY_HIGH,
    hardwareAcceleration,
    keyFrameInterval: 2,
    transform: {
      frameRate: manifest.fps,
      process: (sample) => {
        if (outputFrameCount >= timeline.frameCount) return null;
        sample.setTimestamp(outputFrameCount / manifest.fps);
        sample.setDuration(1 / manifest.fps);
        outputFrameCount += 1;
        onProgress(outputFrameCount / timeline.frameCount, "mediabunny-webcodecs");
        return sample;
      },
    },
  });
  output.addVideoTrack(sampleSource, {
    frameRate: manifest.fps,
    maximumPacketCount: timeline.frameCount,
    rotation: await track.getRotation(),
  });
  const abort = () => void output.cancel();
  let lastSample: VideoSample | null = null;
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await output.start();
    const startTimestamp = Math.max(0, await track.getFirstTimestamp());
    const sink = new VideoSampleSink(track, { hardwareAcceleration });
    for await (const sample of sink.samples(startTimestamp)) {
      try {
        signal.throwIfAborted();
        const adjustedTimestamp = Math.max(0, sample.timestamp - startTimestamp);
        sample.setTimestamp(adjustedTimestamp);
        lastSample?.close();
        lastSample = sample.clone();
        lastTimestamp = adjustedTimestamp;
        await sampleSource.add(sample);
      } finally {
        sample.close();
      }
    }
    if (!lastSample) throw new Error("Episode video has no decodable frames");
    const paddingTimestamp = mediabunnyTerminalPaddingTimestamp(
      lastTimestamp,
      timeline.frameCount,
      manifest.fps,
    );
    if (paddingTimestamp !== null) {
      const terminalSample = lastSample.clone();
      try {
        terminalSample.setTimestamp(paddingTimestamp);
        terminalSample.setDuration(1 / manifest.fps);
        await sampleSource.add(terminalSample);
      } finally {
        terminalSample.close();
      }
    }
    sampleSource.close();
    await output.finalize();
    signal.throwIfAborted();
    if (outputFrameCount !== timeline.frameCount) {
      throw new Error(
        `Mediabunny produced ${outputFrameCount} frames but ${timeline.frameCount} are required`,
      );
    }
    if (!target.buffer) throw new Error("Mediabunny produced no MP4 bytes");
    return new Uint8Array(target.buffer);
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    lastSample?.close();
    signal.removeEventListener("abort", abort);
  }
}

interface NormalisedAvcPrefixResult {
  bytes: Uint8Array | null;
  decision: ExportVideoRemuxDecision;
}

async function tryNormalisedAvcPrefix(
  track: InputVideoTrack,
  frameCount: number,
  fps: number,
  packetCount: number | null,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<NormalisedAvcPrefixResult> {
  try {
    return await normaliseAvcPrefix(
      track,
      frameCount,
      fps,
      packetCount,
      signal,
      onProgress,
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    return {
      bytes: null,
      decision: error instanceof NormalisedAvcPrefixRejection ? error.decision : "failed",
    };
  }
}

async function normaliseAvcPrefix(
  track: InputVideoTrack,
  frameCount: number,
  fps: number,
  packetCount: number | null,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<NormalisedAvcPrefixResult> {
  if (packetCount !== null && packetCount < frameCount) {
    throw new NormalisedAvcPrefixRejection("rejected_packet_shortage");
  }
  if (packetCount !== null && !canNormaliseAvcPacketPrefix(packetCount, frameCount, fps)) {
    throw new NormalisedAvcPrefixRejection("rejected_unverified");
  }
  const maximumTailPacketCount = maximumNormalisedAvcTailPacketCount(fps);
  if (maximumTailPacketCount === null || !Number.isInteger(frameCount) || frameCount < 1) {
    throw new NormalisedAvcPrefixRejection("rejected_unverified");
  }
  const sink = new EncodedPacketSink(track);
  const firstPacket = await sink.getFirstPacket({ verifyKeyPackets: true });
  if (!firstPacket || firstPacket.type !== "key") {
    throw new NormalisedAvcPrefixRejection("rejected_keyframe");
  }
  const firstTimestamp = await validateNormalisedAvcPrefixTiming(
    sink,
    firstPacket,
    frameCount,
    fps,
    packetCount,
    maximumTailPacketCount,
    signal,
  );
  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) throw new NormalisedAvcPrefixRejection("rejected_unverified");

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: EPISODE_MP4_FAST_START }),
    target,
  });
  const packetSource = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(packetSource, {
    frameRate: fps,
    maximumPacketCount: frameCount,
    rotation: await track.getRotation(),
  });
  const abort = () => void output.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await output.start();
    let copied = 0;
    let lastTimestamp = Number.NEGATIVE_INFINITY;
    for await (const packet of sink.packets(firstPacket, undefined, { verifyKeyPackets: true })) {
      signal.throwIfAborted();
      if (
        packet.timestamp <= lastTimestamp
        || !hasNormalisedAvcFrameTiming(
          packet.timestamp,
          packet.duration,
          firstTimestamp,
          copied,
          fps,
        )
      ) {
        throw new NormalisedAvcPrefixRejection("rejected_unverified");
      }
      lastTimestamp = packet.timestamp;
      const normalised = packet.clone({
        timestamp: copied / fps,
        duration: 1 / fps,
        sequenceNumber: copied,
        sideData: {},
      });
      await packetSource.add(
        normalised,
        copied === 0 ? { decoderConfig } : undefined,
      );
      copied += 1;
      onProgress(copied / frameCount);
      if (copied === frameCount) break;
    }
    if (copied !== frameCount) {
      throw new NormalisedAvcPrefixRejection("rejected_packet_shortage");
    }
    packetSource.close();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer) throw new NormalisedAvcPrefixRejection("failed");
    return { bytes: new Uint8Array(target.buffer), decision: "normalised_prefix" };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function validateNormalisedAvcPrefixTiming(
  sink: EncodedPacketSink,
  firstPacket: EncodedPacket,
  frameCount: number,
  fps: number,
  packetCount: number | null,
  maximumTailPacketCount: number,
  signal: AbortSignal,
) {
  const firstTimestamp = firstPacket.timestamp;
  let requiredPacketCount = 0;
  let tailPacketCount = 0;
  let observedPacketCount = 0;
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  let lastRequiredTimestamp = Number.NEGATIVE_INFINITY;
  let lastDuration = 0;
  for await (const packet of sink.packets(firstPacket, undefined, { metadataOnly: true })) {
    signal.throwIfAborted();
    observedPacketCount += 1;
    if (requiredPacketCount < frameCount) {
      if (
        packet.timestamp <= lastTimestamp
        || !hasNormalisedAvcFrameTiming(
          packet.timestamp,
          packet.duration,
          firstTimestamp,
          requiredPacketCount,
          fps,
        )
      ) {
        throw new NormalisedAvcPrefixRejection("rejected_unverified");
      }
      requiredPacketCount += 1;
      lastTimestamp = packet.timestamp;
      lastRequiredTimestamp = packet.timestamp;
      lastDuration = packet.duration;
      continue;
    }
    tailPacketCount += 1;
    if (
      tailPacketCount > maximumTailPacketCount
      || !isNormalisedAvcTerminalPacket(
        packet.timestamp,
        packet.duration,
        lastTimestamp,
        firstTimestamp,
        frameCount,
        fps,
      )
    ) {
      throw new NormalisedAvcPrefixRejection("rejected_unverified");
    }
    lastTimestamp = packet.timestamp;
  }
  if (requiredPacketCount !== frameCount) {
    throw new NormalisedAvcPrefixRejection("rejected_packet_shortage");
  }
  if (packetCount !== null && observedPacketCount !== packetCount) {
    throw new NormalisedAvcPrefixRejection("rejected_unverified");
  }
  if (!hasNormalisedAvcTimestampCoverage(
    lastRequiredTimestamp,
    lastDuration,
    firstTimestamp,
    frameCount,
    fps,
  )) {
    throw new NormalisedAvcPrefixRejection("rejected_unverified");
  }
  return firstTimestamp;
}

function isNormalisedAvcTerminalPacket(
  timestamp: number,
  duration: number,
  previousTimestamp: number,
  firstTimestamp: number,
  frameCount: number,
  fps: number,
) {
  const frameDuration = normalisedAvcFrameDuration(fps);
  if (
    frameDuration === null
    || !Number.isFinite(timestamp)
    || !Number.isFinite(duration)
    || duration < 0
  ) {
    return false;
  }
  const expectedCutoff = firstTimestamp + frameCount * frameDuration;
  const tolerance = frameDuration * 0.2;
  return timestamp > previousTimestamp && timestamp >= expectedCutoff - tolerance;
}

function hasNormalisedAvcTimestampCoverage(
  lastTimestamp: number,
  lastDuration: number,
  firstTimestamp: number,
  frameCount: number,
  fps: number,
) {
  const frameDuration = normalisedAvcFrameDuration(fps);
  if (frameDuration === null) return false;
  const expectedCutoff = firstTimestamp + frameCount * frameDuration;
  return Math.abs(lastTimestamp + lastDuration - expectedCutoff) <= frameDuration * 0.2;
}

function normalisedAvcFrameDuration(fps: number) {
  return Number.isFinite(fps) && fps > 0 ? 1 / fps : null;
}

function maximumNormalisedAvcTailPacketCount(fps: number) {
  return Number.isFinite(fps) && fps > 0 ? Math.floor(fps * 2) : null;
}

function elapsedMilliseconds(startedAt: number) {
  return Math.max(0, performance.now() - startedAt);
}

function createMonotonicProgressReporter(
  report: (progress: number, backend: string) => void,
) {
  let highestProgress = 0;
  return (progress: number, backend: string) => {
    const boundedProgress = Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : highestProgress;
    highestProgress = Math.max(highestProgress, boundedProgress);
    report(highestProgress, backend);
  };
}

async function convertWithFfmpeg(
  source: URL | Blob,
  mediaType: string,
  manifest: EpisodeExportManifest,
  timeline: EpisodeExportTimeline,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  exportCapability?: string,
): Promise<Uint8Array> {
  let ffmpeg: InstanceType<typeof import("@ffmpeg/ffmpeg")["FFmpeg"]> | null = null;
  const progress = ({ progress: value }: { progress: number }) => onProgress(Math.max(0, Math.min(1, value)));
  const abort = () => ffmpeg?.terminate();
  signal.addEventListener("abort", abort, { once: true });
  const extension = mediaType.includes("mp4") ? "mp4" : "webm";
  const inputName = `input.${extension}`;
  const outputName = "output.mp4";
  try {
    ffmpeg = await runFfmpegPhase("ffmpeg_load", signal, async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const instance = new FFmpeg();
      ffmpeg = instance;
      instance.on("progress", progress);
      await instance.load(ffmpegCoreLoadConfig(location.origin), { signal });
      return instance;
    });
    await runFfmpegPhase("ffmpeg_write", signal, async () => {
      const bytes = source instanceof Blob
        ? new Uint8Array(await source.arrayBuffer())
        : await readVideoBytes(source, signal, exportCapability);
      await ffmpeg!.writeFile(inputName, bytes, { signal });
    });
    await runFfmpegPhase("ffmpeg_exec", signal, async () => {
      const result = await ffmpeg!.exec(ffmpegEpisodeVideoArguments(
        inputName,
        outputName,
        timeline.frameCount,
        timeline.sourceSlotCount,
        manifest.fps,
        requiresVideoFrameSelection(timeline) ? timeline.frameRanges : undefined,
      ), undefined, { signal });
      if (result !== 0) throw new Error(`ffmpeg.wasm exited with code ${result}`);
    });
    return await runFfmpegPhase("ffmpeg_read", signal, async () => {
      await ffmpeg!.deleteFile(inputName, { signal });
      const output = await ffmpeg!.readFile(outputName, undefined, { signal });
      if (typeof output === "string") throw new Error("ffmpeg.wasm returned text instead of MP4 bytes");
      return output;
    });
  } finally {
    signal.removeEventListener("abort", abort);
    ffmpeg?.off("progress", progress);
    ffmpeg?.terminate();
  }
}

async function readVideoBytes(sourceUrl: URL, signal: AbortSignal, exportCapability?: string): Promise<Uint8Array> {
  const response = await fetch(sourceUrl, {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: exportHeaders(exportCapability),
  });
  if (!response.ok) throw new Error(`Episode video could not be read (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function inspectVideo(
  bytes: Uint8Array,
  manifest: EpisodeExportManifest,
  timeline: EpisodeExportTimeline,
  backend: ExportVideoMetadata["backend"],
): Promise<ExportVideoMetadata> {
  const input = new Input({ formats: [MP4, WEBM], source: new BlobSource(new Blob([bytes as BlobPart], { type: "video/mp4" })) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("Converted MP4 has no video track");
    const [width, height, codec, duration, stats, audio] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getCodec(),
      input.computeDuration(),
      track.computePacketStats(),
      input.getPrimaryAudioTrack(),
    ]);
    const packetCount = mediabunnyPacketCount(stats);
    if (packetCount !== null && packetCount !== timeline.frameCount) {
      throw new Error(`Converted MP4 has ${packetCount} frames but ${timeline.frameCount} are required`);
    }
    const expectedDuration = timeline.frameCount / manifest.fps;
    if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - expectedDuration) > 1 / manifest.fps) {
      throw new Error("Converted MP4 duration does not match the sensor episode");
    }
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error("Converted MP4 has invalid dimensions");
    }
    return {
      width,
      height,
      channels: 3,
      fps: manifest.fps,
      frame_count: packetCount ?? timeline.frameCount,
      duration_s: duration,
      codec: codec ?? "avc",
      pixel_format: "yuv420p",
      has_audio: Boolean(audio),
      is_depth_map: false,
      backend,
    };
  } finally {
    input.dispose();
  }
}

export function requiresVideoFrameSelection(timeline: EpisodeExportTimeline): boolean {
  return timeline.frameCount < timeline.sourceSlotCount;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}
