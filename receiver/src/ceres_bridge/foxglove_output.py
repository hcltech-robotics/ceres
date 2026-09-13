"""Optional Foxglove SDK output with a bounded, expiring viewer transport."""

import asyncio
from collections import OrderedDict
import contextlib
import json
import struct
import time
from io import BytesIO
from pathlib import Path
from PIL import Image

import aiohttp
from aiohttp import web
import foxglove
from foxglove import channels as c
from foxglove import messages as m

from .client import Receiver
from .foxglove_receiver import FoxgloveReceiver
from .foxglove_scene import NAMES, ORIGIN, StreamMetrics, camera_calibration, converted_pose, joints, scene, timestamp, transforms
from .foxglove_schemas import DIAGNOSTIC_SCHEMA, HAND_SCHEMA, MOTION_SCHEMA
from .foxglove_signals import MotionSignals, ProcessMetrics
from .foxglove_ui import LAYOUTS, connection_links, layout_bytes

MAX_VIEWERS = 4
MAX_VIEWER_MESSAGE = 3 * 1024 * 1024
VIEWER_MAX_AGE_NS = 100_000_000
VIEWER_WRITE_TIMEOUT = 0.5


def _update_subscriptions(value, channels, subscriptions):
    """Track viewer subscriptions and identify a newly subscribed video stream."""
    request_keyframe = False
    if value["op"] == "subscribe":
        for subscription in value.get("subscriptions", []):
            identifier = subscription["id"]
            topic = channels.get(subscription["channelId"])
            if topic == "/ceres/camera/video" and subscriptions.get(identifier) != topic:
                request_keyframe = True
            subscriptions[identifier] = topic
    else:
        for identifier in value.get("subscriptionIds", []):
            subscriptions.pop(identifier, None)
    return request_keyframe


