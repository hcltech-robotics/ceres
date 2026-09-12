"""Write the supported Ceres sensor schema into exported sidecars."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


SUPPORTED_SENSOR_KEYS = frozenset({
    "timestampMs",
    "frameIndex",
    "head",
    "cameraSide",
    "camera",
    "leftHand",
    "rightHand",
    "sceneStatus",
    "recorder",
    "gap",
    "reason",
})


def _without_depth_keys(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: _without_depth_keys(item)
            for key, item in value.items()
            if "depth" not in key.casefold()
        }
    if isinstance(value, list):
        return [_without_depth_keys(item) for item in value]
    return value


def _supported_sensor_record(record: dict[str, object]) -> dict[str, object]:
    return {
        key: _without_depth_keys(value)
        for key, value in record.items()
        if key in SUPPORTED_SENSOR_KEYS and "depth" not in key.casefold()
    }


def copy_sensor_jsonl(source: Path, destination: Path) -> None:
    """Write canonical sensor records without retired or unknown fields."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with source.open("r", encoding="utf-8") as source_file, tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            for line_number, line in enumerate(source_file, start=1):
                if not line.strip():
                    continue
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError(f"Sensor record on line {line_number} must be a JSON object")
                json.dump(
                    _supported_sensor_record(record),
                    temporary_file,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        temporary_path.replace(destination)
    except Exception:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise
