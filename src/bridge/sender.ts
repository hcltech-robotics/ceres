import type { CaptureAuthorityPort } from "../capture-authority.js";
import { normalisePairingCode, pairingCodeInputError } from "../../shared/pairing-code.js";
import type { BridgeCamera } from "./camera.js";
import { Observations } from "./observations.js";
import { BridgePeer } from "./peer.js";
import { completeClaim, forgetReceiver, pairReceiver, storedBinding, type Binding } from "./pairing.js";
import { verifyBridgeConfiguration } from "./config.js";
import { BridgeDepth, type DepthRenderer } from "./depth.js";
import { bridgeVideoProfiles, bridgeVideoQualityKey, configureBridgeVideo, defaultBridgeVideoQuality,
  parseBridgeVideoQuality, type BridgeVideoQuality } from "./video-quality.js";
import { BridgeVideoStatsSampler, emptyVideoStats } from "./video-stats.js";

/** Sender services for CaptureApp, which owns the same IWSDK runtime used by Solo. */
export class BridgeSender implements CaptureAuthorityPort {
  readonly kind = "bridge" as const;
  readonly sessionId = "";
  readonly pairingId = "";
  readonly bufferedAmount = 0;
  readonly supportsPairing = false;
  readonly supportsPeerMedia = false;
  readonly observations = new Observations();
  readonly depth = new BridgeDepth();
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
  videoStats = emptyVideoStats();
  videoQuality: BridgeVideoQuality = defaultBridgeVideoQuality;
  motionFps = 0;
  paused = false;
  hudMode: "off" | "light" | "full" = "light";
  private pauseBusy = false;
  status = "Preparing Bridge";

