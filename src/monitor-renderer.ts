import type { Quat, SensorFrame, Transform } from "../shared/protocol.js";
import {
  effectiveHandRenderMode,
  handMeshStatus,
  type HandMeshStatus,
} from "../shared/hand-display.js";
import { semanticColours, semanticSignalColours } from "../shared/semantic-colours.js";
import {
  bonePairs,
  fitManoVertices,
  jetColour,
  jointNames,
  manoJointTargets,
  middleburyColour,
  normalColour,
  sideColour,
  validateManoAsset,
  type ManoAsset,
  type MotionSample,
  type Rgba,
  type Vec3Like,
} from "./hand-visualisation.js";
import type { MonitorVisualSettings } from "./monitor-worker-session.js";
import { projectWorldPointToCameraInto } from "./camera-projection.js";

const traceCapacity = 240;
const traceChannels = 20;
const poseInstanceCapacity = 256;
const poseInstanceStride = 12;
const manoMeshVertexCapacity = 10_000;
const manoMeshVertexStride = 6;
const motionHistoryCapacity = 240;
const cogTrailCapacity = 48;
const gpuBufferUsage = { mapRead: 0x0001, copySrc: 0x0004, copyDst: 0x0008, vertex: 0x0020, uniform: 0x0040, storage: 0x0080, queryResolve: 0x0200 } as const;

const signalRanges: Record<string, readonly [number, number]> = {
  hxyz: [0, 3], hrot: [3, 6], lpos: [6, 9], lrot: [9, 12], lp: [12, 13],
  rpos: [13, 16], rrot: [16, 19], rp: [19, 20],
};

const defaultSettings: MonitorVisualSettings = {
  signals: ["hxyz", "hrot", "lpos", "lrot", "lp", "rpos", "rrot", "rp"], handMode: "outline", handShading: "side", handTrail: "off",
  cameraProjection: null,
  reticle: false, aid: false, trails: false,
};

type HandSide = "left" | "right";
type JointHistory = Map<string, MotionSample[]>;

const rgbaBufferCss = (values: Float32Array, offset: number) => `rgba(${Math.round(values[offset] * 255)}, ${Math.round(values[offset + 1] * 255)}, ${Math.round(values[offset + 2] * 255)}, ${values[offset + 3]})`;

const quaternionToEuler = (rotation: Quat, target: Float32Array, offset: number) => {
  const { x, y, z, w } = rotation;
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  target[offset] = Math.atan2(sinr, cosr) / Math.PI;
  const sinp = 2 * (w * y - z * x);
  target[offset + 1] = (Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp)) / Math.PI;
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  target[offset + 2] = Math.atan2(siny, cosy) / Math.PI;
};

export type MonitorRendererKind = "webgpu" | "canvas2d" | "none";

export class MonitorRenderer {
  readonly trace = new Float32Array(traceCapacity * traceChannels);
  readonly poseInstances = new Float32Array(poseInstanceCapacity * poseInstanceStride);
  readonly manoMeshVertices = new Float32Array(manoMeshVertexCapacity * manoMeshVertexStride);
  readonly signalUniform = new Uint32Array(4);
  kind: MonitorRendererKind = "none";
  traceCount = 0;
  trackedHandCount = 0;
  gpuDurationMs: number | null = null;
  get manoLoaded() { return Boolean(this.manoAssets.left && this.manoAssets.right); }
  get meshStatus(): HandMeshStatus { return handMeshStatus(this.manoLoaded); }
  private traceWrite = 0;
  private poseInstanceCount = 0;
  private manoMeshVertexCount = 0;
  private settings = defaultSettings;
  private signalMask = 0;
  private readonly jointHistory: Record<HandSide, JointHistory> = { left: new Map(), right: new Map() };
  private readonly cogHistory: Record<HandSide, MotionSample[]> = { left: [], right: [] };
  private readonly manoAssets: Partial<Record<HandSide, ManoAsset>> = {};
  private readonly projectionScratch = new Float32Array(6);
  private readonly manoTargets: Record<HandSide, Record<string, Vec3Like>> = { left: {}, right: {} };
  private readonly manoJointColours: Record<HandSide, Map<string, Rgba>> = { left: new Map(), right: new Map() };
  private readonly manoCornerColours: Rgba[] = [sideColour("left"), sideColour("left"), sideColour("left")];
  private readonly vertexPositionScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly normalScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private device: any = null;
  private poseContext: any = null;
  private signalContext: any = null;
  private posePipeline: any = null;
  private manoMeshPipeline: any = null;
  private signalPipeline: any = null;
  private poseBuffer: any = null;
  private manoMeshBuffer: any = null;
  private traceBuffer: any = null;
  private signalUniformBuffer: any = null;
  private poseBindGroup: any = null;
  private signalBindGroup: any = null;
  private readonly submitList: any[] = [null];
  private timestampQuerySet: any = null;
  private timestampResolveBuffer: any = null;
  private timestampReadBuffer: any = null;
  private timestampReadPending = false;
  private renderedFrames = 0;
  private pose2d: OffscreenCanvasRenderingContext2D | null = null;
  private signal2d: OffscreenCanvasRenderingContext2D | null = null;

