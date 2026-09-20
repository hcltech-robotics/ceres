export const bridgeVideoProfiles = {
  balanced: { label: "Balanced", width: 960, maxBitrate: 4_000_000, maxFramerate: 30 },
  high: { label: "High detail", width: 1280, maxBitrate: 8_000_000, maxFramerate: 30 },
  maximum: { label: "Maximum detail", width: 1920, maxBitrate: 12_000_000, maxFramerate: 30 },
} as const;

export type BridgeVideoQuality = keyof typeof bridgeVideoProfiles;
export const defaultBridgeVideoQuality: BridgeVideoQuality = "high";
export const bridgeVideoQualityKey = "ceres.bridge.video-quality";

export function parseBridgeVideoQuality(value: unknown): BridgeVideoQuality {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(bridgeVideoProfiles, value)
    ? value as BridgeVideoQuality : defaultBridgeVideoQuality;
}

export function bridgeVideoEncoding(quality: BridgeVideoQuality, sourceWidth: number): RTCRtpEncodingParameters {
  const profile = bridgeVideoProfiles[quality];
  return { maxBitrate: profile.maxBitrate, maxFramerate: profile.maxFramerate,
    scaleResolutionDownBy: Math.max(1, sourceWidth / profile.width) };
}

/** Request source detail before applying the independent network encoding budget. */
export async function configureBridgeVideo(track: MediaStreamTrack, quality: BridgeVideoQuality) {
  const profile = bridgeVideoProfiles[quality];
  const capabilities = track.getCapabilities?.();
  const width = Math.min(profile.width, capabilities?.width?.max ?? profile.width);
  const frameRate = Math.min(profile.maxFramerate, capabilities?.frameRate?.max ?? profile.maxFramerate);
  if (track.applyConstraints) {
    try {
      await track.applyConstraints({ width: { ideal: width }, frameRate: { ideal: frameRate } });
    } catch (error) {
      if (!(error instanceof Error) || !["OverconstrainedError", "NotSupportedError"].includes(error.name)) throw error;
      // Some camera drivers expose fixed modes. Keep the acquired source usable.
    }
  }
  track.contentHint = "detail";
}
