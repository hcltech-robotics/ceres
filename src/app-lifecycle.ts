export interface DisposableApp {
  dispose(): void;
}

export interface HotDisposeContext {
  dispose(callback: () => void): void;
}

export function bindDisposableAppLifecycle(
  app: DisposableApp,
  page: Pick<Window, "addEventListener" | "removeEventListener">,
  hot?: HotDisposeContext,
) {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    page.removeEventListener("pagehide", dispose);
    app.dispose();
  };
  page.addEventListener("pagehide", dispose, { once: true });
  hot?.dispose(dispose);
  return dispose;
}
