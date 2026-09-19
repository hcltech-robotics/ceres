import { DEPTH_DEMAND_LEASE_MS, isDepthDemand } from "../shared/directed-depth.js";
import { type DepthStatus } from "../shared/bridge-depth.js";
import { BridgeDepth, type DepthPeer, type DepthRenderer } from "./bridge/depth.js";

type DepthSession = XRSession & { depthActive?: boolean; pauseDepthSensing?(): void; resumeDepthSensing?(): void };
type DepthEngine = Pick<BridgeDepth, "start" | "stop" | "reset" | "publish">;
interface Receiver { channel: RTCDataChannel; expiresAt: number; sequence: number | null; removeListeners(): void }

/** Director demand leases keep optional depth acquisition off the recorder path. */
export class DirectedCaptureDepth {
  private readonly receivers = new Map<string, Receiver>();
  private session: DepthSession | null = null;
  private renderer: DepthRenderer | undefined;
  private running = false;
  private epoch = 0;
  private spaceEpoch = 0;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus: DepthStatus | null = null;
  private readonly peer: DepthPeer;

  constructor(private readonly engine: DepthEngine = new BridgeDepth(), private readonly now = () => performance.now()) {
    const owner = this;
    this.peer = {
      get epoch() { return owner.epoch; },
      depth: {
        readyState: "open",
        get bufferedAmount() {
          for (const receiver of owner.receivers.values()) if (owner.ready(receiver) && receiver.channel.bufferedAmount === 0) return 0;
          return 1;
        },
        send(bytes) {
          for (const receiver of owner.receivers.values()) {
            if (!owner.ready(receiver)) continue;
            // The complete frame is bounded below the recorder transport budget.
            if (receiver.channel.bufferedAmount > 256 * 1024) continue;
            try { receiver.channel.send(bytes as ArrayBuffer); } catch { /* A closing optional channel drops this frame. */ }
          }
        },
      },
      sendDepthStatus(status) {
        owner.lastStatus = status;
        let sent = false;
        for (const receiver of owner.receivers.values()) if (owner.ready(receiver)) sent = owner.sendStatus(receiver, status) || sent;
        return sent;
      },
    };
  }

  startSession(session: XRSession, renderer?: DepthRenderer) {
    this.stopSession();
    this.session = session;
    this.renderer = renderer;
    this.epoch = (this.epoch + 1) >>> 0;
    session.addEventListener("end", this.sessionEnded);
    session.addEventListener("visibilitychange", this.visibilityChanged);
  }

  stopSession() {
    this.session?.removeEventListener("end", this.sessionEnded);
    this.session?.removeEventListener("visibilitychange", this.visibilityChanged);
    this.stopEngine();
    this.session = null;
    this.renderer = undefined;
    this.lastStatus = null;
  }

  addPeer(id: string, channel: RTCDataChannel) {
    this.removePeer(id);
    const onMessage = (event: MessageEvent) => {
      if (this.receivers.get(id) !== receiver || typeof event.data !== "string" || event.data.length > 256) return;
      try {
        const demand: unknown = JSON.parse(event.data);
        if (!isDepthDemand(demand)) return;
        if (receiver.sequence !== null) {
          const distance = (demand.sequence - receiver.sequence) >>> 0;
          if (distance === 0 || distance >= 0x80000000) return;
        }
        receiver.sequence = demand.sequence;
        receiver.expiresAt = demand.enabled ? this.now() + DEPTH_DEMAND_LEASE_MS : 0;
        if (!this.hasDemand()) this.stopEngine();
        this.scheduleExpiry();
        this.sendStatus(receiver, this.lastStatus && demand.enabled ? this.lastStatus : {
          type: "depth-status", version: 1, epoch: this.epoch,
          status: demand.enabled ? "waiting" : "paused", usage: null, source_format: null,
        });
      } catch { /* Malformed optional demand cannot affect recording controls. */ }
    };
    const onClose = () => { if (this.receivers.get(id) === receiver) this.removePeer(id); };
    const receiver: Receiver = { channel, expiresAt: 0, sequence: null, removeListeners: () => {
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("close", onClose);
    } };
    this.receivers.set(id, receiver);
    channel.addEventListener("message", onMessage);
    channel.addEventListener("close", onClose);
  }

  removePeer(id: string) {
    this.receivers.get(id)?.removeListeners();
    this.receivers.delete(id);
    if (!this.hasDemand()) this.stopEngine();
    this.scheduleExpiry();
  }

  clearPeers() {
    for (const receiver of this.receivers.values()) receiver.removeListeners();
    this.receivers.clear();
    this.stopEngine();
    this.scheduleExpiry();
  }

  /** Called only after the authoritative XR sample has reached the recorder. */
  publish(frame: XRFrame, space: XRReferenceSpace, displayTime: number) {
    try {
      this.publishFrame(frame, space, displayTime);
    } catch {
      this.stopEngine();
      this.peer.sendDepthStatus({ type: "depth-status", version: 1, epoch: this.epoch,
        status: "error", usage: null, source_format: null });
    }
  }

  private publishFrame(frame: XRFrame, space: XRReferenceSpace, displayTime: number) {
    const session = this.session;
    if (!session || frame.session !== session) return;
    const needed = this.hasDemand() && session.visibilityState === "visible";
    if (!needed) {
      this.stopEngine();
      // WebXR pause/resume operations must run inside an active XR frame.
      // https://immersive-web.github.io/depth-sensing/#dom-xrsession-pausedepthsensing
      try { if (session.depthActive !== false) session.pauseDepthSensing?.(); } catch { /* Optional feature unavailable. */ }
      return;
    }
    if (!this.running) {
      this.engine.start(session, this.renderer);
      this.running = true;
      this.spaceEpoch = (this.spaceEpoch + 1) >>> 0;
    }
    this.engine.publish(frame, space, displayTime, this.peer, this.spaceEpoch, false, this.now());
  }

  dispose() {
    this.clearPeers();
    this.stopSession();
  }

  private readonly sessionEnded = () => this.stopSession();
  private readonly visibilityChanged = () => {
    if (this.session?.visibilityState !== "visible") this.stopEngine();
  };
  private ready(receiver: Receiver) { return receiver.expiresAt > this.now() && receiver.channel.readyState === "open"; }
  private hasDemand() { for (const receiver of this.receivers.values()) if (this.ready(receiver)) return true; return false; }
  private stopEngine() {
    if (this.running) this.engine.stop();
    this.running = false;
    this.lastStatus = null;
  }
  private sendStatus(receiver: Receiver, status: DepthStatus) {
    if (receiver.channel.readyState !== "open" || receiver.channel.bufferedAmount > 16_384) return false;
    try { receiver.channel.send(JSON.stringify(status)); return true; } catch { return false; }
  }
  private scheduleExpiry() {
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    let expiresAt = Infinity;
    for (const receiver of this.receivers.values()) if (receiver.expiresAt > this.now()) expiresAt = Math.min(expiresAt, receiver.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      if (!this.hasDemand()) this.stopEngine();
      this.scheduleExpiry();
    }, Math.max(1, expiresAt - this.now()));
  }
}
