"""Hardware qualification reuse and release gate regression tests."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("qualification", Path(__file__).parents[1] / "scripts/qualification.py")
qualification = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = qualification
SPEC.loader.exec_module(qualification)


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

    def receipt(self, target, expected):
        return {"schema": "ceres-native-hardware-qualification", "version": 1, "status": "passed",
                "platform": target, "input_sha256": expected, "archive_sha256": "b" * 64,
                "checks": {name: True for name in qualification.CHECKS}, "gpu": "RTX 3090",
                "driver": "591.86", "completed_at": "2026-09-19T12:00:00Z",
                "graphics": {"vendor": "NVIDIA Corporation", "renderer": "RTX 3090"}}

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


if __name__ == "__main__":
    unittest.main()
