import type { RuntimeFeatures } from "../shared/protocol.js";

export function runtimeFeaturesFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): RuntimeFeatures {
  return { speech: environment.CERES_SPEECH_ENABLED === "1" };
}
