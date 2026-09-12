import type { CaptureAuthorityPort } from "../capture-authority.js";
import type { BridgeCamera } from "./camera.js";
import { Observations } from "./observations.js";
import { BridgePeer } from "./peer.js";
import { completeClaim, forgetReceiver, pairReceiver, storedBinding, type Binding } from "./pairing.js";
import { verifyBridgeConfiguration } from "./config.js";

/** Sender services for CaptureApp, which owns the same IWSDK runtime used by Solo. */
export class BridgeSender implements CaptureAuthorityPort {
  readonly kind = "bridge" as const;
  readonly sessionId = "";
  readonly pairingId = "";
  readonly bufferedAmount = 0;
  readonly supportsPairing = false;
  readonly supportsPeerMedia = false;
  readonly observations = new Observations();
  private binding: Binding | null = null;
  private camera: BridgeCamera | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private peer: BridgePeer | null = null;
  private session: XRSession | null = null;
  private sessionEvents: AbortController | null = null;
  private lifetime = new AbortController();
  private scanner: AbortController | null = null;
  private ownsTab = false;
  private busy = false;
  private disposed = false;
  private releaseTab: (() => void) | null = null;
  private changed = () => {};
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  videoFps = 0;
  motionFps = 0;
  paused = false;
  hudMode: "off" | "light" | "full" = "light";
  private pauseBusy = false;
  status = "Preparing Bridge";

  get ready() { return this.ownsTab && Boolean(this.binding && !this.binding.revoked) && !this.busy; }
  get label() { return this.binding?.label ?? "Receiver"; }
  get streaming() { return this.peer?.pc?.connectionState === "connected"; }
  get audioEnabled() { return this.audioTrack?.readyState === "live"; }

  async setAudioTrack(track: MediaStreamTrack | null) {
    await this.peer?.setAudioTrack(track);
    this.audioTrack = track;
    this.changed();
  }

  mount(root: HTMLElement, changed: () => void, prepareCamera: () => Promise<void>) {
    this.changed = () => {
      if (this.disposed) return;
      const paired = Boolean(this.binding && !this.binding.revoked);
      const receiver = root.querySelector<HTMLElement>("#bridge-receiver")!;
      if (paired) {
        const name = document.createElement("strong");
        name.textContent = this.label;
        receiver.replaceChildren("Connected to ", name);
      } else {
        receiver.textContent = "No receiver paired";
      }
      const forget = root.querySelector<HTMLButtonElement>("#bridge-forget")!;
      forget.hidden = !paired;
      forget.disabled = Boolean(this.session) || this.busy;
      root.querySelector<HTMLElement>("#join-code-form")!.hidden = paired;
      root.querySelector<HTMLElement>(".join-key-area")!.hidden = paired;
      root.querySelector<HTMLButtonElement>("#join-code-submit")!.disabled = !this.ownsTab || this.busy;
      root.querySelector<HTMLButtonElement>("#scan-qr")!.disabled = !this.ownsTab || Boolean(this.session) || (this.busy && !this.scanner);
      changed();
    };
    const input = root.querySelector<HTMLInputElement>("#join-code")!;
    const options = { signal: this.lifetime.signal };
    root.querySelector("#join-code-form")!.addEventListener("submit", event => {
      event.preventDefault();
      if (!this.ownsTab || this.busy || this.session) return;
      this.busy = true;
      this.setStatus("Pairing with the receiver");
      void pairReceiver(input.value.trim().toUpperCase()).then(binding => {
        if (this.disposed) return;
        this.binding = binding;
        this.setStatus("");
      }).catch(error => this.failed(error)).finally(() => { this.busy = false; this.changed(); });
    }, options);
    root.querySelector("#bridge-forget")!.addEventListener("click", () => {
      if (!this.binding || this.busy || this.session) return;
      this.busy = true;
      void forgetReceiver(this.binding).then(() => {
        this.binding = null;
        this.setStatus("Receiver forgotten");
      }).catch(error => {
        if (this.binding) this.binding = { ...this.binding, revoked: true };
        this.failed(error);
      }).finally(() => { this.busy = false; this.changed(); });
    }, options);
    root.querySelector("#scan-qr")!.addEventListener("click", () => {
      if (!this.ownsTab || this.session) return;
      if (this.scanner) { this.scanner.abort(); return; }
      if (this.busy) return;
      this.scanner = new AbortController();
      const signal = this.scanner.signal;
      this.busy = true;
      this.setStatus("Point the camera at the receiver QR code");
      void prepareCamera().then(async () => {
        if (signal.aborted || this.disposed) return null;
        const { scanReceiverCode } = await import("./qr.js");
        return scanReceiverCode(root.querySelector<HTMLVideoElement>("#camera-preview")!, signal);
      }).then(code => {
        if (!code || this.disposed) return;
        input.value = code;
        this.busy = false;
        root.querySelector<HTMLFormElement>("#join-code-form")!.requestSubmit();
      }).catch(error => this.failed(error)).finally(() => {
        this.scanner = null;
        // Pairing owns busy after a successful scan submits the form.
        if (this.status !== "Pairing with the receiver") this.busy = false;
        this.changed();
      });
    }, options);
    void this.initialise(input).catch(error => this.failed(error));
    this.changed();
  }

