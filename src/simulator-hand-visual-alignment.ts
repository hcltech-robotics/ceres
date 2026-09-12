import type { HandState, Quat, Vec3 } from "../shared/protocol.js";

export type SimulatorHandSide = "left" | "right";

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

interface SimulatorWristTransform {
  position: Vec3;
  orientation: Quat;
}

const IWER_HAND_VISUAL_SCALE = 1.05;

// IWER's native hand GLTF is five per cent larger than its canonical
// XRJointPose data and uses a slightly different wrist origin. These offsets
// were measured in the managed Meta Quest 3 simulator and expressed in the
// raw wrist's local axes.
const IWER_WRIST_OFFSET_LOCAL_M: Record<SimulatorHandSide, Vec3> = {
  left: { x: -.000133091, y: .001816586, z: .003248507 },
  right: { x: .002901449, y: .001815069, z: .004037567 },
};

const rotateVectorByQuaternionInto = (target: MutableVec3, vector: Vec3, rotation: Quat) => {
  const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) || 1;
  const qx = rotation.x / magnitude;
  const qy = rotation.y / magnitude;
  const qz = rotation.z / magnitude;
  const qw = rotation.w / magnitude;
  const tx = 2 * (qy * vector.z - qz * vector.y);
  const ty = 2 * (qz * vector.x - qx * vector.z);
  const tz = 2 * (qx * vector.y - qy * vector.x);
  target.x = vector.x + qw * tx + qy * tz - qz * ty;
  target.y = vector.y + qw * ty + qz * tx - qx * tz;
  target.z = vector.z + qw * tz + qx * ty - qy * tx;
};

export const simulatorHandMarkerGroupName = (side: SimulatorHandSide) => `ceres-simulator-hand-markers-${side}`;

export const simulatorHandJointMarkerName = (side: SimulatorHandSide, jointName: string) => `ceres-simulator-hand-marker-${side}-${jointName}`;

export function alignManagedSimulatorHandJointInto(
  target: MutableVec3,
  jointPosition: Vec3,
  wrist: SimulatorWristTransform | null | undefined,
  side: SimulatorHandSide,
  managedSimulator: boolean,
) {
  if (!managedSimulator || !wrist) {
    target.x = jointPosition.x;
    target.y = jointPosition.y;
    target.z = jointPosition.z;
    return target;
  }

  rotateVectorByQuaternionInto(target, IWER_WRIST_OFFSET_LOCAL_M[side], wrist.orientation);
  const offsetX = target.x;
  const offsetY = target.y;
  const offsetZ = target.z;
  target.x = wrist.position.x + offsetX + (jointPosition.x - wrist.position.x) * IWER_HAND_VISUAL_SCALE;
  target.y = wrist.position.y + offsetY + (jointPosition.y - wrist.position.y) * IWER_HAND_VISUAL_SCALE;
  target.z = wrist.position.z + offsetZ + (jointPosition.z - wrist.position.z) * IWER_HAND_VISUAL_SCALE;
  return target;
}

export function alignManagedSimulatorHandState(
  hand: HandState,
  side: SimulatorHandSide,
  managedSimulator: boolean,
) {
  const wrist = hand.joints.wrist;
  if (!managedSimulator || !wrist) return hand;
  const joints: HandState["joints"] = {};
  for (const [jointName, joint] of Object.entries(hand.joints)) {
    const position = { x: 0, y: 0, z: 0 };
    alignManagedSimulatorHandJointInto(
      position,
      joint.position,
      { position: wrist.position, orientation: wrist.rotation },
      side,
      true,
    );
    joints[jointName] = { ...joint, position };
  }
  return { ...hand, joints };
}
