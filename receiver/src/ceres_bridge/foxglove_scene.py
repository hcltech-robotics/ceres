"""Foxglove geometry and observables in a right-handed, Z-up body basis."""

import math
from foxglove import messages as m
from .coordinates import HAND_BONES, ros_position, ros_orientation
from .protocol import JOINTS

ORIGIN = "ceres_origin"
NAMES = {"1": "head", "2": "left", "3": "right"}
COLOURS = {"1": (0.8, 0.85, 0.94), "2": (0.28, 0.64, 1), "3": (1, 0.48, 0.72)}
SCENE_LIFETIME_NS = 250_000_000
HEADSET_MODEL_YAW = (0, 0, -math.sqrt(0.5), math.sqrt(0.5))
HEADSET_VISUAL_SCALE = 0.6


def timestamp(ns):
    return m.Timestamp(*divmod(int(ns), 1_000_000_000))


def vector(v):
    return m.Vector3(x=v[0], y=v[1], z=v[2])


def point(v):
    return m.Point3(x=v[0], y=v[1], z=v[2])


def position_pose(v):
    return m.Pose(position=vector(v), orientation=m.Quaternion(w=1))


def converted_pose(values):
    p, q = ros_position(values), ros_orientation(values[3:7])
    return m.Pose(position=vector(p), orientation=m.Quaternion(x=q[0], y=q[1], z=q[2], w=q[3]))


def headset_model_pose(values):
    # Align the mesh by a clockwise quarter turn about its body-basis Z axis.
    # Right composition keeps this visual correction attached to the headset.
    p = ros_position(values)
    q = quaternion_product(ros_orientation(values[3:7]), HEADSET_MODEL_YAW)
    return m.Pose(position=vector(p), orientation=m.Quaternion(x=q[0], y=q[1], z=q[2], w=q[3]))


def pose_dict(values):
    p, q = ros_position(values), ros_orientation(values[3:7])
    return {"position": dict(zip(("x", "y", "z"), p)),
            "orientation": dict(zip(("x", "y", "z", "w"), q))}


def joints(component):
    pose = component.get("pose")
    valid = component.get("tracked", False) and pose is not None
    mask = pose["joint_mask"] if valid else 0
    result = []
    for index, name in enumerate(JOINTS):
        tracked = bool(mask & (1 << index))
        values = pose["values"][index * 8:index * 8 + 8] if tracked else None
        result.append({"name": name, "tracked": tracked,
                       "pose": pose_dict(values) if values else None,
                       "radius_m": values[7] if values else None})
    return {"frame_id": ORIGIN, "tracked": bool(valid), "valid_joints": mask.bit_count(), "joints": result}


