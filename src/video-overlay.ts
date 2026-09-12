export interface ContainedVideoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function containedVideoRect(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number,
): ContainedVideoRect {
  const width = Math.max(1, containerWidth);
  const height = Math.max(1, containerHeight);
  if (videoWidth <= 0 || videoHeight <= 0) return { left: 0, top: 0, width, height };
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  return {
    left: (width - renderedWidth) / 2,
    top: (height - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
  };
}
