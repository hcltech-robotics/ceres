"""Discoverable fields for Foxglove plots and joint inspection."""


def object_schema(properties, *, nullable=False):
    return {"type": ["object", "null"] if nullable else "object", "properties": properties}


NUMBER = {"type": "number"}
OPTIONAL_NUMBER = {"type": ["number", "null"]}
BOOLEAN = {"type": "boolean"}
STRING = {"type": "string"}
VECTOR = object_schema({axis: NUMBER for axis in "xyz"})
ORIENTATION = object_schema({axis: NUMBER for axis in "xyzw"})
HAND_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "ceres.HandJoints",
    **object_schema({
        "frame_id": STRING, "tracked": BOOLEAN, "valid_joints": NUMBER,
        "joints": {"type": "array", "items": object_schema({
            "name": STRING, "tracked": BOOLEAN, "radius_m": OPTIONAL_NUMBER,
            "pose": object_schema({"position": VECTOR, "orientation": ORIENTATION}, nullable=True),
        })},
    }),
}
DIAGNOSTIC_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "ceres.StreamDiagnostics",
    **object_schema({
        **{name: NUMBER for name in ("video_fps", "motion_fps", "left_fps", "right_fps", "video_mbps", "epoch", "space_epoch")},
        "connection": STRING, "codec": {"type": ["string", "null"]},
        "clock_uncertainty_ms": OPTIONAL_NUMBER,
        "counts": object_schema({name: NUMBER for name in (
            "received", "rejected", "gaps", "frames", "late", "future", "duplicate", "malformed")}),
        **{f"{name}_tracked": BOOLEAN for name in ("head", "left", "right")},
        **{f"{name}_age_ms": OPTIONAL_NUMBER for name in ("head", "left", "right")},
        **{f"{name}_valid_joints": NUMBER for name in ("left", "right")},
        **{f"{name}_pinch_m": OPTIONAL_NUMBER for name in ("left", "right")},
        "camera": object_schema({"side": STRING, "width": NUMBER, "height": NUMBER}, nullable=True),
        "camera_projection": STRING,
    }),
}
