import asyncio
import unittest

from ceres_bridge.ipc import AudioMailbox, Broker
from ceres_bridge.state import LatestState, monotonic_us

try:
    from ceres_bridge.media import Gst, MediaPeer
except ImportError:
    Gst = None


@unittest.skipIf(Gst is None, "GStreamer bindings are required")
class AudioDecodeTests(unittest.IsolatedAsyncioTestCase):
    async def test_opus_decodes_into_a_bounded_python_audio_lease(self):
        state = LatestState()
        broker = Broker(state)
        box = AudioMailbox()
        broker.audio[1] = box
        peer = MediaPeer(state, broker, lambda _: None)
        try:
            source = Gst.parse_bin_from_description(
                "audiotestsrc is-live=true wave=sine ! audioconvert ! "
                "audio/x-raw,rate=48000,channels=1 ! opusenc ! rtpopuspay ! "
                'capsfilter caps="application/x-rtp,media=audio,encoding-name=OPUS,clock-rate=48000"', True)
            peer.pipeline.add(source)
            pad = source.get_static_pad("src")
            peer._pad(None, pad)
            self.assertIsNone(peer.error)
            source.sync_state_with_parent()
            for _ in range(100):
                await asyncio.sleep(.01)
                if box.generation > 2:
                    break
            self.assertIsNone(peer.error)
            self.assertGreater(box.generation, 2)
            sample = box.acquire(monotonic_us())
            self.assertIsNotNone(sample)
            self.assertEqual(sample["format"], "S16LE")
            self.assertEqual(sample["channels"], 1)
            self.assertTrue(any(box.memory[sample["offset"]:sample["offset"] + sample["bytes"]]))
        finally:
            peer.close()
            box.close()
