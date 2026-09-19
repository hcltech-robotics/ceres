"""Generate software-decoded NV12 references and compare a hardware probe report."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def fnv1a64(data):
    value = 14695981039346656037
    for byte in data:
        value = ((value ^ byte) * 1099511628211) & 0xffffffffffffffff
    return f"{value:016x}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--hardware-report", type=Path)
    parser.add_argument("--comparison", type=Path)
    args = parser.parse_args()
    output = args.output or args.inputs / "nvdec-cpu-reference.json"
    version = subprocess.check_output([args.ffmpeg, "-version"], text=True).splitlines()[0]
    references = []
    for suffix, width, height in [("640x480-a", 640, 480), ("1280x960-b", 1280, 960),
                                  ("640x480-c", 640, 480)]:
        source = args.inputs / f"nvdec-resolution-{suffix}.h264"
        encoded = source.read_bytes()
        decoded = subprocess.check_output([
            args.ffmpeg, "-hide_banner", "-loglevel", "error", "-hwaccel", "none",
            "-i", str(source), "-pix_fmt", "nv12", "-fps_mode", "passthrough",
            "-f", "rawvideo", "pipe:1"
        ])
        stride = width * height * 3 // 2
        if len(decoded) != 6 * stride:
            raise RuntimeError(f"Expected exactly six {width}x{height} frames from {source}")
        hashes = [fnv1a64(memoryview(decoded)[offset:offset + stride])
                  for offset in range(0, len(decoded), stride)]
        references.append({"file": source.name, "sha256": hashlib.sha256(encoded).hexdigest(),
                           "input_fnv1a64": fnv1a64(encoded), "width": width, "height": height,
                           "input_bytes": len(encoded), "cpu_nv12_fnv1a64": hashes})
    reference = {"schema": "ceres-viewer-nvdec-cpu-reference", "version": 2,
                 "ffmpeg": version, "gpu_executed": False,
                 "method": "Software H.264 decode to packed NV12 and FNV1a64 over every byte",
                 "sources": references}
    output.write_text(json.dumps(reference, indent=2) + "\n", encoding="utf-8")
    print(f"Generated 18 complete NV12 frame references: {output}")
    if args.hardware_report:
        hardware = json.loads(args.hardware_report.read_text(encoding="utf-8"))
        expected = [value for source in references for value in source["cpu_nv12_fnv1a64"]]
        expected.extend(references[-1]["cpu_nv12_fnv1a64"][:2])
        actual = [frame["nv12_fnv1a64"] for frame in hardware["frames"]]
        match = hardware["passed"] and actual == expected
        result = {"schema": "ceres-viewer-nvdec-cpu-comparison", "version": 1,
                  "hardware_report": str(args.hardware_report), "reference_file": str(output),
                  "nvdec_source_sha256": hardware.get("nvdec_source_sha256"),
                  "compared_frames": len(actual), "expected_frames": len(expected),
                  "bit_exact_match": match, "gpu_executed_during_reference_check": False,
                  "mismatches": [{"frame": index + 1, "actual": value,
                                  "expected": expected[index] if index < len(expected) else None}
                                 for index, value in enumerate(actual)
                                 if index >= len(expected) or value != expected[index]]}
        destination = args.comparison or args.hardware_report.with_name(args.hardware_report.stem + "-reference.json")
        destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"compared_frames": len(actual), "bit_exact_match": match,
                          "mismatches": result["mismatches"]}))
        if not match:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
