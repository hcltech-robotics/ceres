import type { CameraSide, CameraViewPose, HandState, SensorFrame, Transform } from "../../shared/protocol.js";
import { cameraViewPoseFromViewerPose } from "../camera-projection.js";

import { XR_HAND_JOINTS } from "../../shared/xr-hand-joints.js";
export { XR_HAND_JOINTS };

export const TELEMETRY_VALUES_PER_TRANSFORM = 8;
export const TELEMETRY_HEAD_OFFSET = 2;
export const TELEMETRY_LEFT_TRACKED_OFFSET = TELEMETRY_HEAD_OFFSET + 7;
export const TELEMETRY_LEFT_JOINT_OFFSET = TELEMETRY_LEFT_TRACKED_OFFSET + 1;
export const TELEMETRY_RIGHT_TRACKED_OFFSET = TELEMETRY_LEFT_JOINT_OFFSET + XR_HAND_JOINTS.length * TELEMETRY_VALUES_PER_TRANSFORM;
export const TELEMETRY_RIGHT_JOINT_OFFSET = TELEMETRY_RIGHT_TRACKED_OFFSET + 1;
export const TELEMETRY_CAMERA_TRACKED_OFFSET = TELEMETRY_RIGHT_JOINT_OFFSET + XR_HAND_JOINTS.length * TELEMETRY_VALUES_PER_TRANSFORM;
export const TELEMETRY_CAMERA_TRANSFORM_OFFSET = TELEMETRY_CAMERA_TRACKED_OFFSET + 1;
export const TELEMETRY_CAMERA_SIDE_OFFSET = TELEMETRY_CAMERA_TRANSFORM_OFFSET + TELEMETRY_VALUES_PER_TRANSFORM;
export const TELEMETRY_CAMERA_PROJECTION_OFFSET = TELEMETRY_CAMERA_SIDE_OFFSET + 1;
export const TELEMETRY_CAMERA_WIDTH_OFFSET = TELEMETRY_CAMERA_PROJECTION_OFFSET + 16;
export const TELEMETRY_CAMERA_HEIGHT_OFFSET = TELEMETRY_CAMERA_WIDTH_OFFSET + 1;
export const TELEMETRY_VALUE_COUNT = TELEMETRY_CAMERA_HEIGHT_OFFSET + 1;
export const TELEMETRY_BYTE_LENGTH = TELEMETRY_VALUE_COUNT * Float64Array.BYTES_PER_ELEMENT;

const SAMPLE_HEAD_TRACKED = 1;
const SAMPLE_CAMERA_TRACKED = 1;

const writeTransform = (values: Float64Array, offset: number, transform: any, radius = Number.NaN) => {
  const rotation = transform.orientation ?? transform.rotation;
  values[offset] = transform.position.x;
  values[offset + 1] = transform.position.y;
  values[offset + 2] = transform.position.z;
  values[offset + 3] = rotation.x;
  values[offset + 4] = rotation.y;
  values[offset + 5] = rotation.z;
  values[offset + 6] = rotation.w;
  values[offset + 7] = radius;
};

const writeHand = (
  values: Float64Array,
  baseOffset: number,
  trackedOffset: number,
  jointOffset: number,
  handedness: "left" | "right",
  xrFrame: any,
  referenceSpace: any,
  xrSession: any,
) => {
  const inputSources = xrSession.inputSources as ArrayLike<any>;
  for (let sourceIndex = 0; sourceIndex < inputSources.length; sourceIndex += 1) {
    const source = inputSources[sourceIndex];
    if (source.handedness !== handedness || !source.hand) continue;
    let trackedJoints = 0;
    for (let jointIndex = 0; jointIndex < XR_HAND_JOINTS.length; jointIndex += 1) {
      const jointSpace = source.hand.get(XR_HAND_JOINTS[jointIndex]);
      const pose = jointSpace ? xrFrame.getJointPose(jointSpace, referenceSpace) : null;
      if (!pose) continue;
      writeTransform(
        values,
        baseOffset + jointOffset + jointIndex * TELEMETRY_VALUES_PER_TRANSFORM,
        pose.transform,
        pose.radius,
      );
      trackedJoints += 1;
    }
    values[baseOffset + trackedOffset] = trackedJoints > 0 ? 1 : 0;
    return;
  }
};