def scene(snapshot, now, meshes=None, model_url=None):
    entities = []
    removed = set(NAMES.values()) if snapshot.get("connection", "connected") != "connected" else set()
    for kind, component in snapshot["poses"].items():
        pose = component.get("pose")
        if kind not in NAMES:
            continue
        if pose and not component["tracked"]:
            removed.add(NAMES[kind])
        if not pose or not component["tracked"] or NAMES[kind] in removed:
            continue
        values = pose["values"]
        colour = m.Color(r=COLOURS[kind][0], g=COLOURS[kind][1], b=COLOURS[kind][2], a=1)
        cubes, lines, spheres, arrows, texts, triangles, models = [], [], [], [], [], [], []
        if kind == "1":
            cubes = [m.CubePrimitive(pose=converted_pose(values),
                                    size=vector(tuple(value * HEADSET_VISUAL_SCALE for value in (0.12, 0.18, 0.1))), color=colour)]
            # Local +X is forward after the WebXR to body basis conversion.
            arrows = [m.ArrowPrimitive(pose=converted_pose(values), shaft_length=0.28 * HEADSET_VISUAL_SCALE,
                                      shaft_diameter=0.007 * HEADSET_VISUAL_SCALE, head_length=0.04 * HEADSET_VISUAL_SCALE,
                                      head_diameter=0.025 * HEADSET_VISUAL_SCALE, color=colour)]
            if model_url:
                cubes, arrows = [], []
                models = [m.ModelPrimitive(pose=headset_model_pose(values), scale=vector((HEADSET_VISUAL_SCALE,) * 3),
                                           url=model_url, media_type="model/gltf-binary")]
        else:
            points = []
            for left, right in HAND_BONES:
                if pose["joint_mask"] & (1 << left) and pose["joint_mask"] & (1 << right):
                    points.extend(point(ros_position(values[joint*8:joint*8+3])) for joint in (left, right))
            lines = [m.LinePrimitive(type=m.LinePrimitiveLineType.LineList, thickness=0.004, points=points, color=colour)]
            for joint in range(25):
                if pose["joint_mask"] & (1 << joint):
                    v = values[joint*8:joint*8+8]
                    diameter = max(0.004, v[7] * 2)
                    spheres.append(m.SpherePrimitive(pose=converted_pose(v), size=vector((diameter,)*3), color=colour))
            mesh = (meshes or {}).get(NAMES[kind])
            vertices = mesh.fit(pose) if mesh else None
            if vertices is not None:
                triangles = [m.TriangleListPrimitive(pose=position_pose((0, 0, 0)),
                    points=[point(vertex) for vertex in vertices], indices=mesh.faces, color=colour)]
                spheres, lines = [], []
        anchor = ros_position(values)
        if kind == "1" or pose["joint_mask"] & 1:
            texts = [m.TextPrimitive(pose=position_pose((anchor[0], anchor[1], anchor[2] + 0.15)),
                      billboard=True, font_size=0.04, color=colour, text=NAMES[kind].capitalize())]
        metadata = [m.KeyValuePair(key="component", value=NAMES[kind]),
                    m.KeyValuePair(key="sequence", value=str(pose.get("sequence", 0))),
                    m.KeyValuePair(key="valid joints", value=str(pose.get("joint_mask", 0).bit_count()))]
        entities.append(m.SceneEntity(timestamp=timestamp(now), frame_id=ORIGIN, id=NAMES[kind],
            lifetime=m.Duration(0, SCENE_LIFETIME_NS), metadata=metadata,
            cubes=cubes, lines=lines, spheres=spheres, arrows=arrows, texts=texts, triangles=triangles, models=models))
    # Replacing an entity preserves its render object. A missing fresh sample is
    # a transport gap, so let the last mesh expire instead of deleting it between
    # updates. Explicit tracking loss still removes the mesh immediately.
    deletions = [m.SceneEntityDeletion(timestamp=timestamp(now), type=m.SceneEntityDeletionType.MatchingId, id=name)
                 for name in sorted(removed)]
    return m.SceneUpdate(deletions=deletions, entities=entities)


def transforms(snapshot, now):
    result = [m.FrameTransform(timestamp=timestamp(now), parent_frame_id=ORIGIN,
                              child_frame_id="ceres_axes", translation=vector((0, 0, 0)), rotation=m.Quaternion(w=1))]
    for kind, component in snapshot["poses"].items():
        pose = component.get("pose")
        if kind not in NAMES or not component["tracked"] or not pose:
            continue
        if kind != "1" and not pose["joint_mask"] & 1:
            continue
        v = pose["values"]
        q = ros_orientation(v[3:7])
        result.append(m.FrameTransform(timestamp=timestamp(now), parent_frame_id=ORIGIN,
            child_frame_id="ceres_" + NAMES[kind] + ("" if kind == "1" else "_wrist"),
            translation=vector(ros_position(v)), rotation=m.Quaternion(x=q[0], y=q[1], z=q[2], w=q[3])))
    side = ((snapshot.get("description") or {}).get("camera") or {}).get("side")
    if side in ("left", "right"):
        yaw = math.radians(-6 if side == "left" else 6)
        # Player's head-to-camera preset followed by optical X-right/Y-down/Z-forward.
        q = quaternion_product(quaternion_product((.5, -.5, -.5, .5), (0, math.sin(yaw/2), 0, math.cos(yaw/2))), (1, 0, 0, 0))
        p = ros_position((-.064 if side == "left" else .064, -.03, -.035))
        result.append(m.FrameTransform(timestamp=timestamp(0), parent_frame_id="ceres_head",
            child_frame_id="ceres_camera_optical", translation=vector(p),
            rotation=m.Quaternion(x=q[0], y=q[1], z=q[2], w=q[3])))
    return m.FrameTransforms(transforms=result)


