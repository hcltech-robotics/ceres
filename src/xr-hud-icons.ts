export type XrHudStatusIcon = "camera" | "xr" | "recorder" | "prompt" | "voice" | "storage";

export const xrHudStatusIconSources = Object.freeze({
  camera: "/assets/xr-status/camera.svg?texture",
  xr: "/assets/xr-status/xr.svg?texture",
  recorder: "/assets/xr-status/recorder.svg?texture",
  prompt: "/assets/xr-status/prompt.svg?texture",
  voice: "/assets/xr-status/voice.svg?texture",
  storage: "/assets/xr-status/storage.svg?texture",
} satisfies Record<XrHudStatusIcon, string>);
