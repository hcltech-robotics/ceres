import {
  encodeDepthFrame, fragmentDepthFrame, isDepthFormat, isDepthUsage,
  type DepthHeader, type DepthSourceDiagnostics, type DepthSourceFormat, type DepthStatus, type DepthUsage,
} from "../../shared/bridge-depth.js";
import { DepthGpuReadback, gpuDepthEncoding, type GpuDepthImage } from "./depth-gpu.js";

export interface DepthGeometry {
  transform: { matrix: ArrayLike<number> };
  projectionMatrix: ArrayLike<number>;
}
export interface DepthImage {
  width: number;
  height: number;
  rawValueToMeters: number;
  normDepthBufferFromNormView: { matrix: ArrayLike<number> };
  transform?: DepthGeometry["transform"];
  projectionMatrix?: ArrayLike<number>;
  view?: DepthGeometry;
  data?: ArrayBuffer;
  texture?: WebGLTexture;
  textureType?: "texture" | "texture-array";
  imageIndex?: number | null;
  isValid?: boolean;
  depthNear?: number;
  depthFar?: number;
}
export interface DepthRenderer {
  getContext(): WebGLRenderingContext | WebGL2RenderingContext;
  xr: { getBinding(): { getDepthInformation?(view: XRView): DepthImage | null } | null };
}
export interface DepthPeer {
  epoch: number;
  depthMetadataVersion?: 1 | 2;
  depthEnabled?: boolean;
  depth: Pick<RTCDataChannel, "readyState" | "bufferedAmount" | "send"> | null;
  sendDepthStatus(status: DepthStatus): boolean;
}
export function depthDimensions(width: number, height: number) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error("Invalid depth image dimensions");
  const scale = Math.min(1, 256 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
export function millimetres(raw: number, scale: number) {
  const mm = raw * scale * 1000;
  return Number.isFinite(mm) && mm >= .5 && mm < 65535.5 ? Math.floor(mm + .5) : 0;
}
/** Sample the original depth buffer. Its normalised coordinate transform is unchanged. */
export function copyCpuDepth(image: DepthImage, format: DepthSourceFormat, width: number, height: number): Uint16Array<ArrayBuffer> {
  if (!image.data || !Number.isFinite(image.rawValueToMeters) || image.rawValueToMeters <= 0) throw new Error("Invalid CPU depth buffer");
  const stride = format === "float32" ? 4 : 2;
  if (image.data.byteLength !== image.width * image.height * stride) throw new Error("Depth buffer size does not match its dimensions");
  const source = new DataView(image.data);
  const pixels = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.min(image.height - 1, Math.floor((y + .5) * image.height / height));
    for (let x = 0; x < width; x++) {
      const column = Math.min(image.width - 1, Math.floor((x + .5) * image.width / width));
      const at = (row * image.width + column) * stride;
      pixels[y * width + x] = millimetres(format === "float32" ? source.getFloat32(at, true) : source.getUint16(at, true), image.rawValueToMeters);
    }
  }
  return pixels;
}
export function depthGeometry(image: DepthImage, view: XRView, usage?: DepthUsage, format?: DepthSourceFormat):
Pick<DepthHeader, "world_from_view" | "projection" | "norm_depth_from_norm_view" | "geometry_source" | "mapping_version"> {
  // Newer WebXR implementations expose the depth sensor's original geometry.
  // Older implementations honour matchDepthView and use the associated XRView.
  const sensor = Boolean(image.transform && image.projectionMatrix);
  const original = sensor ? image as DepthGeometry : image.view;
  const geometry = original ?? view;
  const norm = Array.from(image.normDepthBufferFromNormView.matrix);
  if (usage === "gpu-optimized" && format && gpuDepthEncoding(image, format) === "perspective") {
    // Meta's perspective GPU depth uses framebuffer rows, unlike its CPU data.
    // IWSDK 0.4.2 depth-sensing-system samples GPU screenUV and CPU (x, 1-y).
    // Compose F * N to map API depth coordinates into those raw framebuffer rows.
    // Applying F to the whole output row preserves crops, rotations and reflection.
    for (let column = 0; column < 4; column++) norm[column * 4 + 1] = norm[column * 4 + 3]! - norm[column * 4 + 1]!;
  }
  return {
    mapping_version: 2,
    geometry_source: sensor ? "sensor" : image.view ? "view" : "view-fallback",
    world_from_view: Array.from(geometry.transform.matrix),
    projection: Array.from(geometry.projectionMatrix),
    norm_depth_from_norm_view: norm,
  };
}
type GpuReader = Pick<DepthGpuReadback, "capture" | "poll" | "cancel" | "dispose" | "busy">;
const defaultGpu = (gl: WebGL2RenderingContext): GpuReader => new DepthGpuReadback(gl);

