"""Package boundary regressions. No compiler, GPU or third-party Python modules are needed."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


verify = module("verify-package")
common = module("package-common")


def elf(machine=62, dependency=None):
    data = bytearray(512)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", data, 18, machine)
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HH", data, 54, 56, 2 if dependency else 0)
    if dependency:
        struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0x400000, 0, 512, 512, 4096)
        struct.pack_into("<IIQQQQQQ", data, 120, 2, 6, 192, 0x4000C0, 0, 48, 48, 8)
        struct.pack_into("<qQqQqQ", data, 192, 5, 0x400100, 1, 0, 0, 0)
        name = dependency.encode() + b"\0"
        data[256:256 + len(name)] = name
    return bytes(data)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_zip_rejects_traversal_and_case_collision(self):
        for names in (["pkg/../../escape"], ["pkg/file", "pkg/FILE"], ["C:/escape"]):
            with self.subTest(names=names):
                archive = self.root / "test.zip"
                with zipfile.ZipFile(archive, "w") as stream:
                    for name in names:
                        stream.writestr(name, b"x")
                with self.assertRaises(ValueError):
                    verify.extract_archive(archive, self.root / ("out" + str(len(list(self.root.iterdir())))))
        self.assertFalse((self.root.parent / "escape").exists())

    def test_tar_rejects_external_links(self):
        archive = self.root / "test.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            entry = tarfile.TarInfo("pkg/lib/example.so")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "../../../outside"
            stream.addfile(entry)
        with self.assertRaisesRegex(ValueError, "Unsafe archive path"):
            verify.extract_archive(archive, self.root / "out")

    def test_elf_architecture_and_dynamic_dependencies(self):
        path = self.root / "binary"
        path.write_bytes(elf(183, "libc.so.6"))
        self.assertEqual(verify.binary_info(path), {"format": "elf", "machine": 183, "imports": ["libc.so.6"]})
        path.write_bytes(b"\x7fELF\x01\x01" + bytes(60))
        with self.assertRaisesRegex(ValueError, "ELF64"):
            verify.binary_info(path)

    def fixture_package(self, dependency=None, machine=62, platform="linux-x64", backend="CUVID"):
        source = self.root / "source"
        package = self.root / "pkg"
        build = self.root / "build"
        for directory in (source / "native/viewer/cmake", source / "native/lerobot-exporter", package / "provenance", package / "assets", build):
            directory.mkdir(parents=True, exist_ok=True)
        (source / "package.json").write_text('{"version":"1.2.3"}')
        (source / "native/viewer/CMakeLists.txt").write_text("")
        (source / "native/viewer/cmake/Dependencies.cmake").write_text("")
        (source / "native/lerobot-exporter/Cargo.lock").write_text('version = 4\n[[package]]\nname = "fixture"\nversion = "1.0.0"\n')
        (source / "native/lerobot-exporter/Cargo.toml").write_text('[package]\nname = "ceres-native-exporter"\nversion = "0.1.0"\n')
        (build / "CMakeCache.txt").write_text("//Build type\nCMAKE_BUILD_TYPE:STRING=Release\n\n//Build tool\nCMAKE_MAKE_PROGRAM:FILEPATH=/tools/ninja\n")
        with (build / "CMakeCache.txt").open("a") as cache:
            cache.write("CERES_SELECTED_VIDEO_BACKEND:INTERNAL=" + backend + "\n")
        if backend == "JETSON":
            (package / "provenance/nv_tegra_release").write_text("# R36 (release), REVISION: 4.7\n")
        (package / "provenance/package.json").write_text('{"version":"1.2.3"}')
        shutil.copytree(SCRIPTS.parent / "assets/hands", package / "assets/hands")
        (package / "assets/redistributable.json").write_text(json.dumps({"files": [
            "hands/" + name for name in ("geometry.bin", "model.json", "LICENSE", "NOTICE")]}))
        for name in ("ceres-viewer.bin", "ceres-native-exporter", "ffmpeg", "ffprobe"):
            (package / name).write_bytes(elf(machine, dependency) + b"Ceres viewer 1.2.3\0")
        def versions(directory, values):
            self.assertEqual(values["CMAKE_MAKE_PROGRAM"], "/tools/ninja")
            self.assertEqual(values["CMAKE_BUILD_TYPE"], "Release")
            return {"compiler_id": "fixture"}
        with patch.dict(os.environ, {"CERES_SOURCE_REVISION": "1" * 40, "CERES_RELEASE_VERSION": "1.2.3"}), \
                patch.object(common, "toolchain_versions", side_effect=versions):
            common.create_metadata(package, source, platform, build, "87" if backend == "JETSON" else "75;86;89")
        return package

    def test_jetson_package_records_driver_and_accepts_jetpack_libraries(self):
        package = self.fixture_package(dependency="libnvbufsurface.so.1.0.0", machine=183,
                                       platform="linux-arm64-jetpack6", backend="JETSON")
        manifest, _, report = verify.verify_contents(package, "linux-arm64-jetpack6", "1.2.3")
        self.assertEqual(manifest["video_backend"], "JETSON")
        self.assertEqual(manifest["cuda_architectures"], ["87"])
        self.assertIn("REVISION: 4.7", manifest["jetson_linux_release"])
        self.assertIn("libnvbufsurface.so.1.0.0", report["system_dependencies"])

    def test_desktop_package_cannot_omit_jetson_libraries(self):
        package = self.fixture_package(dependency="libnvbufsurface.so.1.0.0")
        with self.assertRaisesRegex(ValueError, "Unbundled dependency"):
            verify.verify_contents(package, "linux-x64", "1.2.3")

    def test_jetson_backend_cannot_be_labelled_as_sbsa(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.fixture_package(platform="linux-arm64", machine=183, backend="JETSON")

    def test_cuvid_backend_cannot_be_labelled_as_jetpack(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.fixture_package(platform="linux-arm64-jetpack6", machine=183)

    def test_content_tampering_is_rejected(self):
        package = self.fixture_package()
        verify.verify_contents(package, "linux-x64", "1.2.3")
        (package / "ffmpeg").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
            verify.verify_contents(package, "linux-x64", "1.2.3")

    def test_sbom_records_anatomical_source_licence_and_release_version(self):
        package = self.fixture_package()
        sbom = json.loads((package / "SBOM.spdx.json").read_text())
        hand = next(item for item in sbom["packages"] if item["name"] == "SOMA-X-native-hand-mid")
        self.assertEqual(hand["licenseDeclared"], "Apache-2.0")
        self.assertEqual(hand["versionInfo"], "0.3.1")
        self.assertIn("104578ed58857f6faa7592fb83d0a2dad43c36fa", hand["downloadLocation"])
        exporter = next(item for item in sbom["packages"] if item["name"] == "ceres-native-exporter")
        self.assertEqual(exporter["versionInfo"], "1.2.3")

    def test_undeclared_file_is_rejected(self):
        package = self.fixture_package()
        (package / "extra.dll").write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            verify.verify_contents(package, "linux-x64", "1.2.3")

    def test_missing_transitive_runtime_is_rejected(self):
        package = self.fixture_package(dependency="libnotbundled.so.1")
        with self.assertRaisesRegex(ValueError, "Unbundled dependency"):
            verify.verify_contents(package, "linux-x64", "1.2.3")

    def test_wrong_architecture_is_rejected(self):
        package = self.fixture_package(machine=183)
        with self.assertRaisesRegex(ValueError, "architecture differs"):
            verify.verify_contents(package, "linux-x64", "1.2.3")

    def test_version_override_cannot_disagree_with_source(self):
        source = self.root / "source"
        source.mkdir()
        (source / "package.json").write_text('{"version":"1.2.3"}')
        with patch.dict(os.environ, {"CERES_RELEASE_VERSION": "1.2.4", "CERES_SOURCE_REVISION": "1" * 40}):
            with self.assertRaisesRegex(ValueError, "differs"):
                common.release_identity(source)

    def test_source_archive_needs_explicit_revision(self):
        source = self.root / "source"
        source.mkdir()
        (source / "package.json").write_text('{"version":"1.2.3"}')
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "CERES_SOURCE_REVISION"):
                common.release_identity(source)

    def test_mcap_fixture_has_pose_and_video_records(self):
        path = self.root / "fixture.mcap"
        verify.write_fixture(path, [b"frame0", b"frame1", b"frame2"])
        data = path.read_bytes()
        self.assertEqual(data[:8], b"\x89MCAP0\r\n")
        self.assertEqual(data[-8:], data[:8])
        offset, messages = 8, []
        while offset < len(data) - 8:
            opcode, length = struct.unpack_from("<BQ", data, offset)
            body = data[offset + 9:offset + 9 + length]
            if opcode == 5:
                envelope = body[22:]
                self.assertEqual(envelope[:4], b"CSE1")
                header_length = struct.unpack_from("<I", envelope, 4)[0]
                messages.append(json.loads(envelope[8:8 + header_length]))
            offset += 9 + length
        self.assertEqual(sum(item["kind"] == "video" for item in messages), 3)
        self.assertEqual(sum(item["kind"] == "pose" for item in messages), 9)
        self.assertEqual(messages[-1]["session_time_us"], 100000)

    def test_asset_source_checksums_reject_changed_line_endings(self):
        asset = self.root / "NOTICE"
        asset.write_bytes(b"Model attribution\r\n")
        checksums = {"NOTICE": {"file": "NOTICE", "bytes": asset.stat().st_size, "sha256": verify.sha256(asset)}}
        (self.root / "checksums.json").write_text(json.dumps(checksums))
        verify.verify_asset_checksums(self.root)
        asset.write_bytes(b"Model attribution\n")
        with self.assertRaisesRegex(ValueError, "Asset source checksum differs"):
            verify.verify_asset_checksums(self.root)

    def test_hand_geometry_and_format_must_match_the_model(self):
        directory = self.root / "hands"
        shutil.copytree(SCRIPTS.parent / "assets/hands", directory)
        verify.verify_hand_assets(directory)
        model = directory / "model.json"
        metadata = json.loads(model.read_text())
        model.write_text(json.dumps(dict(metadata, version=1)))
        with self.assertRaisesRegex(ValueError, "identity differs"):
            verify.verify_hand_assets(directory)
        model.write_text(json.dumps(metadata))
        geometry = directory / "geometry.bin"
        geometry.write_bytes(geometry.read_bytes()[:-1])
        with self.assertRaisesRegex(ValueError, "source checksum differs"):
            verify.verify_hand_assets(directory)

    def test_hand_notices_are_required(self):
        directory = self.root / "hands"
        shutil.copytree(SCRIPTS.parent / "assets/hands", directory)
        (directory / "NOTICE").unlink()
        with self.assertRaisesRegex(ValueError, "notices are missing"):
            verify.verify_hand_assets(directory)


if __name__ == "__main__":
    unittest.main()
