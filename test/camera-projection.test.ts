import assert from "node:assert/strict";
import test from "node:test";
import type { CameraViewPose, SensorFrame, Transform } from "../shared/protocol.js";
import { CAMERA_REGISTRATION_SCHEMA } from "../shared/camera-registration.js";
import {
  cameraCoverViewport,
  cameraProjectionToCoverViewport,
  cameraViewPoseFromViewerPose,
  inferCameraSide,
  projectHandsToRegisteredCamera,
  projectWorldPointToCamera,
  projectWorldPointToCameraInto,
  projectWorldPointToCameraSample,
  selectCameraView,
} from "../src/camera-projection.js";
import { TELEMETRY_VALUE_COUNT, decodeTelemetryFrame, writeSensorTelemetry } from "../src/recorder/telemetry-buffer.js";

const identityTransform: Transform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

const projectionMatrix = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, -1,
  0, 0, 0, 0,
];

const camera = (side: "left" | "right", x: number): CameraViewPose => ({
  side,
  transform: { ...identityTransform, position: { x, y: 0, z: 0 } },
  projectionMatrix,
  imageWidth: 1280,
  imageHeight: 960,
});

test("allocation-free projection matches the tuple projection", () => {
  const output = new Float32Array(4);
  const position = { x: .15, y: -.08, z: -1.5 };
  const projected = projectWorldPointToCamera(position, null, null, identityTransform, "left");
  const written = projectWorldPointToCameraInto(position, null, null, identityTransform, "left", output, 2);
  assert.ok(projected);
  assert.equal(written, true);
  assert.ok(Math.abs(output[2] - projected[0]) < 1e-6);
  assert.ok(Math.abs(output[3] - projected[1]) < 1e-6);
  assert.deepEqual(
    projectWorldPointToCameraSample(position, null, null, identityTransform, "left"),
    { depth: 1.465, x: projected[0], y: projected[1] },
  );
});

test("maps camera centre and edges through an object-fit cover viewport once", () => {
  assert.deepEqual(
    cameraCoverViewport({ width: 300, height: 300 }, { width: 640, height: 480 }),
    { x: -50, y: 0, width: 400, height: 300, scale: .625 },
  );
  assert.deepEqual(
    cameraProjectionToCoverViewport(
      { x: 0, y: 0 },
      { width: 640, height: 480 },
      { width: 300, height: 300 },
    ),
    { x: 150, y: 150 },
  );
  assert.deepEqual([
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
  ].map((point) => cameraProjectionToCoverViewport(
    point,
    { width: 640, height: 480 },
    { width: 300, height: 300 },
  )), [
    { x: -50, y: 150 },
    { x: 350, y: 150 },
    { x: 150, y: 0 },
    { x: 150, y: 300 },
  ]);
});

test("Quest camera labels and the two-camera fallback resolve physical sides", () => {
  assert.equal(inferCameraSide("Passthrough left", 1, 2, true), "left");
  assert.equal(inferCameraSide("Passthrough right", 0, 2, true), "right");
  assert.equal(inferCameraSide("camera2 0", 1, 2, true), "right");
  assert.equal(inferCameraSide("camera2 1", 0, 2, true), "left");
  assert.equal(inferCameraSide("Outward camera", 0, 2, true), "right");
  assert.equal(inferCameraSide("Outward camera", 1, 2, true), "left");
  assert.equal(inferCameraSide("camera2 0", 0, 2, false), "left");
  assert.equal(inferCameraSide("USB camera", 0, 1, false), "unknown");
});

test("the selected feed side chooses the matching XR view pose", () => {
  const pose = cameraViewPoseFromViewerPose({
    views: [
      { eye: "left", transform: { position: { x: -.03, y: 0, z: 0 }, orientation: identityTransform.rotation }, projectionMatrix },
      { eye: "right", transform: { position: { x: .03, y: 0, z: 0 }, orientation: identityTransform.rotation }, projectionMatrix },
    ],
  }, "right");
  assert.equal(pose?.side, "right");
  assert.equal(pose?.transform.position.x, .062);
  assert.equal(pose?.transform.position.y, -.03);
  assert.equal(pose?.transform.position.z, -.035);
});

test("an unlabelled feed uses the default right Quest view", () => {
  const left = { eye: "left", transform: { position: { x: -.03, y: 0, z: 0 }, orientation: identityTransform.rotation }, projectionMatrix };
  const right = { eye: "right", transform: { position: { x: .03, y: 0, z: 0 }, orientation: identityTransform.rotation }, projectionMatrix };
  assert.equal(selectCameraView([left, right], "unknown"), right);
});