  private constructor(
    private readonly poseCanvas: OffscreenCanvas,
    private readonly signalCanvas: OffscreenCanvas,
  ) {
    this.updateSignalMask();
  }

  static async create(poseCanvas: OffscreenCanvas, signalCanvas: OffscreenCanvas) {
    const renderer = new MonitorRenderer(poseCanvas, signalCanvas);
    await renderer.loadManoAssets();
    if (await renderer.initialiseWebGpu()) renderer.kind = "webgpu";
    else if (renderer.initialiseCanvas2d()) renderer.kind = "canvas2d";
    return renderer;
  }

  resize(poseWidth: number, poseHeight: number, signalWidth: number, signalHeight: number) {
    if (this.poseCanvas.width !== poseWidth) this.poseCanvas.width = poseWidth;
    if (this.poseCanvas.height !== poseHeight) this.poseCanvas.height = poseHeight;
    if (this.signalCanvas.width !== signalWidth) this.signalCanvas.width = signalWidth;
    if (this.signalCanvas.height !== signalHeight) this.signalCanvas.height = signalHeight;
  }

  setSettings(settings: MonitorVisualSettings) {
    this.settings = settings;
    this.updateSignalMask();
  }

  ingest(frame: SensorFrame, keepHistory: boolean) {
    this.trackedHandCount = Number(frame.leftHand.tracked) + Number(frame.rightHand.tracked);
    if (!keepHistory) {
      this.traceCount = 0;
      this.traceWrite = 0;
      this.clearMotionHistory();
    }
    const offset = this.traceWrite * traceChannels;
    const values = this.trace;
    values.fill(0, offset, offset + traceChannels);
    if (frame.head) {
      values[offset] = frame.head.position.x * .5;
      values[offset + 1] = frame.head.position.y * .5;
      values[offset + 2] = frame.head.position.z * .5;
      quaternionToEuler(frame.head.rotation, values, offset + 3);
    }
    this.writeHandTrace(frame.leftHand.joints.wrist, frame.leftHand.pinch, values, offset + 6, offset + 12);
    this.writeHandTrace(frame.rightHand.joints.wrist, frame.rightHand.pinch, values, offset + 13, offset + 19);
    this.traceWrite = (this.traceWrite + 1) % traceCapacity;
    this.traceCount = Math.min(traceCapacity, this.traceCount + 1);
    this.updateMotionHistory(frame.timestampMs, "left", frame.leftHand);
    this.updateMotionHistory(frame.timestampMs, "right", frame.rightHand);
    this.buildPoseInstances(frame);
  }

  render() {
    if (this.kind === "webgpu") this.renderWebGpu();
    else if (this.kind === "canvas2d") this.renderCanvas2d();
  }

  clearHistory() {
    this.trace.fill(0);
    this.poseInstances.fill(0);
    this.manoMeshVertices.fill(0);
    this.traceCount = 0;
    this.traceWrite = 0;
    this.poseInstanceCount = 0;
    this.manoMeshVertexCount = 0;
    this.trackedHandCount = 0;
    this.clearMotionHistory();
  }

