"""Receiver restart recovery over Unix sockets and bounded asynchronous polling."""

import asyncio
import json
import threading
import time

import numpy as np
import pytest

from ceres_bridge import client
from ceres_bridge.foxglove_receiver import FoxgloveReceiver
from ceres_bridge.foxglove_scene import StreamMetrics
from ceres_bridge.foxglove_signals import MotionSignals
from ceres_bridge.teleop import DualArmTeleop


def snapshot(sequence=1, position=.2):
    now = time.monotonic_ns() // 1000
    return {"version": 1, "epoch": 1, "space_epoch": 1, "connection": "connected",
            "now_us": now, "codec": "h264", "clock": None, "description": None,
            "counts": {"frames": 1}, "frame": None, "encoded": None, "audio": None,
            "poses": {"3": {"fresh": True, "tracked": True, "age_us": 0,
                             "received_us": now, "pose": {"sequence": sequence,
                             "joint_mask": 1, "values": [position, 1, -.4, 0, 0, 0, 1, .01] * 25}}}}


async def until_connected(receiver):
    for _ in range(500):
        value = await receiver.latest()
        if value["connection"] == "connected":
            return value
        await asyncio.sleep(.002)
    raise AssertionError("Receiver did not reconnect")


def test_socket_restart_replaces_mmaps_and_leases_and_requests_a_keyframe(tmp_path):
    async def exercise():
        path = tmp_path / "receiver.sock"
        mappings = [tmp_path / "first.bin", tmp_path / "second.bin"]
        for index, mapping in enumerate(mappings):
            mapping.write_bytes(bytes((10 + index,)) * 64)
        requests, writers, handlers = [], [], set()

        async def serve(reader, writer, generation):
            handlers.add(asyncio.current_task())
            writers.append(writer)
            delivered = False
            try:
                while raw := await reader.readline():
                    request = json.loads(raw)
                    requests.append((generation, request))
                    if request["op"] == "subscribe":
                        result = {"version": 1, "path": str(mappings[generation]), "size": 64,
                                  "encoded_path": str(mappings[generation]), "encoded_size": 64}
                    else:
                        result = snapshot()
                        if not delivered:
                            metadata = {"epoch": 1, "slot": 0, "offset": 0, "bytes": 8,
                                        "received_us": result["now_us"], "keyframe": True}
                            result.update(frame=metadata, encoded=metadata)
                            delivered = True
                    writer.write(json.dumps(result).encode() + b"\n")
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                handlers.discard(asyncio.current_task())

        receiver = FoxgloveReceiver(path, encoded=True, retry_delay=.025)
        server = await asyncio.start_unix_server(lambda r, w: serve(r, w, 0), path)
        try:
            first = await until_connected(receiver)
            old = receiver.receiver
            old_mapping = old.memory
            with first["frame"] as frame, first["encoded"] as video:
                assert bytes(frame.data) == bytes((10,)) * 8
                assert bytes(video.data) == bytes((10,)) * 8
            server.close()
            for writer in writers:
                writer.close()
                await writer.wait_closed()
            await server.wait_closed()
            for _ in range(20):
                lost = await receiver.latest()
                if receiver.receiver is None:
                    break
                await asyncio.sleep(.002)
            assert lost["connection"] == "disconnected"
            assert lost["poses"] == {}
            assert all(lost[kind] is None for kind in ("frame", "encoded", "audio"))
            assert old_mapping.closed and old.memory is None
            path.unlink(missing_ok=True)
            server = await asyncio.start_unix_server(lambda r, w: serve(r, w, 1), path)
            second = await until_connected(receiver)
            assert second["ipc_generation"] == first["ipc_generation"] + 1
            assert (second["epoch"], second["space_epoch"]) == (first["epoch"], first["space_epoch"])
            assert receiver.receiver is not old
            with second["frame"] as frame, second["encoded"] as video:
                assert bytes(frame.data) == bytes((11,)) * 8
                assert bytes(video.data) == bytes((11,)) * 8
            new_latest = next(request for generation, request in requests
                              if generation == 1 and request["op"] == "latest")
            assert new_latest["release"] == new_latest["encoded_release"] == []
            assert new_latest["keyframe"] is True
        finally:
            await receiver.close()
            server.close()
            await server.wait_closed()
            await asyncio.gather(*handlers, return_exceptions=True)
    asyncio.run(asyncio.wait_for(exercise(), 5))


def test_missing_receiver_retries_at_a_bounded_rate_and_never_blocks_polling():
    calls = []

    def unavailable(*args, **kwargs):
        calls.append(time.monotonic())
        raise FileNotFoundError("receiver is restarting")

    async def exercise():
        receiver = FoxgloveReceiver(factory=unavailable, retry_delay=.1)
        try:
            started = time.monotonic()
            while time.monotonic() - started < .25:
                before = time.monotonic()
                assert (await receiver.latest())["connection"] == "disconnected"
                assert time.monotonic() - before < .05
                await asyncio.sleep(.002)
            assert 2 <= len(calls) <= 3
            assert all(b-a >= .1 for a, b in zip(calls, calls[1:]))
        finally:
            await receiver.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("error", [client.IPCProtocolError("bad framing"), ValueError("bad JSON"),
                                 TypeError("implementation failure")])