def quaternion_product(a, b):
    x, y, z, w = a
    i, j, k, s = b
    return (w*i+x*s+y*k-z*j, w*j-x*k+y*s+z*i, w*k+x*j-y*i+z*s, w*s-x*i-y*j-z*k)


def camera_calibration(width, height, now):
    # Match CERES Player's 2*atan(0.81) horizontal FOV until measured intrinsics are supplied.
    f = width / (2 * .81)
    cx, cy = width / 2, height / 2
    return m.CameraCalibration(timestamp=timestamp(now), frame_id="ceres_camera_optical",
        width=width, height=height, distortion_model="plumb_bob", D=[0.0]*5,
        K=[f, 0, cx, 0, f, cy, 0, 0, 1], R=[1, 0, 0, 0, 1, 0, 0, 0, 1],
        P=[f, 0, cx, 0, 0, f, cy, 0, 0, 0, 1, 0])


class StreamMetrics:
    """One sampling window, without retaining pose or video history."""

    def __init__(self):
        self.epoch = None
        self.previous = {}
        self.counts = dict.fromkeys(NAMES, 0)
        self.started = None
        self.frames = 0
        self.video_bytes = 0
        self.rates = dict.fromkeys(("video_fps", "motion_fps", "left_fps", "right_fps", "video_mbps"), 0.0)

    def observe(self, snapshot):
        epoch = (snapshot["epoch"], snapshot["space_epoch"])
        if epoch != self.epoch:
            self.previous.clear()
            self.epoch = epoch
        changed = []
        for kind, component in snapshot["poses"].items():
            pose = component.get("pose")
            sequence = pose["sequence"] if pose else None
            if sequence is not None and self.previous.get(kind) != sequence:
                self.counts[kind] += 1
                self.previous[kind] = sequence
                changed.append(kind)
        now = snapshot["now_us"]
        if self.started is None:
            self.started = now
            self.frames = snapshot["counts"]["frames"]
        elapsed = (now - self.started) / 1e6
        if elapsed >= 1:
            self.rates = dict(zip(("motion_fps", "left_fps", "right_fps"),
                                  (self.counts[kind] / elapsed for kind in NAMES)))
            self.rates.update(video_fps=max(0, snapshot["counts"]["frames"] - self.frames) / elapsed,
                              video_mbps=self.video_bytes * 8 / elapsed / 1e6)
            self.counts = dict.fromkeys(NAMES, 0)
            self.video_bytes = 0
            self.frames = snapshot["counts"]["frames"]
            self.started = now
        return changed

    def diagnostic(self, snapshot):
        uncertainty = (snapshot.get("clock") or {}).get("uncertainty_us")
        result = {**self.rates, "connection": snapshot["connection"], "epoch": snapshot["epoch"],
                  "space_epoch": snapshot["space_epoch"], "codec": snapshot["codec"],
                  "clock_uncertainty_ms": uncertainty / 1000 if uncertainty is not None else None,
                  "counts": snapshot["counts"]}
        for kind, name in NAMES.items():
            component = snapshot["poses"].get(kind, {})
            result[name + "_tracked"] = component.get("tracked", False)
            result[name + "_age_ms"] = component.get("age_us", 0) / 1000 if component.get("age_us") is not None else None
            if kind != "1":
                hand = joints(component)
                result[name + "_valid_joints"] = hand["valid_joints"]
                a, b = hand["joints"][4], hand["joints"][9]
                result[name + "_pinch_m"] = math.dist(a["pose"]["position"].values(), b["pose"]["position"].values()) if a["tracked"] and b["tracked"] else None
        result["camera"] = (snapshot.get("description") or {}).get("camera")
        result["camera_projection"] = "quest-3-player-preset"
        return result
