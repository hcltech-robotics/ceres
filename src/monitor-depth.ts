import { validDepthStatus, type DepthStatus } from "../shared/bridge-depth.js";
import {
  DEPTH_DEMAND_INTERVAL_MS, DepthFrameAssembler, type DecodedDepthFrame, type DepthDemand,
} from "../shared/directed-depth.js";

export { DEPTH_CHANNEL } from "../shared/bridge-depth.js";
export type MonitorDepthState = "off" | "waiting" | "streaming" | "paused" | "unsupported" | "error";

/** Keep the displayed image in view coordinates, including reflected source textures. */
export function colouriseDepthFrame(frame: DecodedDepthFrame, pixels?: Uint8ClampedArray<ArrayBuffer>) {
  const { width, height, norm_depth_from_norm_view: matrix } = frame.header;
  const result = pixels?.length === width * height * 4 ? pixels : new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + .5) / width;
      const divisor = matrix[3] * u + matrix[7] * v + matrix[15];
      const dx = (matrix[0] * u + matrix[4] * v + matrix[12]) / divisor;
      const dy = (matrix[1] * u + matrix[5] * v + matrix[13]) / divisor;
      const mm = dx >= 0 && dx < 1 && dy >= 0 && dy < 1
        ? frame.millimetres[Math.floor(dy * height) * width + Math.floor(dx * width)] : 0;
      const at = (y * width + x) * 4;
      if (!mm) { result[at] = 11; result[at + 1] = 15; result[at + 2] = 18; }
      else {
        const distance = Math.min(1, Math.max(0, (mm - 200) / 4_800));
        result[at] = Math.round(255 * Math.max(0, 1 - distance * 2));
        result[at + 1] = Math.round(220 * (1 - Math.abs(distance * 2 - 1)));
        result[at + 2] = Math.round(255 * Math.max(0, distance * 2 - 1));
      }
      result[at + 3] = 255;
    }
  }
  return result;
}

type DepthChannel = Pick<RTCDataChannel, "readyState" | "bufferedAmount" | "send" | "addEventListener" | "removeEventListener" | "binaryType">;
type VisibilitySource = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** A renewable request is safer than a persistent flag on a lossy connection. */
export class MonitorDepthDemand {
  private channel: DepthChannel | null = null;
  private selected = false;
  private live = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sent: boolean | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly visibility: VisibilitySource, private readonly changed: (enabled: boolean) => void = () => {}) {
    visibility.addEventListener("visibilitychange", this.update);
  }
  get enabled() { return !this.disposed && this.selected && this.live && !this.visibility.hidden && this.channel?.readyState === "open"; }
  setSelected(selected: boolean) { if (this.selected !== selected) { this.selected = selected; this.update(); } }
  setLive(live: boolean) { if (this.live !== live) { this.live = live; this.update(); } }
  attach(channel: DepthChannel | null) {
    if (channel === this.channel) return;
    if (this.channel) {
      this.send(false);
      this.channel.removeEventListener("open", this.update);
      this.channel.removeEventListener("close", this.update);
    }
    this.channel = channel;
    this.sent = null;
    this.sequence = 0;
    channel?.addEventListener("open", this.update);
    channel?.addEventListener("close", this.update);
    this.update();
  }
  dispose() {
    this.disposed = true;
    this.attach(null);
    this.visibility.removeEventListener("visibilitychange", this.update);
  }
  private readonly update = () => {
    const enabled = Boolean(this.enabled);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.sent !== enabled) { this.send(enabled); this.changed(enabled); }
    if (enabled) this.timer = setInterval(() => this.send(true), DEPTH_DEMAND_INTERVAL_MS);
  };
  private send(enabled: boolean) {
    if (this.channel?.readyState !== "open" || this.channel.bufferedAmount > 4_096) { this.sent = null; return; }
    const demand: DepthDemand = { type: "depth-demand", version: 1, sequence: this.sequence = (this.sequence + 1) >>> 0, enabled };
    try { this.channel.send(JSON.stringify(demand)); this.sent = enabled; } catch { this.sent = null; }
  }
}

export interface MonitorDepthElements {
  surface: HTMLElement;
  onStateChange?(state: MonitorDepthState, label: string): void;
}

/** The monitor entry owns this view. It imports no capture or XR runtime code. */
export class MonitorDepthView {
  private readonly canvas: HTMLCanvasElement;
  private readonly message: HTMLElement;
  private readonly details: HTMLElement;
  private readonly demand: MonitorDepthDemand;
  private readonly assembler = new DepthFrameAssembler();
  private channel: RTCDataChannel | null = null;
  private image: ImageData | null = null;
  private selected = false;
  private state: MonitorDepthState = "off";
  private lastFrameAt = 0;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly elements: MonitorDepthElements) {
    const document = elements.surface.ownerDocument;
    elements.surface.classList.add("monitor-depth-view");
    elements.surface.hidden = true;
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-label", "Live environment depth, red near and blue far");
    this.canvas.setAttribute("role", "img");
    this.canvas.hidden = true;
    this.message = document.createElement("p");
    this.message.className = "monitor-depth-message";
    this.message.setAttribute("role", "status");
    this.details = document.createElement("p");
    this.details.className = "monitor-depth-details";
    elements.surface.replaceChildren(this.canvas, this.message, this.details);
    this.demand = new MonitorDepthDemand(document, (enabled) => {
      this.clearFrame();
      this.setState(enabled ? "waiting" : "off");
    });
    this.setState("off");
  }

  setSelected(selected: boolean) {
    this.selected = selected;
    this.elements.surface.hidden = !selected;
    this.demand.setSelected(selected);
    if (selected && !this.demand.enabled) this.setState(this.channel ? "paused" : "waiting");
  }

  setLive(live: boolean) {
    this.demand.setLive(live);
    if (!live && this.selected) this.setState("paused", "Depth is available during live capture.");
  }

  attachChannel(channel: RTCDataChannel) {
    if (this.disposed) return;
    this.disconnect();
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", this.receive);
    channel.addEventListener("close", this.closed);
    this.demand.attach(channel);
    if (this.selected) this.setState("waiting");
  }

  disconnect() {
    this.channel?.removeEventListener("message", this.receive);
    this.channel?.removeEventListener("close", this.closed);
    this.demand.attach(null);
    this.channel = null;
    this.clearFrame();
    this.setState(this.selected ? "waiting" : "off");
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
    this.demand.dispose();
  }

  private readonly closed = () => this.disconnect();
  private readonly receive = (event: MessageEvent) => {
    if (this.disposed || !this.demand.enabled) return;
    try {
      if (typeof event.data === "string") {
        if (event.data.length > 4_096) return;
        const status: unknown = JSON.parse(event.data);
        if (!validDepthStatus(status)) return;
        this.receiveStatus(status);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const frame = this.assembler.push(new Uint8Array(event.data));
      if (!frame) return;
      const context = this.canvas.getContext("2d", { alpha: false });
      if (!context) { this.setState("error", "Depth display is unavailable."); return; }
      const { width, height } = frame.header;
      if (!this.image || this.image.width !== width || this.image.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.image = context.createImageData(width, height);
      }
      colouriseDepthFrame(frame, this.image.data);
      context.putImageData(this.image, 0, 0);
      this.canvas.hidden = false;
      this.lastFrameAt = performance.now();
      this.setState("streaming");
      this.details.textContent = `${width}x${height} | Near 0.2 m/Far 5 m`;
      if (this.staleTimer !== null) clearTimeout(this.staleTimer);
      this.staleTimer = setTimeout(() => {
        this.staleTimer = null;
        this.clearFrame();
        if (this.demand.enabled) this.setState("waiting");
      }, 2_000);
    } catch {
      this.assembler.reset();
      // A malformed or dropped visual frame cannot affect recorder transport.
    }
  };
  private receiveStatus(status: DepthStatus) {
    if (status.status === "streaming" && (!this.lastFrameAt || performance.now() - this.lastFrameAt > 2_000)) return;
    if (status.status !== "streaming") this.clearFrame();
    this.setState(status.status);
  }
  private clearFrame() {
    this.assembler.reset();
    this.canvas.hidden = true;
    this.details.textContent = "";
    this.lastFrameAt = 0;
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }
  private setState(state: MonitorDepthState, message?: string) {
    this.state = state;
    const labels: Record<MonitorDepthState, string> = {
      off: "OFF", waiting: "WAIT", streaming: "LIVE", paused: "PAUSED", unsupported: "UNAVAILABLE", error: "ERROR",
    };
    const messages: Record<MonitorDepthState, string> = {
      off: "Depth preview is off.", waiting: "Waiting for depth frames from the headset.", streaming: "",
      paused: "Depth preview is paused.", unsupported: "Environment depth is unavailable on this headset.",
      error: "Environment depth is unavailable.",
    };
    this.elements.surface.dataset.depthState = state;
    this.message.textContent = message ?? messages[state];
    this.message.hidden = state === "streaming";
    this.elements.onStateChange?.(this.state, labels[state]);
  }
}
