import { canSendObservation, createPoseBuffer, writePoseHeader, XR_HAND_JOINTS, type PoseKind } from "../../shared/bridge-protocol.js";

/** Acquires only inside a fresh XR callback and reuses all packet storage. */
export class Observations {
  private sampledFrame: XRFrame | null = null;
  private sampledSpace: XRReferenceSpace | null = null;
  private publishedSample = false;
  private jointPoses: Record<"left" | "right", Map<string, XRJointPose | null>> = { left: new Map(), right: new Map() };
  viewerPose: XRViewerPose | null = null;
  private buffers = [createPoseBuffer(1), createPoseBuffer(2), createPoseBuffer(3)];
  private views = this.buffers.map(buffer => new DataView(buffer));
  private payloads = this.buffers.map((buffer, index) => new Uint8Array(buffer, index === 0 ? 40 : 44));
  private header = { kind: 1 as PoseKind, valid: false, epoch: 0, spaceEpoch: 0, sequence: 0, observedUs: 0, targetUs: 0 };
  sequence = 0;
  spaceEpoch = 0;
  acquired = 0;
  dropped = 0;

  hasSample(frame: XRFrame, space: XRReferenceSpace) { return this.sampledFrame === frame && this.sampledSpace === space; }
  hasPublishedSample(frame: XRFrame, space: XRReferenceSpace) { return this.publishedSample && this.hasSample(frame, space); }
  jointPose(side: "left" | "right", name: string) { return this.jointPoses[side].get(name) ?? null; }
  clearSample() {
    this.publishedSample = false;
    this.sampledFrame = this.sampledSpace = null;
    this.viewerPose = null;
    this.jointPoses.left.clear();
    this.jointPoses.right.clear();
  }

  private transform(view: DataView, offset: number, transform: XRRigidTransform, radius?: number) {
    const { position: p, orientation: q } = transform;
    view.setFloat32(offset, p.x, true);
    view.setFloat32(offset + 4, p.y, true);
    view.setFloat32(offset + 8, p.z, true);
    view.setFloat32(offset + 12, q.x, true);
    view.setFloat32(offset + 16, q.y, true);
    view.setFloat32(offset + 20, q.z, true);
    view.setFloat32(offset + 24, q.w, true);
    if (radius !== undefined) view.setFloat32(offset + 28, radius, true);
  }

  publish(frame: XRFrame, space: XRReferenceSpace, channel: RTCDataChannel | null, epoch: number, observedUs: number, targetMs: number) {
    this.clearSample();
    this.acquired++;
    const seq = this.sequence++ >>> 0;
    if (!channel || !canSendObservation(channel)) { this.dropped++; return; }
    this.sampledFrame = frame;
    this.sampledSpace = space;
    this.header.epoch = epoch;
    this.header.spaceEpoch = this.spaceEpoch;
    this.header.sequence = seq;
    this.header.observedUs = observedUs;
    this.header.targetUs = Math.max(0, Math.round(targetMs * 1000));
    const head = frame.getViewerPose(space);
    this.viewerPose = head ?? null;
    this.header.kind = 1;
    this.header.valid = Boolean(head);
    writePoseHeader(this.buffers[0], this.header);
    if (head) this.transform(this.views[0], 40, head.transform);
    else this.payloads[0].fill(0);
    for (let side = 1; side <= 2; side++) {
      let mask = 0;
      const buffer = this.buffers[side];
      this.payloads[side].fill(0);
      for (const source of frame.session.inputSources) {
        if (source.handedness !== (side === 1 ? "left" : "right") || !source.hand) continue;
        for (let joint = 0; joint < XR_HAND_JOINTS.length; joint++) {
          const jointSpace = source.hand.get(XR_HAND_JOINTS[joint]);
          const pose = jointSpace && frame.getJointPose?.(jointSpace, space);
          this.jointPoses[side === 1 ? "left" : "right"].set(XR_HAND_JOINTS[joint], pose ?? null);
          if (!pose) continue;
          mask |= 1 << joint;
          this.transform(this.views[side], 44 + joint * 32, pose.transform, pose.radius ?? 0);
        }
      }
      this.header.kind = (side + 1) as PoseKind;
      this.header.valid = mask !== 0;
      writePoseHeader(buffer, this.header, mask);
    }
    try {
      channel.send(this.buffers[0]);
      channel.send(this.buffers[1]);
      channel.send(this.buffers[2]);
      this.publishedSample = true;
    } catch { this.dropped++; }
  }
}