  private writeHandTrace(wrist: Transform | undefined, pinch: number, target: Float32Array, positionOffset: number, pinchOffset: number) {
    if (wrist) {
      target[positionOffset] = wrist.position.x * .5;
      target[positionOffset + 1] = wrist.position.y * .5;
      target[positionOffset + 2] = wrist.position.z * .5;
      quaternionToEuler(wrist.rotation, target, positionOffset + 3);
    }
    target[pinchOffset] = Math.min(1, pinch / .12) * 2 - 1;
  }

  private buildPoseInstances(frame: SensorFrame) {
    this.poseInstances.fill(0);
    this.manoMeshVertices.fill(0);
    this.poseInstanceCount = 0;
    this.manoMeshVertexCount = 0;
    if (!frame.head && !frame.camera) return;
    this.addHand("left", frame.leftHand, frame);
    this.addHand("right", frame.rightHand, frame);
  }

  private addHand(side: HandSide, hand: SensorFrame["leftHand"], frame: SensorFrame) {
    if (!hand.tracked) return;
    const joints = hand.joints;
    if (this.settings.handTrail === "cog") this.addCogTrail(side, frame);
    const handMode = effectiveHandRenderMode(this.settings.handMode, this.manoLoaded);
    if (handMode === "off") return;
    if (handMode === "mesh") {
      if (frame.handProjection === null) return;
      const asset = this.manoAssets[side];
      if (asset) this.addManoMesh(side, asset, joints, frame);
      return;
    }
    if (handMode === "outline") {
      for (let index = 0; index < bonePairs.length; index += 1) {
        const [fromName, toName] = bonePairs[index];
        const from = joints[fromName];
        const to = joints[toName];
        if (!from || !to) continue;
        const start = this.projectJointIntoCamera(side, fromName, from.position, frame, this.projectionScratch, 0);
        const end = this.projectJointIntoCamera(side, toName, to.position, frame, this.projectionScratch, 2);
        if (start && end) this.addPoseInstance(this.projectionScratch[0], this.projectionScratch[1], this.projectionScratch[2], this.projectionScratch[3], .005, 1, this.jointColour(side, toName, to.position));
      }
      return;
    }
    for (let index = 0; index < jointNames.length; index += 1) {
      const name = jointNames[index];
      const joint = joints[name];
      if (!joint) continue;
      if (this.projectJointIntoCamera(side, name, joint.position, frame, this.projectionScratch, 0)) {
        this.addPoseInstance(this.projectionScratch[0], this.projectionScratch[1], 0, 0, .01, 0, this.jointColour(side, name, joint.position));
      }
    }
  }

  private addPoseInstance(startX: number, startY: number, endX: number, endY: number, size: number, type: number, colour: Rgba) {
    if (this.poseInstanceCount >= poseInstanceCapacity) return;
    const offset = this.poseInstanceCount * poseInstanceStride;
    const target = this.poseInstances;
    target[offset] = startX;
    target[offset + 1] = startY;
    target[offset + 2] = endX;
    target[offset + 3] = endY;
    target[offset + 4] = size;
    target[offset + 5] = type;
    target[offset + 6] = colour[0];
    target[offset + 7] = colour[1];
    target[offset + 8] = colour[2];
    target[offset + 9] = colour[3];
    target[offset + 10] = 1;
    this.poseInstanceCount += 1;
  }

  private addCogTrail(side: HandSide, frame: SensorFrame) {
    const history = this.cogHistory[side];
    for (let index = 1; index < history.length; index += 1) {
      const progress = index / history.length;
      const colour = sideColour(side, .08 + progress * .72);
      const start = this.projectIntoCamera(history[index - 1], frame, this.projectionScratch, 0);
      const end = this.projectIntoCamera(history[index], frame, this.projectionScratch, 2);
      if (start && end) this.addPoseInstance(this.projectionScratch[0], this.projectionScratch[1], this.projectionScratch[2], this.projectionScratch[3], .0025, 1, colour);
    }
  }

