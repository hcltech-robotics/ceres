#!/usr/bin/env python3
"""Run the macOS backend feasibility gate; this is not full application qualification."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys


def capture(command):
    return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT, timeout=30).strip()


def run_probe(command, log):
    result = subprocess.run(list(map(str, command)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    log.write_bytes(result.stdout)
    if result.returncode:
        raise RuntimeError(f"{command[0].name} failed; see {log}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, default=Path(__file__).resolve().parents[1] / "tests/fixtures/nvdec")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-baseline", action="store_true", help="Require an Apple M1 with 16 GiB RAM")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Run these probes on an Apple Silicon Mac")
    output, build = args.output.resolve(), args.build.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "ceres-macos-backend-probes", "version": 1, "passed": False,
              "graphics_backend": "METAL", "compute_backend": "METAL", "video_backend": "VIDEOTOOLBOX",
              "application_qualified": False, "completed_at": None}
    try:
        report["chip"] = capture(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"])
        report["memory_bytes"] = int(capture(["/usr/sbin/sysctl", "-n", "hw.memsize"]))
        report["macos"] = capture(["/usr/bin/sw_vers", "-productVersion"])
        report["macos_build"] = capture(["/usr/bin/sw_vers", "-buildVersion"])
        report["baseline_match"] = report["chip"] == "Apple M1" and report["memory_bytes"] == 16 * 1024**3
        if args.require_baseline and not report["baseline_match"]:
            raise RuntimeError("This Mac is not the Apple M1/16 GiB qualification baseline")
        if int(report["macos"].split(".")[0]) < 14:
            raise RuntimeError("The macOS deployment baseline is 14.0")
        files = [build / name for name in ("test_videotoolbox", "test_image_metal", "test_metal_reduction", "ceres-probes.metallib")]
        files += sorted(args.fixtures.resolve().glob("*"))
        report["inputs"] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
        run_probe([build / "test_videotoolbox", "--run-gpu", args.fixtures.resolve(), output / "videotoolbox.json"],
                  output / "videotoolbox.log")
        run_probe([build / "test_image_metal", build / "ceres-probes.metallib", output / "image.json"],
                  output / "image.log")
        run_probe([build / "test_metal_reduction", build / "ceres-probes.metallib", output / "reduction.json"],
                  output / "reduction.log")
        report["decoder"] = json.loads((output / "videotoolbox.json").read_text())
        report["image"] = json.loads((output / "image.json").read_text())
        report["reduction"] = json.loads((output / "reduction.json").read_text())
        if not all(report[name].get("passed") for name in ("decoder", "image", "reduction")):
            raise RuntimeError("A backend probe did not pass")
        report["passed"] = True
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    report["completed_at"] = datetime.now(timezone.utc).isoformat()
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
