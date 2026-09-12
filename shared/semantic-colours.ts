export const semanticColours = {
  canvas: "#0b0d10",
  surfaceSunken: "#0f1216",
  surface: "#14181d",
  surfaceRaised: "#1a1f25",
  surfaceInteractive: "#222830",
  border: "#2a3037",
  borderStrong: "#3a424c",
  text: "#eef1f4",
  textSecondary: "#bac2ca",
  textMuted: "#7e8994",
  textDisabled: "#56616c",
  action: "#6ba9ff",
  success: "#65d4cb",
  accent: "#bd9cff",
  warning: "#e2c568",
  danger: "#ff6d70",
  onAction: "#07101c",
  onDanger: "#140506",
  qrForeground: "#000000",
  qrBackground: "#ffffff",
} as const;

export const semanticSignalColours = [
  semanticColours.action,
  semanticColours.success,
  semanticColours.warning,
  semanticColours.accent,
  semanticColours.danger,
  semanticColours.textSecondary,
] as const;

export function colourWithAlpha(colour: string, alpha: number) {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) throw new Error("Semantic colours must use six-digit hexadecimal values");
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error("Colour alpha must be between zero and one");
  const channels = [1, 3, 5].map((offset) => Number.parseInt(colour.slice(offset, offset + 2), 16));
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

export function mixHexColours(from: string, to: string, ratio: number) {
  if (!/^#[0-9a-f]{6}$/i.test(from) || !/^#[0-9a-f]{6}$/i.test(to)) {
    throw new Error("Semantic colours must use six-digit hexadecimal values");
  }
  const mix = Math.min(1, Math.max(0, ratio));
  const channel = (offset: number) => Math.round(
    Number.parseInt(from.slice(offset, offset + 2), 16) * (1 - mix)
      + Number.parseInt(to.slice(offset, offset + 2), 16) * mix,
  );
  return `#${[channel(1), channel(3), channel(5)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}
