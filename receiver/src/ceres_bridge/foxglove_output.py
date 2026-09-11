"""Optional Foxglove SDK output with a bounded, expiring viewer transport."""

import asyncio
from collections import OrderedDict
import contextlib
import json
import struct
import threading
import time
from io import BytesIO
from pathlib import Path
from PIL import Image

import aiohttp
from aiohttp import web
import foxglove
from foxglove import messages as m
from foxglove.websocket import ServerListener

from .client import Receiver
from .foxglove_scene import NAMES, ORIGIN, StreamMetrics, camera_calibration, converted_pose, joints, scene, timestamp, transforms
from .foxglove_schemas import DIAGNOSTIC_SCHEMA, HAND_SCHEMA
from .foxglove_ui import LAYOUTS, connection_links, layout_bytes

MAX_VIEWERS = 4
MAX_VIEWER_MESSAGE = 3 * 1024 * 1024
VIEWER_MAX_AGE_NS = 100_000_000
VIEWER_WRITE_TIMEOUT = 0.5


class Listener(ServerListener):
    def __init__(self):
        self.keyframe = threading.Event()

    def on_subscribe(self, *_):
        self.keyframe.set()


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
    listener = Listener()
    backend = foxglove.start_server(name="CERES Bridge", host="127.0.0.1", port=0, capabilities=[],
                                   message_backlog_size=16, server_listener=listener)
    hand_channels = {kind: foxglove.Channel(f"/ceres/{NAMES[kind]}/joints", schema=HAND_SCHEMA) for kind in ("2", "3")}
    diagnostic_channel = foxglove.Channel("/ceres/diagnostics", schema=DIAGNOSTIC_SCHEMA)
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
                        async for message in front:
                            if message.type != aiohttp.WSMsgType.TEXT:
                                print(f"Viewer input closed: {message.type}", flush=True)
                                break
                            value = json.loads(message.data)
                            if value.get("op") not in ("subscribe", "unsubscribe"):
                                print(f"Unsupported viewer operation: {value.get('op')}", flush=True)
                                break
                            if value["op"] == "subscribe":
                                for subscription in value.get("subscriptions", []):
                                    subscriptions[subscription["id"]] = channels.get(subscription["channelId"])
                            else:
                                for subscription in value.get("subscriptionIds", []):
                                    subscriptions.pop(subscription, None)
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
                                        listener.keyframe.set()
                                        continue
                                    subscription = struct.unpack_from("<I", data, 1)[0]
                                    if subscriptions.get(subscription) == "/ceres/camera/video":
                                        record = video_history.get(sent)
                                        if record is None:
                                            previous_video = None
                                            listener.keyframe.set()
                                            continue
                                        sequence, keyframe = record
                                        if not keyframe and (previous_video is None or sequence != previous_video + 1):
                                            previous_video = None
                                            listener.keyframe.set()
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
    if asset_directory:
        async def quest_model(_request):
            return web.FileResponse(asset_directory / "quest-3.glb", headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "model/gltf-binary"})
        application.router.add_get("/assets/quest-3.glb", quest_model)
    runner = web.AppRunner(application, access_log=None, shutdown_timeout=1)
    await runner.setup()
    await web.TCPSite(runner, args.host, args.port).start()
    receiver = Receiver(args.socket, video=True, encoded=True)
    last_scene = 0
    last_diagnostics = 0
    metrics = StreamMetrics()
    last_projection = 0
    try:
        links = connection_links(args.host, args.port)
        print(f"Foxglove: {links['websocket']}", flush=True)
        print(f"Open in Foxglove: {links['open']}", flush=True)
        print(f"Import layout: {links['layout']}", flush=True)
        while not stop.is_set():
            request_keyframe = listener.keyframe.is_set()
            listener.keyframe.clear()
            snapshot = await asyncio.to_thread(receiver.latest, keyframe=request_keyframe)
            now = time.time_ns()
            for kind in metrics.observe(snapshot):
                component = snapshot["poses"][kind]
                pose = component["pose"]
                source_time = now + (component["received_us"] - snapshot["now_us"]) * 1000
                if kind != "1":
                    hand_channels[kind].log(joints(component), log_time=now)
                if component["tracked"] and (kind == "1" or pose["joint_mask"] & 1):
                    suffix = "pose" if kind == "1" else "wrist"
                    foxglove.log(f"/ceres/{NAMES[kind]}/{suffix}", m.PoseInFrame(
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
                        foxglove.log("/ceres/camera/video", m.CompressedVideo(timestamp=timestamp(source_time),
                            frame_id="ceres_camera_optical", format="h264", data=bytes(frame.data)), log_time=now)
                    else:
                        if now - last_projection >= 66_000_000:
                            picture = Image.frombytes("RGB", (meta["width"], meta["height"]), bytes(frame.data), "raw", "RGB", meta["stride"])
                            encoded_image = BytesIO()
                            picture.save(encoded_image, "JPEG", quality=80)
                            foxglove.log("/ceres/camera/calibration", camera_calibration(meta["width"], meta["height"], now), log_time=now)
                            foxglove.log("/ceres/camera/projection", m.CompressedImage(timestamp=timestamp(now),
                                frame_id="ceres_camera_optical", format="jpeg", data=encoded_image.getvalue()), log_time=now)
                            last_projection = now
            if now - last_scene >= 33_000_000:
                foxglove.log("/ceres/transforms", transforms(snapshot, now), log_time=now)
                foxglove.log("/ceres/scene", scene(snapshot, now, meshes, model_url), log_time=now)
                last_scene = now
            if now - last_diagnostics >= 200_000_000:
                diagnostic_channel.log(metrics.diagnostic(snapshot), log_time=now)
                for kind in ("2", "3"):
                    if not snapshot["poses"].get(kind, {}).get("tracked"):
                        hand_channels[kind].log(joints({}), log_time=now)
                last_diagnostics = now
            await asyncio.sleep(0.002)
    finally:
        receiver.close()
        await asyncio.gather(*(viewer.close() for viewer in list(viewers)), return_exceptions=True)
        await runner.cleanup()
        backend.stop()
        diagnostic_channel.close()
        for channel in hand_channels.values():
            channel.close()
