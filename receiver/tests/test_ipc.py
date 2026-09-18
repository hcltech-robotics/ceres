import unittest
import asyncio
from pathlib import Path
import tempfile

from ceres_bridge.ipc import AudioMailbox, Broker, EncodedMailbox, FrameMailbox, MAX_AUDIO_BYTES, MAX_FRAME_BYTES
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
        with tempfile.TemporaryDirectory(prefix="ceres-camera-") as directory:
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


if __name__ == "__main__":
    unittest.main()
