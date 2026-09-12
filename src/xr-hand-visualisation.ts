import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import {
  effectiveHandRenderMode,
  handMeshStatus,
  type HandDisplaySettings,
  type HandMeshStatus,
  type HandShadingMode,
} from "../shared/hand-display.js";
import type { HandState } from "../shared/protocol.js";
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
  type HandSide,
  type ManoAsset,
  type MotionSample,
  type Rgba,
  type Vec3Like,
} from "./hand-visualisation.js";

const motionHistoryCapacity = 240;
const cogTrailCapacity = 48;
const jointRadiusM = .0042;
const outlineRadiusM = .0017;
const trailRadiusM = .00115;
const renderOrder = 1_090;
const yAxis = new Vector3(0, 1, 0);

type JointHistory = Map<string, MotionSample[]>;

interface BoneVisual {
  fromName: string;
  toName: string;
  mesh: Mesh;
}

interface MeshVisual {
  asset: ManoAsset;
  mesh: Mesh;
  positions: Float32Array;
  colours: Float32Array;
  targets: Record<string, Vec3Like>;
}

interface HandVisual {
  root: Group;
  keypoints: Map<string, Mesh>;
  bones: BoneVisual[];
  trail: Mesh[];
  mesh: MeshVisual | null;
}

export interface XrHandVisualisationFrame {
  timestampMs: number;
  leftHand: HandState;
  rightHand: HandState;
  settings: HandDisplaySettings;
}

export interface XrHandVisualisationOptions {
  manoAssets?: Partial<Record<HandSide, ManoAsset>>;
  loadManoAsset?: (side: HandSide) => Promise<ManoAsset | null>;
}

const defaultManoAssetLoader = async (side: HandSide) => {
  try {
    const response = await fetch(`/assets/mano/mano-${side}.json`);
    if (!response.ok) return null;
    return await response.json() as ManoAsset;
  } catch {
    return null;
  }
};

const createOverlayMaterial = () => new MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 1,
  depthTest: false,
  depthWrite: false,
  side: DoubleSide,
});

const applyColour = (material: MeshBasicMaterial, colour: Rgba) => {
  material.color.setRGB(colour[0], colour[1], colour[2]);
  material.opacity = colour[3];
};

const normaliseVector = (value: Vec3Like): Vec3Like => {
  const magnitude = Math.hypot(value.x, value.y, value.z);
  return magnitude > 1e-8
    ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude }
    : { x: 0, y: 0, z: 0 };
};

const latestVelocity = (samples: readonly MotionSample[]) => {
  if (samples.length < 2) return { x: 0, y: 0, z: 0, speed: 0 };
  const current = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  const elapsed = (current.timestampMs - previous.timestampMs) / 1_000;
  if (elapsed <= 0) return { x: 0, y: 0, z: 0, speed: 0 };
  const x = (current.x - previous.x) / elapsed;
  const y = (current.y - previous.y) / elapsed;
  const z = (current.z - previous.z) / elapsed;
  return { x, y, z, speed: Math.hypot(x, y, z) };
};

export class XrHandVisualisation {
  readonly leftRoot: Group;
  readonly rightRoot: Group;

  private readonly hands: Record<HandSide, HandVisual>;
  private readonly jointGeometry = new SphereGeometry(jointRadiusM, 8, 6);
  private readonly outlineGeometry = new CylinderGeometry(outlineRadiusM, outlineRadiusM, 1, 6, 1, true);
  private readonly trailGeometry = new CylinderGeometry(trailRadiusM, trailRadiusM, 1, 5, 1, true);
  private readonly jointHistory: Record<HandSide, JointHistory> = { left: new Map(), right: new Map() };
  private readonly cogHistory: Record<HandSide, MotionSample[]> = { left: [], right: [] };
  private readonly start = new Vector3();
  private readonly end = new Vector3();
  private readonly delta = new Vector3();

  private constructor() {
    this.hands = {
      left: this.createHand("left"),
      right: this.createHand("right"),
    };
    this.leftRoot = this.hands.left.root;
    this.rightRoot = this.hands.right.root;
  }

  static async create(options: XrHandVisualisationOptions = {}) {
    const visualisation = new XrHandVisualisation();
    const loader = options.loadManoAsset ?? defaultManoAssetLoader;
    await Promise.all((["left", "right"] as const).map(async (side) => {
      const supplied = options.manoAssets?.[side];
      const asset = supplied ?? await loader(side);
      if (asset?.side === side && validateManoAsset(asset)) visualisation.attachManoMesh(side, asset);
    }));
    return visualisation;
  }

  get manoLoaded() {
    return Boolean(this.hands.left.mesh && this.hands.right.mesh);
  }

  get meshStatus(): HandMeshStatus {
    return handMeshStatus(this.manoLoaded);
  }

