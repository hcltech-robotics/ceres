import asyncio
import json
import unittest
from unittest.mock import patch

from ceres_bridge.ipc import Broker, EncodedMailbox, FrameMailbox
from ceres_bridge.protocol import JOINTS
from ceres_bridge.state import LatestState

try:
    from ceres_bridge.media import Gst, MediaPeer
except ImportError:
    Gst = None


def description():
    camera = {"side": "right", "width": 64, "height": 48, "requestedWidth": 640, "fps": 30, "calibration": None}
    return {"type": "description", "version": 1, "epoch": 1,
            "clock": {"id": "clock", "units": "microseconds", "domain": "sender-monotonic"},
            "referenceSpace": "local-floor", "axes": "right-handed-x-right-y-up-z-back", "units": "metres",
            "quaternion": "xyzw", "joints": list(JOINTS), "camera": camera,
            "cameras": [{**camera, "mid": "0"}, {**camera, "side": "left", "mid": "1"}]}


class MetadataChannel:
    def __init__(self):
        self.sent = []

    def get_property(self, name):
        return {"label": "ceres.meta.v1", "ordered": True}[name]

    def emit(self, name, value):
        self.sent.append((name, value))


class IdentifiedPad:
    """Supply the negotiated identity to real RTP source pads in decoder tests."""
    def __init__(self, pad, mid):
        self.pad, self.mid = pad, mid

    def get_property(self, name):
        if name == "transceiver":
            return self
        if name == "mid":
            return self.mid
        raise ValueError(name)

    def __getattr__(self, name):
        return getattr(self.pad, name)


