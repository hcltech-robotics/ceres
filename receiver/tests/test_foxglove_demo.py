"""Exercise the dual-arm dashboard through its real Foxglove WebSocket transport."""

import asyncio
import base64
from collections import defaultdict
from contextlib import AsyncExitStack
import json
import math
import signal
import socket
import struct
import sys
import time
from types import SimpleNamespace

import pytest

pytest.importorskip("foxglove")
aiohttp = pytest.importorskip("aiohttp")
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

from ceres_bridge import foxglove_output, foxglove_teleop


class _Frame:
    def __init__(self, number, now_us, side):
        self.metadata = {"width": 96, "height": 64, "stride": 288,
                         "received_us": now_us, "generation": number, "side": side, "epoch": 1}
        self.data = bytes((number % 256, 80 if side == "left" else 160, 160)) * (96 * 64)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class _GeneratedReceiver:
    """Independent latest-sample consumers with moving wrists and RGB frames."""

    def __init__(self, _socket=None, *, video=False, encoded=False, camera="primary"):
        self.started = time.monotonic()
        self.video = video
        self.camera = camera
        self.keyframe_requests = 0
        self.last_frame = -1
        self.closed = False

    def latest(self, *, keyframe=False):
        self.keyframe_requests += int(keyframe)
        elapsed = time.monotonic() - self.started
        now_us = time.monotonic_ns() // 1000
        sequence = int(elapsed * 90)
        frame_number = int(elapsed * 30)
        poses = {}
        for kind, side in (("1", 0), ("2", -1), ("3", 1)):
            phase = elapsed * 2.5 + side * .6
            angle = .15 * math.sin(phase)
            quaternion = [0, math.sin(angle / 2), 0, math.cos(angle / 2)]
            position = [side * .25 + .025 * math.sin(phase),
                        1.2 + .02 * math.sin(phase * .8),
                        -.35 + .03 * math.cos(phase)]
            values = position + quaternion
            if kind != "1":
                values = [value for joint in range(25)
                          for value in [position[0] + joint * .004, position[1],
                                        position[2] - joint * .002, *quaternion, .008]]
            tracked = kind == "1" or not .8 <= elapsed < 1.05
            poses[kind] = {"tracked": tracked, "fresh": tracked, "age_us": 0,
                           "received_us": now_us,
                           "pose": {"sequence": sequence, "joint_mask": (1 << 25) - 1,
                                    "values": values}}
        frame = None
        if self.video and frame_number != self.last_frame:
            frame = _Frame(frame_number, now_us, "right" if self.camera == "primary" else self.camera)
            self.last_frame = frame_number
        return {"connection": "connected", "epoch": 1, "space_epoch": 1,
                "now_us": now_us, "codec": "vp8", "poses": poses,
                "counts": {"frames": frame_number, "received": sequence,
                           **dict.fromkeys(("rejected", "gaps", "late", "future",
                                            "duplicate", "malformed"), 0)},
                "clock": {"uncertainty_us": 100},
                "description": {"camera": {"side": "right", "width": 96, "height": 64},
                                "cameras": [{"side": side, "width": 96, "height": 64} for side in ("right", "left")]},
                "frame": frame, "encoded": None}

    def close(self):
        self.closed = True


def _decoder(channel):
    if channel["encoding"] == "json":
        return json.loads
    descriptors = descriptor_pb2.FileDescriptorSet.FromString(base64.b64decode(channel["schema"]))
    pool = descriptor_pool.DescriptorPool()
    pending = list(descriptors.file)
    while pending:
        previous = len(pending)
        for descriptor in list(pending):
            try:
                pool.Add(descriptor)
                pending.remove(descriptor)
            except TypeError:
                pass
        assert len(pending) < previous, "Advertised Protobuf dependencies did not resolve"
    return message_factory.GetMessageClass(pool.FindMessageTypeByName(channel["schemaName"])).FromString


def _assert_plot_paths(layout, schemas, messages):
    checked = set()
    for identifier, panel in layout["configById"].items():
        if not identifier.startswith("Plot!"):
            continue
        for path in panel["paths"]:
            value = path["value"]
            topic = next((topic for topic in schemas if value.startswith(topic + ".")), None)
            assert topic is not None, f"Plot topic was not advertised: {value}"
            fields = value[len(topic) + 1:].split(".")
            schema = schemas[topic]
            for field in fields:
                assert field in schema.get("properties", {}), f"Plot field is absent from its schema: {value}"
                schema = schema["properties"][field]
            types = schema.get("type", [])
            assert "number" in types or "integer" in types, f"Plot is not a scalar number: {value}"
            samples = []
            for message in messages[topic]:
                sample = message
                for field in fields:
                    sample = sample[field]
                if sample == "NaN":
                    assert schema["type"] == "number", value
                elif sample is not None:
                    samples.append(sample)
            assert samples and all(isinstance(sample, (int, float)) and math.isfinite(sample)
                                   for sample in samples), f"Plot has no finite numeric samples: {value}"
            checked.add(value)
    assert len(checked) >= (40 if "3D!robot" in layout["configById"] else 30)


