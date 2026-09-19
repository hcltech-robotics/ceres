"""Bounded NVIDIA qualification of the exact portable release archive."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import math
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
    focal = 1 / math.tan(math.radians(70) / 2)
    near, far = 0.1, 10.0
    projection = [focal / (32 / 24), 0, 0, 0, 0, focal, 0, 0,
                  0, 0, (far + near) / (near - far), -1,
                  0, 0, 2 * far * near / (near - far), 0]
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
                     "world_from_view": world, "projection": projection,
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
    if not windows and not os.access(matches[0], os.X_OK):
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


def check_scene_assets(metrics: dict) -> None:
    assets = metrics.get("scene_assets", {})
    hands = assets.get("hands", {})
    metadata = hands.get("metadata", {})
    if metadata.get("name") != "soma-hand-mid" or metadata.get("retargeting") != "webxr-anatomical-v1":
        raise RuntimeError("Public package did not load its anatomical hand meshes")
    meshes = hands.get("meshes", [])
    if len(meshes) != 2 or {mesh.get("side") for mesh in meshes} != {"left", "right"} or any(
            mesh.get("vertices") != 2859 or mesh.get("triangles") != 5692 for mesh in meshes):
        raise RuntimeError("Public package hand geometry differs from the bundled model")
    if assets.get("headset", {}).get("triangles", 0) <= 0:
        raise RuntimeError("Public package did not load its Quest model")


def check_frozen_recording_events(events, freeze_us: int) -> dict:
    """Require acquisition-matched depth on both sides of the map freeze."""
    heads = {}
    depths = []
    for header, payload in events:
        if header["kind"] == "pose" and header["stream"] == "head":
            if len(payload) != 68 or payload[:4] != b"CBR1":
                raise RuntimeError("Recorded fixture head pose is malformed")
            target = struct.unpack_from("<Q", payload, 32)[0]
            heads[(header["epoch"], header["space_epoch"], target)] = struct.unpack_from("<7f", payload, 40)
        elif header["kind"] == "depth":
            if len(payload) < 8 or payload[:4] != b"CED1":
                raise RuntimeError("Recorded fixture depth is malformed")
            size = struct.unpack_from("<I", payload, 4)[0]
            metadata = json.loads(payload[8:8 + size])
            pixels = payload[8 + size:]
            if (metadata.get("mapping_version") != 2 or metadata.get("width") != 32 or
                    metadata.get("height") != 24 or len(pixels) != 32 * 24 * 2 or
                    any(value != 1500 for value in struct.unpack("<768H", pixels)) or
                    metadata.get("observed_us") != metadata.get("target_us")):
                raise RuntimeError("Recorded fixture depth changed its acquisition contract")
            elapsed = header.get("attributes", {}).get("fixture_elapsed_us")
            if type(elapsed) is not int or elapsed < 0:
                raise RuntimeError("Recorded fixture depth lacks its acquisition time")
            depths.append((metadata, elapsed))
    before = after = 0
    latest = -1
    for metadata, elapsed in depths:
        head = heads.get((metadata["epoch"], metadata["space_epoch"], metadata["target_us"]))
        world = metadata["world_from_view"]
        if (head is None or any(not math.isfinite(value) for value in head) or
                any(abs(value) > 1e-6 for value in head[3:6]) or abs(head[6] - 1) > 1e-6):
            raise RuntimeError("Recorded depth is not matched to its acquisition head pose")
        expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, *head[:3], 1]
        if (len(world) != 16 or any(not math.isfinite(value) or abs(value - target) > 1e-5
                                   for value, target in zip(world, expected))):
            raise RuntimeError("Recorded depth is not matched to its acquisition head pose")
        before += elapsed < freeze_us
        after += elapsed >= freeze_us + 500000
        latest = max(latest, elapsed)
    if before < 2 or after < 2 or latest < freeze_us + 1000000:
        raise RuntimeError("Depth recording did not continue through the map freeze")
    return {"depth_frames": len(depths), "before_freeze": before,
            "after_freeze": after, "latest_acquisition_us": latest, "freeze_us": freeze_us}


def check_rendered_fixture(path: Path) -> dict:
    """Find the decoded testsrc2 bars in the captured viewer scene."""
    parts = path.read_bytes().split(b"\n", 3)
    if len(parts) != 4 or parts[0] != b"P6" or parts[2] != b"255":
        raise RuntimeError("Rendered qualification screenshot has an invalid PPM header")
    try:
        width, height = map(int, parts[1].split())
    except ValueError as error:
        raise RuntimeError("Rendered qualification screenshot has invalid dimensions") from error
    pixels = parts[3]
    if width < 960 or height < 640 or len(pixels) != width * height * 3:
        raise RuntimeError("Rendered qualification screenshot is missing or incomplete")

    # The fixture contains these six saturated bars, from left to right. Ignore
    # antialiased edges, the moving pattern and the hands in front of the video.
    bars = (("red", 4), ("green", 2), ("yellow", 6),
            ("blue", 1), ("magenta", 5), ("cyan", 3))
    samples = {mask: [0, 0, 0, height, -1] for _, mask in bars}
    stride = max(1, min(width, height) // 160)
    sample_count = len(range(0, width, stride)) * len(range(0, height, stride))
    for y in range(0, height, stride):
        for x in range(0, width, stride):
            offset = (y * width + x) * 3
            red, green, blue = pixels[offset:offset + 3]
            if any(96 <= value < 160 for value in (red, green, blue)):
                continue
            mask = (4 if red >= 160 else 0) | (2 if green >= 160 else 0) | (1 if blue >= 160 else 0)
            if mask not in samples:
                continue
            point = samples[mask]
            point[0] += 1
            point[1] += x
            point[2] += y
            point[3] = min(point[3], y)
            point[4] = max(point[4], y)

    result = {}
    for name, mask in bars:
        count, total_x, total_y, top, bottom = samples[mask]
        if count < sample_count * 0.005 or bottom - top < height * 0.2:
            raise RuntimeError(f"Rendered qualification screenshot lacks the fixture's {name} bar")
        result[name] = {"coverage": count / sample_count, "x": total_x / count, "y": total_y / count}
    centres = list(result.values())
    if any(right["x"] - left["x"] < width * 0.025 for left, right in zip(centres, centres[1:])):
        raise RuntimeError("Rendered qualification colour bars are not in the fixture's left-to-right order")
    if centres[-1]["x"] - centres[0]["x"] < width * 0.25:
        raise RuntimeError("Rendered qualification colour bars do not cover the fixture's scene width")
    if max(point["y"] for point in centres) - min(point["y"] for point in centres) > height * 0.15:
        raise RuntimeError("Rendered qualification colour bars are not aligned in the fixture's scene")
    return {"width": width, "height": height, "colour_bars": result}


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
    for name in ("test_image", "test_stereo_cuda", "test_voxel_cuda", "test_depth_cuda",
                 "test_spatial_map_render", "test_spatial_map_lifecycle"):
        memory_check(target)
        binary = find_binary(args.build_tests, name, windows)
        test_env = dict(environment)
        if windows:
            test_env["PATH"] = str(package) + os.pathsep + environment["PATH"]
        command = [str(binary)]
        if name == "test_spatial_map_lifecycle":
            command += ["--assets", str(package / "assets")]
        run(command, work, work / f"{name}.log", env=test_env)
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
    check_scene_assets(metrics)
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
    check_scene_assets(replay)
    for name in ("record.ppm", "replay.ppm"):
        check_rendered_fixture(work / name)
    memory_check(target)
    frozen_recording = work / "frozen-recording.mcap"
    freeze_us = 4500000
    preferences = read_json(config / "preferences.json")
    preferences["view"].update({"depth": True, "depth_source": 1, "map_frozen": False})
    (config / "preferences.json").write_text(json.dumps(preferences), encoding="utf-8")
    run(base + ["--fixture", "--fixture-depth", "--fixture-video", str(fixture),
                "--freeze-map-after", "4.5", "--seconds", "8",
                "--record", str(frozen_recording), "--metrics", str(work / "frozen.json"),
                "--screenshot", str(work / "frozen.ppm")], work, work / "frozen.log",
        env=environment, timeout=45)
    frozen = read_json(work / "frozen.json")
    check_metrics(frozen)
    if (not frozen.get("map_frozen") or frozen.get("map_error") or
            frozen.get("map_point_count", 0) == 0 or
            frozen.get("environment_depth_updates", 0) < 2 or
            frozen.get("environment_depth_updates") != frozen.get("map_freeze_environment_updates")):
        raise RuntimeError("Freezing the spatial map did not preserve its acquired surface")
    saved_map = Path(frozen["map_file"])
    if not saved_map.is_file() or saved_map.stat().st_size > frozen["map_max_bytes"]:
        raise RuntimeError("The spatial map was not saved within its configured size")
    from mcap.reader import make_reader
    with frozen_recording.open("rb") as stream:
        def events():
            for _, _, message in make_reader(stream, validate_crcs=True).iter_messages():
                size = struct.unpack_from("<I", message.data, 4)[0]
                yield json.loads(message.data[8:8 + size]), message.data[8 + size:]
        frozen_recording_proof = check_frozen_recording_events(events(), freeze_us)
    if frozen.get("environment_depth_received", 0) < frozen_recording_proof["depth_frames"]:
        raise RuntimeError("The live depth input did not continue while the map was frozen")
    (work / "frozen-recording-proof.json").write_text(json.dumps(frozen_recording_proof, indent=2) + "\n")
    run([str(executable), "--hidden", "--no-connect", "--no-vsync", "--seconds", "1.5",
         "--config-dir", str(work / "loaded-config"), "--load-map", str(saved_map),
         "--metrics", str(work / "loaded.json")], work, work / "loaded.log",
        env=environment, timeout=30)
    loaded = read_json(work / "loaded.json")
    if (loaded.get("map_error") or not loaded.get("map_frozen") or
            loaded.get("map_point_count") != frozen["map_point_count"]):
        raise RuntimeError("The saved spatial map did not reopen with its complete surface")
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
