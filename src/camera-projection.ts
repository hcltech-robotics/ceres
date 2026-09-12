import type { CameraRegistration } from "../shared/camera-registration.js";
import type { CameraSide, CameraViewPose, HandCameraProjection, HandState, ProjectedHandState, Quat, Transform, Vec3 } from "../shared/protocol.js";

export interface PinholeProjection {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion: number[];
}

interface XrViewLike {
  eye?: string;
  transform?: {
    position: Vec3;
    orientation: Quat;
  };
  projectionMatrix?: ArrayLike<number>;
  camera?: { width?: number; height?: number } | null;
}

interface ViewerPoseLike {
  views?: ArrayLike<XrViewLike>;
}

export interface CameraImageSize {
  width: number | null | undefined;
  height: number | null | undefined;
}

export interface CameraProjectionSample {
  depth: number;
  x: number;
  y: number;
}

export interface CameraViewportSize {
  width: number;
  height: number;
}

export interface CameraCoverViewport extends CameraViewportSize {
  scale: number;
  x: number;
  y: number;
}

const questCameraOffsetsFromEyeM: Record<Exclude<CameraSide, "unknown">, Vec3> = {
  left: { x: -.032, y: -.030, z: -.035 },
  right: { x: .032, y: -.030, z: -.035 },
};

const questCameraOffsetsFromHeadM: Record<Exclude<CameraSide, "unknown">, Vec3> = {
  left: { x: -.064, y: -.030, z: -.035 },
  right: { x: .064, y: -.030, z: -.035 },
};

function rotateVectorByQuaternion(vector: Vec3, rotation: Quat): Vec3 {
  const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) || 1;
  const qx = rotation.x / magnitude;
  const qy = rotation.y / magnitude;
  const qz = rotation.z / magnitude;
  const qw = rotation.w / magnitude;
  const tx = 2 * (qy * vector.z - qz * vector.y);
  const ty = 2 * (qz * vector.x - qx * vector.z);
  const tz = 2 * (qx * vector.y - qy * vector.x);
  return {
    x: vector.x + qw * tx + qy * tz - qz * ty,
    y: vector.y + qw * ty + qz * tx - qx * tz,
    z: vector.z + qw * tz + qx * ty - qy * tx,
  };
}

export function inferCameraSide(label: string, index: number, cameraCount: number, questBrowser: boolean): CameraSide {
  const normalised = label.trim().toLowerCase();
  if (/(^|[\s_-])(left|leftmost)([\s_-]|$)/.test(normalised)) return "left";
  if (/(^|[\s_-])(right|rightmost)([\s_-]|$)/.test(normalised)) return "right";
  if (/(^|[\s_-])(position[\s_-]*0|camera(?:2)?[\s_-]*0)([\s_-]|$)/.test(normalised)) return questBrowser ? "right" : "left";
  if (/(^|[\s_-])(position[\s_-]*1|camera(?:2)?[\s_-]*1)([\s_-]|$)/.test(normalised)) return questBrowser ? "left" : "right";
  if (questBrowser && cameraCount === 2) return index === 0 ? "right" : "left";
  return "unknown";
}

export function selectCameraView(views: ArrayLike<XrViewLike> | undefined, side: CameraSide): XrViewLike | null {
  if (!views?.length) return null;
  const candidates = Array.from(views);
  if (side !== "unknown") {
    const exact = candidates.find((view) => view.eye === side);
    if (exact) return exact;
  }
  if (candidates.length === 1) return candidates[0];
  return candidates.find((view) => view.eye === "none")
    ?? candidates.find((view) => view.eye === "right")
    ?? candidates[0]
    ?? null;
}

export function cameraViewPoseFromViewerPose(
  viewerPose: ViewerPoseLike | null | undefined,
  side: CameraSide,
  imageSize?: CameraImageSize,
): CameraViewPose | null {
  const view = selectCameraView(viewerPose?.views, side);
  if (!view?.transform || !view.projectionMatrix || view.projectionMatrix.length !== 16) return null;
  const projectionMatrix = Array.from(view.projectionMatrix, Number);
  if (!projectionMatrix.every(Number.isFinite)) return null;
  const eye = view.eye === "left" || view.eye === "right" ? view.eye : "none";
  const rotation = {
    x: view.transform.orientation.x,
    y: view.transform.orientation.y,
    z: view.transform.orientation.z,
    w: view.transform.orientation.w,
  };
  const cameraOffset = eye === "none"
    ? { x: 0, y: 0, z: 0 }
    : rotateVectorByQuaternion(questCameraOffsetsFromEyeM[eye], rotation);
  return {
    side: eye,
    transform: {
      position: {
        x: view.transform.position.x + cameraOffset.x,
        y: view.transform.position.y + cameraOffset.y,
        z: view.transform.position.z + cameraOffset.z,
      },
      rotation,
    },
    projectionMatrix,
    imageWidth: Number.isFinite(imageSize?.width)
      ? Number(imageSize?.width)
      : Number.isFinite(view.camera?.width) ? Number(view.camera?.width) : null,
    imageHeight: Number.isFinite(imageSize?.height)
      ? Number(imageSize?.height)
      : Number.isFinite(view.camera?.height) ? Number(view.camera?.height) : null,
  };
}

