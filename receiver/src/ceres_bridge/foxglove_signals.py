"""Scalar pose signals and measured process load for the live dashboards."""

import math
import os
from pathlib import Path
import time

from .coordinates import ros_orientation, ros_position


def motion_gap():
    # A valid JSON sentinel which Foxglove's numeric plot adapter maps to NaN.
    return {"frame_id": "ceres_origin", "tracked": False,
        "position": dict.fromkeys("xyz", "NaN"),
        "rotation": dict.fromkeys(("roll", "pitch", "yaw"), "NaN")}


class MotionSignals:
    """Publish each observation once and break plots when tracking expires."""

    def __init__(self):
        self.epoch = None
        self.previous = {}
        self.rotation = {}
        self.tracked = {}

    def observe(self, snapshot):
        epoch = (snapshot["epoch"], snapshot["space_epoch"])
        if epoch != self.epoch:
            changed_origin = self.epoch is not None
            self.previous.clear()
            self.rotation.clear()
            self.tracked.clear()
            self.epoch = epoch
            if changed_origin:
                # Do not consume any source sequence until the new frame has a
                # separate chart sample, otherwise the plot connects origins.
                self.tracked = dict.fromkeys(("1", "2", "3"), False)
                return {kind: motion_gap() for kind in ("1", "2", "3")}
        result = {}
        for kind in ("1", "2", "3"):
            component = snapshot["poses"].get(kind, {})
            pose = component.get("pose")
            valid = (snapshot.get("connection") == "connected" and component.get("tracked", False)
                     and pose is not None and (kind == "1" or pose["joint_mask"] & 1))
            if valid:
                values = pose["values"][:7]
                valid = len(values) == 7 and all(math.isfinite(v) for v in values)
            if valid:
                q = ros_orientation(values[3:7])
                norm = math.sqrt(sum(v*v for v in q))
                valid = norm > 1e-8
            if not valid:
                if self.tracked.get(kind) is not False:
                    result[kind] = motion_gap()
                self.tracked[kind] = False
                self.rotation.pop(kind, None)
                self.previous.pop(kind, None)
                continue
            sequence = pose["sequence"]
            if self.previous.get(kind) == sequence:
                continue
            x, y, z, w = (v / norm for v in q)
            angles = [math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y)),
                      math.asin(max(-1, min(1, 2*(w*y-z*x)))),
                      math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z))]
            previous = self.rotation.get(kind)
            if previous is not None:
                angles = [old + math.remainder(new-old, math.tau) for new, old in zip(angles, previous)]
            self.rotation[kind] = angles
            self.previous[kind] = sequence
            self.tracked[kind] = True
            result[kind] = {"frame_id": "ceres_origin", "tracked": True,
                "position": dict(zip("xyz", ros_position(values))),
                "rotation": dict(zip(("roll", "pitch", "yaw"), angles))}
        return result


class ProcessMetrics:
    """CPU uses one core as 100 percent and RSS is current resident memory."""

    def __init__(self):
        self.wall = time.monotonic_ns()
        self.cpu = time.process_time_ns()
        self.cpu_percent = 0.0
        self.loop_ms = 0.0

    def observe_loop(self, elapsed_ns):
        self.loop_ms = elapsed_ns / 1e6

    def diagnostic(self):
        now, cpu = time.monotonic_ns(), time.process_time_ns()
        if now > self.wall:
            self.cpu_percent = max(0.0, 100 * (cpu-self.cpu) / (now-self.wall))
        self.wall, self.cpu = now, cpu
        try:
            pages = int(Path("/proc/self/statm").read_text(encoding="ascii").split()[1])
            rss_mb = pages * os.sysconf("SC_PAGE_SIZE") / 1024**2
        except (OSError, ValueError, IndexError, AttributeError):
            rss_mb = None
        return {"process_cpu_percent": self.cpu_percent, "process_rss_mb": rss_mb,
                "loop_ms": self.loop_ms}
