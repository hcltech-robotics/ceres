import json
import math

import pytest

from ceres_bridge.foxglove_signals import MotionSignals, ProcessMetrics
from ceres_bridge.foxglove_schemas import MOTION_SCHEMA


def snapshot(angle=0, sequence=1):
    return {"epoch": 1, "space_epoch": 1, "connection": "connected", "poses": {
        "2": {"tracked": True, "pose": {"sequence": sequence, "joint_mask": 1,
            "values": [1, 2, 3, 0, math.sin(angle/2), 0, math.cos(angle/2), .01] * 25}}}}


def test_motion_is_scalar_in_the_display_basis_and_publishes_unique_observations():
    signals = MotionSignals()
    data = snapshot()
    values = signals.observe(data)["2"]
    assert values["position"] == {"x": -3, "y": -1, "z": 2}
    assert values["rotation"] == {"roll": 0, "pitch": 0, "yaw": 0}
    assert signals.observe(data) == {}


def test_rotation_remains_continuous_at_pi_but_reanchors_after_tracking_loss():
    signals = MotionSignals()
    before = signals.observe(snapshot(math.radians(179)))["2"]["rotation"]["yaw"]
    after = signals.observe(snapshot(math.radians(-179), 2))["2"]["rotation"]["yaw"]
    assert after-before == pytest.approx(math.radians(2))
    lost = snapshot(sequence=3)
    lost["poses"]["2"]["tracked"] = False
    gap = signals.observe(lost)["2"]
    assert gap["tracked"] is False
    assert all(value == "NaN" for value in gap["position"].values())
    assert all(value == "NaN" for value in gap["rotation"].values())
    assert signals.observe(lost) == {}
    resumed = signals.observe(snapshot(math.radians(-170), 4))["2"]
    assert resumed["rotation"]["yaw"] == pytest.approx(math.radians(-170))


def test_missing_wrist_and_disconnection_break_the_plot_even_without_a_new_sequence():
    signals = MotionSignals()
    data = snapshot()
    signals.observe(data)
    data["poses"]["2"]["pose"]["joint_mask"] = 2
    assert signals.observe(data)["2"]["tracked"] is False
    data = snapshot()
    assert signals.observe(data)["2"]["tracked"] is True
    data["connection"] = "waiting"
    assert signals.observe(data)["2"]["tracked"] is False


@pytest.mark.parametrize("epoch", ["epoch", "space_epoch"])
def test_reference_space_reset_inserts_a_gap_then_accepts_the_new_frame(epoch):
    signals = MotionSignals()
    signals.observe(snapshot(math.radians(179)))
    signals.observe(snapshot(math.radians(-179), 2))
    data = snapshot(math.radians(-90), 2)
    data[epoch] += 1
    gap = signals.observe(data)["2"]
    assert gap["tracked"] is False
    assert gap["rotation"]["yaw"] == "NaN"
    assert signals.observe(data)["2"]["rotation"]["yaw"] == pytest.approx(-math.pi/2)
    assert signals.observe(data) == {}


def test_plot_gap_is_valid_json_and_its_only_nonnumeric_scalar_is_the_nan_sentinel():
    signals = MotionSignals()
    data = snapshot()
    valid = signals.observe(data)["2"]
    data["poses"]["2"]["tracked"] = False
    gap = signals.observe(data)["2"]
    for message in (valid, gap):
        encoded = json.dumps(message, allow_nan=False)
        decoded = json.loads(encoded)
        for group in ("position", "rotation"):
            for name, value in decoded[group].items():
                schema = MOTION_SCHEMA["properties"][group]["properties"][name]
                # Foxglove rejects number/string unions before reading data.
                # Its primitive JSON reader preserves the NaN transport value.
                assert schema["type"] == "number"
                if decoded["tracked"]:
                    assert isinstance(value, (int, float)) and math.isfinite(value)
                else:
                    assert value == "NaN"


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_non_finite_observations_do_not_enter_plot_messages(value):
    data = snapshot()
    data["poses"]["2"]["pose"]["values"][0] = value
    assert MotionSignals().observe(data)["2"]["tracked"] is False


def test_process_metrics_report_measured_duration_and_nonnegative_cpu():
    metrics = ProcessMetrics()
    metrics.observe_loop(2_500_000)
    data = metrics.diagnostic()
    assert data["loop_ms"] == 2.5
    assert math.isfinite(data["process_cpu_percent"]) and data["process_cpu_percent"] >= 0
    assert data["process_rss_mb"] is None or data["process_rss_mb"] > 0