async def _assert_robot_models(session, endpoint, geometry):
    assert len(geometry) >= 10
    entities = {entity.id: entity for entity in geometry[-1].entities}
    assert len(entities) == len(geometry[-1].entities)
    models = [entity for entity in entities.values() if entity.models]
    assert len(models) == 20
    assert {"robot/Upper_Arm", "robot/Upper_Arm_2", "robot/base_link"} <= entities.keys()
    urls = set()
    for entity in models:
        assert entity.id.startswith("robot/") and entity.frame_id == "ceres_robot_base"
        assert not entity.lines and not entity.spheres and not entity.cubes
        assert len(entity.models) == 1
        model = entity.models[0]
        assert all(math.isfinite(getattr(model.pose.position, axis)) for axis in "xyz")
        assert sum(getattr(model.pose.orientation, axis) ** 2 for axis in "xyzw") == pytest.approx(1)
        assert all(math.isfinite(getattr(model.scale, axis)) and getattr(model.scale, axis) > 0 for axis in "xyz")
        assert model.media_type == "model/gltf-binary" and not model.data
        assert model.url.startswith(endpoint + "/assets/xlerobot/") and model.url.endswith(".glb")
        urls.add(model.url)
    assert len(urls) == 12

    async def validate_asset(url):
        async with session.get(url) as response:
            assert response.status == 200
            assert response.content_type == "model/gltf-binary"
            assert response.headers["Access-Control-Allow-Origin"] == "*"
            assert "immutable" in response.headers["Cache-Control"]
            assert "max-age=" in response.headers["Cache-Control"]
            data = await response.read()
        assert len(data) >= 28
        magic, version, length = struct.unpack_from("<4sII", data)
        assert (magic, version, length) == (b"glTF", 2, len(data))
        json_length, chunk_type = struct.unpack_from("<II", data, 12)
        assert chunk_type == 0x4E4F534A
        model = json.loads(data[20:20 + json_length])
        assert model["asset"]["version"] == "2.0" and model["meshes"]
        assert all("POSITION" in primitive["attributes"] for mesh in model["meshes"]
                   for primitive in mesh["primitives"])

    await asyncio.gather(*(validate_asset(url) for url in sorted(urls)))
    for name in ("unknown.glb", "manifest.json", "%2e%2e%2fposes.json", "%2e%2e%5cposes.json"):
        async with session.get(endpoint + "/assets/xlerobot/" + name) as response:
            assert response.status == 404


