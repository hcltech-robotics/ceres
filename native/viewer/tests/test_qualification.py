"""Hardware qualification reuse and release gate regression tests."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("qualification", Path(__file__).parents[1] / "scripts/qualification.py")
qualification = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = qualification
SPEC.loader.exec_module(qualification)
HARDWARE_SPEC = importlib.util.spec_from_file_location("qualify_hardware", Path(__file__).parents[1] / "scripts/qualify_hardware.py")
hardware = importlib.util.module_from_spec(HARDWARE_SPEC)
HARDWARE_SPEC.loader.exec_module(hardware)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        files = {"package.json": '{"version":"1.2.3"}',
                 "native/viewer/src/main.cpp": "int main() { return 0; }\n",
                 "native/viewer/scripts/build-windows.cmd": "cmake --build build\n",
                 "native/viewer/assets/model.bin": "geometry",
                 "native/lerobot-exporter/src/main.rs": "fn main() {}\n",
                 "wasm/lerobot-exporter/src/lib.rs": "pub fn export() {}\n",
                 "wasm/lerobot-exporter/Cargo.toml": "[package]\n",
                 "wasm/lerobot-exporter/Cargo.lock": "version = 4\n",
                 ".github/workflows/native-viewer.yml": "jobs: {}\n",
                 ".github/scripts/native-viewer-inputs.py": "print('inputs')\n",
                 ".github/scripts/install-native-tools.py": "print('tools')\n",
                 ".github/scripts/build-native-ffmpeg.sh": "make ffmpeg\n",
                 ".github/scripts/native-build-requirements.txt": "Jinja2==3.1.6\n"}
        for name, text in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text.encode())
        self.inputs = {"schema": "ceres-native-build-inputs", "version": 1,
                       "platform": "windows-x64", "source_revision": "a" * 40, "release_version": "1.2.3",
                       "toolchain": {"runner": "windows-2022", "build_image": None, "cuda": "12.4.1",
                                     "rust": "1.91.0", "cmake": "3.31.8", "cuda_architectures": "75;86;89",
                                     "compiler": "19.44"}, "ffmpeg": {"version": "ffmpeg version 8.0"},
                       "runtime_dependencies": {"bin/ffmpeg.exe": "1" * 64, "bin/ffprobe.exe": "2" * 64,
                                                "vcruntime140.dll": "3" * 64}}
        self.enterContext(patch.dict(os.environ, {"GITHUB_SHA": self.inputs["source_revision"]}))

    def receipt(self, target, expected):
        return {"schema": "ceres-native-hardware-qualification", "version": 1, "status": "passed",
                "platform": target, "input_sha256": expected, "archive_sha256": "b" * 64,
                "checks": {name: True for name in qualification.CHECKS}, "gpu": "RTX 3090",
                "driver": "591.86", "completed_at": "2026-09-19T12:00:00Z",
                "graphics": {"vendor": "NVIDIA Corporation", "renderer": "RTX 3090"}}

    def test_jetson_fingerprint_requires_backend_and_driver_identity(self):
        inputs = copy.deepcopy(self.inputs)
        inputs["platform"] = "linux-arm64-jetpack6"
        with self.assertRaisesRegex(ValueError, "Jetson build inputs omit"):
            qualification.fingerprint(self.root, inputs)
        inputs["toolchain"].update(video_backend="JETSON", jetson_linux_release="# R36 (release), REVISION: 4.7")
        first = qualification.fingerprint(self.root, inputs)
        inputs["toolchain"]["jetson_linux_release"] = "# R36 (release), REVISION: 4.4"
        self.assertNotEqual(first, qualification.fingerprint(self.root, inputs))

    def test_version_revision_docs_and_line_endings_reuse_qualification(self):
        expected = qualification.fingerprint(self.root, self.inputs)
        changed = copy.deepcopy(self.inputs)
        changed.update(release_version="1.2.4", source_revision="c" * 40)
        (self.root / "native/viewer/docs").mkdir()
        (self.root / "native/viewer/docs/guide.md").write_text("New instructions")
        source = self.root / "native/viewer/src/main.cpp"
        source.write_bytes(source.read_bytes().replace(b"\n", b"\r\n"))
        self.assertEqual(expected, qualification.fingerprint(self.root, changed))

    def test_build_scripts_are_runtime_inputs(self):
        expected = qualification.fingerprint(self.root, self.inputs)
        (self.root / "native/viewer/scripts/build-windows.cmd").write_text("different compiler")
        self.assertNotEqual(expected, qualification.fingerprint(self.root, self.inputs))

    def test_each_runtime_dependency_invalidates_receipt(self):
        expected = qualification.fingerprint(self.root, self.inputs)
        for relative in ("native/viewer/src/main.cpp", "native/viewer/assets/model.bin",
                         "native/lerobot-exporter/src/main.rs", "wasm/lerobot-exporter/Cargo.lock",
                         ".github/workflows/native-viewer.yml", ".github/scripts/install-native-tools.py",
                         ".github/scripts/build-native-ffmpeg.sh"):
            with self.subTest(path=relative):
                path = self.root / relative
                previous = path.read_bytes()
                path.write_bytes(previous + b"changed")
                self.assertNotEqual(expected, qualification.fingerprint(self.root, self.inputs))
                path.write_bytes(previous)

    def test_compiler_or_ffmpeg_change_invalidates_receipt(self):
        expected = qualification.fingerprint(self.root, self.inputs)
        for group, key in (("toolchain", "compiler"), ("toolchain", "cuda"), ("ffmpeg", "version")):
            changed = copy.deepcopy(self.inputs)
            changed[group][key] += "-new"
            self.assertNotEqual(expected, qualification.fingerprint(self.root, changed))

    def test_runtime_binary_changes_invalidate_the_receipt(self):
        expected = qualification.fingerprint(self.root, self.inputs)
        for name in self.inputs["runtime_dependencies"]:
            with self.subTest(runtime=name):
                changed = copy.deepcopy(self.inputs)
                changed["runtime_dependencies"][name] = "4" * 64
                self.assertNotEqual(expected, qualification.fingerprint(self.root, changed))

    def test_runtime_inventory_selects_dependencies_without_release_binaries(self):
        files = {name: {"sha256": "1" * 64} for name in (
            "bin/ffmpeg", "bin/ffprobe", "lib/libstdc++.so.6", "lib/libcudart.so.12.9.79",
            "example.dll", "bin/ceres-viewer", "bin/ceres-native-exporter", "provenance/source.json")}
        actual = qualification.runtime_dependency_hashes({"schema": "ceres-viewer-package", "version": 1, "files": files})
        self.assertEqual(set(actual), {"bin/ffmpeg", "bin/ffprobe", "lib/libstdc++.so.6", "lib/libcudart.so.12.9.79", "example.dll"})

    def test_missing_or_invalid_runtime_inventory_fails(self):
        for dependencies in (None, {}, {"bin/ffmpeg.exe": "1" * 64},
                             {"bin/ffmpeg.exe": "1" * 64, "bin/ffprobe.exe": "invalid"}):
            with self.subTest(inventory=dependencies):
                with self.assertRaises(ValueError):
                    qualification.fingerprint(self.root, dict(self.inputs, runtime_dependencies=dependencies))

    def test_failed_partial_software_rendered_and_stale_receipts_fail(self):
        expected = qualification.fingerprint(self.root, self.inputs)
        original = self.receipt("windows-x64", expected)
        for mutation in (lambda r: r.update(status="failed"),
                         lambda r: r["checks"].pop("nvdec"),
                         lambda r: r["checks"].update(depth=False),
                         lambda r: r["graphics"].update(vendor="Mesa"),
                         lambda r: r.update(input_sha256="0" * 64),
                         lambda r: r.update(archive_sha256="")):
            candidate = copy.deepcopy(original)
            mutation(candidate)
            with self.assertRaises(ValueError):
                qualification.validate_receipt(candidate, expected, "windows-x64")

    def make_gate(self):
        artifacts, receipts = self.root / "artifacts", self.root / "receipts"
        receipts.mkdir()
        for target in qualification.PLATFORMS:
            inputs = dict(self.inputs, platform=target)
            directory = artifacts / target
            directory.mkdir(parents=True)
            (directory / "workflow-inputs.json").write_text(json.dumps(inputs))
            archive = directory / qualification.archive_name(inputs)
            archive.write_bytes(b"qualified package")
            manifest = {"schema": "ceres-viewer-package", "version": 1, "platform": target,
                        "release_version": inputs["release_version"], "source_revision": inputs["source_revision"],
                        "files": {name: {"sha256": value} for name, value in inputs["runtime_dependencies"].items()}}
            Path(str(archive) + ".manifest.json").write_text(json.dumps(manifest))
            report = {"schema": "ceres-viewer-package-verification", "version": 1, "passed": True,
                      "platform": target, "release_version": inputs["release_version"], "source_revision": inputs["source_revision"],
                      "archive_sha256": qualification.digest(archive), "manifest": manifest}
            (directory / f"ceres-viewer-1.2.3-{target}.verification.json").write_text(json.dumps(report))
            receipt = self.receipt(target, qualification.fingerprint(self.root, inputs))
            (receipts / f"{target}.json").write_text(json.dumps(receipt))
        return artifacts, receipts

    def test_all_three_platforms_pass_and_record_new_archive_hashes(self):
        artifacts, receipts = self.make_gate()
        with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}):
            result = qualification.check(self.root, artifacts, receipts)
        self.assertEqual(set(result["platforms"]), set(qualification.PLATFORMS))
        self.assertTrue(all(p["qualification_reused"] for p in result["platforms"].values()))

    def test_missing_receipt_does_not_skip_initial_hardware_qualification(self):
        artifacts, receipts = self.make_gate()
        (receipts / "linux-arm64.json").unlink()
        with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}):
            with self.assertRaisesRegex(ValueError, "Initial NVIDIA"):
                qualification.check(self.root, artifacts, receipts)

    def test_wrong_version_or_revision_fails(self):
        artifacts, receipts = self.make_gate()
        with patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}):
            with self.assertRaisesRegex(ValueError, "revision"):
                qualification.check(self.root, artifacts, receipts)
        manifest = artifacts / "windows-x64/workflow-inputs.json"
        manifest.write_text(json.dumps(dict(self.inputs, release_version="1.2.4")))
        with self.assertRaisesRegex(ValueError, "version"):
            qualification.check(self.root, artifacts, receipts)

    def test_self_declared_runtime_hash_cannot_replace_the_verified_manifest(self):
        artifacts, receipts = self.make_gate()
        filename = artifacts / "windows-x64/workflow-inputs.json"
        inputs = qualification.read_json(filename)
        inputs["runtime_dependencies"]["vcruntime140.dll"] = "e" * 64
        filename.write_text(json.dumps(inputs))
        (receipts / "windows-x64.json").write_text(json.dumps(self.receipt("windows-x64", qualification.fingerprint(self.root, inputs))))
        with self.assertRaisesRegex(ValueError, "Packaged runtime dependencies differ"):
            qualification.check(self.root, artifacts, receipts)

    def test_sidecar_runtime_manifest_must_match_the_package_verification(self):
        artifacts, receipts = self.make_gate()
        filename = artifacts / "windows-x64/ceres-viewer-1.2.3-windows-x64.zip.manifest.json"
        manifest = qualification.read_json(filename)
        manifest["files"]["vcruntime140.dll"]["sha256"] = "e" * 64
        filename.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "manifest differs from the verified archive"):
            qualification.check(self.root, artifacts, receipts)

    def test_package_verification_must_cover_the_current_archive(self):
        artifacts, receipts = self.make_gate()
        (artifacts / "windows-x64/ceres-viewer-1.2.3-windows-x64.zip").write_bytes(b"different archive")
        with self.assertRaisesRegex(ValueError, "manifest differs from the verified archive"):
            qualification.check(self.root, artifacts, receipts)


class SceneAssetTests(unittest.TestCase):
    def test_both_anatomical_hands_are_required_in_live_and_replay(self):
        metrics = {"scene_assets": {
            "hands": {"metadata": {"name": "soma-hand-mid", "retargeting": "webxr-anatomical-v1"},
                      "meshes": [{"side": side, "vertices": 2859, "triangles": 5692} for side in ("left", "right")]},
            "headset": {"triangles": 76260}}}
        hardware.check_scene_assets(metrics)
        for mutate in (lambda m: m["hands"]["metadata"].update(name="ceres-original-hand-rig"),
                       lambda m: m["hands"]["meshes"].pop(),
                       lambda m: m["hands"]["meshes"][0].update(vertices=778),
                       lambda m: m["headset"].update(triangles=0)):
            candidate = copy.deepcopy(metrics)
            mutate(candidate["scene_assets"])
            with self.assertRaises(RuntimeError):
                hardware.check_scene_assets(candidate)


class GpuBinaryTests(unittest.TestCase):
    def test_executable_from_another_owner_needs_no_permission_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "test_image"
            binary.write_bytes(b"executable fixture")
            with patch.object(hardware.os, "access", return_value=True), \
                    patch.object(Path, "chmod", side_effect=PermissionError("Different owner")):
                self.assertEqual(hardware.find_binary(root, "test_image", False), binary.resolve())


class RenderedFixtureTests(unittest.TestCase):
    colours = ((225, 20, 15), (18, 220, 30), (220, 230, 25),
               (25, 20, 235), (230, 30, 220), (25, 225, 230))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "scene.ppm"

    def fixture(self, colours=None, occluded=False):
        width, height = 960, 640
        pixels = bytearray(bytes((14, 16, 17)) * (width * height))
        for index, colour in enumerate(colours or self.colours):
            for y in range(128, 480):
                if occluded and 280 <= y < 330:
                    continue
                offset = (y * width + 240 + index * 70) * 3
                pixels[offset:offset + 70 * 3] = bytes(colour) * 70
        self.path.write_bytes(b"P6\n960 640\n255\n" + pixels)
        return pixels

    def test_decoded_bars_survive_colour_rounding_and_scene_occlusion(self):
        self.fixture(occluded=True)
        result = hardware.check_rendered_fixture(self.path)
        self.assertEqual(list(result["colour_bars"]), ["red", "green", "yellow", "blue", "magenta", "cyan"])

    def test_missing_or_mirrored_bars_fail(self):
        for colours in (self.colours[:-1] + ((30, 30, 30),), tuple(reversed(self.colours))):
            with self.subTest(colours=colours):
                self.fixture(colours)
                with self.assertRaises(RuntimeError):
                    hardware.check_rendered_fixture(self.path)

    def test_many_colours_without_the_scene_geometry_fail(self):
        tile = b"".join(bytes(colour) for colour in self.colours) + bytes(range(96, 129))
        row = tile * (960 * 3 // len(tile) + 1)
        pixels = row[:960 * 3] * 640
        self.path.write_bytes(b"P6\n960 640\n255\n" + pixels)
        self.assertGreater(len(set(pixels)), 16)
        with self.assertRaisesRegex(RuntimeError, "left-to-right order"):
            hardware.check_rendered_fixture(self.path)

    def test_separate_coloured_panels_are_not_the_fixture(self):
        pixels = bytearray(bytes((14, 16, 17)) * (960 * 640))
        for index, colour in enumerate(self.colours):
            top = 96 if index % 2 == 0 else 384
            for y in range(top, top + 160):
                offset = (y * 960 + 240 + index * 70) * 3
                pixels[offset:offset + 70 * 3] = bytes(colour) * 70
        self.path.write_bytes(b"P6\n960 640\n255\n" + pixels)
        with self.assertRaisesRegex(RuntimeError, "not aligned"):
            hardware.check_rendered_fixture(self.path)

    def test_invalid_headers_dimensions_and_truncated_pixels_fail(self):
        pixels = self.fixture()
        for data in (b"P3\n960 640\n255\n" + pixels, b"P6\ninvalid\n255\n" + pixels,
                     b"P6\n960 640\n255\n" + pixels[:-1], b"P6\n10 10\n255\n" + bytes(300)):
            with self.subTest(header=data[:24]):
                self.path.write_bytes(data)
                with self.assertRaises(RuntimeError):
                    hardware.check_rendered_fixture(self.path)


class FrozenRecordingTests(unittest.TestCase):
    def events(self, times=(3200000, 3800000, 5200000, 6100000)):
        result = []
        for sequence, elapsed in enumerate(times):
            target = 100000000 + elapsed
            pose = b"CBR1" + struct.pack("<BBHIIIIQQ7f", 1, 1, 1, 1, 1, sequence, 28,
                                        target, target, 0, 1.6, 0, 0, 0, 0, 1)
            result.append(({"kind": "pose", "stream": "head", "epoch": 1, "space_epoch": 1}, pose))
            metadata = {"epoch": 1, "space_epoch": 1, "target_us": target, "observed_us": target,
                        "width": 32, "height": 24, "mapping_version": 2,
                        "world_from_view": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1]}
            text = json.dumps(metadata).encode()
            depth = b"CED1" + struct.pack("<I", len(text)) + text + struct.pack("<768H", *([1500] * 768))
            result.append(({"kind": "depth", "stream": "environment_depth",
                            "attributes": {"fixture_elapsed_us": elapsed}}, depth))
        return result

    def test_depth_recorded_after_freeze_retains_matching_head_pose(self):
        proof = hardware.check_frozen_recording_events(self.events(), 4500000)
        self.assertEqual(proof["before_freeze"], 2)
        self.assertEqual(proof["after_freeze"], 2)
        self.assertEqual(proof["depth_frames"], 4)

    def test_depth_stopping_at_freeze_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "continue through"):
            hardware.check_frozen_recording_events(self.events((3200000, 3800000, 4500000)), 4500000)

    def test_depth_without_an_acquisition_matched_head_is_rejected(self):
        events = self.events()
        events[0][0]["epoch"] = 2
        with self.assertRaisesRegex(RuntimeError, "acquisition head pose"):
            hardware.check_frozen_recording_events(events, 4500000)

    def test_depth_without_elapsed_acquisition_time_is_rejected(self):
        events = self.events()
        events[1][0]["attributes"].clear()
        with self.assertRaisesRegex(RuntimeError, "acquisition time"):
            hardware.check_frozen_recording_events(events, 4500000)

    def test_recorded_zero_depth_is_rejected(self):
        events = self.events()
        header, payload = events[1]
        events[1] = (header, payload[:-2] + b"\x00\x00")
        with self.assertRaisesRegex(RuntimeError, "acquisition contract"):
            hardware.check_frozen_recording_events(events, 4500000)

    def test_rotated_or_nonfinite_depth_transform_is_rejected(self):
        for value in (-1, float("nan"), float("inf")):
            with self.subTest(value=value):
                events = self.events()
                header, payload = events[1]
                size = struct.unpack_from("<I", payload, 4)[0]
                metadata = json.loads(payload[8:8 + size])
                metadata["world_from_view"][0] = value
                text = json.dumps(metadata).encode()
                events[1] = (header, b"CED1" + struct.pack("<I", len(text)) + text + payload[8 + size:])
                with self.assertRaisesRegex(RuntimeError, "acquisition head pose"):
                    hardware.check_frozen_recording_events(events, 4500000)


if __name__ == "__main__":
    unittest.main()
