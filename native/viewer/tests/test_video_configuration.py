"""Check decoder selection without a CUDA installation or a GPU."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "cmake/VideoBackend.cmake"


@unittest.skipUnless(shutil.which("cmake"), "CMake is required")
class VideoConfigurationTests(unittest.TestCase):
    def configure(self, backend, processor="aarch64", system="Linux", cross=True):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / "select.cmake"
            script.write_text(f'''set(CMAKE_SYSTEM_NAME {system})
set(CMAKE_SYSTEM_PROCESSOR {processor})
set(CMAKE_CROSSCOMPILING {"TRUE" if cross else "FALSE"})
set(CERES_VIDEO_BACKEND {backend} CACHE STRING "")
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

    def test_unknown_backend_is_rejected(self):
        result = self.configure("UNKNOWN")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be AUTO, CUVID or JETSON", result.stderr)


if __name__ == "__main__":
    unittest.main()
