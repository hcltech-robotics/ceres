export const canvasTypeSizes = {
  label: 18,
  body: 28,
  title: 44,
  display: 92,
} as const;

export type CanvasTypeTier = keyof typeof canvasTypeSizes;

export const canvasFont = (tier: CanvasTypeTier, weight = 600) =>
  `${weight} ${canvasTypeSizes[tier]}px "Geist Variable", sans-serif`;
