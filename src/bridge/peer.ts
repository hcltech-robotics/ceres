import { parseMetadata, XR_HAND_JOINTS, type BridgeCameraDescription, type BridgeDescription } from "../../shared/bridge-protocol.js";
import type { BridgeCamera } from "./camera.js";
import { relayBase, refreshBinding, type Binding } from "./pairing.js";
import { DEPTH_CHANNEL, DEPTH_FEATURE, type DepthStatus } from "../../shared/bridge-depth.js";

const nowUs = () => Math.round(performance.now() * 1000);

const describeCamera = (camera: BridgeCamera): BridgeCameraDescription => ({
  side: camera.side, width: camera.width, height: camera.height,
  requestedWidth: 640, fps: camera.track.getSettings().frameRate ?? null, calibration: null,
});

export class BridgePeer {
  pc: RTCPeerConnection | null = null;
  pose: RTCDataChannel | null = null;
  depth: RTCDataChannel | null = null;
  epoch = 0;
  depthMetadataVersion: 1 | 2 = 1;
  depthEnabled = false;
  private depthControlSupported = false;
  private paused = false;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private retrying = false;
  private metadata: RTCDataChannel | null = null;
  private signalComplete = false;

  constructor(private binding: Binding, private camera: BridgeCamera | null, private referenceSpace: "local" | "local-floor",
    private status: (message: string) => void, private fatal: (error: Error) => void) {
    if (camera && (!camera.track || !camera.stream)) {
      throw new Error("Bridge accepts one selected camera");
    }
  }