  private async initialise(input: HTMLInputElement) {
    verifyBridgeConfiguration();
    if (!navigator.locks) throw new Error("This browser cannot reserve an exclusive Bridge session");
    await navigator.locks.request("ceres-bridge-sender", { ifAvailable: true }, async lock => {
      if (this.disposed) return;
      if (!lock) { this.setStatus("Bridge is already open in another tab"); return; }
      const released = new Promise<void>(resolve => { this.releaseTab = resolve; });
      this.ownsTab = true;
      try {
        let binding = await storedBinding();
        if (binding?.revoked) { await forgetReceiver(binding); binding = null; }
        if (binding) binding = await completeClaim(binding);
        if (this.disposed) return;
        this.binding = binding;
        const url = new URL(location.href);
        const code = url.searchParams.get("code");
        if (code) {
          input.value = code.toUpperCase();
          url.searchParams.delete("code");
          history.replaceState(null, "", url);
        }
        this.setStatus("");
        if (code && !binding) input.form?.requestSubmit();
      } catch (error) { this.failed(error); }
      await released;
    });
  }

  setCamera(camera: BridgeCamera | null) { this.camera = camera; }

  start(session: XRSession, space: XRReferenceSpace, referenceSpace: "local" | "local-floor") {
    if (!this.ready || !this.binding || !this.camera) throw new Error("Pair a receiver and enable the camera before entering XR");
    this.stop();
    this.session = session;
    this.observations.spaceEpoch = (this.observations.spaceEpoch + 1) >>> 0;
    this.sessionEvents = new AbortController();
    const options = { signal: this.sessionEvents.signal };
    space.addEventListener("reset", () => { this.observations.spaceEpoch = (this.observations.spaceEpoch + 1) >>> 0; }, options);
    this.camera.track.addEventListener("ended", () => {
      this.stop();
      this.setStatus("The camera disconnected. Enable it again before restarting Bridge.");
      void session.end().catch(() => undefined);
    }, options);
    const peer = this.peer = new BridgePeer(this.binding, this.camera, referenceSpace,
      message => this.setStatus(message), error => {
        if (this.peer !== peer) return;
        this.stop();
        this.failed(error);
        void session.end().catch(() => undefined);
      });
    void peer.setAudioTrack(this.audioTrack);
    this.setStatus("Connecting to " + this.label);
    void peer.start().catch(error => {
      if (this.peer !== peer) return;
      this.stop();
      this.failed(error);
      void session.end().catch(() => undefined);
    });
    this.sampleRates(peer);
    // IWSDK has already started its rendering loop. A refresh-rate request must not block it.
    const rates = session.supportedFrameRates;
    if (rates?.length && session.updateTargetFrameRate) {
      void session.updateTargetFrameRate(Math.max(...rates)).catch(() => undefined);
    }
  }