async def run(args):
    meshes = {}
    model_url = None
    asset_directory = Path(args.assets).resolve() if args.assets else None
    if asset_directory:
        from .foxglove_mesh import HandMesh
        meshes = {side: HandMesh(asset_directory / f"mano-{side}.json", side) for side in ("left", "right")}
        if not (asset_directory / "quest-3.glb").is_file():
            raise ValueError("Quest model is missing from the viewer asset directory")
        model_url = f"http://{args.host}:{args.port}/assets/quest-3.glb"
    # Keep subscription handling on this event loop. SDK Python callbacks can
    # acquire the GIL while its context lock is held during channel removal.
    keyframe_requested = asyncio.Event()
    # Own every channel for this run. The convenience foxglove.log() path
    # consults the SDK global context and retains channels between runs.
    context = foxglove.Context()
    pose_channels = {kind: c.PoseInFrameChannel(
        f"/ceres/{name}/{'pose' if kind == '1' else 'wrist'}", context=context)
        for kind, name in NAMES.items()}
    video_channel = c.CompressedVideoChannel("/ceres/camera/video", context=context)
    calibration_channel = c.CameraCalibrationChannel("/ceres/camera/calibration", context=context)
    projection_channel = c.CompressedImageChannel("/ceres/camera/projection", context=context)
    transform_channel = c.FrameTransformsChannel("/ceres/transforms", context=context)
    scene_channel = c.SceneUpdateChannel("/ceres/scene", context=context)
    typed_channels = [*pose_channels.values(), video_channel, calibration_channel,
                      projection_channel, transform_channel, scene_channel]
    backend = foxglove.start_server(name="CERES Bridge", host="127.0.0.1", port=0, capabilities=[],
                                   message_backlog_size=16, context=context)
    hand_channels = {kind: foxglove.Channel(f"/ceres/{NAMES[kind]}/joints", schema=HAND_SCHEMA, context=context) for kind in ("2", "3")}
    motion_channels = {kind: foxglove.Channel(f"/ceres/{name}/motion", schema=MOTION_SCHEMA, context=context) for kind, name in NAMES.items()}
    diagnostic_channel = foxglove.Channel("/ceres/diagnostics", schema=DIAGNOSTIC_SCHEMA, context=context)
    viewers = set()
    video_history = OrderedDict()
    video_sequence = 0
    stop = asyncio.Event()
    import signal
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, stop.set)

    async def websocket(request):
        if len(viewers) >= MAX_VIEWERS:
            return web.Response(status=429, text="Viewer limit reached")
        front = web.WebSocketResponse(protocols=("foxglove.sdk.v1",), max_msg_size=4096, compress=False)
        await front.prepare(request)
        viewers.add(front)
        channels = {}
        subscriptions = {}
        previous_video = None
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(f"http://127.0.0.1:{backend.port}", protocols=("foxglove.sdk.v1",),
                                              max_msg_size=MAX_VIEWER_MESSAGE, compress=0) as back:
                    async def upstream():
                        nonlocal previous_video
                        async for message in front:
                            if message.type != aiohttp.WSMsgType.TEXT:
                                print(f"Viewer input closed: {message.type}", flush=True)
                                break
                            value = json.loads(message.data)
                            if value.get("op") not in ("subscribe", "unsubscribe"):
                                print(f"Unsupported viewer operation: {value.get('op')}", flush=True)
                                break
                            if _update_subscriptions(value, channels, subscriptions):
                                previous_video = None
                                keyframe_requested.set()
                            await asyncio.wait_for(back.send_str(message.data), VIEWER_WRITE_TIMEOUT)

                    async def downstream():
                        nonlocal previous_video
                        async for message in back:
                            if message.type == aiohttp.WSMsgType.BINARY:
                                data = message.data
                                if len(data) > MAX_VIEWER_MESSAGE:
                                    print(f"Viewer message exceeded limit: {len(data)}", flush=True)
                                    break
                                if len(data) >= 13 and data[0] == 1:
                                    sent = struct.unpack_from("<Q", data, 5)[0]
                                    if time.time_ns() - sent > VIEWER_MAX_AGE_NS:
                                        previous_video = None
                                        keyframe_requested.set()
                                        continue
                                    subscription = struct.unpack_from("<I", data, 1)[0]
                                    if subscriptions.get(subscription) == "/ceres/camera/video":
                                        record = video_history.get(sent)
                                        if record is None:
                                            previous_video = None
                                            keyframe_requested.set()
                                            continue
                                        sequence, keyframe = record
                                        if not keyframe and (previous_video is None or sequence != previous_video + 1):
                                            previous_video = None
                                            keyframe_requested.set()
                                            continue
                                        previous_video = sequence
                                await asyncio.wait_for(front.send_bytes(data), VIEWER_WRITE_TIMEOUT)
                            elif message.type == aiohttp.WSMsgType.TEXT:
                                value = json.loads(message.data)
                                if value.get("op") == "advertise":
                                    for channel in value["channels"]:
                                        channels[channel["id"]] = channel["topic"]
                                await asyncio.wait_for(front.send_str(message.data), VIEWER_WRITE_TIMEOUT)
                            else:
                                print(f"Viewer backend closed: {message.type}", flush=True)
                                break
                    tasks = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
                    try:
                        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for task in tasks:
                            task.cancel()
                        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
                        for outcome in outcomes:
                            if isinstance(outcome, Exception):
                                print(f"Viewer transport error: {type(outcome).__name__}: {outcome}", flush=True)
        except (ValueError, OSError, asyncio.TimeoutError, aiohttp.ClientError) as error:
            print(f"Foxglove viewer disconnected: {error}", flush=True)
        finally:
            viewers.discard(front)
            await front.close()
        return front

    application = web.Application(client_max_size=4096)
    application.router.add_get("/", websocket)
    async def download_layout(request):
        name = request.match_info["name"]
        if name not in LAYOUTS:
            raise web.HTTPNotFound()
        return web.Response(body=layout_bytes(name), content_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="ceres-bridge-{name}"',
        })
    application.router.add_get("/layouts/{name}", download_layout)
    if getattr(args, "robot", None):
        from .robot_assets import asset_bytes

        async def robot_asset(request):
            try:
                data = asset_bytes(request.match_info["name"])
            except ValueError:
                raise web.HTTPNotFound() from None
            return web.Response(body=data, content_type="model/gltf-binary", headers={
                "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=31536000, immutable"})

        application.router.add_get("/assets/xlerobot/{name}", robot_asset)
    if asset_directory:
        async def quest_model(_request):
            return web.FileResponse(asset_directory / "quest-3.glb", headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "model/gltf-binary"})
        application.router.add_get("/assets/quest-3.glb", quest_model)
    runner = web.AppRunner(application, access_log=None, shutdown_timeout=1)
    await runner.setup()
    await web.TCPSite(runner, args.host, args.port).start()
    receiver = FoxgloveReceiver(args.socket, video=True, encoded=True, factory=Receiver)
    last_scene = 0
    last_diagnostics = 0
    metrics = StreamMetrics()
    motion = MotionSignals()
    process = ProcessMetrics()
    robot_task = None
    last_projection = 0
    receiver_generation = None
    try:
        links = connection_links(args.host, args.port)
        if getattr(args, "robot", None):
            from .foxglove_teleop import run_robot
            robot_task = asyncio.create_task(run_robot(args, stop, context=context))
            links["layout"] = links["layout"].replace("/layout.json", "/dual-arm-layout.json")
        print(f"Foxglove: {links['websocket']}", flush=True)
        print(f"Open in Foxglove: {links['open']}", flush=True)
        print(f"Import layout: {links['layout']}", flush=True)
        while not stop.is_set():
            loop_started = time.monotonic_ns()
            if robot_task is not None and robot_task.done():
                robot_task.result()
            request_keyframe = keyframe_requested.is_set()
            keyframe_requested.clear()
            snapshot = await receiver.latest(keyframe=request_keyframe)
            if snapshot["ipc_generation"] != receiver_generation:
                receiver_generation = snapshot["ipc_generation"]
                video_history.clear()
            now = time.time_ns()
            for kind, signal in motion.observe(snapshot).items():
                motion_channels[kind].log(signal, log_time=now)
            for kind in metrics.observe(snapshot):
                component = snapshot["poses"][kind]
                pose = component["pose"]
                source_time = now + (component["received_us"] - snapshot["now_us"]) * 1000
                if kind != "1":
                    hand_channels[kind].log(joints(component), log_time=now)
                if component["tracked"] and (kind == "1" or pose["joint_mask"] & 1):
                    pose_channels[kind].log(m.PoseInFrame(
                        timestamp=timestamp(source_time), frame_id=ORIGIN, pose=converted_pose(pose["values"])), log_time=now)
            for key in ("frame", "encoded"):
                frame = snapshot[key]
                if not frame:
                    continue
                with frame:
                    meta = frame.metadata
                    source_time = now + (meta["received_us"] - time.monotonic_ns() // 1000) * 1000
                    if key == "encoded":
                        metrics.video_bytes += len(frame.data)
                        video_sequence += 1
                        video_history[now] = (video_sequence, meta["keyframe"])
                        while len(video_history) > 128:
                            video_history.popitem(last=False)
                        video_channel.log(m.CompressedVideo(timestamp=timestamp(source_time),
                            frame_id="ceres_camera_optical", format="h264", data=bytes(frame.data)), log_time=now)
                    else:
                        if now - last_projection >= 66_000_000:
                            picture = Image.frombytes("RGB", (meta["width"], meta["height"]), bytes(frame.data), "raw", "RGB", meta["stride"])
                            encoded_image = BytesIO()
                            picture.save(encoded_image, "JPEG", quality=80)
                            calibration_channel.log(camera_calibration(meta["width"], meta["height"], now), log_time=now)
                            projection_channel.log(m.CompressedImage(timestamp=timestamp(now),
                                frame_id="ceres_camera_optical", format="jpeg", data=encoded_image.getvalue()), log_time=now)
                            last_projection = now
            if now - last_scene >= 33_000_000:
                transform_channel.log(transforms(snapshot, now), log_time=now)
                scene_channel.log(scene(snapshot, now, meshes, model_url), log_time=now)
                last_scene = now
            if now - last_diagnostics >= 200_000_000:
                diagnostic_channel.log({**metrics.diagnostic(snapshot), **process.diagnostic()}, log_time=now)
                for kind in ("2", "3"):
                    if not snapshot["poses"].get(kind, {}).get("tracked"):
                        hand_channels[kind].log(joints({}), log_time=now)
                last_diagnostics = now
            process.observe_loop(time.monotonic_ns() - loop_started)
            await asyncio.sleep(0.002)
    finally:
        stop.set()
        if robot_task is not None:
            await asyncio.gather(robot_task, return_exceptions=True)
        await receiver.close()
        await asyncio.gather(*(viewer.close() for viewer in list(viewers)), return_exceptions=True)
        await runner.cleanup()
        backend.stop()
        diagnostic_channel.close()
        for channel in hand_channels.values():
            channel.close()
        for channel in motion_channels.values():
            channel.close()
        for channel in typed_channels:
            channel.close()