const cameraSideValue = (side: CameraViewPose["side"] | CameraSide) => side === "left" ? -1 : side === "right" ? 1 : 0;

const writeCamera = (values: Float64Array, baseOffset: number, camera: CameraViewPose | null | undefined, selectedSide: CameraSide) => {
  values[baseOffset + TELEMETRY_CAMERA_TRACKED_OFFSET] = camera ? SAMPLE_CAMERA_TRACKED : 0;
  values[baseOffset + TELEMETRY_CAMERA_SIDE_OFFSET] = cameraSideValue(camera?.side ?? selectedSide);
  if (!camera) return;
  writeTransform(values, baseOffset + TELEMETRY_CAMERA_TRANSFORM_OFFSET, camera.transform);
  for (let index = 0; index < 16; index += 1) {
    values[baseOffset + TELEMETRY_CAMERA_PROJECTION_OFFSET + index] = camera.projectionMatrix[index];
  }
  values[baseOffset + TELEMETRY_CAMERA_WIDTH_OFFSET] = camera.imageWidth ?? Number.NaN;
  values[baseOffset + TELEMETRY_CAMERA_HEIGHT_OFFSET] = camera.imageHeight ?? Number.NaN;
};

export const writeXrTelemetry = (
  values: Float64Array,
  baseOffset: number,
  sourceTimestampUs: number,
  xrFrame: any,
  referenceSpace: any,
  xrSession: any,
  cameraSide: CameraSide,
) => {
  values.fill(Number.NaN, baseOffset, baseOffset + TELEMETRY_VALUE_COUNT);
  values[baseOffset] = sourceTimestampUs;
  values[baseOffset + 1] = 0;
  const viewerPose = xrFrame.getViewerPose(referenceSpace);
  if (viewerPose) {
    writeTransform(values, baseOffset + TELEMETRY_HEAD_OFFSET, viewerPose.transform);
    values[baseOffset + 1] = SAMPLE_HEAD_TRACKED;
    writeCamera(values, baseOffset, cameraViewPoseFromViewerPose(viewerPose, cameraSide), cameraSide);
  }
  writeHand(values, baseOffset, TELEMETRY_LEFT_TRACKED_OFFSET, TELEMETRY_LEFT_JOINT_OFFSET, "left", xrFrame, referenceSpace, xrSession);
  writeHand(values, baseOffset, TELEMETRY_RIGHT_TRACKED_OFFSET, TELEMETRY_RIGHT_JOINT_OFFSET, "right", xrFrame, referenceSpace, xrSession);
};

const writeSensorHand = (
  values: Float64Array,
  baseOffset: number,
  trackedOffset: number,
  jointOffset: number,
  hand: HandState,
) => {
  values[baseOffset + trackedOffset] = hand.tracked ? 1 : 0;
  if (!hand.tracked) return;
  for (let jointIndex = 0; jointIndex < XR_HAND_JOINTS.length; jointIndex += 1) {
    const joint = hand.joints[XR_HAND_JOINTS[jointIndex]];
    if (!joint) continue;
    writeTransform(
      values,
      baseOffset + jointOffset + jointIndex * TELEMETRY_VALUES_PER_TRANSFORM,
      joint,
      joint.radius,
    );
  }
};

