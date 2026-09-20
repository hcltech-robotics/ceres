"""Native exporter build wiring, using CMake, a C compiler and a Cargo fixture."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "cmake" / "NativeExporter.cmake"
COMPILER = next((found for name in ("cc", "gcc", "clang", "cl")
                 if (found := shutil.which(name))), None)
TOOLS_AVAILABLE = shutil.which("cmake") and shutil.which("ninja") and COMPILER
SUFFIX = ".exe" if os.name == "nt" else ""


@unittest.skipUnless(TOOLS_AVAILABLE, "CMake, Ninja and a C compiler are required")
class ExporterBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ceres exporter build ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source with spaces"
        self.viewer = self.source / "native" / "viewer"
        self.build = self.root / "build with spaces"
        self.inputs = (
            "native/lerobot-exporter/Cargo.toml",
            "native/lerobot-exporter/Cargo.lock",
            "native/lerobot-exporter/build.rs",
            "native/lerobot-exporter/src/main.rs",
            "wasm/lerobot-exporter/Cargo.toml",
            "wasm/lerobot-exporter/src/lib.rs",
            "package.json",
        )
        for name in self.inputs:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name, encoding="utf-8")
        (self.viewer / "cmake").mkdir(parents=True)
        shutil.copyfile(MODULE, self.viewer / "cmake" / MODULE.name)
        (self.viewer / "viewer.c").write_text("int main(void) { return 0; }\n", encoding="utf-8")
        (self.viewer / "CMakeLists.txt").write_text('''cmake_minimum_required(VERSION 3.25)
project(ExporterBuild LANGUAGES C)
add_executable(ceres-viewer viewer.c)
set_target_properties(ceres-viewer PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/viewer output")
include(cmake/NativeExporter.cmake)
ceres_add_native_exporter(ceres-viewer)
install(TARGETS ceres-viewer RUNTIME DESTINATION . COMPONENT ViewerRuntime)
''', encoding="utf-8")
        cargo_script = self.root / "cargo fixture.py"
        cargo_script.write_text('''import hashlib
import json
from pathlib import Path
import sys

args = sys.argv[1:]
assert args[0] == "build" and "--locked" in args and "--release" in args
assert args[args.index("--bin") + 1] == "ceres-native-exporter"
manifest = Path(args[args.index("--manifest-path") + 1])
root = manifest.parents[2]
if (root / "fail-cargo").exists():
    sys.exit(42)
output = Path(args[args.index("--target-dir") + 1]) / "release" / ("ceres-native-exporter" + SUFFIX)
output.parent.mkdir(parents=True, exist_ok=True)
digest = hashlib.sha256()
for name in INPUTS:
    digest.update((root / name).read_bytes())
content = digest.hexdigest().encode()
if not output.exists() or output.read_bytes() != content:
    output.write_bytes(content)
with (root / "cargo-calls.jsonl").open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\\n")
'''.replace("SUFFIX", repr(SUFFIX)).replace("INPUTS", repr(self.inputs)), encoding="utf-8")
        if os.name == "nt":
            self.cargo = self.root / "cargo fixture.cmd"
            self.cargo.write_text(f'@echo off\n"{sys.executable}" "{cargo_script}" %*\nexit /b %errorlevel%\n', encoding="utf-8")
        else:
            self.cargo = self.root / "cargo fixture"
            self.cargo.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{cargo_script}" "$@"\n', encoding="utf-8")
            self.cargo.chmod(0o755)

    def command(self, *args, success=True):
        result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def configure(self, generator="Ninja"):
        self.command("cmake", "-S", self.viewer, "-B", self.build, "-G", generator,
                     f"-DCMAKE_C_COMPILER={COMPILER}", f"-DCARGO_EXECUTABLE={self.cargo}",
                     "-DCMAKE_BUILD_TYPE=Release")

    def stage(self, config=None):
        directory = self.build / "viewer output"
        if config:
            directory /= config
        return directory / ("ceres-native-exporter" + SUFFIX)

    def test_default_and_explicit_viewer_targets_stage_the_exporter(self):
        self.configure()
        self.command("cmake", "--build", self.build)
        self.assertTrue(self.stage().is_file())
        self.assertTrue((self.stage().parent / ("ceres-viewer" + SUFFIX)).is_file())
        initial = self.stage().read_bytes()
        self.stage().unlink()
        self.command("cmake", "--build", self.build, "--target", "ceres-viewer")
        self.assertEqual(self.stage().read_bytes(), initial)

    def test_incremental_rust_inputs_refresh_without_relinking_the_viewer(self):
        self.configure()
        self.command("cmake", "--build", self.build, "--target", "ceres-viewer")
        viewer = self.stage().parent / ("ceres-viewer" + SUFFIX)
        viewer_time = viewer.stat().st_mtime_ns
        staged_time = self.stage().stat().st_mtime_ns
        previous = self.stage().read_bytes()
        self.command("cmake", "--build", self.build, "--target", "ceres-viewer")
        self.assertEqual(self.stage().stat().st_mtime_ns, staged_time)
        for name in self.inputs:
            with self.subTest(input=name):
                with (self.source / name).open("a", encoding="utf-8") as stream:
                    stream.write("\nchanged")
                self.command("cmake", "--build", self.build, "--target", "ceres-viewer")
                current = self.stage().read_bytes()
                self.assertNotEqual(current, previous)
                self.assertEqual(viewer.stat().st_mtime_ns, viewer_time)
                previous = current

    def test_deleted_cargo_output_is_restored_and_cargo_failure_fails_the_build(self):
        self.configure()
        self.command("cmake", "--build", self.build, "--target", "ceres-viewer")
        cached = self.build / "exporter-target" / "release" / self.stage().name
        cached.unlink()
        self.stage().unlink()
        self.command("cmake", "--build", self.build, "--target", "ceres-native-exporter")
        self.assertEqual(cached.read_bytes(), self.stage().read_bytes())
        (self.source / "fail-cargo").touch()
        self.command("cmake", "--build", self.build, "--target", "ceres-viewer", success=False)

    def test_single_configuration_install_contains_both_executables(self):
        self.configure()
        self.command("cmake", "--build", self.build, "--target", "ceres-viewer")
        destination = self.root / "installed runtime"
        self.command("cmake", "--install", self.build, "--component", "ViewerRuntime", "--prefix", destination)
        self.assertEqual((destination / self.stage().name).read_bytes(), self.stage().read_bytes())
        self.assertTrue((destination / ("ceres-viewer" + SUFFIX)).is_file())

    def test_multiple_configurations_stage_and_install_beside_the_selected_viewer(self):
        self.configure("Ninja Multi-Config")
        for config in ("Release", "Debug"):
            with self.subTest(config=config):
                self.command("cmake", "--build", self.build, "--config", config, "--target", "ceres-viewer")
                self.assertTrue(self.stage(config).is_file())
                self.stage(config).unlink()
                self.command("cmake", "--build", self.build, "--config", config, "--target", "ceres-viewer")
                destination = self.root / ("installed " + config)
                self.command("cmake", "--install", self.build, "--config", config,
                             "--component", "ViewerRuntime", "--prefix", destination)
                self.assertEqual((destination / self.stage(config).name).read_bytes(), self.stage(config).read_bytes())
                self.assertTrue((destination / ("ceres-viewer" + SUFFIX)).is_file())
        calls = [json.loads(line) for line in (self.source / "cargo-calls.jsonl").read_text().splitlines()]
        self.assertEqual(len(calls), 4)
        self.assertTrue(all("--release" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