  async start(restartAfter?: number): Promise<void> {
    const attempt = ++this.attempt;
    this.cleanup();
    if (this.stopped) return;
    this.binding = await refreshBinding(this.binding, restartAfter);
    if (this.stopped || attempt !== this.attempt) return;
    this.epoch = this.binding.epoch;
    const pc = this.pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.pose = pc.createDataChannel("ceres.pose.v1", { ordered: false, maxRetransmits: 0 });
    this.depth = pc.createDataChannel(DEPTH_CHANNEL, { ordered: false, maxRetransmits: 0 });
    const meta = this.metadata = pc.createDataChannel("ceres.meta.v1", { ordered: true });
    const description: BridgeDescription = {
      type: "description", version: 1, epoch: this.epoch,
      clock: { id: crypto.randomUUID(), units: "microseconds", domain: "sender-monotonic" },
      referenceSpace: this.referenceSpace, axes: "right-handed-x-right-y-up-z-back", units: "metres",
      quaternion: "xyzw", joints: XR_HAND_JOINTS,
      ...(this.camera ? { camera: describeCamera(this.camera) } : {}),
      environment_depth: { ...DEPTH_FEATURE },
      depth_control_version: 1,
    };
    let acknowledged = false, remoteEnd = false, localEndSent = false, offered = false;
    let remoteSet = false;
    const pendingIce: (RTCIceCandidateInit | null)[] = [];
    const url = new URL(`${relayBase}/bindings/${this.binding.bindingId}/signal`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socket = new WebSocket(url);
    const active = () => attempt === this.attempt && !this.stopped;
    const fail = (error: unknown) => {
      if (active()) this.fatal(error instanceof Error ? error : new Error("Pairing failed"));
    };
    const send = (signal: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Pairing connection closed before setup completed");
      socket.send(JSON.stringify({ type: "signal", epoch: this.epoch, signal }));
    };
    const finish = () => {
      if (attempt !== this.attempt || this.stopped) return;
      if (acknowledged && remoteEnd && localEndSent && pc.connectionState === "connected") {
        this.signalComplete = true;
        if (this.setupTimer) clearTimeout(this.setupTimer);
        this.setupTimer = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        socket.close(1000, "Direct stream established");
        this.status("Streaming directly to " + this.binding.label);
      }
    };
    pc.onicecandidate = event => {
      if (attempt !== this.attempt || this.stopped) return;
      try {
        if (event.candidate) send({ candidate: event.candidate.toJSON() });
        else { send({ candidate: null }); localEndSent = true; finish(); }
      } catch { this.scheduleRetry(); }
    };
    meta.onopen = () => { if (active()) meta.send(JSON.stringify(description)); };
    meta.onmessage = event => {
      if (!active()) return;
      const t1 = nowUs();
      try {
        if (typeof event.data !== "string") throw new Error("Invalid Bridge metadata");
        const message = parseMetadata(event.data);
        if (message.epoch !== this.epoch) return;
        if (message.type === "ack") {
          this.depthMetadataVersion = "depth_metadata_version" in message && message.depth_metadata_version === 2 ? 2 : 1;
          this.depthControlSupported = message.depth_control_version === 1;
          this.depthEnabled = this.depthControlSupported ? message.depth_enabled! : true;
          acknowledged = true;
          finish();
        }
        else if (message.type === "depth-control") {
          if (acknowledged && this.depthControlSupported) this.depthEnabled = message.enabled;
        }
        else if (message.type === "ping" && meta.bufferedAmount < 4096) {
          meta.send(JSON.stringify({ ...message, type: "pong", t1, t2: nowUs() }));
        } else if (message.type !== "ping") throw new Error("Unexpected receiver message");
      } catch (error) { fail(error); }
    };
    pc.onconnectionstatechange = () => {
      if (attempt !== this.attempt || this.stopped) return;
      if (pc.connectionState === "connected") {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        finish();
      } else if (["disconnected", "failed", "closed"].includes(pc.connectionState)) this.scheduleRetry();
    };
    socket.onopen = () => {
      if (active()) socket.send(JSON.stringify({ type: "register", version: 1, epoch: this.epoch,
        role: "sender", deviceId: this.binding.deviceId, secret: this.binding.secret }));
    };
    // SDP and ICE callbacks are serialised to preserve the remote-description boundary.
    let messages = Promise.resolve();
    socket.onmessage = event => {
      messages = messages.then(async () => {
        if (attempt !== this.attempt || this.stopped) return;
        if (typeof event.data !== "string" || event.data.length > 32768) throw new Error("Invalid pairing message");
        const message = JSON.parse(event.data);
        if (message.epoch !== this.epoch) return;
        if (message.type === "peer-ready" && !offered) {
          offered = true;
          const video = this.camera ? pc.addTransceiver(this.camera.track, {
            direction: "sendonly", streams: [this.camera.stream],
            sendEncodings: [{ maxBitrate: 2_000_000, scaleResolutionDownBy: Math.max(1, this.camera.width / 640) }],
          }) : null;
          this.videoSender = video?.sender ?? null;
          if (this.paused) await this.videoSender?.replaceTrack(null);
          if (!active()) return;
          const audio = pc.addTransceiver("audio", { direction: "sendonly", sendEncodings: [{ maxBitrate: 32_000 }] });
          const opus = RTCRtpSender.getCapabilities("audio")?.codecs.filter(codec => codec.mimeType.toLowerCase() === "audio/opus");
          if (opus?.length) audio.setCodecPreferences(opus);
          this.audioSender = audio.sender;
          await audio.sender.replaceTrack(this.paused ? null : this.audioTrack);
          const codecs = RTCRtpSender.getCapabilities("video")?.codecs.filter(codec => /video\/(H264|VP8|rtx)/i.test(codec.mimeType));
          if (codecs?.length) {
            const preferred = new URLSearchParams(location.search).get("codec") === "vp8" ? "video/VP8" : "video/H264";
            codecs.sort((a, b) => Number(b.mimeType === preferred) - Number(a.mimeType === preferred));
            video?.setCodecPreferences(codecs);
          }
          const offer = await pc.createOffer();
          if (!active()) return;
          await pc.setLocalDescription(offer);
          if (!active()) return;
          if (this.camera) description.camera = describeCamera(this.camera);
          send({ type: "offer", sdp: offer.sdp });
        } else if (message.type === "signal") {
          const signal = message.signal;
          if (signal.type === "answer") {
            if (remoteSet || typeof signal.sdp !== "string") throw new Error("Invalid receiver answer");
            await pc.setRemoteDescription(signal);
            if (!active()) return;
            remoteSet = true;
            for (const candidate of pendingIce) {
              if (!active()) return;
              await pc.addIceCandidate(candidate ?? undefined);
            }
            pendingIce.length = 0;
          } else if ("candidate" in signal) {
            if (signal.candidate === null) remoteEnd = true;
            if (remoteSet) await pc.addIceCandidate(signal.candidate ?? undefined);
            else {
              if (pendingIce.length >= 64) throw new Error("Too many receiver candidates");
              pendingIce.push(signal.candidate);
            }
          } else throw new Error("Unexpected receiver signal");
          finish();
        }
      }).catch(fail);
    };
    socket.onclose = event => {
      if (attempt !== this.attempt || this.stopped || this.signalComplete) return;
      if ([4403, 4409].includes(event.code)) this.fatal(new Error(event.code === 4409 ? "This receiver is already connected" : "Receiver pairing was rejected"));
      else this.scheduleRetry();
    };
    socket.onerror = () => { if (active()) this.scheduleRetry(); };
    this.setupTimer = setTimeout(() => { this.setupTimer = null; this.scheduleRetry(); }, 30_000);
    this.status("Connecting to " + this.binding.label);
  }

  private scheduleRetry() {
    if (this.stopped || this.retrying) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.retrying = true;
      this.status("Reconnecting to " + this.binding.label);
      void this.start(this.epoch).catch(() => {
        this.retrying = false;
        this.scheduleRetry();
      }).finally(() => { this.retrying = false; });
    }, 3000);
  }

  async setPaused(paused: boolean) {
    this.paused = paused;
    await Promise.all([
      this.videoSender?.replaceTrack(paused ? null : this.camera?.track ?? null),
      this.audioSender?.replaceTrack(paused ? null : this.audioTrack),
    ]);
  }

  async setAudioTrack(track: MediaStreamTrack | null) {
    await this.audioSender?.replaceTrack(this.paused ? null : track);
    this.audioTrack = track;
  }

  sendDepthStatus(status: DepthStatus): boolean {
    const meta = this.metadata;
    if (!meta || meta.readyState !== "open" || meta.bufferedAmount >= 4096 || status.epoch !== this.epoch) return false;
    try { meta.send(JSON.stringify(status)); return true; }
    catch { return false; }
  }

  private cleanup() {
    this.depthMetadataVersion = 1;
    this.depthEnabled = false;
    this.depthControlSupported = false;
    this.videoSender = null;
    this.audioSender = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.timer = null;
    this.setupTimer = null;
    this.signalComplete = false;
    if (this.socket) { this.socket.onopen = null; this.socket.onmessage = null; this.socket.onclose = null; this.socket.onerror = null; this.socket.close(); }
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.onicecandidate = null; this.pc.close(); }
    this.pose = null;
    this.depth = null;
    if (this.metadata) { this.metadata.onopen = null; this.metadata.onmessage = null; }
    this.metadata = null;
    this.socket = null;
    this.pc = null;
  }

  stop() { this.stopped = true; this.attempt++; this.cleanup(); }
}
