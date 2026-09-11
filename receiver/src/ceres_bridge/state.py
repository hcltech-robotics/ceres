"""Bounded observation state and four-timestamp monotonic clock mapping."""

from collections import deque
from dataclasses import dataclass
import threading
import time

from .protocol import Pose, decode_pose, newer_sequence


def monotonic_us() -> int:
    return time.monotonic_ns() // 1000


class ClockMap:
    def __init__(self):
        self.samples = deque(maxlen=12)

    def add(self, t0: int, t1: int, t2: int, t3: int):
        rtt = (t3 - t0) - (t2 - t1)
        if not 0 <= rtt <= 1_000_000 or t3 < t0 or t2 < t1:
            return False
        self.samples.append((rtt / 2, (t1 + t2) / 2, (t0 + t3) / 2, t3))
        return True

    def mapping(self, now: int):
        recent = [s for s in self.samples if 0 <= now - s[3] <= 3_000_000][-8:]
        if not recent:
            return None
        best = min(sample[0] for sample in recent)
        recent = [sample for sample in recent if sample[0] <= max(2000, best * 4)]
        if len(recent) < 2:
            uncertainty, sender, receiver, sampled = recent[-1]
            return receiver - sender, uncertainty + (now - sampled) * 0.05, 1.0
        # Fit an affine mapping. Virtualised hosts can have substantially different
        # clock rates, so a constant offset is not a valid freshness measurement.
        origin_x, origin_y = recent[-1][1:3]
        weights = [1 / max(100, sample[0])**2 for sample in recent]
        total = sum(weights)
        mean_x = sum(w * (s[1] - origin_x) for w, s in zip(weights, recent)) / total
        mean_y = sum(w * (s[2] - origin_y) for w, s in zip(weights, recent)) / total
        variance = sum(w * (s[1] - origin_x - mean_x)**2 for w, s in zip(weights, recent))
        if variance <= 0:
            return None
        rate = sum(w * (s[1] - origin_x - mean_x) * (s[2] - origin_y - mean_y) for w, s in zip(weights, recent)) / variance
        if not 0.5 < rate < 2:
            return None
        offset = origin_y + mean_y - rate * (origin_x + mean_x)
        residual = max(abs(s[2] - (rate * s[1] + offset)) + s[0] for s in recent)
        span = max(1, recent[-1][3] - recent[0][3])
        uncertainty = residual * (1 + max(0, now - recent[-1][3]) / span) + max(0, now - recent[-1][3]) * 0.0001
        return offset, uncertainty, rate


@dataclass(frozen=True, slots=True)
class Observation:
    pose: Pose
    received_us: int


class LatestState:
    def __init__(self):
        self.lock = threading.RLock()
        self.epoch = 0
        self.space_epoch = None
        self.description = None
        self.clock = ClockMap()
        self.poses: dict[int, Observation] = {}
        self.counts = {"received": 0, "rejected": 0, "gaps": 0, "frames": 0, "late": 0, "future": 0, "duplicate": 0, "malformed": 0}
        self.arrival_ages = deque(maxlen=2048)
        self.connection = "waiting"
        self.codec = None

    def reset(self, epoch: int):
        with self.lock:
            self.epoch, self.space_epoch = epoch, None
            self.description = None
            self.poses.clear()
            self.clock = ClockMap()
            self.arrival_ages.clear()
            self.connection = "connecting"
            self.codec = None

    def accept(self, raw: bytes, received_us: int | None = None) -> bool:
        now = monotonic_us() if received_us is None else received_us
        try:
            pose = decode_pose(raw)
        except ValueError:
            with self.lock:
                self.counts["rejected"] += 1
                self.counts["malformed"] += 1
            return False
        with self.lock:
            if self.description is None or pose.epoch != self.epoch:
                return False
            if self.space_epoch is not None and pose.space_epoch != self.space_epoch:
                if not newer_sequence(pose.space_epoch, self.space_epoch):
                    return False
                self.poses.clear()
            self.space_epoch = pose.space_epoch
            previous = self.poses.get(pose.kind)
            if previous and not newer_sequence(pose.sequence, previous.pose.sequence):
                self.counts["rejected"] += 1
                self.counts["duplicate"] += 1
                return False
            mapping = self.clock.mapping(now)
            if mapping:
                age = now - (pose.observed_us * mapping[2] + mapping[0])
                self.arrival_ages.append(age)
                if age - mapping[1] > 50_000 or age + mapping[1] < -5000:
                    self.counts["rejected"] += 1
                    self.counts["late" if age > 0 else "future"] += 1
                    return False
            if previous:
                self.counts["gaps"] += ((pose.sequence - previous.pose.sequence) & 0xFFFFFFFF) - 1
            self.poses[pose.kind] = Observation(pose, now)
            self.counts["received"] += 1
            return True

    def snapshot(self, now: int | None = None) -> dict:
        now = monotonic_us() if now is None else now
        with self.lock:
            mapping = self.clock.mapping(now)
            poses = {}
            for kind, observation in self.poses.items():
                pose = observation.pose
                age = now - observation.received_us
                source_age = now - (pose.observed_us * mapping[2] + mapping[0]) if mapping else None
                fresh = age <= 50_000 and mapping is not None and source_age + mapping[1] <= 50_000
                poses[str(kind)] = {"pose": pose.to_dict() if fresh else None,
                                    "received_us": observation.received_us, "age_us": source_age,
                                    "fresh": fresh, "tracked": fresh and pose.valid}
            return {"version": 1, "epoch": self.epoch, "space_epoch": self.space_epoch,
                    "description": self.description, "poses": poses, "connection": self.connection, "codec": self.codec,
                    "clock": {"offset_us": mapping[0], "uncertainty_us": mapping[1], "rate": mapping[2]} if mapping else None,
                    "counts": dict(self.counts), "now_us": now}

    def diagnostics(self):
        with self.lock:
            ages = sorted(self.arrival_ages)
            return {"version": 1, "counts": dict(self.counts), "clock_samples": list(self.clock.samples),
                    "arrival_age_us": {str(p): ages[min(len(ages) - 1, int(len(ages) * p / 100))] if ages else None for p in (0, 50, 95, 99, 100)}}
