export interface CaptureLoadingSurface {
  fail(error: unknown): void;
  failInsecureOrigin(message: string): void;
  setStage(message: string): void;
}

declare const __CERES_BUILD_IDENTITY__: {
  shortCommit: string | null;
};

function startupBuildHash() {
  const hash = typeof __CERES_BUILD_IDENTITY__ === "undefined"
    ? null
    : __CERES_BUILD_IDENTITY__.shortCommit;
  return hash && /^[a-f0-9]{7}$/i.test(hash) ? hash : "LOCAL";
}

export function mountCaptureLoading(root: HTMLElement): CaptureLoadingSurface {
  document.body.classList.add("capture-loading-page");
  root.innerHTML = `
    <main class="capture-loading-shell" aria-labelledby="capture-loading-title">
      <section class="capture-loading-card">
        <div class="capture-loading-brand" aria-hidden="true">CERES</div>
        <h1 id="capture-loading-title">Preparing demonstrator capture</h1>
        <p id="capture-loading-stage" class="capture-loading-stage">Loading the capture client</p>
        <div class="capture-loading-progress" role="progressbar" aria-label="Loading the CERES capture client">
          <span></span>
        </div>
        <p class="capture-loading-build">BUILD ${startupBuildHash()}</p>
        <p class="capture-loading-note">Keep this page open while the capture tools are prepared.</p>
      </section>
    </main>
  `;

  const stage = root.querySelector<HTMLElement>("#capture-loading-stage")!;

  return {
    setStage(message) {
      stage.textContent = message;
    },
    fail(error) {
      document.body.classList.remove("capture-join-page");
      root.innerHTML = `
        <main class="capture-loading-shell" aria-labelledby="capture-loading-title">
          <section class="capture-loading-card">
            <div class="capture-loading-brand" aria-hidden="true">CERES</div>
            <h1 id="capture-loading-title">Capture client unavailable</h1>
            <p class="capture-loading-stage" role="alert">The capture client could not start.</p>
            <p class="capture-loading-note"></p>
            <button class="capture-loading-retry" type="button">Reload capture client</button>
          </section>
        </main>
      `;
      const note = root.querySelector<HTMLElement>(".capture-loading-note")!;
      note.textContent = error instanceof Error && error.message
        ? error.message
        : "Reload the page to try again.";
      const retry = root.querySelector<HTMLButtonElement>(".capture-loading-retry")!;
      retry.addEventListener("click", () => location.reload());
    },
    failInsecureOrigin(message) {
      document.body.classList.remove("capture-join-page");
      root.innerHTML = `
        <main class="capture-loading-shell" aria-labelledby="capture-loading-title">
          <section class="capture-loading-card">
            <div class="capture-loading-brand" aria-hidden="true">CERES</div>
            <h1 id="capture-loading-title">Secure capture required</h1>
            <p id="capture-status" class="capture-loading-stage" role="status"></p>
            <p class="capture-loading-note">Camera <strong id="join-camera-state">ERR</strong></p>
            <button class="capture-loading-retry" type="button" disabled>HTTPS required</button>
          </section>
        </main>
      `;
      root.querySelector<HTMLElement>("#capture-status")!.textContent = message;
    },
  };
}