type ProjectionTarget = { [index: number]: number };

function projectionImageSize(imageSize: CameraImageSize | null | undefined) {
  return {
    width: Number.isFinite(imageSize?.width) && Number(imageSize?.width) > 0
      ? Number(imageSize?.width)
      : 1280,
    height: Number.isFinite(imageSize?.height) && Number(imageSize?.height) > 0
      ? Number(imageSize?.height)
      : 960,
  };
}

export function cameraProjectionFocalLengths(
  calibration: PinholeProjection | null | undefined,
  imageSize?: CameraImageSize | null,
) {
  if (calibration) return { x: calibration.fx, y: calibration.fy };
  const { width, height } = projectionImageSize(imageSize);
  const aspect = Math.max(1, width / height);
  return {
    x: width / (2 * .81),
    y: height / (2 * (.81 / aspect)),
  };
}

export function cameraCoverViewport(
  viewport: CameraViewportSize,
  imageSize: CameraImageSize,
): CameraCoverViewport {
  const width = Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 1);
  const height = Math.max(1, Number.isFinite(viewport.height) ? viewport.height : 1);
  const image = projectionImageSize(imageSize);
  const scale = Math.max(width / image.width, height / image.height);
  const renderedWidth = image.width * scale;
  const renderedHeight = image.height * scale;
  return {
    height: renderedHeight,
    scale,
    width: renderedWidth,
    x: (width - renderedWidth) / 2,
    y: (height - renderedHeight) / 2,
  };
}

export function cameraProjectionToCoverViewport(
  point: Pick<CameraProjectionSample, "x" | "y">,
  imageSize: CameraImageSize,
  viewport: CameraViewportSize,
) {
  const cover = cameraCoverViewport(viewport, imageSize);
  return {
    x: cover.x + (point.x + 1) / 2 * cover.width,
    y: cover.y + (point.y + 1) / 2 * cover.height,
  };
}

export function projectWorldPointToCameraInto(
  position: Vec3,
  camera: CameraViewPose | null | undefined,
  calibration: PinholeProjection | null | undefined,
  fallbackHead: Transform,
  fallbackSide: CameraSide,
  target: ProjectionTarget,
  offset = 0,
  fallbackImageSize?: CameraImageSize,
  depthOffset?: number,
): boolean {
  const pose = camera?.transform ?? fallbackHead;
  const x = position.x - pose.position.x;
  const y = position.y - pose.position.y;
  const z = position.z - pose.position.z;
  const rotation = pose.rotation;
  const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) || 1;
  const qx = -rotation.x / magnitude;
  const qy = -rotation.y / magnitude;
  const qz = -rotation.z / magnitude;
  const qw = rotation.w / magnitude;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  let localX = x + qw * tx + qy * tz - qz * ty;
  let localY = y + qw * ty + qz * tx - qx * tz;
  let localZ = z + qw * tz + qx * ty - qy * tx;
  if (!camera && fallbackSide !== "unknown") {
    const cameraOffset = questCameraOffsetsFromHeadM[fallbackSide];
    localX -= cameraOffset.x;
    localY -= cameraOffset.y;
    localZ -= cameraOffset.z;
  }
  const forward = -localZ;
  if (forward <= .08) return false;
  if (depthOffset !== undefined) target[depthOffset] = forward;

  if (calibration) {
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = calibration.distortion;
    const normalX = localX / forward;
    const normalY = localY / forward;
    const radius2 = normalX * normalX + normalY * normalY;
    const radial = 1 + k1 * radius2 + k2 * radius2 * radius2 + k3 * radius2 * radius2 * radius2;
    const distortedX = normalX * radial + 2 * p1 * normalX * normalY + p2 * (radius2 + 2 * normalX * normalX);
    const distortedY = normalY * radial + p1 * (radius2 + 2 * normalY * normalY) + 2 * p2 * normalX * normalY;
    const pixelX = calibration.fx * distortedX + calibration.cx;
    const pixelY = calibration.cy - calibration.fy * distortedY;
    target[offset] = pixelX / calibration.width * 2 - 1;
    target[offset + 1] = pixelY / calibration.height * 2 - 1;
    return true;
  }

  if (camera?.projectionMatrix.length === 16) {
    const matrix = camera.projectionMatrix;
    const clipX = matrix[0] * localX + matrix[4] * localY + matrix[8] * localZ + matrix[12];
    const clipY = matrix[1] * localX + matrix[5] * localY + matrix[9] * localZ + matrix[13];
    const clipW = matrix[3] * localX + matrix[7] * localY + matrix[11] * localZ + matrix[15];
    if (Math.abs(clipW) < 1e-6) return false;
    target[offset] = clipX / clipW;
    target[offset + 1] = -clipY / clipW;
    return true;
  }

  const widthValue = camera ? camera.imageWidth : fallbackImageSize?.width;
  const heightValue = camera ? camera.imageHeight : fallbackImageSize?.height;
  const width = Number.isFinite(widthValue) && Number(widthValue) > 0
    ? Number(widthValue)
    : 1280;
  const height = Number.isFinite(heightValue) && Number(heightValue) > 0
    ? Number(heightValue)
    : 960;
  const aspect = Math.max(1, width / height);
  const fx = width / (2 * .81);
  const fy = height / (2 * (.81 / aspect));
  const pixelX = fx * localX / forward + width / 2;
  const pixelY = height / 2 - fy * localY / forward;
  target[offset] = pixelX / width * 2 - 1;
  target[offset + 1] = pixelY / height * 2 - 1;
  return true;
}