def test_protocol_and_implementation_errors_do_not_retry(error):
    calls = []

    def broken(*args, **kwargs):
        calls.append(True)
        raise error

    async def exercise():
        receiver = FoxgloveReceiver(factory=broken)
        try:
            await receiver.latest()
            await asyncio.sleep(.01)
            with pytest.raises(type(error)):
                await receiver.latest()
            assert len(calls) == 1
        finally:
            await receiver.close()
    asyncio.run(exercise())


def test_pending_read_keeps_loss_updates_responsive_and_revalidates_delayed_data():
    entered, finish = threading.Event(), threading.Event()

    class SlowReceiver:
        closed = False
        reads = 0

        def __init__(self, *args, **kwargs):
            pass

        def latest(self, **kwargs):
            self.reads += 1
            value = snapshot()
            entered.set()
            finish.wait(1)
            return value

        def close(self):
            self.closed = True

    async def exercise():
        receiver = FoxgloveReceiver(factory=SlowReceiver)
        try:
            await receiver.latest()
            await asyncio.sleep(.01)
            assert (await receiver.latest())["connection"] == "disconnected"
            assert entered.is_set()
            for _ in range(3):
                before = time.monotonic()
                assert (await receiver.latest())["poses"] == {}
                assert time.monotonic()-before < .05
            assert receiver.receiver.reads == 1
            await asyncio.sleep(.06)
            finish.set()
            await asyncio.sleep(.01)
            stale = await receiver.latest()
            assert stale["poses"]["3"]["pose"] is None
            assert stale["poses"]["3"]["tracked"] is False
        finally:
            finish.set()
            inner = receiver.receiver
            await receiver.close()
            assert inner.closed
    asyncio.run(exercise())


def test_shutdown_joins_a_pending_constructor_before_closing_its_connection():
    entered, finish = threading.Event(), threading.Event()
    created = []

    class DelayedReceiver:
        closed = False

        def __init__(self, *args, **kwargs):
            created.append(self)
            entered.set()
            finish.wait(1)

        def close(self):
            self.closed = True

    async def exercise():
        receiver = FoxgloveReceiver(factory=DelayedReceiver)
        await receiver.latest()
        await asyncio.to_thread(entered.wait, 1)
        closing = asyncio.create_task(receiver.close())
        await asyncio.sleep(.01)
        assert not closing.done()
        finish.set()
        await asyncio.wait_for(closing, .2)
        assert created[0].closed
        await receiver.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("response", [b"[]\n", b"{bad}\n", b'{"version":2}\n', b"x" * 32_769])
def test_failed_subscribe_closes_partial_resources_and_preserves_protocol_errors(tmp_path, response):
    async def exercise():
        path = tmp_path / "receiver.sock"

        async def serve(reader, writer):
            await reader.readline()
            writer.write(response)
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_unix_server(serve, path)
        receiver = client.Receiver.__new__(client.Receiver)
        try:
            with pytest.raises((client.IPCProtocolError, ValueError)):
                await asyncio.to_thread(receiver.__init__, path, video=False)
            assert receiver.socket is None and receiver.stream is None
            assert receiver.memory is None and receiver.mapping_file is None
            receiver.close()
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(asyncio.wait_for(exercise(), 2))


def test_delivery_expiry_releases_every_media_lease_and_requests_encoded_recovery():
    receiver = client.Receiver.__new__(client.Receiver)
    receiver.releases, receiver.encoded_releases, receiver.audio_releases = [], [], []
    value = snapshot()
    old = {"received_us": value["now_us"] - 100_001, "epoch": 1, "slot": 0}
    value["frame"] = client.Frame(receiver, old)
    value["encoded"] = client.Frame(receiver, old, encoded=True)
    value["audio"] = client.Frame(receiver, old, audio=True)
    assert client.expire_snapshot(value, now_us=value["now_us"])
    assert all(value[kind] is None for kind in ("frame", "encoded", "audio"))
    assert receiver.releases == receiver.encoded_releases == receiver.audio_releases == [0]
    assert not client.expire_snapshot(value, now_us=value["now_us"])


def test_generation_reaccepts_repeated_sequences_resets_rates_and_preserves_neutral_return():
    motion, rates, robot = MotionSignals(), StreamMetrics(), DualArmTeleop()
    first = {**snapshot(sequence=50), "ipc_generation": 1}
    motion.observe(first)
    rates.observe(first)
    robot.update(first, now_ns=1_000_000_000)
    lost = {**first, "poses": {}, "connection": "disconnected"}
    result = robot.update(lost, now_ns=1_100_000_000)
    assert result["arms"]["right"]["status"] == "coasting"
    result = robot.update(lost, now_ns=1_600_000_000)
    assert result["arms"]["right"]["status"] in ("returning", "neutral")
    second = {**snapshot(sequence=1, position=.1), "ipc_generation": 2}
    rates.frames = 1000
    rates.rates["video_fps"] = 60
    rates.video_bytes = 5000
    assert motion.observe(second)["3"]["tracked"] is False
    assert motion.observe(second)["3"]["tracked"] is True
    assert rates.observe(second) == ["3"]
    assert rates.frames == 1 and rates.video_bytes == 0
    assert all(value == 0 for value in rates.rates.values())
    before = robot.arms["right"].q.copy()
    robot.update(second, now_ns=1_616_666_667)
    assert robot.arms["right"].sequence == 1
    assert np.max(np.abs(robot.arms["right"].q - before)) <= robot.max_joint_speed / 60 + 1e-8
