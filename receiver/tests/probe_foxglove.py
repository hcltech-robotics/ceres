"""Check advancing Foxglove topics while the native sender is running."""

import asyncio
import base64
import json
import math
import struct
import sys
import time
import aiohttp
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory


def decoder(channel):
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
        assert len(pending) < previous
    return message_factory.GetMessageClass(pool.FindMessageTypeByName(channel["schemaName"])).FromString


async def main():
    counts = {}
    subscriptions = {}
    decoders = {}
    meshes = set()
    model_url = None
    calibration = False
    projected_image = False
    joint_validity = {"left": set(), "right": set()}
    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8767", protocols=("foxglove.sdk.v1",)) as ws:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                message = await asyncio.wait_for(ws.receive(), 10)
                if message.type == aiohttp.WSMsgType.TEXT:
                    value = json.loads(message.data)
                    if value["op"] == "advertise":
                        added = []
                        for channel in value["channels"]:
                            subscriptions[channel["id"]] = channel["topic"]
                            decoders[channel["id"]] = decoder(channel)
                            if channel["topic"] == "/ceres/diagnostics":
                                assert "video_fps" in json.loads(channel["schema"])["properties"]
                            added.append({"id": channel["id"], "channelId": channel["id"]})
                        await ws.send_json({"op": "subscribe", "subscriptions": added})
                elif message.type == aiohttp.WSMsgType.BINARY:
                    if message.data[0] == 1:
                        subscription = struct.unpack_from("<I", message.data, 1)[0]
                        topic = subscriptions[subscription]
                        counts[topic] = counts.get(topic, 0) + 1
                        data = decoders[subscription](message.data[13:])
                        if topic == "/ceres/scene":
                            for entity in data.entities:
                                for model in entity.models:
                                    model_url = model.url
                                for mesh in entity.triangles:
                                    assert len(mesh.points) == 778 and len(mesh.indices) == 4614
                                    assert all(math.isfinite(getattr(point, axis)) for point in mesh.points for axis in "xyz")
                                    meshes.add(entity.id)
                        elif topic == "/ceres/camera/calibration":
                            assert data.width == 640 and data.K[0] > 0
                            calibration = True
                        elif topic == "/ceres/camera/projection":
                            assert data.format == "jpeg" and data.data[:2] == b"\xff\xd8"
                            projected_image = True
                        elif topic in ("/ceres/left/joints", "/ceres/right/joints"):
                            assert len(data["joints"]) == 25
                            joint_validity[topic.split("/")[2]].add(data["valid_joints"])
                        if (counts.get("/ceres/camera/video", 0) >= 60 and counts.get("/ceres/scene", 0) >= 60
                                and counts.get("/ceres/diagnostics", 0) >= 10
                                and counts.get("/ceres/camera/projection", 0) >= 20
                                and counts.get("/ceres/head/pose", 0) >= 60
                                and counts.get("/ceres/left/wrist", 0) >= 1
                                and counts.get("/ceres/right/wrist", 0) >= 1
                                and meshes == {"left", "right"} and model_url and calibration and projected_image):
                            async with http.get(model_url, headers={"Range": "bytes=0-11"}) as response:
                                assert response.status == 206
                                assert (await response.read())[:4] == b"glTF"
                            print(json.dumps({"foxglove_topics": counts, "hand_meshes": sorted(meshes),
                                "quest_model": "GLB served", "projection": "JPEG with camera preset",
                                "joint_validity": {side: sorted(values) for side, values in joint_validity.items()}}), flush=True)
                            return
                else:
                    raise RuntimeError(f"Foxglove connection closed: {message.type}, topics={counts}")
    raise RuntimeError(f"Foxglove acceptance incomplete: topics={counts}, meshes={sorted(meshes)}, joints={joint_validity}")


asyncio.run(main())