  getRoot(side: HandSide) {
    return this.hands[side].root;
  }

  update(frame: XrHandVisualisationFrame) {
    this.updateMotionHistory(frame.timestampMs, "left", frame.leftHand);
    this.updateMotionHistory(frame.timestampMs, "right", frame.rightHand);
    this.updateHand("left", frame.leftHand, frame.settings);
    this.updateHand("right", frame.rightHand, frame.settings);
  }

  clear() {
    this.jointHistory.left.clear();
    this.jointHistory.right.clear();
    this.cogHistory.left.length = 0;
    this.cogHistory.right.length = 0;
    this.hideHand(this.hands.left);
    this.hideHand(this.hands.right);
  }

  dispose() {
    for (const side of ["left", "right"] as const) {
      const hand = this.hands[side];
      for (const marker of hand.keypoints.values()) (marker.material as MeshBasicMaterial).dispose();
      for (const bone of hand.bones) (bone.mesh.material as MeshBasicMaterial).dispose();
      for (const segment of hand.trail) (segment.material as MeshBasicMaterial).dispose();
      if (hand.mesh) {
        hand.mesh.mesh.geometry.dispose();
        (hand.mesh.mesh.material as MeshBasicMaterial).dispose();
      }
      hand.root.remove(...hand.root.children);
    }
    this.jointGeometry.dispose();
    this.outlineGeometry.dispose();
    this.trailGeometry.dispose();
    this.clear();
  }

  private createHand(side: HandSide): HandVisual {
    const root = new Group();
    root.name = `ceres-xr-hand-${side}`;
    root.renderOrder = renderOrder;
    root.visible = false;
    const keypoints = new Map<string, Mesh>();
    for (const jointName of jointNames) {
      const marker = new Mesh(this.jointGeometry, createOverlayMaterial());
      marker.name = `ceres-xr-hand-${side}-joint-${jointName}`;
      marker.renderOrder = renderOrder;
      marker.frustumCulled = false;
      marker.visible = false;
      keypoints.set(jointName, marker);
      root.add(marker);
    }
    const bones = bonePairs.map(([fromName, toName]) => {
      const mesh = new Mesh(this.outlineGeometry, createOverlayMaterial());
      mesh.name = `ceres-xr-hand-${side}-bone-${fromName}-${toName}`;
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = false;
      mesh.visible = false;
      root.add(mesh);
      return { fromName, toName, mesh };
    });
    const trail = Array.from({ length: cogTrailCapacity - 1 }, (_, index) => {
      const mesh = new Mesh(this.trailGeometry, createOverlayMaterial());
      mesh.name = `ceres-xr-hand-${side}-cog-${index}`;
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = false;
      mesh.visible = false;
      root.add(mesh);
      return mesh;
    });
    return { root, keypoints, bones, trail, mesh: null };
  }

  private attachManoMesh(side: HandSide, asset: ManoAsset) {
    const hand = this.hands[side];
    if (hand.mesh) return;
    const triangleVertexCount = asset.faceCount * 3;
    const positions = new Float32Array(triangleVertexCount * 3);
    const colours = new Float32Array(triangleVertexCount * 4);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute("color", new BufferAttribute(colours, 4).setUsage(DynamicDrawUsage));
    geometry.setDrawRange(0, triangleVertexCount);
    const material = createOverlayMaterial();
    material.vertexColors = true;
    const mesh = new Mesh(geometry, material);
    mesh.name = `ceres-xr-hand-${side}-mano`;
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.visible = false;
    hand.root.add(mesh);
    hand.mesh = { asset, mesh, positions, colours, targets: {} };
  }

  private updateHand(side: HandSide, state: HandState, settings: HandDisplaySettings) {
    const hand = this.hands[side];
    if (!state.tracked) {
      this.hideHand(hand);
      return;
    }
    hand.root.visible = true;
    this.updateTrail(side, hand, settings.handTrail === "cog");
    this.hideModeVisuals(hand);
    const handMode = effectiveHandRenderMode(settings.handMode, this.manoLoaded);
    if (handMode === "off") return;
    if (handMode === "mesh") {
      this.updateManoMesh(side, state, settings.handShading);
      return;
    }
    if (handMode === "outline") {
      for (const bone of hand.bones) {
        const from = state.joints[bone.fromName];
        const to = state.joints[bone.toName];
        if (!from || !to) continue;
        this.setSegmentTransform(bone.mesh, from.position, to.position);
        if (!bone.mesh.visible) continue;
        applyColour(bone.mesh.material as MeshBasicMaterial, this.jointColour(side, bone.toName, to.position, settings.handShading));
      }
      return;
    }
    for (const name of jointNames) {
      const joint = state.joints[name];
      const marker = hand.keypoints.get(name)!;
      if (!joint) continue;
      marker.visible = true;
      marker.position.set(joint.position.x, joint.position.y, joint.position.z);
      marker.quaternion.set(joint.rotation.x, joint.rotation.y, joint.rotation.z, joint.rotation.w);
      applyColour(marker.material as MeshBasicMaterial, this.jointColour(side, name, joint.position, settings.handShading));
    }
  }

