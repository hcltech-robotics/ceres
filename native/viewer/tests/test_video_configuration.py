"""Check decoder selection without a CUDA installation or a GPU."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "cmake/VideoBackend.cmake"


@unittest.skipUnless(shutil.which("cmake"), "CMake is required")
class VideoConfigurationTests(unittest.TestCase):
    def configure(self, backend, processor="aarch64", system="Linux", cross=True, graphics="AUTO", core_only=False):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / "select.cmake"
            script.write_text(f'''set(CMAKE_SYSTEM_NAME {system})
set(CMAKE_SYSTEM_PROCESSOR {processor})
set(CMAKE_CROSSCOMPILING {"TRUE" if cross else "FALSE"})
set(CERES_VIDEO_BACKEND {backend} CACHE STRING "")
set(CERES_GRAPHICS_BACKEND {graphics} CACHE STRING "")
set(CERES_BUILD_APP {"FALSE" if core_only else "TRUE"})
include("{MODULE.as_posix()}")
message(STATUS "Selected=${{CERES_SELECTED_VIDEO_BACKEND}}")
''')
            return subprocess.run(["cmake", "-P", str(script)], text=True, capture_output=True)

    def test_explicit_jetson_selects_multimedia_backend(self):
        result = self.configure("JETSON")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Selected=JETSON", result.stdout)

    def test_arm64_cpu_does_not_imply_jetson(self):
        result = self.configure("AUTO")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Selected=CUVID", result.stdout)

    def test_explicit_cuvid_is_supported_on_arm64(self):
        result = self.configure("CUVID")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Selected=CUVID", result.stdout)

    def test_jetson_cannot_be_selected_on_windows_or_x64(self):
        for processor, system in (("AMD64", "Windows"), ("x86_64", "Linux")):
            with self.subTest(processor=processor, system=system):
                result = self.configure("JETSON", processor, system)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires Linux ARM64", result.stderr)

    def test_macos_selects_videotoolbox(self):
        result = self.configure("AUTO", "arm64", "Darwin")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Selected=VIDEOTOOLBOX", result.stdout)

    def test_macos_rejects_nvidia_decoder(self):
        result = self.configure("CUVID", "arm64", "Darwin")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("METAL graphics requires VIDEOTOOLBOX", result.stderr)

    def test_videotoolbox_rejects_linux(self):
        result = self.configure("VIDEOTOOLBOX")
        self.assertNotEqual(result.returncode, 0)

    def test_intel_mac_is_rejected(self):
        result = self.configure("AUTO", "x86_64", "Darwin")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires Apple Silicon", result.stderr)

    def test_cpu_only_build_remains_portable_on_intel_mac(self):
        result = self.configure("AUTO", "x86_64", "Darwin", core_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_graphics_backend_combinations_are_validated(self):
        for processor, system, graphics in (("x86_64", "Linux", "METAL"),
                                            ("arm64", "Darwin", "OPENGL_CUDA"),
                                            ("arm64", "Darwin", "UNKNOWN")):
            with self.subTest(system=system, graphics=graphics):
                result = self.configure("AUTO", processor, system, graphics=graphics)
                self.assertNotEqual(result.returncode, 0)

    def test_unknown_backend_is_rejected(self):
        result = self.configure("UNKNOWN")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be AUTO, CUVID, JETSON or VIDEOTOOLBOX", result.stderr)


if __name__ == "__main__":
    unittest.main()