@unittest.skipIf(Gst is None, "GStreamer bindings are required")
class CameraDecodeTests(unittest.IsolatedAsyncioTestCase):
    async def test_keyframe_requests_ignore_absent_sides_and_limit_each_mid(self):
        class Decoder:
            def __init__(self):
                self.requests = 0

            def get_by_name(self, _name):
                return self

            def get_static_pad(self, _name):
                return self

            def send_event(self, _event):
                self.requests += 1

        state = LatestState()
        state.reset(1)
        broker = Broker(state)
        peer = MediaPeer(state, broker, lambda _: None)
        right, left = Decoder(), Decoder()
        try:
            state.description = description()
            del state.description["cameras"]
            peer.video_bins = {"0": right}
            peer.video_codecs = {"0": "h264"}
            with patch("ceres_bridge.media.monotonic_us", return_value=500_000) as clock, patch(
                    "ceres_bridge.media.GLib.idle_add", side_effect=lambda callback: callback()):
                for value in (500_000, 750_000, 1_000_000):
                    clock.return_value = value
                    peer.request_keyframe("left")
                self.assertEqual(right.requests, 0)
                peer.request_keyframe("primary")
                peer.request_keyframe("right")
                self.assertEqual(right.requests, 1)
                state.description = description()
                peer.video_bins["1"] = left
                peer.video_codecs["1"] = "h264"
                peer.request_keyframe("left")
                self.assertEqual(left.requests, 1)
                self.assertEqual(right.requests, 1)
                peer.request_keyframe()
                self.assertEqual((right.requests, left.requests), (1, 1))
                clock.return_value += 200_000
                peer.request_keyframe()
                self.assertEqual((right.requests, left.requests), (2, 2))
        finally:
            peer.close()

    def source(self, peer, mid, encoding, colour):
        encoder = ("openh264enc gop-size=5 ! rtph264pay config-interval=-1"
                   if encoding == "H264" else "vp8enc deadline=1 keyframe-max-dist=5 ! rtpvp8pay")
        source = Gst.parse_bin_from_description(
            f"videotestsrc is-live=true pattern=solid-color foreground-color={colour} ! "
            f"video/x-raw,width=64,height=48,framerate=30/1 ! videoconvert ! {encoder} ! "
            f'capsfilter caps="application/x-rtp,media=video,encoding-name={encoding},clock-rate=90000"', True)
        peer.pipeline.add(source)
        peer._pad(None, IdentifiedPad(source.get_static_pad("src"), mid))
        return source

    async def decode_pair(self, encoding):
        state = LatestState()
        state.reset(1)
        broker = Broker(state)
        broker.consumers = {1: FrameMailbox(), 2: FrameMailbox(), 3: FrameMailbox()}
        broker.encoded = {1: EncodedMailbox(), 2: EncodedMailbox(), 3: EncodedMailbox()}
        broker.cameras = {1: "primary", 2: "right", 3: "left"}
        peer = MediaPeer(state, broker, lambda _: None)
        try:
            # The left RTP pad arrives first. Its arrival order must not choose
            # the primary camera, and no frame may escape before metadata.
            left = self.source(peer, "1", encoding, 0xFF0000FF)
            right = self.source(peer, "0", encoding, 0xFFFF0000)
            self.assertIsNone(peer.error)
            left.sync_state_with_parent()
            right.sync_state_with_parent()
            await asyncio.sleep(.15)
            self.assertTrue(all(box.generation == 0 for box in broker.consumers.values()))
            channel = MetadataChannel()
            with patch.object(peer, "request_keyframe", wraps=peer.request_keyframe) as request_keyframe:
                peer._metadata(channel, json.dumps(description()))
                request_keyframe.assert_called_once_with()
            self.assertIsNone(peer.error)
            self.assertTrue(peer.acknowledged)
            for _ in range(100):
                if all(box.generation > 2 for box in broker.consumers.values()):
                    break
                await asyncio.sleep(.01)
            self.assertIsNone(peer.error)
            self.assertTrue(all(box.generation > 2 for box in broker.consumers.values()),
                            ([(identity, box.generation) for identity, box in broker.consumers.items()],
                             peer.pipeline.get_state(0), left.get_state(0), right.get_state(0)))
            self.assertEqual(state.codec, encoding.lower())
            for identity, side, channel_index in ((1, "right", 0), (2, "right", 0), (3, "left", 2)):
                box = broker.consumers[identity]
                self.assertEqual(box.latest["side"], side)
                self.assertEqual(box.latest["mid"], "0" if side == "right" else "1")
                pixel = box.memory[box.latest["offset"]:box.latest["offset"] + 3]
                self.assertGreater(pixel[channel_index], 180)
                self.assertLess(pixel[2 - channel_index], 70)
                if encoding == "H264":
                    self.assertGreater(broker.encoded[identity].generation, 0)
            peer.request_keyframe()
        finally:
            peer.close()
            for box in (*broker.consumers.values(), *broker.encoded.values()):
                box.close()

    async def test_two_h264_tracks_decode_and_route_independently(self):
        await self.decode_pair("H264")

    async def test_two_vp8_tracks_decode_and_route_independently(self):
        await self.decode_pair("VP8")

    async def test_unknown_and_duplicate_tracks_are_rejected(self):
        for known, incoming, has_metadata in (("0", "0", True), ("0", "2", True), ("2", None, False)):
            with self.subTest(known=known, incoming=incoming, has_metadata=has_metadata):
                state = LatestState()
                state.reset(1)
                broker = Broker(state)
                peer = MediaPeer(state, broker, lambda _: None)
                try:
                    if has_metadata:
                        peer._metadata(MetadataChannel(), json.dumps(description()))
                    self.source(peer, known, "VP8", 0xFFFF0000)
                    if incoming is not None:
                        self.source(peer, incoming, "VP8", 0xFF0000FF)
                    else:
                        peer._metadata(MetadataChannel(), json.dumps(description()))
                    self.assertRegex(peer.error, "duplicate|undeclared")
                finally:
                    peer.close()

    async def test_legacy_description_keeps_a_single_primary_camera(self):
        state = LatestState()
        state.reset(1)
        broker = Broker(state)
        peer = MediaPeer(state, broker, lambda _: None)
        try:
            value = description()
            del value["cameras"]
            peer._metadata(MetadataChannel(), json.dumps(value))
            self.source(peer, "0", "VP8", 0xFFFF0000)
            self.assertIsNone(peer.error)
            self.assertEqual(peer._camera_for_mid("0"), {"side": "right", "mid": "0", "primary": True})
            self.source(peer, "1", "VP8", 0xFF0000FF)
            self.assertIn("undeclared", peer.error)
        finally:
            peer.close()