  private updateTrail(side: HandSide, hand: HandVisual, enabled: boolean) {
    for (const segment of hand.trail) segment.visible = false;
    if (!enabled) return;
    const history = this.cogHistory[side];
    const segmentCount = Math.min(hand.trail.length, Math.max(0, history.length - 1));
    const historyStart = history.length - segmentCount - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      const segment = hand.trail[index];
      this.setSegmentTransform(segment, history[historyStart + index], history[historyStart + index + 1]);
      if (!segment.visible) continue;
      const progress = (index + 1) / segmentCount;
      applyColour(segment.material as MeshBasicMaterial, sideColour(side, .08 + progress * .72));
    }
  }

  private updateManoMesh(side: HandSide, handState: HandState, shading: HandShadingMode) {
    const visual = this.hands[side].mesh;
    if (!visual) return;
    const { asset, targets } = visual;
    for (const name of [...asset.jointNames, ...Object.keys(asset.tipVertexIds)]) {
      const targetName = manoJointTargets[name];
      const joint = targetName ? handState.joints[targetName] : undefined;
      if (!joint) return;
      targets[name] = joint.position;
    }
    const vertices = fitManoVertices(asset, targets);
    if (!vertices) return;
    let outputVertex = 0;
    for (let face = 0; face < asset.faceCount; face += 1) {
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
      const normal = normaliseVector({
        x: edgeAy * edgeBz - edgeAz * edgeBy,
        y: edgeAz * edgeBx - edgeAx * edgeBz,
        z: edgeAx * edgeBy - edgeAy * edgeBx,
      });
      const faceColour = shading === "normal" ? normalColour(normal) : null;
      for (const vertex of [firstVertex, secondVertex, thirdVertex]) {
        const position = {
          x: vertices[vertex * 3],
          y: vertices[vertex * 3 + 1],
          z: vertices[vertex * 3 + 2],
        };
        const positionOffset = outputVertex * 3;
        visual.positions[positionOffset] = position.x;
        visual.positions[positionOffset + 1] = position.y;
        visual.positions[positionOffset + 2] = position.z;
        const colour = faceColour ?? this.jointColour(side, this.dominantJointName(asset, vertex), position, shading);
        const colourOffset = outputVertex * 4;
        visual.colours[colourOffset] = colour[0];
        visual.colours[colourOffset + 1] = colour[1];
        visual.colours[colourOffset + 2] = colour[2];
        visual.colours[colourOffset + 3] = colour[3];
        outputVertex += 1;
      }
    }
    (visual.mesh.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (visual.mesh.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
    visual.mesh.visible = true;
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

  private jointColour(side: HandSide, jointName: string, position: Vec3Like, shading: HandShadingMode): Rgba {
    const samples = this.jointHistory[side].get(jointName) ?? [];
    const velocity = latestVelocity(samples);
    if (shading === "velocity") return jetColour(velocity.speed / 1.5);
    if (shading === "motion") return middleburyColour(velocity.x, velocity.z, 1.5);
    if (shading === "normal") {
      const cog = this.cogHistory[side].at(-1);
      return normalColour(cog ? normaliseVector({ x: position.x - cog.x, y: position.y - cog.y, z: position.z - cog.z }) : { x: 0, y: 1, z: 0 });
    }
    return sideColour(side);
  }

  private updateMotionHistory(timestampMs: number, side: HandSide, hand: HandState) {
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

  private setSegmentTransform(mesh: Mesh, from: Vec3Like, to: Vec3Like) {
    this.start.set(from.x, from.y, from.z);
    this.end.set(to.x, to.y, to.z);
    this.delta.subVectors(this.end, this.start);
    const length = this.delta.length();
    if (length <= 1e-6) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.copy(this.start).addScaledVector(this.delta, .5);
    mesh.scale.set(1, length, 1);
    mesh.quaternion.setFromUnitVectors(yAxis, this.delta.multiplyScalar(1 / length));
  }

  private hideModeVisuals(hand: HandVisual) {
    for (const marker of hand.keypoints.values()) marker.visible = false;
    for (const bone of hand.bones) bone.mesh.visible = false;
    if (hand.mesh) hand.mesh.mesh.visible = false;
  }

  private hideHand(hand: HandVisual) {
    hand.root.visible = false;
    this.hideModeVisuals(hand);
    for (const segment of hand.trail) segment.visible = false;
  }
}