  private addManoMesh(side: HandSide, asset: ManoAsset, joints: SensorFrame["leftHand"]["joints"], frame: SensorFrame) {
    const targets = this.manoTargets[side];
    for (const name of [...asset.jointNames, ...Object.keys(asset.tipVertexIds)]) {
      const joint = joints[manoJointTargets[name]];
      if (!joint) return;
      targets[name] = joint.position;
    }
    const vertices = fitManoVertices(asset, targets);
    if (!vertices) return;
    const jointColours = this.manoJointColours[side];
    jointColours.clear();
    for (let face = 0; face < asset.faceCount; face += 1) {
      if (this.manoMeshVertexCount + 3 > manoMeshVertexCapacity) return;
      const firstVertex = asset.faces[face * 3];
      const secondVertex = asset.faces[face * 3 + 1];
      const thirdVertex = asset.faces[face * 3 + 2];
      const ax = vertices[firstVertex * 3];
      const ay = vertices[firstVertex * 3 + 1];
      const az = vertices[firstVertex * 3 + 2];
      const edgeAx = vertices[secondVertex * 3] - ax;
      const edgeAy = vertices[secondVertex * 3 + 1] - ay;
      const edgeAz = vertices[secondVertex * 3 + 2] - az;
      const edgeBx = vertices[thirdVertex * 3] - ax;
      const edgeBy = vertices[thirdVertex * 3 + 1] - ay;
      const edgeBz = vertices[thirdVertex * 3 + 2] - az;
      let normalX = edgeAy * edgeBz - edgeAz * edgeBy;
      let normalY = edgeAz * edgeBx - edgeAx * edgeBz;
      let normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
      const normalMagnitude = Math.hypot(normalX, normalY, normalZ);
      if (normalMagnitude > 1e-8) {
        normalX /= normalMagnitude;
        normalY /= normalMagnitude;
        normalZ /= normalMagnitude;
      } else {
        normalX = 0;
        normalY = 0;
        normalZ = 0;
      }
      this.normalScratch.x = normalX;
      this.normalScratch.y = normalY;
      this.normalScratch.z = normalZ;
      const normalFaceColour = this.settings.handShading === "normal" ? normalColour(this.normalScratch) : null;
      let projected = true;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = corner === 0 ? firstVertex : corner === 1 ? secondVertex : thirdVertex;
        const position = this.vertexPositionScratch;
        position.x = vertices[vertex * 3];
        position.y = vertices[vertex * 3 + 1];
        position.z = vertices[vertex * 3 + 2];
        const jointName = this.dominantJointName(asset, vertex);
        let colour = normalFaceColour ?? jointColours.get(jointName);
        if (!colour) {
          colour = this.jointColour(side, jointName, position);
          jointColours.set(jointName, colour);
        }
        this.manoCornerColours[corner] = colour;
        if (!this.projectIntoCamera(position, frame, this.projectionScratch, corner * 2)) {
          projected = false;
          break;
        }
      }
      if (!projected) continue;
      for (let corner = 0; corner < 3; corner += 1) {
        this.addManoMeshVertex(this.projectionScratch[corner * 2], this.projectionScratch[corner * 2 + 1], this.manoCornerColours[corner]);
      }
    }
  }

  private addManoMeshVertex(x: number, y: number, colour: Rgba) {
    const offset = this.manoMeshVertexCount * manoMeshVertexStride;
    this.manoMeshVertices[offset] = x;
    this.manoMeshVertices[offset + 1] = y;
    this.manoMeshVertices[offset + 2] = colour[0];
    this.manoMeshVertices[offset + 3] = colour[1];
    this.manoMeshVertices[offset + 4] = colour[2];
    this.manoMeshVertices[offset + 5] = colour[3];
    this.manoMeshVertexCount += 1;
  }

  private projectIntoCamera(position: Vec3Like, frame: SensorFrame, target: Float32Array, offset: number): boolean {
    if (frame.handProjection === null) return false;
    const fallbackHead = frame.head ?? frame.camera?.transform;
    if (!fallbackHead) return false;
    return projectWorldPointToCameraInto(
      position,
      frame.camera,
      this.settings.cameraProjection,
      fallbackHead,
      frame.cameraSide ?? "unknown",
      target,
      offset,
    );
  }

  private projectJointIntoCamera(
    side: HandSide,
    jointName: string,
    position: Vec3Like,
    frame: SensorFrame,
    target: Float32Array,
    offset: number,
  ) {
    if (frame.handProjection === null) return false;
    const projectedHand = frame.handProjection?.[side === "left" ? "leftHand" : "rightHand"];
    if (!projectedHand) return this.projectIntoCamera(position, frame, target, offset);
    const joint = projectedHand.joints[jointName];
    if (!joint || !Number.isFinite(joint.x) || !Number.isFinite(joint.y)) return false;
    target[offset] = joint.x;
    target[offset + 1] = joint.y;
    return true;
  }

  private dominantJointName(asset: ManoAsset, vertex: number) {
    let bestJoint = 0;
    let bestWeight = -1;
    for (let joint = 0; joint < asset.jointCount; joint += 1) {
      const weight = asset.weights[vertex * asset.jointCount + joint];
      if (weight > bestWeight) {
        bestWeight = weight;
        bestJoint = joint;
      }
    }
    return manoJointTargets[asset.jointNames[bestJoint]] ?? "wrist";
  }

  private jointColour(side: HandSide, jointName: string, position: Vec3Like): Rgba {
    const samples = this.jointHistory[side].get(jointName) ?? [];
    const velocity = this.latestVelocity(samples);
    if (this.settings.handShading === "velocity") return jetColour(velocity.speed / 1.5);
    if (this.settings.handShading === "motion") return middleburyColour(velocity.x, velocity.z, 1.5);
    if (this.settings.handShading === "normal") {
      const cog = this.cogHistory[side].at(-1);
      return normalColour(cog ? this.normalise({ x: position.x - cog.x, y: position.y - cog.y, z: position.z - cog.z }) : { x: 0, y: 1, z: 0 });
    }
    return sideColour(side);
  }

  private latestVelocity(samples: readonly MotionSample[]) {
    if (samples.length < 2) return { x: 0, y: 0, z: 0, speed: 0 };
    const current = samples[samples.length - 1];
    const previous = samples[samples.length - 2];
    const elapsed = (current.timestampMs - previous.timestampMs) / 1_000;
    if (elapsed <= 0) return { x: 0, y: 0, z: 0, speed: 0 };
    const x = (current.x - previous.x) / elapsed;
    const y = (current.y - previous.y) / elapsed;
    const z = (current.z - previous.z) / elapsed;
    return { x, y, z, speed: Math.hypot(x, y, z) };
  }

  private normalise(value: Vec3Like): Vec3Like {
    const magnitude = Math.hypot(value.x, value.y, value.z);
    return magnitude > 1e-8
      ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude }
      : { x: 0, y: 0, z: 0 };
  }

  private updateMotionHistory(timestampMs: number, side: HandSide, hand: SensorFrame["leftHand"]) {
    if (!hand.tracked) return;
    let cogX = 0;
    let cogY = 0;
    let cogZ = 0;
    let cogCount = 0;
    for (const name of jointNames) {
      const joint = hand.joints[name];
      if (!joint) continue;
      const history = this.jointHistory[side].get(name) ?? [];
      history.push({ timestampMs, x: joint.position.x, y: joint.position.y, z: joint.position.z });
      if (history.length > motionHistoryCapacity) history.splice(0, history.length - motionHistoryCapacity);
      this.jointHistory[side].set(name, history);
      cogX += joint.position.x;
      cogY += joint.position.y;
      cogZ += joint.position.z;
      cogCount += 1;
    }
    if (!cogCount) return;
    const cog = this.cogHistory[side];
    cog.push({ timestampMs, x: cogX / cogCount, y: cogY / cogCount, z: cogZ / cogCount });
    if (cog.length > cogTrailCapacity) cog.splice(0, cog.length - cogTrailCapacity);
  }

  private clearMotionHistory() {
    this.jointHistory.left.clear();
    this.jointHistory.right.clear();
    this.cogHistory.left.length = 0;
    this.cogHistory.right.length = 0;
  }

  private async loadManoAssets() {
    await Promise.all((["left", "right"] as const).map(async (side) => {
      try {
        const response = await fetch(`/assets/mano/mano-${side}.json`);
        if (!response.ok) return;
        const asset = await response.json() as ManoAsset;
        if (asset.side === side && validateManoAsset(asset)) this.manoAssets[side] = asset;
      } catch {
        // Licensed MANO assets are installed locally and may be absent in a clean checkout.
      }
    }));
  }

  private updateSignalMask() {
    let mask = 0;
    for (let index = 0; index < this.settings.signals.length; index += 1) {
      const range = signalRanges[this.settings.signals[index]];
      if (!range) continue;
      for (let channel = range[0]; channel < range[1]; channel += 1) mask |= 1 << channel;
    }
    this.signalMask = mask;
  }

  private async initialiseWebGpu() {
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu) return false;
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return false;
      const timestampQueries = adapter.features?.has?.("timestamp-query") === true;
      this.device = await adapter.requestDevice(timestampQueries ? { requiredFeatures: ["timestamp-query"] } : undefined);
      this.poseContext = this.poseCanvas.getContext("webgpu" as OffscreenRenderingContextId) as any;
      this.signalContext = this.signalCanvas.getContext("webgpu" as OffscreenRenderingContextId) as any;
      if (!this.poseContext || !this.signalContext) return false;
      const format = gpu.getPreferredCanvasFormat();
      this.poseContext.configure({ device: this.device, format, alphaMode: "premultiplied" });
      this.signalContext.configure({ device: this.device, format, alphaMode: "opaque" });
      this.poseBuffer = this.device.createBuffer({ size: this.poseInstances.byteLength, usage: gpuBufferUsage.storage | gpuBufferUsage.copyDst });
      this.manoMeshBuffer = this.device.createBuffer({ size: this.manoMeshVertices.byteLength, usage: gpuBufferUsage.vertex | gpuBufferUsage.copyDst });
      this.traceBuffer = this.device.createBuffer({ size: this.trace.byteLength, usage: gpuBufferUsage.storage | gpuBufferUsage.copyDst });
      this.signalUniformBuffer = this.device.createBuffer({ size: 16, usage: gpuBufferUsage.uniform | gpuBufferUsage.copyDst });
      const colourTarget = { format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } };
      this.posePipeline = this.device.createRenderPipeline({ layout: "auto", vertex: { module: this.device.createShaderModule({ code: poseShader }), entryPoint: "vs" }, fragment: { module: this.device.createShaderModule({ code: fragmentShader }), entryPoint: "fs", targets: [colourTarget] }, primitive: { topology: "triangle-list" } });
      this.manoMeshPipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.device.createShaderModule({ code: manoMeshShader }),
          entryPoint: "vs",
          buffers: [{
            arrayStride: manoMeshVertexStride * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x4" },
            ],
          }],
        },
        fragment: { module: this.device.createShaderModule({ code: fragmentShader }), entryPoint: "fs", targets: [colourTarget] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      });
      this.signalPipeline = this.device.createRenderPipeline({ layout: "auto", vertex: { module: this.device.createShaderModule({ code: signalShader }), entryPoint: "vs" }, fragment: { module: this.device.createShaderModule({ code: fragmentShader }), entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "line-list" } });
      this.poseBindGroup = this.device.createBindGroup({ layout: this.posePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.poseBuffer } }] });
      this.signalBindGroup = this.device.createBindGroup({ layout: this.signalPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.traceBuffer } }, { binding: 1, resource: { buffer: this.signalUniformBuffer } }] });
      if (timestampQueries) {
        this.timestampQuerySet = this.device.createQuerySet({ type: "timestamp", count: 4 });
        this.timestampResolveBuffer = this.device.createBuffer({ size: 32, usage: gpuBufferUsage.queryResolve | gpuBufferUsage.copySrc });
        this.timestampReadBuffer = this.device.createBuffer({ size: 32, usage: gpuBufferUsage.copyDst | gpuBufferUsage.mapRead });
      }
      this.device.lost.then(() => { this.kind = this.initialiseCanvas2d() ? "canvas2d" : "none"; });
      return true;
    } catch {
      return false;
    }
  }

  private initialiseCanvas2d() {
    this.pose2d = this.poseCanvas.getContext("2d");
    this.signal2d = this.signalCanvas.getContext("2d");
    return Boolean(this.pose2d && this.signal2d);
  }

  private renderWebGpu() {
    this.device.queue.writeBuffer(this.poseBuffer, 0, this.poseInstances.buffer, 0, this.poseInstances.byteLength);
    if (this.manoMeshVertexCount) this.device.queue.writeBuffer(this.manoMeshBuffer, 0, this.manoMeshVertices.buffer, 0, this.manoMeshVertexCount * manoMeshVertexStride * 4);
    this.device.queue.writeBuffer(this.traceBuffer, 0, this.trace.buffer, 0, this.trace.byteLength);
    this.signalUniform[0] = this.traceWrite;
    this.signalUniform[1] = this.traceCount;
    this.signalUniform[2] = this.signalMask;
    this.device.queue.writeBuffer(this.signalUniformBuffer, 0, this.signalUniform.buffer, 0, 16);
    const encoder = this.device.createCommandEncoder();
    this.renderedFrames += 1;
    const measureGpu = Boolean(this.timestampQuerySet && !this.timestampReadPending && this.renderedFrames % 60 === 0);
    const posePass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.poseContext.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      ...(measureGpu ? { timestampWrites: { querySet: this.timestampQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    if (this.manoMeshVertexCount) {
      posePass.setPipeline(this.manoMeshPipeline);
      posePass.setVertexBuffer(0, this.manoMeshBuffer);
      posePass.draw(this.manoMeshVertexCount);
    }
    posePass.setPipeline(this.posePipeline);
    posePass.setBindGroup(0, this.poseBindGroup);
    if (this.poseInstanceCount) posePass.draw(6, this.poseInstanceCount);
    posePass.end();
    const signalPass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.signalContext.getCurrentTexture().createView(), clearValue: { r: .078, g: .094, b: .114, a: 1 }, loadOp: "clear", storeOp: "store" }],
      ...(measureGpu ? { timestampWrites: { querySet: this.timestampQuerySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {}),
    });
    signalPass.setPipeline(this.signalPipeline);
    signalPass.setBindGroup(0, this.signalBindGroup);
    if (this.traceCount > 1) signalPass.draw((this.traceCount - 1) * 2, traceChannels);
    signalPass.end();
    if (measureGpu) {
      encoder.resolveQuerySet(this.timestampQuerySet, 0, 4, this.timestampResolveBuffer, 0);
      encoder.copyBufferToBuffer(this.timestampResolveBuffer, 0, this.timestampReadBuffer, 0, 32);
      this.timestampReadPending = true;
    }
    this.submitList[0] = encoder.finish();
    this.device.queue.submit(this.submitList);
    if (measureGpu) {
      void this.timestampReadBuffer.mapAsync(1).then(() => {
        const timestamps = new BigUint64Array(this.timestampReadBuffer.getMappedRange().slice(0));
        this.gpuDurationMs = Number((timestamps[1] - timestamps[0]) + (timestamps[3] - timestamps[2])) / 1_000_000;
        this.timestampReadBuffer.unmap();
        this.timestampReadPending = false;
      }).catch(() => {
        this.timestampReadPending = false;
      });
    }
  }

  private renderCanvas2d() {
    const pose = this.pose2d;
    const signal = this.signal2d;
    if (!pose || !signal) return;
    const pw = this.poseCanvas.width;
    const ph = this.poseCanvas.height;
    pose.clearRect(0, 0, pw, ph);
    for (let vertex = 0; vertex < this.manoMeshVertexCount; vertex += 3) {
      const firstOffset = vertex * manoMeshVertexStride;
      pose.fillStyle = rgbaBufferCss(this.manoMeshVertices, firstOffset + 2);
      pose.beginPath();
      for (let corner = 0; corner < 3; corner += 1) {
        const offset = (vertex + corner) * manoMeshVertexStride;
        const x = pw * (.5 + this.manoMeshVertices[offset] * .5);
        const y = ph * (.5 + this.manoMeshVertices[offset + 1] * .5);
        if (corner) pose.lineTo(x, y); else pose.moveTo(x, y);
      }
      pose.closePath();
      pose.fill();
    }
    for (let index = 0; index < this.poseInstanceCount; index += 1) {
      const offset = index * poseInstanceStride;
      const startX = pw * (.5 + this.poseInstances[offset] * .5);
      const startY = ph * (.5 + this.poseInstances[offset + 1] * .5);
      pose.strokeStyle = rgbaBufferCss(this.poseInstances, offset + 6);
      pose.fillStyle = pose.strokeStyle;
      if (this.poseInstances[offset + 5] === 1) {
        pose.lineWidth = Math.max(1, this.poseInstances[offset + 4] * pw);
        pose.beginPath();
        pose.moveTo(startX, startY);
        pose.lineTo(pw * (.5 + this.poseInstances[offset + 2] * .5), ph * (.5 + this.poseInstances[offset + 3] * .5));
        pose.stroke();
      } else {
        const radius = Math.max(2, this.poseInstances[offset + 4] * pw);
        pose.beginPath(); pose.arc(startX, startY, radius, 0, Math.PI * 2); pose.fill();
      }
    }
    const sw = this.signalCanvas.width;
    const sh = this.signalCanvas.height;
    signal.fillStyle = semanticColours.surface;
    signal.fillRect(0, 0, sw, sh);
    signal.strokeStyle = semanticColours.border;
    signal.lineWidth = 1;
    for (let y = 24; y < sh; y += 32) { signal.beginPath(); signal.moveTo(0, y); signal.lineTo(sw, y); signal.stroke(); }
    if (this.traceCount < 2) return;
    for (let channel = 0; channel < traceChannels; channel += 1) {
      if (!(this.signalMask & (1 << channel))) continue;
      signal.strokeStyle = signalColours[channel % signalColours.length];
      signal.lineWidth = 2;
      signal.beginPath();
      for (let sample = 0; sample < this.traceCount; sample += 1) {
        const index = this.traceCount === traceCapacity ? (this.traceWrite + sample) % traceCapacity : sample;
        const x = sample / (this.traceCount - 1) * sw;
        const y = sh * (.5 - this.trace[index * traceChannels + channel] * .45);
        if (sample) signal.lineTo(x, y); else signal.moveTo(x, y);
      }
      signal.stroke();
    }
  }
}

