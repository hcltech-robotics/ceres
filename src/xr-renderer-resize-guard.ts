export interface XrResizableRenderer {
  xr: {
    isPresenting: boolean;
  };
  setSize(
    width: number,
    height: number,
    updateStyle?: boolean,
  ): unknown;
}

export function guardImmersiveRendererResize(
  renderer: XrResizableRenderer,
) {
  const originalSetSize = renderer.setSize;
  const guardedSetSize = function (
    width: number,
    height: number,
    updateStyle?: boolean,
  ) {
    if (renderer.xr.isPresenting) return renderer;
    return originalSetSize.call(renderer, width, height, updateStyle);
  };
  renderer.setSize = guardedSetSize;
  return () => {
    if (renderer.setSize === guardedSetSize) renderer.setSize = originalSetSize;
  };
}