  publish(frame: XRFrame, space: XRReferenceSpace, displayTime: number) {
    if (this.paused) return;
    this.observations.publish(frame, space, this.peer?.pose ?? null, this.peer?.epoch ?? 0,
      Math.round(performance.now() * 1000), displayTime);
  }

  async togglePause() {
    const peer = this.peer;
    if (!peer || this.pauseBusy) return;
    this.pauseBusy = true;
    this.paused = !this.paused;
    try {
      await peer.setPaused(this.paused);
      if (this.peer !== peer) return;
      if (this.paused) this.videoFps = this.motionFps = 0;
      this.setStatus(this.paused ? "Streaming paused" : (this.streaming ? "Streaming directly to " : "Connecting to ") + this.label);
    } catch (error) {
      this.stop();
      this.failed(error);
    } finally { this.pauseBusy = false; }
  }

  cycleHudMode() {
    this.hudMode = this.hudMode === "off" ? "light" : this.hudMode === "light" ? "full" : "off";
    this.changed();
  }

  private sampleRates(peer: BridgePeer) {
    let lastMotion = this.observations.acquired - this.observations.dropped;
    let lastTime = performance.now();
    let lastVideo: { id: string; frames: number; time: number } | null = null;
    const sample = async () => {
      if (this.peer !== peer) return;
      const now = performance.now();
      const motion = this.observations.acquired - this.observations.dropped;
      this.motionFps = this.paused ? 0 : 1000 * (motion - lastMotion) / Math.max(1, now - lastTime);
      lastMotion = motion;
      lastTime = now;
      const pc = peer.pc;
      try {
        const report = await pc?.getStats();
        if (this.peer !== peer || peer.pc !== pc) return;
        let videoFound = false;
        report?.forEach(stat => {
          if (stat.type !== "outbound-rtp" || stat.kind !== "video" || typeof stat.framesSent !== "number") return;
          videoFound = true;
          this.videoFps = !this.paused && lastVideo && lastVideo.id === stat.id && stat.framesSent >= lastVideo.frames
            ? 1000 * (stat.framesSent - lastVideo.frames) / Math.max(1, stat.timestamp - lastVideo.time) : 0;
          lastVideo = { id: stat.id, frames: stat.framesSent, time: stat.timestamp };
        });
        if (!videoFound) { this.videoFps = 0; lastVideo = null; }
        const settings = this.camera?.track.getSettings();
        if (settings?.width && settings.height && this.camera
          && (settings.width !== this.camera.width || settings.height !== this.camera.height)) {
          this.camera.width = settings.width;
          this.camera.height = settings.height;
          void peer.start(peer.epoch).catch(error => this.failed(error));
        }
      } catch { this.videoFps = 0; }
      finally {
        if (this.peer === peer) this.statsTimer = setTimeout(() => { void sample(); }, 500);
      }
    };
    this.statsTimer = setTimeout(() => { void sample(); }, 500);
  }

  stop() {
    this.paused = false;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.videoFps = this.motionFps = 0;
    this.peer?.stop();
    this.peer = null;
    this.sessionEvents?.abort();
    this.sessionEvents = null;
    this.session = null;
    this.changed();
  }

  private setStatus(message: string) { if (!this.disposed) { this.status = message; this.changed(); } }
  private failed(error: unknown) { this.setStatus(error instanceof Error ? error.message : "Bridge could not connect"); }
  on<T>(_event: string, _listener: (value: T) => void) { return () => {}; }
  connect() {}
  close() { this.stop(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.scanner?.abort();
    this.lifetime.abort();
    this.releaseTab?.();
    this.camera = null;
    this.audioTrack = null;
  }
  // The local sender does not accept run commands or expose recording services.
  control() { return false; }
  setHandDisplay() { return true; }
  requestCaptureIntent() { return this.ready; }
  markXrActive() { return this.ready; }
  configurationApplied() { return false; }
  publishCaptureStatus() { return false; }
  publishPromptAudioStatus() { return false; }
  acknowledgePrompt() { return false; }
  publishSensorFrame() { return false; }
  publishRecorderResult() { return false; }
  publishWebRtcSignal() { return false; }
}
