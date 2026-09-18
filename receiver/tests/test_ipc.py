import unittest
import asyncio
import errno
import json
import mmap
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

from ceres_bridge import ipc
from ceres_bridge.ipc import AudioMailbox, Broker, EncodedMailbox, FrameMailbox, MAX_AUDIO_BYTES, MAX_FRAME_BYTES, peer_uid
from ceres_bridge.client import Receiver
from ceres_bridge.state import LatestState


class MailboxTests(unittest.TestCase):
    def test_encoded_recovery_requests_only_the_affected_camera(self):
        broker = Broker(LatestState())
        broker.encoded = {1: EncodedMailbox(), 2: EncodedMailbox(), 3: EncodedMailbox()}
        broker.cameras = {1: "primary", 2: "right", 3: "left"}
        requests = []
        broker.request_keyframe = requests.append
        try:
            broker.publish_encoded(b"delta", False, 1, 0, camera={"side": "left", "mid": "1", "primary": False})
            self.assertEqual(requests, ["left"])
            requests.clear()
            broker.publish_encoded(b"delta", False, 1, 0, camera={"side": "right", "mid": "0", "primary": True})
            self.assertCountEqual(requests, ["primary", "right"])
        finally:
            for box in broker.encoded.values():
                box.close()

    def test_camera_routing_keeps_raw_and_encoded_leases_independent(self):
        broker = Broker(LatestState())
        broker.consumers = {identity: FrameMailbox() for identity in (1, 2, 3)}
        broker.encoded = {identity: EncodedMailbox() for identity in (1, 2, 3)}
        broker.cameras = {1: "primary", 2: "right", 3: "left"}
        right = {"side": "right", "mid": "0", "primary": True}
        left = {"side": "left", "mid": "1", "primary": False}
        try:
            for camera, data in ((right, b"red"), (left, b"blu")):
                broker.publish_frame(data, 1, 1, 3, 1, camera=camera)
                broker.publish_encoded(data, True, 1, 0, camera=camera)
            for identity, side, data in ((1, "right", b"red"), (2, "right", b"red"), (3, "left", b"blu")):
                for box in (broker.consumers[identity], broker.encoded[identity]):
                    self.assertEqual(box.latest["side"], side)
                    self.assertEqual(box.memory[:3], data)
            stalled = broker.consumers[3]
            stalled.leased.update((0, 1))
            for _ in range(3):
                broker.publish_frame(b"new", 1, 1, 3, 1, camera=left)
                broker.publish_frame(b"rgb", 1, 1, 3, 1, camera=right)
            self.assertEqual(stalled.drops, 3)
            self.assertEqual(broker.consumers[1].generation, 4)
            self.assertEqual(broker.consumers[2].generation, 4)
            broker.reset()
            self.assertTrue(all(box.latest is None for box in broker.consumers.values()))
            self.assertTrue(all(box.needs_keyframe for box in broker.encoded.values()))
        finally:
            for box in (*broker.consumers.values(), *broker.encoded.values()):
                box.close()

    def test_audio_leases_are_bounded_and_expire(self):
        box = AudioMailbox()
        try:
            box.publish_audio(b"\x01\x00" * 960, 10, 1, 0)
            first = box.acquire(10)
            self.assertEqual(first["samples"], 960)
            self.assertEqual(first["sample_rate"], 48_000)
            self.assertEqual(first["format"], "S16LE")
            box.publish_audio(b"\x02\x00" * 960, 20, 1, 1)
            second = box.acquire(20)
            box.publish_audio(b"\x03\x00" * 960, 30, 1, 2)
            self.assertEqual(box.drops, 1)
            self.assertEqual(box.memory[first["offset"]:first["offset"] + 2], b"\x01\x00")
            self.assertEqual(len(box.memory), 2 * MAX_AUDIO_BYTES)
            box.leased.remove(second["slot"])
            box.publish_audio(b"\x04\x00" * 960, 40, 1, 3)
            self.assertIsNone(box.acquire(100_041))
            broker = Broker(LatestState())
            broker.audio[1] = box
            broker.reset()
            self.assertIsNone(box.latest)
        finally:
            box.close()

    def test_two_leases_protect_frames_and_stall_is_private(self):
        broker = Broker(LatestState())
        first, second = FrameMailbox(), FrameMailbox()
        broker.consumers = {1: first, 2: second}
        try:
            first.publish(b"abc", 1, 1, 3, 100, 1, 0)
            lease0 = first.acquire(100)
            first.publish(b"def", 1, 1, 3, 101, 1, 1)
            lease1 = first.acquire(101)
            self.assertNotEqual(lease0["slot"], lease1["slot"])
            for _ in range(100):
                broker.publish_frame(b"xyz", 1, 1, 3, 1)
            self.assertEqual(first.memory[lease0["offset"]:lease0["offset"] + 3], b"abc")
            self.assertEqual(first.memory[lease1["offset"]:lease1["offset"] + 3], b"def")
            self.assertEqual(first.drops, 100)
            self.assertEqual(second.generation, 100)
            self.assertEqual(len(first.memory), 2 * MAX_FRAME_BYTES)
            first.leased.remove(lease0["slot"])
            first.publish(b"new", 1, 1, 3, 200, 1, 2)
            self.assertEqual(first.acquire(200)["generation"], 3)
        finally:
            first.close()
            second.close()

    def test_stale_frame_is_unavailable(self):
        box = FrameMailbox()
        try:
            box.publish(b"rgb", 1, 1, 3, 1, 1, 0)
            self.assertIsNone(box.acquire(100_002))
        finally:
            box.close()

    def test_encoded_loss_and_age_require_a_new_keyframe(self):
        box = EncodedMailbox()
        try:
            self.assertFalse(box.publish_access_unit(b"delta", False, 1, 1, 0))
            self.assertTrue(box.publish_access_unit(b"key", True, 1, 1, 0))
            self.assertIsNone(box.acquire(100_002))
            self.assertTrue(box.needs_keyframe)
            self.assertFalse(box.publish_access_unit(b"delta", False, 100_003, 1, 1))
            self.assertTrue(box.publish_access_unit(b"new-key", True, 100_004, 1, 2))
            lease = box.acquire(100_004)
            self.assertTrue(lease["keyframe"])
            self.assertTrue(box.publish_access_unit(b"delta", False, 100_005, 1, 3))
            self.assertFalse(box.publish_access_unit(b"lost", False, 100_006, 1, 4))
            self.assertIsNone(box.acquire(100_006))
            self.assertEqual(box.memory[lease["offset"]:lease["offset"] + lease["bytes"]], b"new-key")
        finally:
            box.close()


class CameraSubscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_camera_selection_reaches_python_frames_over_real_ipc(self):
        state = LatestState()
        state.reset(1)
        broker = Broker(state)
        keyframe_requests = []
        broker.request_keyframe = keyframe_requests.append
        with tempfile.TemporaryDirectory(prefix="ceres-camera-", dir="/tmp") as directory:
            path = str(Path(directory) / "receiver.sock")
            server = await asyncio.start_unix_server(broker.handle, path)
            primary = left = None
            try:
                primary = await asyncio.to_thread(Receiver, path, encoded=True)
                left = await asyncio.to_thread(Receiver, path, camera="left", encoded=True)
                self.assertEqual(keyframe_requests, ["primary", "left"])
                for side, mid, data in (("left", "1", b"blu"), ("right", "0", b"red")):
                    camera = {"side": side, "mid": mid, "primary": side == "right"}
                    broker.publish_frame(data, 1, 1, 3, 1, camera=camera)
                    broker.publish_encoded(data, True, 1, 0, camera=camera)
                for receiver, side, mid, data in ((primary, "right", "0", b"red"), (left, "left", "1", b"blu")):
                    sample = await asyncio.to_thread(receiver.latest)
                    for key in ("frame", "encoded"):
                        with sample[key] as frame:
                            self.assertEqual(frame.metadata["side"], side)
                            self.assertEqual(frame.metadata["mid"], mid)
                            self.assertEqual(bytes(frame.data), data)
                    await asyncio.to_thread(receiver.latest)
                self.assertEqual(len(broker.consumers), 2)
                self.assertEqual(sum(len(box.memory) for box in broker.consumers.values()), MAX_FRAME_BYTES * 4)
            finally:
                for receiver in (primary, left):
                    if receiver:
                        receiver.close()
                server.close()
                await server.wait_closed()
                await asyncio.sleep(0)

    def test_invalid_camera_is_rejected_before_connecting(self):
        with self.assertRaisesRegex(ValueError, "primary, left or right"):
            Receiver("/does-not-exist", camera="both")


