"""Bounded NVIDIA qualification of the exact portable release archive."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
from datetime import datetime, timezone

from qualification import CHECKS, archive_name, digest, fingerprint, read_json, run


def memory_check(target: str) -> None:
    if target != "linux-arm64":
        return
    fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    available = int(fields["MemAvailable"].split()[0]) * 1024
    if available < 4 * 1024**3:
        raise RuntimeError("ARM64 qualification requires at least 4 GiB available system memory")


def envelope(header: dict, payload: bytes) -> bytes:
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return b"CSE1" + struct.pack("<I", len(encoded)) + encoded + payload


def make_dual_depth_recording(source: Path, output: Path) -> None:
    from mcap.reader import make_reader
    from mcap.writer import CompressionType, Writer

    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    world = identity.copy()
    world[13] = 1.6
    with source.open("rb") as input_stream, output.open("wb") as output_stream:
        reader = make_reader(input_stream, validate_crcs=True)
        writer = Writer(output_stream, compression=CompressionType.NONE)
        writer.start(profile="ceres-session-v1")
        channel = writer.register_channel("ceres/events", "ceres-session-v1", 0)
        for _, _, message in reader.iter_messages(log_time_order=False):
            size = struct.unpack_from("<I", message.data, 4)[0]
            header = json.loads(message.data[8:8 + size])
            payload = message.data[8 + size:]
            if header["kind"] == "metadata" and header["attributes"].get("type") == "description":
                camera = header["attributes"]["camera"]
                header["attributes"]["cameras"] = [dict(camera, mid="0", side="right"),
                                                     dict(camera, mid="1", side="left")]
            writer.add_message(channel, message.log_time, envelope(header, payload), message.publish_time)
            if header["kind"] != "video":
                continue
            second = copy.deepcopy(header)
            second["stream"] = "passthrough_left"
            second["attributes"]["side"] = "left"
            second["attributes"]["mid"] = "1"
            writer.add_message(channel, message.log_time, envelope(second, payload), message.publish_time)
            depth = {"version": 1, "epoch": header["epoch"], "space_epoch": header["space_epoch"],
                     "sequence": header["sequence"], "observed_us": header["time_us"],
                     "target_us": header["time_us"], "width": 32, "height": 24,
                     "source_width": 32, "source_height": 24, "eye": "left", "usage": "cpu-optimized",
                     "source_format": "luminance-alpha", "depth_format": "uint16-mm",
                     "world_from_view": world, "projection": identity,
                     "norm_depth_from_norm_view": identity}
            text = json.dumps(depth, separators=(",", ":")).encode("utf-8")
            depth_payload = b"CED1" + struct.pack("<I", len(text)) + text + struct.pack("<768H", *([1500] * 768))
            depth_event = copy.deepcopy(header)
            depth_event["kind"] = "depth"
            depth_event["stream"] = "environment_depth"
            depth_event["attributes"] = {"usage": "cpu-optimized"}
            writer.add_message(channel, message.log_time, envelope(depth_event, depth_payload), message.publish_time)
        writer.finish()


def find_binary(directory: Path, name: str, windows: bool) -> Path:
    name += ".exe" if windows else ""
    matches = [p for p in directory.rglob(name) if p.is_file()]
    if len(matches) != 1:
        raise ValueError(f"Expected one {name} in the GPU test bundle")
    if not windows:
        matches[0].chmod(matches[0].stat().st_mode | 0o111)
    return matches[0].resolve()


def check_metrics(metrics: dict, *, dual: bool = False) -> None:
    for key in ("render_frames", "decoded_frames", "presented_frames"):
        if metrics.get(key, 0) < 2:
            raise RuntimeError(f"Viewer did not advance {key}")
    for key in ("decoder_error", "secondary_decoder_error", "record_error"):
        if metrics.get(key):
            raise RuntimeError(f"Viewer reported {key}: {metrics[key]}")
    if "nvidia" not in metrics.get("opengl_vendor", "").lower():
        raise RuntimeError("Viewer did not use an NVIDIA OpenGL context")
    if dual:
        if metrics.get("secondary_decoded_frames", 0) < 2:
            raise RuntimeError("The second camera did not decode")
        if metrics.get("environment_depth_updates", 0) < 2 or metrics.get("map_memory_bytes", 0) <= 0:
            raise RuntimeError("Environment depth did not accumulate")


def record(args: argparse.Namespace) -> dict:
    root = args.root.resolve()
    archive = args.archive.resolve()
    inputs = read_json(args.inputs)
    target = inputs["platform"]
    windows = target == "windows-x64"
    if archive.name != archive_name(inputs):
        raise ValueError("Archive name differs from its build input manifest")
    memory_check(target)
    work = args.work_dir.resolve()
    if work.exists() and any(work.iterdir()):
        raise ValueError("Use an empty hardware qualification work directory")
    work.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("verify_package", root / "native/viewer/scripts/verify-package.py")
    verifier = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = verifier
    spec.loader.exec_module(verifier)
    verified = verifier.verify_package(archive, target, inputs["release_version"], work / "extracted")
    package = Path(verified["package_root"]).resolve()
    environment = dict(os.environ)
    for key in list(environment):
        if key.startswith("CUDA") or key in {"LD_PRELOAD", "LIBRARY_PATH", "PYTHONPATH"}:
            environment.pop(key, None)
    if windows:
        environment["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
    else:
        environment["PATH"] = "/usr/bin:/bin"
        environment["LD_LIBRARY_PATH"] = str(package / "lib")
    identity = run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
                   work, work / "gpu.txt", timeout=30).strip()
    for name in ("test_image", "test_stereo_cuda", "test_voxel_cuda", "test_depth_cuda"):
        memory_check(target)
        binary = find_binary(args.build_tests, name, windows)
        test_env = dict(environment)
        if windows:
            test_env["PATH"] = str(package) + os.pathsep + environment["PATH"]
        run([str(binary)], work, work / f"{name}.log", env=test_env)
    decoder = find_binary(args.build_tests, "test_nvdec", windows)
    decoder_env = dict(environment)
    if windows:
        decoder_env["PATH"] = str(package) + os.pathsep + environment["PATH"]
    run([str(decoder), "--run-gpu", str(root / "native/viewer/tests/fixtures/nvdec"), str(work / "nvdec.json")],
        work, work / "nvdec.log", env=decoder_env)
    executable = package / ("ceres-viewer.exe" if windows else "ceres-viewer")
    if not executable.is_file():
        raise ValueError("Packaged viewer launcher is missing")
    fixture = root / "native/viewer/tests/fixtures/nvdec/nvdec-resolution-640x480-a.h264"
    recording = work / "recording.mcap"
    config = work / "config"
    base = [str(executable), "--hidden", "--no-connect", "--no-vsync", "--width", "960", "--height", "640",
            "--fps", "60", "--config-dir", str(config)]
    memory_check(target)
    run(base + ["--fixture", "--fixture-video", str(fixture), "--record", str(recording),
                "--seconds", "7", "--metrics", str(work / "record.json"),
                "--screenshot", str(work / "record.ppm")], work, work / "record.log", env=environment, timeout=45)
    metrics = read_json(work / "record.json")
    check_metrics(metrics)
    assets = metrics.get("scene_assets", {})
    if assets.get("hands", {}).get("metadata", {}).get("name") != "ceres-original-hand-rig":
        raise RuntimeError("Public package did not load the original hand meshes")
    if assets.get("headset", {}).get("triangles", 0) <= 0:
        raise RuntimeError("Public package did not load its Quest model")
    if metrics.get("record_failed") or metrics.get("record_written_events", 0) < 2 or not recording.is_file():
        raise RuntimeError("Fixture recording did not finish")
    run([sys.executable, str(root / "native/viewer/scripts/verify-recording.py"), str(recording),
         "--report", str(work / "recording-report.json")], work, work / "recording-check.log")
    dual = work / "dual-depth.mcap"
    make_dual_depth_recording(recording, dual)
    preferences = read_json(config / "preferences.json")
    preferences["view"].update({"depth": True, "depth_source": 1})
    (config / "preferences.json").write_text(json.dumps(preferences), encoding="utf-8")
    memory_check(target)
    run(base + ["--replay", str(dual), "--seconds", "5", "--metrics", str(work / "replay.json"),
                "--screenshot", str(work / "replay.ppm")], work, work / "replay.log", env=environment, timeout=45)
    replay = read_json(work / "replay.json")
    check_metrics(replay, dual=True)
    for name in ("record.ppm", "replay.ppm"):
        data = (work / name).read_bytes()
        if not data.startswith(b"P6\n") or len(data) < 960 * 640 * 3:
            raise RuntimeError("Rendered qualification screenshot is missing or incomplete")
        if len(set(data[-960 * 640 * 3:])) < 16:
            raise RuntimeError("Rendered qualification image has no visible scene content")
    receipt = {"schema": "ceres-native-hardware-qualification", "version": 1, "status": "passed",
               "platform": target, "input_sha256": fingerprint(root, inputs),
               "source_revision": inputs["source_revision"], "archive_name": archive.name,
               "archive_sha256": digest(archive), "build_inputs_sha256": digest(args.inputs),
               "completed_at": datetime.now(timezone.utc).isoformat(),
               "gpu": metrics.get("gpu"), "driver": identity,
               "graphics": {"vendor": metrics["opengl_vendor"], "renderer": metrics["opengl_renderer"],
                            "version": metrics["opengl_version"]},
               "checks": {name: True for name in sorted(CHECKS)},
               "evidence_sha256": {p.name: digest(p) for p in sorted(work.iterdir())
                                   if p.is_file() and p.suffix in {".json", ".ppm", ".log"}}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, ensure_ascii=True) + "\n", encoding="ascii")
    return receipt