test("the camera pose carries the outgoing media dimensions", () => {
  const pose = cameraViewPoseFromViewerPose({
    views: [{
      eye: "right",
      transform: { position: { x: .03, y: 0, z: 0 }, orientation: identityTransform.rotation },
      projectionMatrix,
      camera: { width: 1280, height: 960 },
    }],
  }, "right", { width: 640, height: 480 });
  assert.equal(pose?.imageWidth, 640);
  assert.equal(pose?.imageHeight, 480);
});

test("camera extrinsics follow headset orientation", () => {
  const halfTurn = Math.sin(Math.PI / 4);
  const pose = cameraViewPoseFromViewerPose({
    views: [{
      eye: "right",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: halfTurn, z: 0, w: halfTurn },
      },
      projectionMatrix,
    }],
  }, "right");
  assert.ok(pose);
  assert.ok(Math.abs(pose.transform.position.x + .035) < 1e-9);
  assert.ok(Math.abs(pose.transform.position.y + .03) < 1e-9);
  assert.ok(Math.abs(pose.transform.position.z + .032) < 1e-9);
});

test("calibrated projection is centred on the selected camera pose", () => {
  const projected = projectWorldPointToCamera(
    { x: .03, y: 0, z: -1 },
    camera("right", .03),
    { width: 1000, height: 800, fx: 500, fy: 500, cx: 500, cy: 400, distortion: [0, 0, 0, 0, 0] },
    identityTransform,
    "right",
  );
  assert.deepEqual(projected, [0, 0]);
});

test("registered hand projection is generated on the capture frame", () => {
  const registration = {
    schema: CAMERA_REGISTRATION_SCHEMA,
    cameraDeviceId: "quest-camera-device-0",
    cameraLabel: "camera2 0",
    side: "right" as const,
    width: 1280,
    height: 960,
    fx: 640,
    fy: 640,
    cx: 640,
    cy: 480,
    distortion: [0, 0, 0, 0, 0],
    rms: .2,
    sampleCount: 18,
    reprojection: {
      centre: { near: .2, middle: .2, far: .2 },
      edges: { near: .2, middle: .2, far: .2 },
      maximumRms: .2,
    },
    calibratedAtMs: 1_000,
  };
  const rightCamera = camera("right", .03);
  const projection = projectHandsToRegisteredCamera(
    { tracked: false, joints: {}, pinch: 0 },
    {
      tracked: true,
      joints: { wrist: { ...identityTransform, position: { x: .03, y: 0, z: -1 } } },
      pinch: .02,
    },
    rightCamera,
    registration,
    identityTransform,
    "right",
  );
  assert.equal(projection?.source, "calibrated-media-camera");
  assert.equal(projection?.leftHand.tracked, false);
  assert.deepEqual(projection?.rightHand.joints.wrist, { x: 0, y: 0, inFrame: true });
  assert.equal(projectHandsToRegisteredCamera(
    { tracked: false, joints: {}, pinch: 0 },
    { tracked: false, joints: {}, pinch: 0 },
    { ...rightCamera, imageWidth: 640 },
    registration,
    identityTransform,
    "right",
  ), null);
});

test("XR projection matrices preserve the selected view parallax", () => {
  const projected = projectWorldPointToCamera(
    { x: .23, y: .1, z: -1 },
    camera("right", .03),
    null,
    identityTransform,
    "right",
  );
  assert.ok(projected);
  assert.ok(Math.abs(projected[0] - .2) < 1e-9);
  assert.ok(Math.abs(projected[1] + .1) < 1e-9);
});

test("left and right fallback extrinsics move the same world point in opposite directions", () => {
  const left = projectWorldPointToCamera({ x: 0, y: 0, z: -1 }, null, null, identityTransform, "left");
  const right = projectWorldPointToCamera({ x: 0, y: 0, z: -1 }, null, null, identityTransform, "right");
  assert.ok(left && right);
  assert.ok(left[0] > 0);
  assert.ok(right[0] < 0);
});

test("durable telemetry retains camera side, pose and projection", () => {
  const values = new Float64Array(TELEMETRY_VALUE_COUNT);
  const frame: SensorFrame = {
    timestampMs: 1000,
    frameIndex: 7,
    head: identityTransform,
    cameraSide: "right",
    camera: camera("right", .03),
    leftHand: { tracked: false, joints: {}, pinch: 0 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: true, meshes: true, anchors: true },
  };
  writeSensorTelemetry(values, 0, 1_000_000, frame);
  const decoded = decodeTelemetryFrame(values, 7, 0);
  assert.equal(decoded.cameraSide, "right");
  assert.equal(decoded.camera?.side, "right");
  assert.equal(decoded.camera?.transform.position.x, .03);
  assert.deepEqual(decoded.camera?.projectionMatrix, projectionMatrix);
  assert.deepEqual(decoded.sceneStatus, { planes: false, meshes: false, anchors: false });
});
