"""Independent coordinate and retention checks for the optional Quest Mapper."""

from pathlib import Path
import sys
import tempfile
import unittest
import json
import struct

try:
    import numpy as np
    import mcap.reader
except ModuleNotFoundError:
    np = None

if np is not None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    import quest_mapper as mapper
    import quest_mapper_fixture as fixture


@unittest.skipIf(np is None, "Optional Quest Mapper tests require NumPy and MCAP")
class QuestMapperTests(unittest.TestCase):
    def test_asymmetric_top_left_coordinates_preserve_world_up(self):
        metadata, depth = fixture.frame(0)
        observation = mapper.rectify(metadata, depth)
        points = mapper.world_points(observation)
        self.assertGreater(points[0, 0, 1], points[-1, 0, 1])
        self.assertLess(points[0, 0, 0], points[0, -1, 0])
        # Independent inverse-projection oracle at off-centre pixels.
        inverse = np.linalg.inv(mapper.matrix(metadata, "projection"))
        world = mapper.matrix(metadata, "world_from_view")
        for row, column in ((3, 7), (11, 67), (61, 22), (67, 85)):
            clip = np.array([2 * (column + .5) / 96 - 1,
                             1 - 2 * (row + .5) / 72, 0, 1])
            ray = inverse @ clip
            ray /= ray[3]
            ray[:3] *= depth[row, column] * .001 / -ray[2]
            expected = (world @ ray)[:3]
            np.testing.assert_allclose(points[row, column], expected, atol=1e-6)

    def test_intrinsics_match_pinned_mapper_half_pixel_kernel(self):
        metadata, depth = fixture.frame(7)
        observation = mapper.rectify(metadata, depth)
        p = mapper.matrix(metadata, "projection")
        k = observation.intrinsics
        # builder_camera_integrate.py and builder_raycast.py at the pinned
        # revision both use (pixel + 0.5 - principal_point) / focal_length.
        for row, column in ((0, 0), (71, 95), (13, 67)):
            kernel_ray = [(column + .5 - k[0, 2]) / k[0, 0],
                          (row + .5 - k[1, 2]) / k[1, 1], 1]
            xr = np.linalg.inv(p) @ [2 * (column + .5) / 96 - 1,
                                     1 - 2 * (row + .5) / 72, 0, 1]
            expected = [xr[0] / -xr[2], -xr[1] / -xr[2], 1]
            np.testing.assert_allclose(kernel_ray, expected, atol=1e-7)

    def test_moving_camera_keeps_stationary_world_wall(self):
        for index in (0, 7, 19, 35):
            metadata, depth = fixture.frame(index)
            observation = mapper.rectify(metadata, depth)
            points = mapper.world_points(observation)
            # The upper-left corner observes only the stationary z=-2.4 wall.
            np.testing.assert_allclose(points[:8, :8, 2], -2.4, atol=.0006)
            # Using a later acquisition transform must fail this same oracle.
            later, _ = fixture.frame(index + 5)
            stale = mapper.rectify(later, depth)
            self.assertGreater(np.max(np.abs(mapper.world_points(stale)[:8, :8, 2] + 2.4)), .005)

    def test_norm_depth_transform_applies_row_flip_exactly_once(self):
        metadata, depth = fixture.frame(0)
        expected = mapper.rectify(metadata, depth)
        transform = np.eye(4)
        transform[1, 1], transform[1, 3] = -1, 1
        metadata["norm_depth_from_norm_view"] = transform.ravel(order="F").tolist()
        actual = mapper.rectify(metadata, depth[::-1].copy())
        np.testing.assert_array_equal(actual.depth, expected.depth)
        np.testing.assert_array_equal(mapper.world_points(actual), mapper.world_points(expected))

    def test_axial_depth_is_not_normalised_to_ray_length(self):
        metadata, depth = fixture.frame(0)
        depth[:] = 2000
        observation = mapper.rectify(metadata, depth)
        points = mapper.world_points(observation)
        np.testing.assert_allclose(points[..., 2], -2, atol=1e-6)
        self.assertGreater(np.linalg.norm(points[0, 0] - observation.world_from_camera[:3, 3]), 2.3)

    def test_ced1_roundtrip_and_invalid_lengths(self):
        metadata, depth = fixture.frame(3)
        payload = fixture.encode(metadata, depth)
        actual, values = mapper.decode_ced1(payload)
        self.assertEqual(actual, metadata)
        np.testing.assert_array_equal(values, depth)
        with self.assertRaises(ValueError):
            mapper.decode_ced1(payload[:-1])

    def test_malformed_protocol_metadata_is_rejected(self):
        metadata, depth = fixture.frame(0)
        for update in ({"version": True}, {"epoch": 2**32}, {"mapping_version": 999},
                       {"target_lead_us": 0}, {"source_width": 1}, {"extra": 0},
                       {"world_from_view": [True] * 16}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                mapper.decode_ced1(fixture.encode(dict(metadata, **update), depth))
        with self.assertRaises(ValueError):
            mapper.strict_json(b'{"version":1,"version":2}')
        with self.assertRaises(ValueError):
            mapper.strict_json(b'{"value":NaN}')

    def test_range_mask_and_invalid_projection(self):
        metadata, depth = fixture.frame(0)
        depth[0, :3] = [0, 20, 65000]
        self.assertFalse(mapper.rectify(metadata, depth).depth[0, :3].any())
        metadata["projection"] = np.eye(4).ravel(order="F").tolist()
        with self.assertRaises(ValueError):
            mapper.rectify(metadata, depth)

    def test_only_three_complete_owned_checkpoints_remain(self):
        class Writer:
            def save_blocks(self, path):
                Path(path).write_bytes(b"checkpoint")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "checkpoints"
            for index in range(5):
                mapper.checkpoint(Writer(), path, index)
            self.assertEqual([p.name for p in sorted(path.glob("*.pt"))],
                             [f"quest-tsdf-{index:08d}.pt" for index in (2, 3, 4)])
            class Failed:
                def save_blocks(self, path):
                    Path(path).write_bytes(b"incomplete")
                    raise RuntimeError("write failed")
            with self.assertRaises(RuntimeError):
                mapper.checkpoint(Failed(), path, 6)
            self.assertEqual(len(list(path.glob("*.pt"))), 3)

    def test_foreign_checkpoint_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "quest-tsdf-00000001.pt").write_bytes(b"foreign")
            with self.assertRaises(ValueError):
                mapper.checkpoint(None, path, 2)
            self.assertEqual((path / "quest-tsdf-00000001.pt").read_bytes(), b"foreign")

    def test_shorter_repeated_run_retains_its_new_checkpoint(self):
        class Writer:
            def save_blocks(self, path):
                Path(path).write_bytes(b"checkpoint")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for index in (60, 90, 120, 30):
                saved = mapper.checkpoint(Writer(), path, index)
            self.assertTrue(saved.is_file())
            self.assertEqual(len(list(path.glob("*.pt"))), 3)

    def test_fixture_has_complete_native_session_envelopes(self):
        from mcap.reader import make_reader
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "room.mcap"
            fixture.write_mcap(path, 2)
            with path.open("rb") as stream:
                messages = list(make_reader(stream).iter_messages())
            self.assertEqual(len(messages), 2)
            for _, channel, message in messages:
                size = struct.unpack_from("<I", message.data, 4)[0]
                header = json.loads(message.data[8:8 + size])
                self.assertEqual(header["version"], 1)
                self.assertEqual(channel.message_encoding, "ceres-session-v1")
                for key in ("receive_us", "time_us", "session_receive_us", "session_time_us",
                            "epoch", "space_epoch", "sequence", "rtp_timestamp", "keyframe",
                            "stream", "attributes"):
                    self.assertIn(key, header)
                self.assertEqual(message.log_time, header["session_receive_us"] * 1000)
                self.assertEqual(message.publish_time, header["session_time_us"] * 1000)
                metadata, _ = mapper.decode_ced1(message.data[8 + size:])
                self.assertEqual(metadata["mapping_version"], 2)


if __name__ == "__main__":
    unittest.main()
