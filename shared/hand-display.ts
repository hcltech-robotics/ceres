export const handRenderModes = ["off", "outline", "keypoints", "mesh"] as const;
export type HandRenderMode = typeof handRenderModes[number];
export type HandMeshStatus = "available" | "outline-fallback";

export const handShadingModes = ["side", "velocity", "normal", "motion"] as const;
export type HandShadingMode = typeof handShadingModes[number];

export const handTrailModes = ["off", "cog"] as const;
export type HandTrailMode = typeof handTrailModes[number];

export interface HandDisplaySettings {
  handMode: HandRenderMode;
  handShading: HandShadingMode;
  handTrail: HandTrailMode;
}

export const defaultHandDisplaySettings: HandDisplaySettings = {
  handMode: "outline",
  handShading: "side",
  handTrail: "off",
};

export const handMeshStatus = (available: boolean): HandMeshStatus => available
  ? "available"
  : "outline-fallback";

export const effectiveHandRenderMode = (
  requested: HandRenderMode,
  meshAvailable: boolean,
): HandRenderMode => requested === "mesh" && !meshAvailable ? "outline" : requested;

export function normaliseHandDisplaySettings(value: unknown): HandDisplaySettings {
  const raw = value && typeof value === "object" ? value as Partial<HandDisplaySettings> : {};
  return {
    handMode: normaliseMode(handRenderModes, raw.handMode, defaultHandDisplaySettings.handMode),
    handShading: normaliseMode(handShadingModes, raw.handShading, defaultHandDisplaySettings.handShading),
    handTrail: normaliseMode(handTrailModes, raw.handTrail, defaultHandDisplaySettings.handTrail),
  };
}

function normaliseMode<T extends string>(modes: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (modes as readonly string[]).includes(value) ? value as T : fallback;
}