@pytest.mark.skipif(sys.platform != "linux", reason="The Bridge receiver runtime uses Linux")
@pytest.mark.parametrize("_run", range(3))
def test_dual_arm_dashboard_streams_moving_waveforms_geometry_and_measured_load(monkeypatch, _run):
    consumers = []

    def reject_global_lookup(*_args, **_kwargs):
        pytest.fail("Streaming must use its registered Foxglove channels")

    def receiver(*args, **kwargs):
        consumer = _GeneratedReceiver(*args, **kwargs)
        consumers.append(consumer)
        return consumer

    monkeypatch.setattr(foxglove_output, "Receiver", receiver)
    monkeypatch.setattr(foxglove_teleop, "Receiver", receiver)
    monkeypatch.setattr(foxglove_output.foxglove, "log", reject_global_lookup)

    async def exercise():
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        args = SimpleNamespace(socket=None, host="127.0.0.1", port=port, assets=None,
                               robot="xlerobot", retargeter="cpu", position_scale=.6, robot_rate=60,
                               robot_origin=(0.0, 0.0, 0.0), robot_yaw=0.0)
        callbacks = {}
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(loop, "add_signal_handler", lambda name, callback: callbacks.update({name: callback}))
        running = asyncio.create_task(foxglove_output.run(args))
        messages = defaultdict(list)
        schemas, channels, decoders = {}, {}, {}
        endpoint = f"http://127.0.0.1:{port}"
        try:
            async with aiohttp.ClientSession() as session:
                deadline = time.monotonic() + 5
                while True:
                    if running.done():
                        await running
                        pytest.fail("Foxglove stopped before the dashboard connected")
                    try:
                        websocket = await session.ws_connect(endpoint, protocols=("foxglove.sdk.v1",))
                        break
                    except aiohttp.ClientConnectorError:
                        assert time.monotonic() < deadline, "Foxglove did not start within five seconds"
                        await asyncio.sleep(.02)
                async with AsyncExitStack() as connection:
                    connection.push_async_callback(websocket.close)
                    started = time.monotonic()
                    while time.monotonic() - started < 2.5:
                        if running.done():
                            await running
                        message = await asyncio.wait_for(websocket.receive(), 3)
                        if message.type == aiohttp.WSMsgType.TEXT:
                            payload = json.loads(message.data)
                            if payload["op"] == "advertise":
                                subscriptions = []
                                for channel in payload["channels"]:
                                    identifier = channel["id"]
                                    channels[identifier] = channel["topic"]
                                    decoders[identifier] = _decoder(channel)
                                    if channel["encoding"] == "json":
                                        schemas[channel["topic"]] = json.loads(channel["schema"])
                                    subscriptions.append({"id": identifier, "channelId": identifier})
                                await websocket.send_json({"op": "subscribe", "subscriptions": subscriptions})
                        elif message.type == aiohttp.WSMsgType.BINARY and message.data[0] == 1:
                            identifier = struct.unpack_from("<I", message.data, 1)[0]
                            topic = channels[identifier]
                            messages[topic].append(decoders[identifier](message.data[13:]))
                        else:
                            pytest.fail(f"Foxglove closed during dashboard acquisition: {message.type}")

                    for side in ("left", "right"):
                        motion = messages[f"/ceres/{side}/motion"]
                        gaps = [index for index, sample in enumerate(motion) if not sample["tracked"]]
                        assert gaps, f"{side} tracking loss did not reach the motion topic"
                        gap_index = gaps[0]
                        assert any(sample["tracked"] for sample in motion[:gap_index])
                        assert any(sample["tracked"] for sample in motion[gap_index + 1:])
                        for group in ("position", "rotation"):
                            assert set(motion[gap_index][group].values()) == {"NaN"}
                        samples = [sample for sample in motion if sample["tracked"]]
                        assert len(samples) >= 20
                        for group, fields in (("position", "xyz"), ("rotation", ("roll", "pitch", "yaw"))):
                            variation = [max(sample[group][axis] for sample in samples)
                                         - min(sample[group][axis] for sample in samples) for axis in fields]
                            assert max(variation) > .01, f"{side} {group} waveform did not move"
                        joints = messages["/ceres/robot/joints"]
                        assert len(joints) >= 20
                        assert any(max(sample[side][joint] for sample in joints)
                                   - min(sample[side][joint] for sample in joints) > .005
                                   for joint in ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"))

                    await _assert_robot_models(session, endpoint, messages["/ceres/robot/scene"])
                    assert len(messages["/ceres/scene"]) >= 10
                    images = messages["/ceres/camera/projection"]
                    assert len(images) >= 10 and images[-1].data.startswith(b"\xff\xd8")
                    assert images[-1].format == "jpeg"
                    for side in ("left", "right"):
                        topic = f"/ceres/camera/{side}"
                        images = messages[topic + "/projection"]
                        assert len(images) >= 10 and images[-1].data.startswith(b"\xff\xd8")
                        assert images[-1].frame_id == f"ceres_camera_{side}_optical"
                        calibration = messages[topic + "/calibration"][-1]
                        assert calibration.frame_id == images[-1].frame_id
                        assert (calibration.width, calibration.height) == (96, 64)
                    assert messages["/ceres/camera/left/projection"][-1].data != messages["/ceres/camera/right/projection"][-1].data
                    diagnostics = messages["/ceres/diagnostics"]
                    assert len(diagnostics) >= 5
                    for field in ("video_fps", "motion_fps", "left_fps", "right_fps", "process_cpu_percent", "process_rss_mb", "loop_ms"):
                        assert all(isinstance(sample[field], (int, float)) and math.isfinite(sample[field])
                                   for sample in diagnostics)
                        assert max(sample[field] for sample in diagnostics) > 0, field
                    assert max(sample["update_fps"] for sample in messages["/ceres/robot/diagnostics"]) > 0

                    for name in ("layout.json", "vp8-layout.json", "dual-arm-layout.json", "dual-arm-vp8-layout.json",
                                 "dual-camera-layout.json", "dual-camera-vp8-layout.json"):
                        async with session.get(f"{endpoint}/layouts/{name}") as response:
                            assert response.status == 200
                            layout = await response.json()
                        _assert_plot_paths(layout, schemas, messages)
        finally:
            if signal.SIGTERM in callbacks:
                callbacks[signal.SIGTERM]()
            await asyncio.wait_for(running, 5)

    asyncio.run(asyncio.wait_for(exercise(), 15))
    assert len(consumers) == 4 and all(consumer.closed for consumer in consumers)
    assert {consumer.camera for consumer in consumers if consumer.video} == {"primary", "left", "right"}
    assert all(consumer.keyframe_requests for consumer in consumers if consumer.video)