  constructor() {
    try { this.videoQuality = parseBridgeVideoQuality(globalThis.localStorage?.getItem(bridgeVideoQualityKey)); }
    catch { /* Storage is optional for a live session. */ }
  }

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
      const quality = root.querySelector<HTMLSelectElement>("#bridge-video-quality");
      if (quality) { quality.value = this.videoQuality; quality.disabled = Boolean(this.session) || this.busy; }
      const stats = this.videoStats;
      root.dataset.bridgeVideoQuality = this.videoQuality;
      root.dataset.bridgeEncodedWidth = String(stats.width);
      root.dataset.bridgeEncodedHeight = String(stats.height);
      root.dataset.bridgeVideoBitrate = String(Math.round(stats.bitrate));
      root.dataset.bridgeVideoLimitation = stats.limitation;
      root.dataset.bridgeVideoEncodeMs = String(stats.encodeMs);
      root.dataset.bridgeVideoQp = stats.qp === null ? "" : String(stats.qp);
      const videoStatus = root.querySelector<HTMLElement>("#bridge-video-status");
      if (videoStatus) videoStatus.textContent = stats.width
        ? `${stats.width} x ${stats.height} at ${stats.fps.toFixed(0)} fps, ${(stats.bitrate / 1_000_000).toFixed(1)} Mbps`
        : `${bridgeVideoProfiles[this.videoQuality].label}. Hands update independently of video.`;
      changed();
    };
    const input = root.querySelector<HTMLInputElement>("#join-code")!;
    const options = { signal: this.lifetime.signal };
    root.querySelector<HTMLSelectElement>("#bridge-video-quality")?.addEventListener("change", event => {
      const value = parseBridgeVideoQuality((event.target as HTMLSelectElement).value);
      void this.setVideoQuality(value).catch(error => this.failed(error));
    }, options);
    root.querySelector("#join-code-form")!.addEventListener("submit", event => {
      event.preventDefault();
      if (!this.ownsTab || this.busy || this.session) return;
      const code = normalisePairingCode(input.value);
      if (!code) {
        input.setCustomValidity(pairingCodeInputError);
        input.reportValidity();
        this.setStatus(pairingCodeInputError);
        return;
      }
      input.setCustomValidity("");
      input.value = code;
      this.busy = true;
      this.setStatus("Pairing with the receiver");
      void pairReceiver(code).then(binding => {
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
          input.value = normalisePairingCode(code) ?? code;
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

  async setVideoQuality(quality: BridgeVideoQuality) {
    if (this.session || this.busy || this.disposed) return;
    this.busy = true;
    this.changed();
    try {
      const camera = this.camera;
      if (camera) {
        await configureBridgeVideo(camera.track, quality);
        const settings = camera.track.getSettings();
        camera.width = settings.width ?? camera.width;
        camera.height = settings.height ?? camera.height;
      }
      if (this.disposed) return;
      this.videoQuality = quality;
      try { globalThis.localStorage?.setItem(bridgeVideoQualityKey, quality); } catch { /* Optional preference. */ }
    } finally { this.busy = false; this.changed(); }
  }

  start(session: XRSession, space: XRReferenceSpace, referenceSpace: "local" | "local-floor", renderer?: DepthRenderer) {
    if (!this.ready || !this.binding
      || (this.camera && this.camera.track.readyState !== "live")) {
      throw new Error("Pair a receiver and reconnect the selected camera before entering XR");
    }
    this.stop();
    this.session = session;
    this.depth.start(session, renderer);
    this.observations.spaceEpoch = (this.observations.spaceEpoch + 1) >>> 0;
    this.sessionEvents = new AbortController();
    const options = { signal: this.sessionEvents.signal };
    session.addEventListener("end", () => this.depth.stop(), options);
    space.addEventListener("reset", () => {
      this.observations.spaceEpoch = (this.observations.spaceEpoch + 1) >>> 0;
      this.depth.reset();
    }, options);
    this.camera?.track.addEventListener("ended", () => {
      this.stop();
      this.setStatus("The selected camera disconnected. Enable the camera again before restarting Bridge.");
      void session.end().catch(() => undefined);
    }, options);
    const peer = this.peer = new BridgePeer(this.binding, this.camera, referenceSpace,
      message => this.setStatus(message), error => {
        if (this.peer !== peer) return;
        this.stop();
        this.failed(error);
        void session.end().catch(() => undefined);
      }, this.videoQuality);
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

  publishDepth(frame: XRFrame, space: XRReferenceSpace, displayTime: number) {
    this.depth.publish(frame, space, displayTime, this.peer, this.observations.spaceEpoch, this.paused,
      performance.now(), this.observations.hasPublishedSample(frame, space));
  }

  async togglePause() {
    const peer = this.peer;
    if (!peer || this.pauseBusy) return;
    this.pauseBusy = true;
    this.paused = !this.paused;
    try {
      await peer.setPaused(this.paused);
      this.depth.reset();
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
    const videoStats = new BridgeVideoStatsSampler();
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
        this.videoStats = videoStats.sample(report, this.paused);
        this.videoFps = this.camera ? this.videoStats.fps : 0;
        peer.depthThrottled = this.videoStats.limitation === "bandwidth" || this.videoStats.packetDelayMs > 20;
        let geometryChanged = false;
        if (this.camera) {
          const camera = this.camera;
          const settings = camera.track.getSettings();
          if (settings.width && settings.height
            && (settings.width !== camera.width || settings.height !== camera.height)) {
            camera.width = settings.width;
            camera.height = settings.height;
            geometryChanged = true;
          }
        }
        if (geometryChanged) {
          void peer.start(peer.epoch).catch(error => this.failed(error));
        }
      } catch { this.videoFps = 0; }
      finally {
        this.changed();
        if (this.peer === peer) this.statsTimer = setTimeout(() => { void sample(); }, 500);
      }
    };
    this.statsTimer = setTimeout(() => { void sample(); }, 500);
  }

  stop() {
    this.paused = false;
    this.observations.clearSample();
    this.depth.stop();
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.videoFps = this.motionFps = 0;
    this.videoStats = emptyVideoStats();
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
