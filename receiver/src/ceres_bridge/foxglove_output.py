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
from .foxglove_scene import NAMES, ORIGIN, StreamMetrics, camera_calibration, converted_pose, joints, scene, timestamp, transforms
from .foxglove_schemas import DIAGNOSTIC_SCHEMA, HAND_SCHEMA, MOTION_SCHEMA
from .foxglove_signals import MotionSignals, ProcessMetrics
from .foxglove_ui import LAYOUTS, connection_links, layout_bytes

MAX_VIEWERS = 4
MAX_VIEWER_MESSAGE = 3 * 1024 * 1024
VIEWER_MAX_AGE_NS = 100_000_000
VIEWER_WRITE_TIMEOUT = 0.5
CAMERA_SIDES = ("left", "right")
VIDEO_TOPICS = ("/ceres/camera/video", *(f"/ceres/camera/{side}/video" for side in CAMERA_SIDES))


class VideoHistory:
    """Bounded H264 continuity records, independent for each camera topic."""

    def __init__(self):
        self.records = {topic: OrderedDict() for topic in VIDEO_TOPICS}
        self.sequences = dict.fromkeys(VIDEO_TOPICS, 0)

    def record(self, topic, sent, keyframe, epoch):
        self.sequences[topic] += 1
        records = self.records[topic]
        records[sent] = (epoch, self.sequences[topic], keyframe)
        while len(records) > 128:
            records.popitem(last=False)

    def accept(self, topic, sent, previous):
        record = self.records[topic].get(sent)
        if record is not None:
            epoch, sequence, keyframe = record
            if keyframe or previous.get(topic) == (epoch, sequence - 1):
                previous[topic] = (epoch, sequence)
                return True
        previous.pop(topic, None)
        return False


