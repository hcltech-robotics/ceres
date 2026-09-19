"""Reconstruct recorded Quest sensor depth with the optional cuRobo Mapper."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import importlib.metadata
import importlib.util
import json
import math
from pathlib import Path
import re
import struct
import sys
import time

import numpy as np

CUROBO_REVISION = "78fd485fa82d9b9a063fb4985e371814587e666a"
CUROBO_ARCHIVE_SHA256 = "704151d8ff81a532379d96ce9a036a704547b6bdf1404fa8795d87d80e555922"
CUROBO_SOURCE_SHA256 = "77221d01983537b6de88dabccbc02443102c65d75a4b91a823a9fbfccbe0f626"
MAX_FRAME_BYTES = 8 + 4096 + 256 * 256 * 2
CV_TO_XR = np.diag([1.0, -1.0, -1.0, 1.0])
REQUIRED_FIELDS = set("version epoch space_epoch sequence observed_us target_us width height "
                      "source_width source_height eye usage source_format depth_format "
                      "world_from_view projection norm_depth_from_norm_view".split())
OPTIONAL_FIELDS = {"geometry_source", "readback_us", "target_lead_us", "mapping_version"}


def strict_json(data: bytes) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON field: {key}")
            result[key] = value
        return result

    def invalid(value):
        raise ValueError(f"Non-finite JSON value: {value}")

    result = json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)
    if not isinstance(result, dict):
        raise ValueError("Metadata must be an object")
    return result


def integer(metadata: dict, name: str, maximum: int, minimum: int = 0) -> int:
    value = metadata[name]
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"Invalid {name}")
    return value


@dataclass(frozen=True)
class DepthObservation:
    metadata: dict
    depth: np.ndarray
    intrinsics: np.ndarray
    world_from_camera: np.ndarray


def matrix(metadata: dict, name: str) -> np.ndarray:
    raw = metadata[name]
    if not isinstance(raw, list) or len(raw) != 16 or any(type(v) not in (int, float) for v in raw):
        raise ValueError(f"{name} requires sixteen numeric values")
    values = np.asarray(metadata[name], dtype=np.float64)
    if (values.shape != (16,) or not np.isfinite(values).all() or
            np.any(np.abs(values) > np.finfo(np.float32).max)):
        raise ValueError(f"{name} must contain sixteen finite column-major values")
    result = values.reshape((4, 4), order="F")
    if abs(np.linalg.det(result)) < 1e-12:
        raise ValueError(f"{name} is singular")
    return result


def decode_ced1(payload: bytes) -> tuple[dict, np.ndarray]:
    if len(payload) < 8 or len(payload) > MAX_FRAME_BYTES or payload[:4] != b"CED1":
        raise ValueError("Invalid CED1 envelope")
    length = struct.unpack_from("<I", payload, 4)[0]
    if not 0 < length <= 4096 or 8 + length > len(payload):
        raise ValueError("Invalid CED1 metadata length")
    metadata = strict_json(payload[8:8 + length])
    if not REQUIRED_FIELDS <= metadata.keys() or metadata.keys() - REQUIRED_FIELDS - OPTIONAL_FIELDS:
        raise ValueError("Unexpected or missing CED1 metadata fields")
    integer(metadata, "version", 1, 1)
    width, height = (integer(metadata, key, 256, 1) for key in ("width", "height"))
    integer(metadata, "source_width", 8192, width)
    integer(metadata, "source_height", 8192, height)
    for key, choices in {"eye": ("left", "right", "none"),
                         "usage": ("cpu-optimized", "gpu-optimized"),
                         "source_format": ("luminance-alpha", "float32", "unsigned-short"),
                         "depth_format": ("uint16-mm",)}.items():
        if metadata[key] not in choices:
            raise ValueError(f"Unsupported {key}")
    if len(payload) != 8 + length + width * height * 2:
        raise ValueError("Quest depth payload length does not match its dimensions")
    for key in ("epoch", "space_epoch", "sequence"):
        integer(metadata, key, 0xFFFFFFFF)
    for key in ("observed_us", "target_us", "readback_us"):
        if key in metadata:
            integer(metadata, key, 9007199254740991)
    if "geometry_source" in metadata and metadata["geometry_source"] not in ("sensor", "view", "view-fallback"):
        raise ValueError("Unsupported geometry_source")
    if "mapping_version" in metadata:
        integer(metadata, "mapping_version", 2, 2)
    if "target_lead_us" in metadata:
        lead = integer(metadata, "target_lead_us", 9007199254740991, -9007199254740991)
        if lead != metadata["target_us"] - metadata["observed_us"]:
            raise ValueError("Depth target lead disagrees with its timestamps")
    for key in ("world_from_view", "projection", "norm_depth_from_norm_view"):
        matrix(metadata, key)
    if not np.allclose(matrix(metadata, "world_from_view")[3], [0, 0, 0, 1], atol=1e-4):
        raise ValueError("Depth view pose must be affine")
    depth = np.frombuffer(payload, dtype="<u2", offset=8 + length).reshape(height, width)
    return metadata, depth.copy()


def rectify(metadata: dict, millimetres: np.ndarray,
            minimum: float = 0.1, maximum: float = 6.0) -> DepthObservation:
    """Use top-left WebXR coordinates and retain axial, rather than radial, depth."""
    height, width = millimetres.shape
    projection = matrix(metadata, "projection")
    world_from_view = matrix(metadata, "world_from_view")
    depth_from_view = matrix(metadata, "norm_depth_from_norm_view")
    if not np.allclose(projection[3], [0, 0, -1, 0], atol=1e-5):
        raise ValueError("Mapper requires a perspective projection")
    if (projection[0, 0] <= 0 or projection[1, 1] <= 0 or
            not np.allclose(projection[[0, 0, 1, 1], [1, 3, 0, 3]], 0, atol=1e-6)):
        raise ValueError("Mapper requires an axis-aligned pinhole projection")
    rotation = world_from_view[:3, :3]
    if (not np.allclose(world_from_view[3], [0, 0, 0, 1], atol=1e-5) or
            not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-4) or
            not np.isclose(np.linalg.det(rotation), 1, atol=1e-4)):
        raise ValueError("Quest acquisition pose must be a rigid transform")
    # The pinned Mapper kernels project pixel centres as px+0.5 and py+0.5.
    intrinsics = np.array([
        [projection[0, 0] * width / 2, 0, (1 - projection[0, 2]) * width / 2],
        [0, projection[1, 1] * height / 2, (1 + projection[1, 2]) * height / 2],
        [0, 0, 1],
    ], dtype=np.float32)
    yy, xx = np.indices((height, width), dtype=np.float64)
    view = np.stack(((xx + .5) / width, (yy + .5) / height,
                     np.zeros_like(xx), np.ones_like(xx)), axis=-1)
    coordinates = view @ depth_from_view.T
    valid = np.isfinite(coordinates).all(axis=-1) & (np.abs(coordinates[..., 3]) > 1e-9)
    divisor = np.where(valid, coordinates[..., 3], 1)
    u, v = coordinates[..., 0] / divisor, coordinates[..., 1] / divisor
    valid &= (u >= 0) & (u < 1) & (v >= 0) & (v < 1)
    x = np.floor(np.clip(u, 0, 1) * width).astype(np.int64).clip(0, width - 1)
    y = np.floor(np.clip(v, 0, 1) * height).astype(np.int64).clip(0, height - 1)
    depth = millimetres[y, x].astype(np.float32) * .001
    valid &= (depth >= minimum) & (depth <= maximum)
    depth[~valid] = 0
    # cuRobo camera: right/down/forward. WebXR view: right/up/backward.
    # This basis change belongs in the pose and must not flip world geometry.
    return DepthObservation(dict(metadata), depth, intrinsics,
                            world_from_view @ CV_TO_XR)


def world_points(observation: DepthObservation) -> np.ndarray:
    height, width = observation.depth.shape
    y, x = np.indices((height, width))
    k = observation.intrinsics
    z = observation.depth
    points = np.stack(((x + .5 - k[0, 2]) * z / k[0, 0],
                       (y + .5 - k[1, 2]) * z / k[1, 1], z), axis=-1)
    return points @ observation.world_from_camera[:3, :3].T + observation.world_from_camera[:3, 3]


def read_exact(stream, count: int) -> bytes:
    output = bytearray()
    while len(output) < count:
        part = stream.read(count - len(output))
        if not part:
            raise ValueError("Truncated depth stream")
        output.extend(part)
    return bytes(output)


def packets(source: str):
    """Read MCAP, one CED1 file or a length-prefixed CED1 stdin stream."""
    if source == "-":
        while prefix := sys.stdin.buffer.read(4):
            if len(prefix) != 4:
                prefix += read_exact(sys.stdin.buffer, 4 - len(prefix))
            length = struct.unpack("<I", prefix)[0]
            if not 8 <= length <= MAX_FRAME_BYTES:
                raise ValueError("Invalid framed CED1 length")
            yield read_exact(sys.stdin.buffer, length)
        return
    path = Path(source)
    if path.suffix.lower() == ".ced1":
        if path.stat().st_size > MAX_FRAME_BYTES:
            raise ValueError("CED1 file exceeds the frame budget")
        yield path.read_bytes()
        return
    from mcap.reader import make_reader
    with path.open("rb") as stream:
        for _, _, message in make_reader(stream, validate_crcs=True).iter_messages():
            data = message.data
            if data[:4] != b"CSE1" or len(data) < 8:
                continue
            length = struct.unpack_from("<I", data, 4)[0]
            if not 0 < length <= 65536 or 8 + length > len(data):
                raise ValueError("Invalid recorded session envelope")
            header = strict_json(data[8:8 + length])
            if header.get("kind") == "depth" and header.get("stream") == "environment_depth":
                integer(header, "version", 1, 1)
                if not isinstance(header.get("attributes"), dict):
                    raise ValueError("Session attributes must be an object")
                for key in ("receive_us", "time_us", "session_receive_us", "session_time_us"):
                    integer(header, key, 0x7FFFFFFFFFFFFFFF)
                payload = data[8 + length:]
                depth_metadata, _ = decode_ced1(payload)
                for key in ("epoch", "space_epoch", "sequence"):
                    if integer(header, key, 0xFFFFFFFF) != depth_metadata[key]:
                        raise ValueError("Session event and CED1 identities disagree")
                yield payload


def checkpoint(mapper, directory: Path, frame_number: int) -> Path:
    """Keep three complete checkpoints owned by this output directory."""
    directory.mkdir(parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError("Checkpoint directory must not be a symbolic link")
    marker = directory / ".quest-mapper-checkpoints"
    if marker.is_symlink():
        raise ValueError("Checkpoint ownership marker must not be a symbolic link")
    if not marker.exists():
        if any(directory.iterdir()):
            raise ValueError("Checkpoint directory contains files from another owner")
        marker.write_text("ceres-quest-mapper-checkpoints-v1\n", encoding="ascii")
    if marker.read_text(encoding="ascii") != "ceres-quest-mapper-checkpoints-v1\n":
        raise ValueError("Unknown checkpoint directory owner")
    target = directory / f"quest-tsdf-{frame_number:08d}.pt"
    pending = directory / (target.name + ".pending")
    if target.is_symlink() or pending.is_symlink():
        raise ValueError("Checkpoint destination must not be a symbolic link")
    mapper.save_blocks(pending)
    pending.replace(target)
    owned = sorted((p for p in directory.iterdir()
                    if re.fullmatch(r"quest-tsdf-[0-9]{8}\.pt", p.name)
                    and p != target and p.is_file() and not p.is_symlink()),
                   key=lambda p: (p.stat().st_mtime_ns, p.name))
    for old in owned[:-2]:
        old.unlink()
    return target


def ppm(path: Path, pixels: np.ndarray) -> None:
    pixels = np.asarray(pixels, dtype=np.uint8)
    height, width, _ = pixels.shape
    path.write_bytes(f"P6\n{width} {height}\n255\n".encode("ascii") + pixels.tobytes())


def run(args) -> dict:
    spec = importlib.util.find_spec("curobo")
    if spec is None or spec.origin is None:
        raise RuntimeError("The pinned optional cuRobo source is not on PYTHONPATH")
    source = Path(spec.origin).parent
    source_hash = hashlib.sha256()
    files = sorted((p for p in source.rglob("*") if p.is_file() and
                    p.suffix in (".py", ".cu", ".cuh", ".h")),
                   key=lambda p: p.relative_to(source).as_posix())
    for path in files:
        source_hash.update(path.relative_to(source).as_posix().encode("utf-8") + b"\0")
        source_hash.update(path.read_bytes())
    if source_hash.hexdigest() != CUROBO_SOURCE_SHA256:
        raise RuntimeError("cuRobo source differs from the pinned Mapper revision")
    import torch
    from curobo._src.perception.mapper.mapper import Mapper
    from curobo._src.perception.mapper.mapper_cfg import MapperCfg
    from curobo._src.types.camera import CameraObservation
    from curobo._src.types.pose import Pose

    if not torch.cuda.is_available():
        raise RuntimeError("The optional Mapper requires CUDA PyTorch")
    free, total = torch.cuda.mem_get_info()
    budget = args.gpu_budget_mib * 1024**2
    if free < budget + 1024**3:
        raise RuntimeError("Mapper requires its GPU budget plus 1 GiB free headroom")
    torch.cuda.set_per_process_memory_fraction(budget / total)
    torch.set_num_threads(2)
    allocation_samples = []

    def check_memory(phase):
        torch.cuda.synchronize()
        available, _ = torch.cuda.mem_get_info()
        sample = {"phase": phase, "torch_allocated_bytes": torch.cuda.memory_allocated(),
                  "torch_reserved_bytes": torch.cuda.memory_reserved(),
                  "device_free_bytes": available,
                  "device_used_since_start_bytes": max(0, free - available)}
        allocation_samples.append(sample)
        if max(sample["torch_reserved_bytes"], sample["device_used_since_start_bytes"]) > budget:
            (output / "memory-budget-failure.json").write_text(
                json.dumps({"budget_bytes": budget, "allocation_samples": allocation_samples}, indent=2) + "\n")
            raise RuntimeError(f"Mapper GPU memory budget exceeded during {phase}")

    @dataclass
    class BoundedMapperCfg(MapperCfg):
        block_limit: int = args.max_blocks

        @property
        def max_blocks(self):
            return self.block_limit

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    if output.is_symlink():
        raise ValueError("Output directory must not be a symbolic link")
    mapper = None
    first = None
    identity = None
    pending_identity = None
    previous_sequence = None
    count = 0
    input_frames = empty_frames = 0
    timing = []
    packet_hash = hashlib.sha256()
    first_observed = last_observed = 0
    for payload in packets(args.input):
        metadata, raw = decode_ced1(payload)
        if metadata.get("eye") not in (args.eye, "none"):
            continue
        current_identity = (metadata["epoch"], metadata["space_epoch"])
        if identity is not None and identity != current_identity:
            raise ValueError("A map cannot combine different acquisition spaces")
        if mapper is None and current_identity != pending_identity:
            previous_sequence = None
            pending_identity = current_identity
        if previous_sequence is not None and not 0 < ((metadata["sequence"] - previous_sequence) & 0xFFFFFFFF) < 0x80000000:
            continue
        previous_sequence = metadata["sequence"]
        input_frames += 1
        if args.legacy_flip_rows:
            raw = raw[::-1].copy()
        observation = rectify(metadata, raw, args.minimum_depth, args.maximum_depth)
        if not np.any(observation.depth > 0):
            empty_frames += 1
            if input_frames >= args.max_frames:
                break
            continue
        if mapper is None:
            identity = current_identity
            first = observation
            first_observed = metadata["observed_us"]
            centre = world_points(observation)[observation.depth > 0]
            centre = np.asarray(args.grid_centre) if args.grid_centre else np.median(centre, axis=0)
            cfg = BoundedMapperCfg(
                extent_meters_xyz=(args.extent,) * 3,
                voxel_size=args.voxel_size,
                grid_center=centre.tolist(),
                truncation_distance=args.voxel_size * 4,
                minimum_tsdf_weight=args.minimum_weight,
                depth_minimum_distance=args.minimum_depth,
                depth_maximum_distance=args.maximum_depth,
                decay_factor=1.0, frustum_decay_factor=1.0,
                image_height=raw.shape[0], image_width=raw.shape[1],
                extent_esdf_meters_xyz=(.2, .2, .2), esdf_voxel_size=.1,
                max_visible_blocks_per_integration=args.max_blocks,
                max_support_pixels_per_block_camera=1,
                block_size=8, color_grid_size=1,
            )
            mapper = Mapper(cfg)
            check_memory("mapper-created")
        if observation.depth.shape != first.depth.shape:
            raise ValueError("Quest dimensions changed during the map")
        depth = torch.as_tensor(observation.depth[None], device="cuda", dtype=torch.float32)
        k = torch.as_tensor(observation.intrinsics[None], device="cuda", dtype=torch.float32)
        pose = Pose.from_matrix(torch.as_tensor(observation.world_from_camera[None],
                                               device="cuda", dtype=torch.float32))
        rgb = torch.zeros((*depth.shape, 3), device="cuda", dtype=torch.uint8)
        camera = CameraObservation(depth_image=depth, rgb_image=rgb, intrinsics=k, pose=pose)
        start = time.perf_counter()
        mapper.integrate(camera_observation=camera)
        torch.cuda.synchronize()
        timing.append((time.perf_counter() - start) * 1000)
        if mapper.memory_usage_mb() * 1024**2 > budget:
            raise RuntimeError("Mapper storage exceeded the selected GPU budget")
        packet_hash.update(payload)
        count += 1
        last_observed = metadata["observed_us"]
        if count % args.checkpoint_every == 0:
            checkpoint(mapper, output / "checkpoints", count)
            check_memory(f"checkpoint-{count}")
            print(f"Integrated {count} Quest frames", flush=True)
        if input_frames >= args.max_frames:
            break
    if mapper is None or count == 0:
        raise ValueError(f"Input has no usable Quest depth among {input_frames} selected-eye frames")
    saved = checkpoint(mapper, output / "checkpoints", count)
    stats = mapper.get_stats()
    vertices = mapper.extract_occupied_voxels(surface_only=True, max_points=100000).centers
    np.save(output / "surface-world-metres.npy", vertices.detach().cpu().numpy())
    check_memory("surface-extracted")
    k = torch.as_tensor(first.intrinsics, device="cuda", dtype=torch.float32)
    pose = Pose.from_matrix(torch.as_tensor(first.world_from_camera[None],
                                           device="cuda", dtype=torch.float32))
    rendered_depth, normals, valid = mapper.render(k, pose, first.depth.shape)
    torch.cuda.synchronize()
    rendered_depth = rendered_depth.detach().cpu().numpy().reshape(first.depth.shape)
    normals = normals.detach().cpu().numpy().reshape((*first.depth.shape, 3))
    valid = valid.detach().cpu().numpy().reshape(first.depth.shape).astype(bool)
    colours = np.clip((normals + 1) * 127.5, 0, 255).astype(np.uint8)
    colours[~valid] = 0
    ppm(output / "raycast-normals.ppm", colours)
    np.save(output / "raycast-depth-metres.npy", rendered_depth)
    np.save(output / "input-depth-metres.npy", first.depth)
    check_memory("volume-raycast")
    shaded = np.clip((.25 + .75 * np.abs(normals[..., 2:3])) * 210, 0, 255)
    shaded = np.broadcast_to(shaded, (*first.depth.shape, 3)).astype(np.uint8).copy()
    shaded[~valid] = 0
    ppm(output / "raycast-shaded.ppm", shaded)
    if args.mesh:
        mesh = mapper.extract_mesh()
        import trimesh
        def host_array(value):
            return value.detach().cpu().numpy() if hasattr(value, "detach") else np.asarray(value)
        trimesh.Trimesh(vertices=host_array(mesh.vertices), faces=host_array(mesh.faces),
                        process=False).export(output / "surface.ply")
        check_memory("mesh-extracted")
    del mapper
    torch.cuda.empty_cache()
    restored = Mapper.load_blocks(saved, cfg)
    restored_depth, _, restored_valid = restored.render(k, pose, first.depth.shape)
    restored_depth = restored_depth.detach().cpu().numpy().reshape(first.depth.shape)
    restored_valid = restored_valid.detach().cpu().numpy().reshape(first.depth.shape).astype(bool)
    restore_identical = (np.array_equal(restored_valid, valid) and
                        np.allclose(restored_depth[valid], rendered_depth[valid], atol=1e-6))
    if not restore_identical:
        raise RuntimeError("Restored TSDF checkpoint changed the rendered surface")
    check_memory("checkpoint-restored")
    comparison = valid & (first.depth > 0)
    errors = np.abs(rendered_depth[comparison] - first.depth[comparison])
    report = {
        "schema": "ceres-quest-mapper-proof", "version": 1,
        "passed": True,
        "prior_attempt_failure_present": (output / "memory-budget-failure.json").exists(),
        "curobo_revision": CUROBO_REVISION,
        "curobo_archive_sha256": CUROBO_ARCHIVE_SHA256,
        "curobo_source_sha256": source_hash.hexdigest(),
        "input": args.input, "depth_packets_sha256": packet_hash.hexdigest(),
        "input_sha256": (hashlib.file_digest(Path(args.input).open("rb"), "sha256").hexdigest()
                         if args.input != "-" else None),
        "frames": count, "epoch": identity[0], "space_epoch": identity[1],
        "input_frames": input_frames, "empty_depth_frames": empty_frames,
        "first_observed_us": first_observed, "last_observed_us": last_observed,
        "convention": "WebXR world metres, Y up, acquisition pose per CED1 frame",
        "config": vars(args), "stats": stats, "surface_points": len(vertices),
        "grid_centre_metres": centre.tolist(),
        "rendered_pixels": int(valid.sum()),
        "first_view_depth_median_absolute_error_m": float(np.median(errors)) if len(errors) else None,
        "first_view_depth_p95_absolute_error_m": float(np.percentile(errors, 95)) if len(errors) else None,
        "integration_ms": timing, "checkpoint": str(saved),
        "torch_allocated_peak_bytes": torch.cuda.max_memory_allocated(),
        "allocation_samples": allocation_samples,
        "checkpoint_render_identical": restore_identical,
        "gpu": torch.cuda.get_device_name(),
        "torch_runtime_version": torch.__version__, "torch_cuda_version": torch.version.cuda,
        "dependencies": {name: importlib.metadata.version(name)
                         for name in ("torch", "warp-lang", "numpy", "mcap")},
    }
    report["artefact_sha256"] = {p.name: hashlib.file_digest(p.open("rb"), "sha256").hexdigest()
                                for p in sorted(output.iterdir())
                                if p.is_file() and p.name != "report.json"}
    (output / "report.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
    print(json.dumps({k: report[k] for k in ("frames", "surface_points", "rendered_pixels", "checkpoint")}))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="MCAP, CED1 or '-' for framed CED1 stdin")
    parser.add_argument("--output", required=True)
    parser.add_argument("--eye", choices=("left", "right"), default="left")
    parser.add_argument("--max-frames", type=int, default=120)
    parser.add_argument("--max-blocks", type=int, default=8192)
    parser.add_argument("--gpu-budget-mib", type=int, default=512)
    parser.add_argument("--checkpoint-every", type=int, default=30)
    parser.add_argument("--voxel-size", type=float, default=.02)
    parser.add_argument("--extent", type=float, default=8)
    parser.add_argument("--grid-centre", nargs=3, type=float,
                        help="Fixed world-space map centre for comparisons")
    parser.add_argument("--minimum-depth", type=float, default=.1)
    parser.add_argument("--maximum-depth", type=float, default=6)
    parser.add_argument("--minimum-weight", type=float, default=.5)
    parser.add_argument("--mesh", action="store_true")
    parser.add_argument("--legacy-flip-rows", action="store_true",
                        help="Explicitly flip packed rows in a legacy GPU recording")
    args = parser.parse_args()
    if not (1 <= args.max_frames <= 10000 and 1 <= args.max_blocks <= 32768 and
            128 <= args.gpu_budget_mib <= 2048 and 1 <= args.checkpoint_every <= 10000 and
            .005 <= args.voxel_size <= .1 and .5 <= args.extent <= 20 and
            0 < args.minimum_depth < args.maximum_depth <= 20 and
            math.isfinite(args.minimum_weight) and args.minimum_weight > 0):
        parser.error("Mapper settings are outside the bounded supported range")
    if args.grid_centre and not all(math.isfinite(x) for x in args.grid_centre):
        parser.error("Grid centre must contain finite world coordinates")
    run(args)


if __name__ == "__main__":
    main()