/** Optional, bounded work following the authoritative pose publication. */
export class BridgeDepth {
  private session: XRSession | null = null;
  private renderer: DepthRenderer | null = null;
  private gpu: GpuReader | null = null;
  private pending: { header: DepthHeader; at: number } | null = null;
  private usage: DepthUsage | null = null;
  private format: DepthSourceFormat | null = null;
  private status: DepthStatus["status"] = "unsupported";
  private diagnostics: DepthSourceDiagnostics = {};
  private diagnosticKey = "";
  private error: string | undefined;
  private lastStatus = "";
  private epoch = -1;
  private spaceEpoch = -1;
  private sequence = 0;
  private nextAt = 0;
  private lastAt = -1;
  private capturePaused = false;
  constructor(private readonly createGpu = defaultGpu) {}
  start(session: XRSession, renderer?: DepthRenderer) {
    this.stop();
    this.session = session;
    this.renderer = renderer ?? null;
    try {
      const granted = session as XRSession & { depthUsage?: unknown; depthDataFormat?: unknown };
      if (!isDepthUsage(granted.depthUsage) || !isDepthFormat(granted.depthDataFormat)) return;
      this.usage = granted.depthUsage;
      this.format = granted.depthDataFormat;
      if (this.usage === "gpu-optimized") {
        if (!renderer) throw new Error("Depth renderer is unavailable");
        this.gpu = this.createGpu(renderer.getContext() as WebGL2RenderingContext);
      }
      this.status = "waiting";
    } catch (error) {
      // A missing optional feature may throw from depthUsage/depthDataFormat.
      this.status = this.usage ? "error" : "unsupported";
      if (this.usage) this.error = error instanceof Error ? error.message.slice(0, 160) : "Depth initialisation failed";
    }
  }
  reset() {
    this.gpu?.cancel();
    this.pending = null;
    this.nextAt = 0;
    this.lastAt = -1;
    this.lastStatus = "";
    if (this.status !== "unsupported" && this.status !== "error") this.status = "waiting";
  }
  stop() {
    this.gpu?.dispose();
    this.gpu = null;
    this.session = null;
    this.renderer = null;
    this.usage = this.format = null;
    this.status = "unsupported";
    this.diagnostics = {};
    this.diagnosticKey = "";
    this.error = undefined;
    this.epoch = this.spaceEpoch = -1;
    this.sequence = 0;
    this.capturePaused = false;
    this.reset();
  }
  publish(frame: XRFrame, space: XRReferenceSpace, displayTime: number, peer: DepthPeer | null,
    spaceEpoch: number, paused: boolean, now = performance.now()) {
    if (!peer || frame.session !== this.session) return;
    if (this.epoch !== peer.epoch || this.spaceEpoch !== spaceEpoch || now < this.lastAt) {
      this.reset();
      this.epoch = peer.epoch;
      this.spaceEpoch = spaceEpoch;
    }
    this.lastAt = now;
    if (paused || peer.depthEnabled === false) {
      this.gpu?.cancel();
      this.pending = null;
      this.nextAt = 0;
      if (!this.capturePaused && this.usage) {
        try {
          const session = this.session as XRSession & { pauseDepthSensing?(): void };
          session.pauseDepthSensing?.();
          this.capturePaused = true;
        } catch (error) {
          this.error = error instanceof Error ? error.message.slice(0, 160) : "Depth pause failed";
          this.sendStatus(peer, "error");
          return;
        }
      }
      this.sendStatus(peer, "paused");
      return;
    }
    if (!this.usage || !this.format || (this.usage === "gpu-optimized" && !this.gpu)) {
      this.sendStatus(peer, this.status);
      return;
    }
    const channel = peer.depth;
    if (!channel || channel.readyState !== "open") {
      this.reset();
      this.sendStatus(peer, "waiting");
      return;
    }
    try {
      if (this.pending) {
        const pending = this.pending;
        if (now - pending.at > 250 || channel.bufferedAmount > 0) {
          this.gpu?.cancel();
          this.pending = null;
        } else {
          const pixels = this.gpu?.poll();
          if (pixels) {
            this.pending = null;
            pending.header.readback_us = Math.max(0, Math.round((now - pending.at) * 1000));
            this.transmit(peer, pending.header, pixels);
          }
        }
      }
      if (this.pending || now < this.nextAt || channel.bufferedAmount > 0) {
        this.sendStatus(peer, this.status);
        return;
      }
      this.nextAt = now + 500;
      const depthSession = this.session as XRSession & { depthActive?: boolean; resumeDepthSensing?(): void };
      if (this.capturePaused || depthSession.depthActive === false) {
        depthSession.resumeDepthSensing?.();
        if (depthSession.depthActive === false) { this.sendStatus(peer, "waiting"); return; }
        this.capturePaused = false;
      }
      const pose = frame.getViewerPose(space);
      if (!pose || !this.usage || !this.format) { this.sendStatus(peer, "waiting"); return; }
      for (const view of pose.views) {
        const image: DepthImage | null | undefined = this.usage === "cpu-optimized"
          ? (frame as XRFrame & { getDepthInformation?(view: XRView): DepthImage | null }).getDepthInformation?.(view)
          : this.renderer?.xr.getBinding()?.getDepthInformation?.(view);
        if (!image) continue;
        this.diagnostics = {
          source_encoding: this.usage === "gpu-optimized" ? gpuDepthEncoding(image, this.format) : "linear",
          raw_value_to_metres: Number.isFinite(image.rawValueToMeters) ? image.rawValueToMeters : null,
          ...(image.depthNear !== undefined ? { depth_near: Number.isFinite(image.depthNear) ? image.depthNear : null } : {}),
          ...(image.depthFar !== undefined ? { depth_far: image.depthFar === Infinity ? "infinity" as const
            : Number.isFinite(image.depthFar) ? image.depthFar : null } : {}),
          ...(image.textureType === "texture" || image.textureType === "texture-array" ? { texture_type: image.textureType } : {}),
          ...(image.imageIndex !== undefined ? { image_index: Number.isInteger(image.imageIndex) ? image.imageIndex : null } : {}),
          ...(typeof image.isValid === "boolean" ? { source_valid: image.isValid } : {}),
        };
        this.diagnosticKey = JSON.stringify(this.diagnostics);
        if (image.isValid === false) continue;
        const dimensions = depthDimensions(image.width, image.height);
        if (!Number.isFinite(image.rawValueToMeters) || image.rawValueToMeters <= 0) continue;
        const header: DepthHeader = {
          version: 1, epoch: peer.epoch, space_epoch: spaceEpoch, sequence: this.sequence++ >>> 0,
          // Share the pose and clock-exchange sender-monotonic domain.
          observed_us: Math.round(now * 1000), target_us: Math.max(0, Math.round(displayTime * 1000)),
          ...dimensions, source_width: image.width, source_height: image.height, eye: view.eye,
          usage: this.usage, source_format: this.format, depth_format: "uint16-mm",
          ...depthGeometry(image, view, this.usage, this.format),
        };
        header.target_lead_us = header.target_us - header.observed_us;
        this.diagnostics.geometry_source = header.geometry_source;
        this.diagnostics.mapping_version = header.mapping_version;
        this.diagnostics.target_lead_us = header.target_lead_us;
        this.diagnosticKey = JSON.stringify(this.diagnostics);
        if (this.usage === "cpu-optimized") {
          const started = performance.now();
          const pixels = copyCpuDepth(image, this.format, dimensions.width, dimensions.height);
          header.readback_us = Math.max(0, Math.round((performance.now() - started) * 1000));
          this.transmit(peer, header, pixels);
        } else if (image.texture && image.textureType && this.gpu?.capture(image as GpuDepthImage, this.format, dimensions.width, dimensions.height)) {
          this.pending = { header, at: now };
        } else continue;
        this.sendStatus(peer, this.status);
        return;
      }
      this.sendStatus(peer, "waiting");
    } catch (error) {
      this.gpu?.cancel();
      this.pending = null;
      // Optional spatial acquisition must never stop poses, video or recording.
      this.error = error instanceof Error ? error.message.slice(0, 160) : "Depth acquisition failed";
      this.sendStatus(peer, "error");
    }
  }
  private transmit(peer: DepthPeer, header: DepthHeader, pixels: Uint16Array) {
    const channel = peer.depth;
    if (peer.depthEnabled === false || !channel || channel.readyState !== "open" || channel.bufferedAmount !== 0
      || peer.epoch !== header.epoch || this.spaceEpoch !== header.space_epoch) return;
    const { geometry_source, readback_us, target_lead_us, mapping_version, ...legacyHeader } = header;
    const wireHeader = peer.depthMetadataVersion === 2 ? header : legacyHeader;
    const fragments = fragmentDepthFrame(encodeDepthFrame(wireHeader, pixels), header);
    for (const fragment of fragments) channel.send(fragment);
    this.diagnostics.geometry_source = header.geometry_source;
    this.diagnostics.mapping_version = header.mapping_version;
    this.diagnostics.readback_us = header.readback_us;
    this.diagnostics.target_lead_us = header.target_lead_us;
    this.diagnosticKey = JSON.stringify(this.diagnostics);
    this.sendStatus(peer, "streaming");
  }
  private sendStatus(peer: DepthPeer, status: DepthStatus["status"]) {
    this.status = status === "paused" ? this.status : status;
    if (status !== "error" && status !== "paused") this.error = undefined;
    const key = `${peer.epoch}/${status}/${this.usage}/${this.format}/${this.diagnosticKey}/${status === "error" ? this.error : ""}`;
    if (key === this.lastStatus) return;
    const message: DepthStatus = { type: "depth-status", version: 1, epoch: peer.epoch, status,
      usage: this.usage, source_format: this.format, ...this.diagnostics,
      ...(this.error && status === "error" ? { error: this.error } : {}) };
    if (peer.sendDepthStatus(message)) this.lastStatus = key;
  }
}
