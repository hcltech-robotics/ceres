"""Write an asymmetric room with moving acquisition poses as Quest CED1 frames."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct

import numpy as np


def frame(index: int, frames: int = 48, width: int = 96, height: int = 72):
    angle = .12 * math.sin(index / max(1, frames - 1) * math.pi * 2)
    x = .22 * math.sin(index / max(1, frames - 1) * math.pi * 2)
    world = np.eye(4)
    world[:3, :3] = [[math.cos(angle), 0, math.sin(angle)], [0, 1, 0],
                     [-math.sin(angle), 0, math.cos(angle)]]
    world[:3, 3] = [x, 1.25 + .06 * math.cos(index * .2), 0]
    focal = 1 / math.tan(math.radians(70) / 2)
    near, far = .1, 10
    projection = np.array([[focal / (width / height), 0, .08, 0],
                           [0, focal, -.04, 0],
                           [0, 0, (far + near) / (near - far), 2 * far * near / (near - far)],
                           [0, 0, -1, 0]])
    yy, xx = np.indices((height, width))
    # Independent OpenGL unprojection, without using the adapter's intrinsics.
    clip = np.stack((2 * (xx + .5) / width - 1, 1 - 2 * (yy + .5) / height,
                     np.zeros_like(xx), np.ones_like(xx)), axis=-1)
    ray = clip @ np.linalg.inv(projection).T
    ray = ray[..., :3] / ray[..., 3:4]
    ray /= -ray[..., 2:3]
    direction = ray @ world[:3, :3].T
    origin = world[:3, 3]
    depth = (-2.4 - origin[2]) / direction[..., 2]
    # Low block on the left and high narrow block on the right expose Y inversions.
    boxes = [([-0.85, .35, -2.15], [-.3, .95, -1.8]),
             ([.28, 1.65, -2.1], [.65, 2.05, -1.7])]
    for minimum, maximum in boxes:
        safe = np.where(np.abs(direction) < 1e-10, 1e-10, direction)
        a = (np.array(minimum) - origin) / safe
        b = (np.array(maximum) - origin) / safe
        enter = np.maximum(np.minimum(a, b).max(axis=-1), 0)
        leave = np.maximum(a, b).min(axis=-1)
        hit = (leave >= enter) & (enter > 0)
        depth = np.where(hit, np.minimum(depth, enter), depth)
    depth = np.rint(depth * 1000).clip(0, 65535).astype("<u2")
    metadata = {
        "version": 1, "mapping_version": 2, "epoch": 1, "space_epoch": 1, "sequence": index + 1,
        "observed_us": 1000000 + index * 33333, "target_us": 1011111 + index * 33333,
        "width": width, "height": height, "source_width": width, "source_height": height,
        "eye": "left", "usage": "cpu-optimized", "source_format": "float32",
        "depth_format": "uint16-mm", "world_from_view": world.ravel(order="F").tolist(),
        "projection": projection.ravel(order="F").tolist(),
        "norm_depth_from_norm_view": np.eye(4).ravel(order="F").tolist(),
    }
    return metadata, depth


def encode(metadata, depth) -> bytes:
    header = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    return b"CED1" + struct.pack("<I", len(header)) + header + depth.astype("<u2").tobytes()


def write_mcap(path: Path, frames: int = 48) -> None:
    from mcap.writer import CompressionType, Writer
    with path.open("wb") as stream:
        writer = Writer(stream, compression=CompressionType.NONE)
        writer.start(profile="ceres-session-v1")
        writer.add_metadata("ceres.session", {"version": "1", "origin_us": "1000000",
                                             "encoding": "ceres-session-v1", "time_unit": "microseconds"})
        channel = writer.register_channel("/ceres/depth/environment_depth", "ceres-session-v1", 0)
        for index in range(frames):
            metadata, depth = frame(index, frames)
            receive_us = metadata["target_us"] + 3000
            header = {
                "version": 1, "kind": "depth", "stream": "environment_depth",
                "receive_us": receive_us, "time_us": metadata["target_us"],
                "session_receive_us": receive_us - 1000000,
                "session_time_us": metadata["target_us"] - 1000000,
                "epoch": metadata["epoch"], "space_epoch": metadata["space_epoch"],
                "sequence": metadata["sequence"], "rtp_timestamp": 0, "keyframe": False,
                "attributes": dict(metadata, clock_valid=True, clock_rate=1.0,
                                   clock_offset_us=0, clock_uncertainty_us=0,
                                   mapped_observed_us=metadata["observed_us"],
                                   mapped_target_us=metadata["target_us"]),
            }
            encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
            payload = b"CSE1" + struct.pack("<I", len(encoded)) + encoded + encode(metadata, depth)
            writer.add_message(channel, header["session_receive_us"] * 1000, payload,
                               header["session_time_us"] * 1000, metadata["sequence"])
        writer.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--frames", type=int, default=48)
    args = parser.parse_args()
    if not 1 <= args.frames <= 10000:
        parser.error("Frame count must be between 1 and 10000")
    write_mcap(args.output, args.frames)
