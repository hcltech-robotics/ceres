import json
from importlib.resources import files
from pathlib import Path
import struct
import unittest

from ceres_bridge.protocol import Pose, decode_pose, encode_pose, newer_sequence, parse_metadata, JOINTS
from ceres_bridge.state import ClockMap, LatestState


def head(seq=0, epoch=1, space=0, observed=100_000, valid=True):
    return Pose(1, valid, epoch, space, seq, observed, observed + 10_000, 0, (1.25, 2, 3, 0, 0, 0, 1) if valid else (0,) * 7)


def description():
    return {"type": "description", "version": 1, "epoch": 1, "clock": {"id": "clock", "units": "microseconds", "domain": "sender-monotonic"},
            "referenceSpace": "local-floor", "axes": "right-handed-x-right-y-up-z-back", "units": "metres", "quaternion": "xyzw",
            "joints": list(JOINTS), "camera": {"side": "right", "width": 1280, "height": 960, "requestedWidth": 640, "fps": 30, "calibration": None}}


class ProtocolTests(unittest.TestCase):
    def test_round_trip(self):
        original = head(seq=0xFFFFFFFF)
        packet = encode_pose(original)
        self.assertEqual(len(packet), 68)
        self.assertEqual(packet[:4], b"CBR1")
        self.assertEqual(decode_pose(packet), original)
        self.assertTrue(newer_sequence(0, 0xFFFFFFFF))
        self.assertFalse(newer_sequence(0xFFFFFFFF, 0))
        self.assertFalse(newer_sequence(0x80000000, 0))

    def test_malformed_packets(self):
        packet = encode_pose(head())
        for bad in (packet[:-1], packet + b"x", b"BAD!" + packet[4:], packet[:4] + b"\x02" + packet[5:]):
            with self.assertRaises(ValueError):
                decode_pose(bad)
        bad = bytearray(packet)
        struct.pack_into("<f", bad, 40, float("nan"))
        with self.assertRaises(ValueError):
            decode_pose(bad)
        bad[6] = 0
        with self.assertRaises(ValueError):
            decode_pose(bad)

    def test_description_and_no_commands(self):
        self.assertEqual(parse_metadata(json.dumps(description())), description())
        for command in ("record", "start", "stop", "reconfigure"):
            with self.assertRaises(ValueError):
                parse_metadata(json.dumps({"type": command, "version": 1, "epoch": 1}))

    def test_cross_language_fixtures(self):
        path = Path(__file__).parents[2] / "protocol/bridge/fixtures/poses.json"
        packaged = files("ceres_bridge").joinpath("data/poses.json").read_text()
        if path.exists():
            self.assertEqual(path.read_text(), packaged)
        for fixture in json.loads(packaged):
            raw = bytes.fromhex(fixture["hex"])
            pose = decode_pose(raw)
            self.assertEqual(encode_pose(pose), raw)
            self.assertEqual(pose.kind, fixture["kind"])
            self.assertEqual(pose.sequence, fixture["sequence"])


class FreshnessTests(unittest.TestCase):
    def setUp(self):
        self.state = LatestState()
        self.state.reset(1)
        self.state.description = description()
        self.state.clock.add(199_900, 100_000, 100_020, 200_120)

    def test_source_and_receiver_staleness(self):
        self.assertTrue(self.state.accept(encode_pose(head()), 200_200))
        self.assertTrue(self.state.snapshot(200_300)["poses"]["1"]["fresh"])
        self.assertIsNone(self.state.snapshot(250_300)["poses"]["1"]["pose"])
        self.assertFalse(self.state.accept(encode_pose(head(seq=1)), 300_000))

    def test_order_and_recentre(self):
        self.assertTrue(self.state.accept(encode_pose(head(seq=0xFFFFFFFF)), 200_200))
        self.assertTrue(self.state.accept(encode_pose(head(seq=0)), 200_200))
        self.assertFalse(self.state.accept(encode_pose(head(seq=0xFFFFFFFF)), 200_200))
        self.assertTrue(self.state.accept(encode_pose(head(seq=1, space=1)), 200_200))
        self.assertFalse(self.state.accept(encode_pose(head(seq=2, space=0)), 200_200))
        self.assertFalse(self.state.accept(encode_pose(head(seq=2, epoch=2)), 200_200))

    def test_invalid_tracking_clears_previous(self):
        self.state.accept(encode_pose(head()), 200_200)
        self.state.accept(encode_pose(head(seq=1, valid=False)), 200_300)
        self.assertFalse(self.state.snapshot(200_400)["poses"]["1"]["tracked"])
        self.state.reset(2)
        self.assertEqual(self.state.snapshot(200_400)["poses"], {})

    def test_clock_requires_exchange_and_expires(self):
        clock = ClockMap()
        self.assertIsNone(clock.mapping(100))
        self.assertFalse(clock.add(100, 1000, 2000, 101))
        self.assertTrue(clock.add(100, 1000, 1010, 120))
        self.assertEqual(clock.mapping(120), (-895.0, 5.0, 1.0))
        self.assertIsNone(clock.mapping(30_000_121))

    def test_affine_clock_mapping_tracks_different_clock_rates(self):
        clock = ClockMap()
        for source in range(1_000_000, 3_000_000, 250_000):
            receiver = 500_000 + source * 1.04
            clock.add(int(receiver - 100), source, source, int(receiver + 100))
        offset, uncertainty, rate = clock.mapping(int(receiver + 500))
        self.assertAlmostEqual(rate, 1.04, places=6)
        self.assertAlmostEqual(offset, 500_000, places=3)
        self.assertLess(uncertainty, 101)


if __name__ == "__main__":
    unittest.main()