class PortableMailboxTests(unittest.TestCase):
    def named_mailbox(self, directory):
        with patch("ceres_bridge.ipc.sys.platform", "darwin"), patch(
                "ceres_bridge.ipc.runtime_dir", return_value=Path(directory)):
            return FrameMailbox(capacity=16)

    def test_named_mapping_is_private_and_survives_unlink(self):
        with tempfile.TemporaryDirectory(prefix="ceres-map-", dir="/tmp") as directory:
            box = self.named_mailbox(directory)
            path = Path(box.path)
            try:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(path.stat().st_uid, os.getuid())
                with open(path, "rb") as client_file, mmap.mmap(
                        client_file.fileno(), 32, access=mmap.ACCESS_READ) as client_memory:
                    box.unlink()
                    self.assertFalse(path.exists())
                    box.publish(b"rgb", 1, 1, 3, 1, 1, 0)
                    self.assertEqual(client_memory[:3], b"rgb")
                    box.close()
                    self.assertEqual(client_memory[:3], b"rgb")
            finally:
                box.close()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_close_removes_a_mapping_before_client_acknowledgement(self):
        with tempfile.TemporaryDirectory(prefix="ceres-map-", dir="/tmp") as directory:
            box = self.named_mailbox(directory)
            path = Path(box.path)
            self.assertTrue(path.exists())
            box.close()
            self.assertFalse(path.exists())

    def test_failed_mapping_allocation_removes_its_file(self):
        with tempfile.TemporaryDirectory(prefix="ceres-map-", dir="/tmp") as directory:
            with patch("ceres_bridge.ipc.mmap.mmap", side_effect=OSError("mapping failed")):
                with self.assertRaisesRegex(OSError, "mapping failed"):
                    self.named_mailbox(directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_native_peer_credentials_match_the_connected_user(self):
        first, second = socket.socketpair()
        with first, second:
            self.assertEqual(peer_uid(first), os.getuid())
            self.assertEqual(peer_uid(second), os.getuid())

    def test_macos_credential_failure_keeps_the_native_error(self):
        getpeereid = Mock(return_value=-1)
        with patch("ceres_bridge.ipc.sys.platform", "darwin"), patch(
                "ceres_bridge.ipc.ctypes.CDLL", return_value=SimpleNamespace(getpeereid=getpeereid)), patch(
                "ceres_bridge.ipc.ctypes.get_errno", return_value=errno.EBADF):
            with self.assertRaises(OSError) as caught:
                peer_uid(Mock())
        self.assertEqual(caught.exception.errno, errno.EBADF)


PROCESS_CLIENT = r'''
import json
import sys
from ceres_bridge.client import Receiver

def contents(bundle):
    return {kind: bytes(frame.data).hex() for kind, frame in bundle.items()}

with Receiver(sys.argv[1], encoded=True, audio=True) as receiver:
    leases = []
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        operation = json.loads(line)
        if operation == "take":
            sample = receiver.latest()
            bundle = {kind: sample[kind] for kind in ("frame", "encoded", "audio")}
            leases.append(bundle)
            result = contents(bundle)
        elif operation == "inspect":
            result = [contents(bundle) for bundle in leases]
        elif operation == "release":
            for bundle in leases:
                for frame in bundle.values():
                    frame.release()
            leases.clear()
            receiver.latest()
            result = {"released": True}
        print(json.dumps(result), flush=True)
'''


class PortableBrokerTests(unittest.IsolatedAsyncioTestCase):
    async def test_foreign_user_is_rejected_before_subscription(self):
        broker = Broker(LatestState())
        with tempfile.TemporaryDirectory(prefix="ceres-auth-", dir="/tmp") as directory:
            path = str(Path(directory) / "receiver.sock")
            server = await asyncio.start_unix_server(broker.handle, path)
            try:
                with patch("ceres_bridge.ipc.peer_uid", return_value=os.getuid() + 1):
                    reader, writer = await asyncio.open_unix_connection(path)
                    try:
                        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
                        self.assertEqual(broker.consumers, {})
                    finally:
                        writer.close()
                        await writer.wait_closed()
            finally:
                server.close()
                await server.wait_closed()

    async def test_independent_process_maps_leases_and_disconnect_cleanup(self):
        state = LatestState()
        state.reset(1)
        broker = Broker(state)
        with tempfile.TemporaryDirectory(prefix="ceres-process-", dir="/tmp") as directory:
            path = str(Path(directory) / "receiver.sock")
            server = await asyncio.start_unix_server(broker.handle, path)
            environment = {**os.environ, "PYTHONPATH": str(Path(ipc.__file__).resolve().parents[1])}
            process = None
            try:
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-c", PROCESS_CLIENT, path, env=environment,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

                async def response():
                    line = await asyncio.wait_for(process.stdout.readline(), 5)
                    if not line:
                        self.fail((await process.stderr.read()).decode())
                    return json.loads(line)

                async def exchange(operation):
                    process.stdin.write(json.dumps(operation).encode() + b"\n")
                    await process.stdin.drain()
                    return await response()

                self.assertEqual(await response(), {"ready": True})
                boxes = [*broker.consumers.values(), *broker.encoded.values(), *broker.audio.values()]
                if sys.platform == "darwin":
                    self.assertTrue(all(box.named_path is None and not Path(box.path).exists() for box in boxes))
                expected = []
                for data, audio in ((b"abc", b"\x01\x00"), (b"def", b"\x02\x00")):
                    broker.publish_frame(data, 1, 1, 3, 1)
                    broker.publish_encoded(data, True, 1, 0)
                    broker.publish_audio(audio, 1, 0)
                    result = {"frame": data.hex(), "encoded": data.hex(), "audio": audio.hex()}
                    self.assertEqual(await exchange("take"), result)
                    expected.append(result)
                broker.publish_frame(b"xyz", 1, 1, 3, 1)
                broker.publish_encoded(b"xyz", True, 1, 0)
                broker.publish_audio(b"\x03\x00", 1, 0)
                self.assertTrue(all(box.drops == 1 for box in boxes))
                self.assertEqual(await exchange("inspect"), expected)
                self.assertEqual(await exchange("release"), {"released": True})
                self.assertTrue(all(not box.leased for box in boxes))
                broker.publish_frame(b"new", 1, 1, 3, 1)
                broker.publish_encoded(b"new", True, 1, 0)
                broker.publish_audio(b"\x04\x00", 1, 0)
                self.assertEqual(await exchange("take"), {
                    "frame": b"new".hex(), "encoded": b"new".hex(), "audio": "0400"})
                process.kill()
                await asyncio.wait_for(process.wait(), 5)

                async def disconnected():
                    while broker.consumers:
                        await asyncio.sleep(0.01)

                await asyncio.wait_for(disconnected(), 2)
                self.assertEqual(broker.encoded, {})
                self.assertEqual(broker.audio, {})
                self.assertTrue(all(box.file.closed and box.memory.closed for box in boxes))
                self.assertTrue(all(not Path(box.path).exists() for box in boxes))
            finally:
                if process is not None and process.returncode is None:
                    process.kill()
                    await process.wait()
                server.close()
                await server.wait_closed()
                await asyncio.sleep(0)


if __name__ == "__main__":
    unittest.main()