class CameraOutput:
    """Publish primary and side camera views while releasing every frame lease."""

    def __init__(self, history, log):
        self.history = history
        self.log = log
        self.last_projection = {}

    def publish(self, snapshot, now, side=None):
        topic = "/ceres/camera" + (f"/{side}" if side else "")
        frame_id = f"ceres_camera_{side}_optical" if side else "ceres_camera_optical"
        description = snapshot.get("description") or {}
        cameras = description.get("cameras") or [description.get("camera") or {}]
        declared_sides = {camera.get("side") for camera in cameras}
        video_bytes = 0
        with contextlib.ExitStack() as leases:
            frames = {key: leases.enter_context(snapshot[key]) for key in ("frame", "encoded") if snapshot.get(key)}
            for key, frame in frames.items():
                meta = frame.metadata
                if side is not None and (meta.get("side") != side or side not in declared_sides):
                    continue
                source_time = now + (meta["received_us"] - time.monotonic_ns() // 1000) * 1000
                if key == "encoded":
                    video_bytes += len(frame.data)
                    self.history.record(topic + "/video", now, meta["keyframe"], meta["epoch"])
                    self.log(topic + "/video", m.CompressedVideo(timestamp=timestamp(source_time),
                        frame_id=frame_id, format="h264", data=bytes(frame.data)), log_time=now)
                elif now - self.last_projection.get(topic, 0) >= 66_000_000:
                    picture = Image.frombytes("RGB", (meta["width"], meta["height"]), bytes(frame.data), "raw", "RGB", meta["stride"])
                    encoded_image = BytesIO()
                    picture.save(encoded_image, "JPEG", quality=80)
                    self.log(topic + "/calibration", camera_calibration(meta["width"], meta["height"], now, frame_id=frame_id), log_time=now)
                    self.log(topic + "/projection", m.CompressedImage(timestamp=timestamp(now),
                        frame_id=frame_id, format="jpeg", data=encoded_image.getvalue()), log_time=now)
                    self.last_projection[topic] = now
        return video_bytes


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
    keyframe_request = asyncio.Event()
    context = foxglove.Context()
    backend = foxglove.start_server(name="CERES Bridge", host="127.0.0.1", port=0, capabilities=[],
                                   message_backlog_size=16, context=context)
    hand_channels = {kind: foxglove.Channel(f"/ceres/{NAMES[kind]}/joints", schema=HAND_SCHEMA, context=context) for kind in ("2", "3")}
    motion_channels = {kind: foxglove.Channel(f"/ceres/{name}/motion", schema=MOTION_SCHEMA, context=context) for kind, name in NAMES.items()}
    diagnostic_channel = foxglove.Channel("/ceres/diagnostics", schema=DIAGNOSTIC_SCHEMA, context=context)
    typed_channels = {
        "/ceres/transforms": c.FrameTransformsChannel("/ceres/transforms", context=context),
        "/ceres/scene": c.SceneUpdateChannel("/ceres/scene", context=context),
    }
    for kind, name in NAMES.items():
        topic = f"/ceres/{name}/" + ("pose" if kind == "1" else "wrist")
        typed_channels[topic] = c.PoseInFrameChannel(topic, context=context)
    for side in (None, *CAMERA_SIDES):
        prefix = "/ceres/camera" + (f"/{side}" if side else "")
        for suffix, channel_type in (("video", c.CompressedVideoChannel), ("projection", c.CompressedImageChannel),
                                     ("calibration", c.CameraCalibrationChannel)):
            topic = f"{prefix}/{suffix}"
            typed_channels[topic] = channel_type(topic, context=context)

    def log(topic, message, **kwargs):
        typed_channels[topic].log(message, **kwargs)

    viewers = set()
    video_history = VideoHistory()
    camera_output = CameraOutput(video_history, log)
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
        previous_video = {}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(f"http://127.0.0.1:{backend.port}", protocols=("foxglove.sdk.v1",),
                                              max_msg_size=MAX_VIEWER_MESSAGE, compress=0) as back:
                    async def upstream():
                        async for message in front:
                            if message.type != aiohttp.WSMsgType.TEXT:
                                print(f"Viewer input closed: {message.type}", flush=True)
                                break
                            value = json.loads(message.data)
                            if value.get("op") not in ("subscribe", "unsubscribe"):
                                print(f"Unsupported viewer operation: {value.get('op')}", flush=True)
                                break
                            if value["op"] == "subscribe":
                                keyframe_request.set()
                                for subscription in value.get("subscriptions", []):
                                    subscriptions[subscription["id"]] = channels.get(subscription["channelId"])
                            else:
                                for subscription in value.get("subscriptionIds", []):
                                    subscriptions.pop(subscription, None)
                            await asyncio.wait_for(back.send_str(message.data), VIEWER_WRITE_TIMEOUT)

                    async def downstream():
                        async for message in back:
                            if message.type == aiohttp.WSMsgType.BINARY:
                                data = message.data
                                if len(data) > MAX_VIEWER_MESSAGE:
                                    print(f"Viewer message exceeded limit: {len(data)}", flush=True)
                                    break
                                if len(data) >= 13 and data[0] == 1:
                                    sent = struct.unpack_from("<Q", data, 5)[0]
                                    subscription = struct.unpack_from("<I", data, 1)[0]
                                    topic = subscriptions.get(subscription)
                                    if time.time_ns() - sent > VIEWER_MAX_AGE_NS:
                                        if topic in VIDEO_TOPICS:
                                            previous_video.pop(topic, None)
                                            keyframe_request.set()
                                        continue
                                    if topic in VIDEO_TOPICS and not video_history.accept(topic, sent, previous_video):
                                        keyframe_request.set()
                                        continue
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
    receivers = {}
    last_scene = 0
    last_diagnostics = 0
    metrics = StreamMetrics()
    motion = MotionSignals()
    process = ProcessMetrics()
    robot_task = None
    try:
        for camera in ("primary", *CAMERA_SIDES):
            receivers[camera] = Receiver(args.socket, video=True, encoded=True, camera=camera)
        links = connection_links(args.host, args.port)
        if getattr(args, "robot", None):
            from .foxglove_teleop import run_robot
            robot_task = asyncio.create_task(run_robot(args, stop, context=context))
            links["layout"] = links["layout"].replace("/layout.json", "/dual-arm-layout.json")
        print(f"Foxglove: {links['websocket']}", flush=True)
        print(f"Open in Foxglove: {links['open']}", flush=True)
        print(f"Import layout: {links['layout']}", flush=True)
        print(f"Import dual-camera layout: {links['dual_camera_layout']}", flush=True)
        while not stop.is_set():
            loop_started = time.monotonic_ns()
            if robot_task is not None and robot_task.done():
                robot_task.result()
            request_keyframe = keyframe_request.is_set()
            keyframe_request.clear()
            snapshots = await asyncio.gather(*(asyncio.to_thread(receiver.latest, keyframe=request_keyframe)
                                               for receiver in receivers.values()))
            snapshot = snapshots[0]
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
                    suffix = "pose" if kind == "1" else "wrist"
                    log(f"/ceres/{NAMES[kind]}/{suffix}", m.PoseInFrame(
                        timestamp=timestamp(source_time), frame_id=ORIGIN, pose=converted_pose(pose["values"])), log_time=now)
            metrics.video_bytes += camera_output.publish(snapshot, now)
            for side, camera_snapshot in zip(CAMERA_SIDES, snapshots[1:]):
                camera_output.publish(camera_snapshot, now, side)
            if now - last_scene >= 33_000_000:
                log("/ceres/transforms", transforms(snapshot, now), log_time=now)
                log("/ceres/scene", scene(snapshot, now, meshes, model_url), log_time=now)
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
        for receiver in receivers.values():
            receiver.close()
        await asyncio.gather(*(viewer.close() for viewer in list(viewers)), return_exceptions=True)
        await runner.cleanup()
        backend.stop()
        diagnostic_channel.close()
        for channel in hand_channels.values():
            channel.close()
        for channel in motion_channels.values():
            channel.close()
        for channel in typed_channels.values():
            channel.close()