export const writeSensorTelemetry = (
  values: Float64Array,
  baseOffset: number,
  sourceTimestampUs: number,
  frame: SensorFrame,
) => {
  values.fill(Number.NaN, baseOffset, baseOffset + TELEMETRY_VALUE_COUNT);
  values[baseOffset] = sourceTimestampUs;
  values[baseOffset + 1] = frame.head ? SAMPLE_HEAD_TRACKED : 0;
  if (frame.head) writeTransform(values, baseOffset + TELEMETRY_HEAD_OFFSET, frame.head);
  writeCamera(values, baseOffset, frame.camera, frame.cameraSide ?? "unknown");
  writeSensorHand(values, baseOffset, TELEMETRY_LEFT_TRACKED_OFFSET, TELEMETRY_LEFT_JOINT_OFFSET, frame.leftHand);
  writeSensorHand(values, baseOffset, TELEMETRY_RIGHT_TRACKED_OFFSET, TELEMETRY_RIGHT_JOINT_OFFSET, frame.rightHand);
};

const readTransform = (values: Float64Array, offset: number): Transform => ({
  position: { x: values[offset], y: values[offset + 1], z: values[offset + 2] },
  rotation: { x: values[offset + 3], y: values[offset + 4], z: values[offset + 5], w: values[offset + 6] },
});

const readHand = (values: Float64Array, trackedOffset: number, jointOffset: number): HandState => {
  const hand: HandState = { tracked: values[trackedOffset] === 1, joints: {}, pinch: 0 };
  if (!hand.tracked) return hand;
  for (let jointIndex = 0; jointIndex < XR_HAND_JOINTS.length; jointIndex += 1) {
    const offset = jointOffset + jointIndex * TELEMETRY_VALUES_PER_TRANSFORM;
    if (!Number.isFinite(values[offset])) continue;
    const radius = values[offset + 7];
    hand.joints[XR_HAND_JOINTS[jointIndex]] = {
      ...readTransform(values, offset),
      ...(Number.isFinite(radius) ? { radius } : {}),
    };
  }
  const thumb = hand.joints["thumb-tip"]?.position;
  const index = hand.joints["index-finger-tip"]?.position;
  if (thumb && index) hand.pinch = Math.hypot(thumb.x - index.x, thumb.y - index.y, thumb.z - index.z);
  return hand;
};

const readCamera = (values: Float64Array): CameraViewPose | null => {
  if (values[TELEMETRY_CAMERA_TRACKED_OFFSET] !== SAMPLE_CAMERA_TRACKED) return null;
  const sideValue = values[TELEMETRY_CAMERA_SIDE_OFFSET];
  return {
    side: sideValue < 0 ? "left" : sideValue > 0 ? "right" : "none",
    transform: readTransform(values, TELEMETRY_CAMERA_TRANSFORM_OFFSET),
    projectionMatrix: Array.from(values.subarray(TELEMETRY_CAMERA_PROJECTION_OFFSET, TELEMETRY_CAMERA_PROJECTION_OFFSET + 16)),
    imageWidth: Number.isFinite(values[TELEMETRY_CAMERA_WIDTH_OFFSET]) ? values[TELEMETRY_CAMERA_WIDTH_OFFSET] : null,
    imageHeight: Number.isFinite(values[TELEMETRY_CAMERA_HEIGHT_OFFSET]) ? values[TELEMETRY_CAMERA_HEIGHT_OFFSET] : null,
  };
};

export const decodeTelemetryFrame = (
  values: Float64Array,
  frameIndex: number,
  wallClockOffsetMs: number,
): SensorFrame => ({
  timestampMs: wallClockOffsetMs + values[0] / 1_000,
  frameIndex,
  head: values[1] === SAMPLE_HEAD_TRACKED ? readTransform(values, TELEMETRY_HEAD_OFFSET) : null,
  cameraSide: values[TELEMETRY_CAMERA_SIDE_OFFSET] < 0 ? "left" : values[TELEMETRY_CAMERA_SIDE_OFFSET] > 0 ? "right" : "unknown",
  camera: readCamera(values),
  leftHand: readHand(values, TELEMETRY_LEFT_TRACKED_OFFSET, TELEMETRY_LEFT_JOINT_OFFSET),
  rightHand: readHand(values, TELEMETRY_RIGHT_TRACKED_OFFSET, TELEMETRY_RIGHT_JOINT_OFFSET),
  sceneStatus: { planes: false, meshes: false, anchors: false },
});
