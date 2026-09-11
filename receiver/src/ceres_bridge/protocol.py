"""CBR1 wire format, independent of the media runtime."""

from dataclasses import dataclass
import json
import math
import struct

VERSION = 1
HEADER = struct.Struct("<4sBBHIIIIQQ")
JOINT_MASK = (1 << 25) - 1
JOINTS = (
    "wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
    "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
    "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
    "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
    "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
)


@dataclass(frozen=True, slots=True)
class Pose:
    kind: int
    valid: bool
    epoch: int
    space_epoch: int
    sequence: int
    observed_us: int
    target_us: int
    joint_mask: int
    values: tuple[float, ...]

    def to_dict(self):
        return {"kind": self.kind, "valid": self.valid, "epoch": self.epoch, "space_epoch": self.space_epoch,
                "sequence": self.sequence, "observed_us": self.observed_us, "target_us": self.target_us,
                "joint_mask": self.joint_mask, "values": self.values}


def newer_sequence(candidate: int, previous: int) -> bool:
    return 0 < (candidate - previous) & 0xFFFFFFFF < 0x80000000


def decode_pose(data: bytes) -> Pose:
    if len(data) < HEADER.size:
        raise ValueError("Truncated Bridge pose")
    magic, version, kind, flags, epoch, space, seq, length, observed, target = HEADER.unpack_from(data)
    expected = 68 if kind == 1 else 844
    if (magic != b"CBR1" or version != 1 or kind not in (1, 2, 3) or flags > 1
            or len(data) != expected or length != expected - 40
            or max(observed, target) > 2**53 - 1):
        raise ValueError("Invalid Bridge pose envelope")
    mask = struct.unpack_from("<I", data, 40)[0] if kind != 1 else 0
    if mask & ~JOINT_MASK or kind != 1 and bool(mask) != bool(flags):
        raise ValueError("Invalid Bridge joint validity")
    values = struct.unpack_from("<7f" if kind == 1 else "<200f", data, 40 if kind == 1 else 44)
    stride = 7 if kind == 1 else 8
    for joint in range(1 if kind == 1 else 25):
        transform = values[joint * stride:(joint + 1) * stride]
        if not (flags if kind == 1 else mask & (1 << joint)):
            if any(value != 0 for value in transform):
                raise ValueError("Untracked Bridge transforms must be zero")
            continue
        if (not all(math.isfinite(v) for v in transform)
                or not 0.5 <= sum(q*q for q in transform[3:7]) <= 1.5
                or stride == 8 and transform[7] < 0):
            raise ValueError("Invalid Bridge transform")
    return Pose(kind, bool(flags), epoch, space, seq, observed, target, mask, values)


def encode_pose(pose: Pose) -> bytes:
    payload = struct.pack("<7f", *pose.values) if pose.kind == 1 else struct.pack("<I200f", pose.joint_mask, *pose.values)
    data = HEADER.pack(b"CBR1", 1, pose.kind, int(pose.valid), pose.epoch, pose.space_epoch,
                       pose.sequence, len(payload), pose.observed_us, pose.target_us) + payload
    decode_pose(data)
    return data


def _uint(value, bits=32):
    return type(value) is int and 0 <= value < 2**bits


def parse_metadata(raw: str) -> dict:
    if len(raw.encode("utf-8")) > 8192:
        raise ValueError("Bridge metadata exceeds its budget")
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("version") != 1 or not _uint(value.get("epoch")):
        raise ValueError("Incompatible Bridge metadata")
    kind = value.get("type")
    if kind == "ack":
        return value
    if kind in ("ping", "pong"):
        if (not _uint(value.get("id")) or not _uint(value.get("t0"), 53)
                or kind == "pong" and (not _uint(value.get("t1"), 53) or not _uint(value.get("t2"), 53)
                                        or value["t2"] < value["t1"])):
            raise ValueError("Invalid Bridge clock exchange")
        return value
    camera, clock = value.get("camera", {}), value.get("clock", {})
    if (kind != "description" or value.get("axes") != "right-handed-x-right-y-up-z-back"
            or value.get("units") != "metres" or value.get("quaternion") != "xyzw"
            or value.get("referenceSpace") not in ("local", "local-floor")
            or value.get("joints") != list(JOINTS)
            or not isinstance(clock, dict) or clock.get("units") != "microseconds"
            or clock.get("domain") != "sender-monotonic" or not isinstance(clock.get("id"), str)
            or len(clock["id"]) > 128 or not isinstance(camera, dict)
            or camera.get("side") not in ("left", "right", "unknown") or camera.get("calibration") is not None
            or not all(type(camera.get(k)) is int and 0 < camera[k] <= 8192 for k in ("width", "height", "requestedWidth"))
            or camera.get("fps") is not None and (type(camera["fps"]) not in (int, float) or not math.isfinite(camera["fps"]) or camera["fps"] <= 0)):
        raise ValueError("Invalid Bridge stream description")
    return value
