"""Independent XLeRobot retargeting consumer and lightweight Foxglove geometry."""

import asyncio
import math
import time
from urllib.parse import urlsplit

import foxglove
from foxglove import channels as c
from foxglove import messages as m
import numpy as np

from .client import Receiver
from .foxglove_receiver import FoxgloveReceiver
from .foxglove_scene import position_pose, timestamp, vector
from .foxglove_schemas import NUMBER, STRING, BOOLEAN, object_schema
from .foxglove_ui import connection_links
from .robot_assets import manifest, model_poses
from .teleop import DualArmTeleop

JOINT_FIELDS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper")
JOINT_SCHEMA = {"$schema": "http://json-schema.org/draft-07/schema#", "title": "ceres.RobotJoints",
    **object_schema({side: object_schema({name: NUMBER for name in JOINT_FIELDS}) for side in ("left", "right")})}
DIAGNOSTIC_SCHEMA = {"$schema": "http://json-schema.org/draft-07/schema#", "title": "ceres.RobotDiagnostics",
    **object_schema({"model": STRING, "backend": STRING, "solver": STRING, "update_fps": NUMBER, "solve_ms": NUMBER,
        **{side+suffix: schema for side in ("left", "right") for suffix, schema in (
            ("_status", STRING), ("_tracked", BOOLEAN), ("_error_m", NUMBER), ("_rotation_error_rad", NUMBER))}})}


def robot_scene(result, links, now, asset_base_url):
    """Render the upstream visual meshes at the exact commanded link poses."""
    entities = []
    for name, pose in model_poses(links).items():
        position, orientation = pose["position"], pose["orientation"]
        model = manifest()["models"][name]
        entities.append(m.SceneEntity(timestamp=timestamp(now), frame_id="ceres_robot_base",
            id="robot/" + name, lifetime=m.Duration(0, 250_000_000),
            models=[m.ModelPrimitive(
                pose=m.Pose(position=vector(tuple(position[axis] for axis in "xyz")),
                    orientation=m.Quaternion(**orientation)),
                scale=vector((1, 1, 1)), url=asset_base_url + "/" + model["file"],
                media_type="model/gltf-binary")]))
    for side, state in result["arms"].items():
        target = state["target"]["position"]
        markers = []
        if state["tracked"]:
            markers.append(m.SpherePrimitive(
                pose=position_pose(tuple(target[axis] for axis in "xyz")),
                size=vector((.014,) * 3), color=m.Color(r=1, g=1, b=1, a=.9)))
        base = links["Base_2" if side == "left" else "Base"]["position"]
        colour = m.Color(r=.15, g=.65, b=1, a=1) if side == "left" else m.Color(r=1, g=.45, b=.24, a=1)
        entities.append(m.SceneEntity(timestamp=timestamp(now), frame_id="ceres_robot_base",
            id="target/" + side, lifetime=m.Duration(0, 250_000_000), spheres=markers,
            texts=[m.TextPrimitive(
                pose=position_pose((base["x"], base["y"], base["z"] + .35)),
                billboard=True, font_size=.035, color=colour, text=f"{side.capitalize()} arm: {state['status']}")]))
    return m.SceneUpdate(entities=entities)


def fixed_robot_transform(origin, yaw_degrees):
    """Map the scaled CERES frame into the robot base with a fixed rigid pose."""
    origin = np.asarray(origin, dtype=float)
    if origin.shape != (3,) or not np.isfinite(origin).all() or not math.isfinite(yaw_degrees):
        raise ValueError("Robot origin must contain three finite coordinates and yaw must be finite")
    yaw = math.radians(yaw_degrees)
    cosine, sine = math.cos(yaw), math.sin(yaw)
    transform = np.eye(4)
    transform[:3, :3] = ((cosine, -sine, 0), (sine, cosine, 0), (0, 0, 1))
    transform[:3, 3] = origin
    return transform


async def run_robot(args, stop, *, context=None):
    teleop = DualArmTeleop(position_scale=args.position_scale, backend=args.retargeter,
                          robot_from_ceres=fixed_robot_transform(args.robot_origin, args.robot_yaw),
                          tracking_grace=getattr(args, "tracking_grace", .5),
                          max_joint_speed=getattr(args, "max_joint_speed", 2.0),
                          max_joint_acceleration=getattr(args, "max_joint_acceleration", 8.0),
                          max_joint_jerk=getattr(args, "max_joint_jerk", 80.0))
    authority = urlsplit(connection_links(args.host, args.port)["layout"]).netloc
    asset_base_url = f"http://{authority}/assets/xlerobot"
    joint_channel = foxglove.Channel("/ceres/robot/joints", schema=JOINT_SCHEMA, context=context)
    diagnostics = foxglove.Channel("/ceres/robot/diagnostics", schema=DIAGNOSTIC_SCHEMA, context=context)
    scene_channel = c.SceneUpdateChannel("/ceres/robot/scene", context=context)
    transform_channel = c.FrameTransformsChannel("/ceres/robot/transforms", context=context)
    receiver = None
    count, started, rate = 0, time.monotonic(), 0.0
    last_diagnostic = last_scene = 0
    period = 1 / args.robot_rate
    try:
        receiver = FoxgloveReceiver(args.socket, video=False, factory=Receiver)

        def step(snapshot):
            result = teleop.update(snapshot)
            return result, teleop.link_transforms()

        while not stop.is_set():
            cycle = time.monotonic()
            # One outstanding operation. An expensive solve never queues old observations.
            snapshot = await receiver.latest()
            result, links = await asyncio.to_thread(step, snapshot)
            now = time.time_ns()
            joints = {side: dict(zip(JOINT_FIELDS, result["arms"][side]["joint_positions"])) for side in ("left", "right")}
            joint_channel.log(joints, log_time=now)
            count += int(result["updated"])
            elapsed = time.monotonic() - started
            if elapsed >= 1:
                rate, count, started = count/elapsed, 0, time.monotonic()
            if now - last_scene >= 33_000_000:
                scene_channel.log(robot_scene(result, links, now, asset_base_url), log_time=now)
                transform_channel.log(m.FrameTransforms(transforms=[m.FrameTransform(
                    timestamp=timestamp(now), parent_frame_id="ceres_robot_base", child_frame_id="ceres_robot_axes",
                    translation=vector((0, 0, 0)), rotation=m.Quaternion(w=1))]), log_time=now)
                last_scene = now
            if now - last_diagnostic >= 200_000_000:
                values = {"model": result["model"], "backend": result["backend"], "solver": result["solver"], "update_fps": rate,
                          "solve_ms": result["solve_ms"]}
                for side, arm in result["arms"].items():
                    values.update({side+"_status": arm["status"], side+"_tracked": arm["tracked"],
                                   side+"_error_m": arm["position_error_m"], side+"_rotation_error_rad": arm["rotation_error_rad"]})
                diagnostics.log(values, log_time=now)
                last_diagnostic = now
            await asyncio.sleep(max(0, period - (time.monotonic()-cycle)))
    finally:
        if receiver is not None:
            await receiver.close()
        joint_channel.close()
        diagnostics.close()
        scene_channel.close()
        transform_channel.close()
