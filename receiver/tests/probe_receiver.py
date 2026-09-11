"""Measure native receive/IPC progress while a separate browser sends test input."""
import json
import time
from ceres_bridge import Receiver

frames, sequences, latencies, shapes = set(), {"1": set(), "2": set(), "3": set()}, [], set()
deadline = time.monotonic() + 12
with Receiver() as receiver:
    while time.monotonic() < deadline:
        snapshot = receiver.latest()
        for kind, component in snapshot["poses"].items():
            if component["fresh"] and component["pose"]:
                sequences[kind].add(component["pose"]["sequence"])
                latencies.append(component["age_us"])
        frame = snapshot["frame"]
        if frame:
            with frame:
                frames.add(frame.metadata["generation"])
                shapes.add((frame.metadata["width"], frame.metadata["height"]))
                if len(frame.data) != frame.metadata["bytes"]:
                    raise RuntimeError("Invalid shared frame geometry")
        time.sleep(0.005)
    print(json.dumps(receiver.diagnostics()))
print(json.dumps({"frames": len(frames), "poses": {k: len(v) for k, v in sequences.items()},
                  "shapes": sorted(shapes), "clock": snapshot["clock"], "counts": snapshot["counts"],
                  "pose_age_p95_us": sorted(latencies)[int(len(latencies) * .95)] if latencies else None,
                  "connection": snapshot["connection"]}))
if len(frames) < 100 or min(map(len, sequences.values())) < 100:
    raise SystemExit("Native receiver did not sustain test video and all pose components")