export function projectWorldPointToCamera(
  position: Vec3,
  camera: CameraViewPose | null | undefined,
  calibration: PinholeProjection | null | undefined,
  fallbackHead: Transform,
  fallbackSide: CameraSide,
  fallbackImageSize?: CameraImageSize,
): readonly [number, number] | null {
  const projected: [number, number] = [0, 0];
  return projectWorldPointToCameraInto(
    position,
    camera,
    calibration,
    fallbackHead,
    fallbackSide,
    projected,
    0,
    fallbackImageSize,
  )
    ? projected
    : null;
}

export function projectWorldPointToCameraSample(
  position: Vec3,
  camera: CameraViewPose | null | undefined,
  calibration: PinholeProjection | null | undefined,
  fallbackHead: Transform,
  fallbackSide: CameraSide,
  fallbackImageSize?: CameraImageSize,
): CameraProjectionSample | null {
  const projected = [0, 0, 0];
  if (!projectWorldPointToCameraInto(
    position,
    camera,
    calibration,
    fallbackHead,
    fallbackSide,
    projected,
    0,
    fallbackImageSize,
    2,
  )) return null;
  return {
    depth: projected[2]!,
    x: projected[0]!,
    y: projected[1]!,
  };
}

export function projectHandsToRegisteredCamera(
  leftHand: HandState,
  rightHand: HandState,
  camera: CameraViewPose | null | undefined,
  registration: CameraRegistration | null | undefined,
  fallbackHead: Transform,
  fallbackSide: CameraSide,
): HandCameraProjection | null {
  if (!camera || !registration) return null;
  if (camera.imageWidth !== registration.width || camera.imageHeight !== registration.height) return null;
  if (registration.side !== "unknown" && fallbackSide !== registration.side) return null;
  return {
    source: "calibrated-media-camera",
    cameraSide: fallbackSide,
    width: registration.width,
    height: registration.height,
    leftHand: projectHand(leftHand, camera, registration, fallbackHead, fallbackSide),
    rightHand: projectHand(rightHand, camera, registration, fallbackHead, fallbackSide),
  };
}

function projectHand(
  hand: HandState,
  camera: CameraViewPose,
  registration: CameraRegistration,
  fallbackHead: Transform,
  fallbackSide: CameraSide,
): ProjectedHandState {
  const joints: ProjectedHandState["joints"] = {};
  if (!hand.tracked) return { tracked: false, joints };
  const projected = new Float32Array(2);
  for (const [name, joint] of Object.entries(hand.joints)) {
    if (!projectWorldPointToCameraInto(
      joint.position,
      camera,
      registration,
      fallbackHead,
      fallbackSide,
      projected,
    )) continue;
    const x = projected[0];
    const y = projected[1];
    joints[name] = {
      x,
      y,
      inFrame: Number.isFinite(x) && Number.isFinite(y) && x >= -1 && x <= 1 && y >= -1 && y <= 1,
    };
  }
  return { tracked: true, joints };
}