const signalColours = semanticSignalColours;

const fragmentShader = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) colour: vec4<f32> };
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { return input.colour; }
`;

const poseShader = `
struct Instance { a: vec4<f32>, b: vec4<f32>, c: vec4<f32> };
@group(0) @binding(0) var<storage, read> instances: array<Instance>;
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) colour: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOut {
  let item = instances[instanceIndex];
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1., -1.), vec2<f32>(1., -1.), vec2<f32>(1., 1.), vec2<f32>(-1., -1.), vec2<f32>(1., 1.), vec2<f32>(-1., 1.));
  let corner = corners[vertex];
  var position = item.a.xy + corner * item.b.x;
  if (item.b.y > .5) {
    let delta = item.a.zw - item.a.xy;
    let length = max(length(delta), .0001);
    let tangent = delta / length;
    let normal = vec2<f32>(-tangent.y, tangent.x);
    position = (item.a.xy + item.a.zw) * .5 + tangent * corner.x * length * .5 + normal * corner.y * item.b.x;
  }
  var output: VertexOut;
  output.position = vec4<f32>(position.x, -position.y, 0., 1.);
  if (item.c.z < .5) { output.position = vec4<f32>(2., 2., 0., 1.); }
  output.colour = vec4<f32>(item.b.z, item.b.w, item.c.x, item.c.y);
  return output;
}
`;

const manoMeshShader = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) colour: vec4<f32> };
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) colour: vec4<f32>) -> VertexOut {
  var output: VertexOut;
  output.position = vec4<f32>(position.x, -position.y, 0., 1.);
  output.colour = colour;
  return output;
}
`;

const signalShader = `
@group(0) @binding(0) var<storage, read> trace: array<f32>;
@group(0) @binding(1) var<uniform> state: vec4<u32>;
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) colour: vec4<f32> };
fn colour(index: u32) -> vec4<f32> {
  let phase = f32(index % 6u);
  return vec4<f32>(.42 + .08 * phase, .72 - .06 * phase, .96 - .08 * phase, .9);
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) channel: u32) -> VertexOut {
  let segment = vertex / 2u;
  let point = segment + vertex % 2u;
  let capacity = 240u;
  let count = max(state.y, 2u);
  let first = select(0u, state.x, state.y == capacity);
  let sample = (first + point) % capacity;
  let active = (state.z & (1u << channel)) != 0u;
  let x = f32(point) / f32(count - 1u) * 2. - 1.;
  let y = clamp(trace[sample * 20u + channel], -1., 1.) * .9;
  var output: VertexOut;
  output.position = select(vec4<f32>(2., 2., 0., 1.), vec4<f32>(x, y, 0., 1.), active);
  output.colour = colour(channel);
  return output;
}
`;
