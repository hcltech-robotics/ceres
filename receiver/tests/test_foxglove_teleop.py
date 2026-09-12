import sys

import numpy as np
import pytest

from ceres_bridge.foxglove_teleop import fixed_robot_transform


def test_fixed_robot_transform_rotates_positions_and_axes_before_translation():
    transform = fixed_robot_transform((1, 2, 3), 90)
    assert transform @ np.array((1, 0, 0, 1)) == pytest.approx((1, 3, 3, 1))
    assert transform[:3, :3] @ np.array((1, 0, 0)) == pytest.approx((0, 1, 0))
    assert fixed_robot_transform((0, 0, 0), 0) == pytest.approx(np.eye(4))


@pytest.mark.parametrize("origin,yaw", [((0, 0), 0), ((0, float("nan"), 0), 0), ((0, 0, 0), float("inf"))])
def test_fixed_robot_transform_rejects_invalid_coordinates(origin, yaw):
    with pytest.raises(ValueError, match="finite"):
        fixed_robot_transform(origin, yaw)


def test_cli_passes_absolute_mapping_arguments_to_foxglove(monkeypatch):
    from ceres_bridge import cli, foxglove_output

    received = []

    async def capture(args):
        received.append(args)

    monkeypatch.setattr(foxglove_output, "run", capture)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "argv", ["ceres-bridge", "foxglove", "--robot", "xlerobot",
        "--position-scale", "0.8", "--robot-origin", "1", "2", "3", "--robot-yaw", "90",
        "--tracking-grace", "0.75"])
    cli.main()
    assert len(received) == 1
    args = received[0]
    assert args.position_scale == 0.8
    assert args.robot_origin == [1, 2, 3]
    assert args.robot_yaw == 90
    assert args.tracking_grace == 0.75


def test_cli_defaults_to_an_identity_robot_frame(monkeypatch):
    from ceres_bridge import cli, foxglove_output

    received = []

    async def capture(args):
        received.append(args)

    monkeypatch.setattr(foxglove_output, "run", capture)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "argv", ["ceres-bridge", "foxglove", "--robot", "xlerobot"])
    cli.main()
    args = received[0]
    assert args.position_scale == 0.6
    assert args.tracking_grace == 0.5
    assert fixed_robot_transform(args.robot_origin, args.robot_yaw) == pytest.approx(np.eye(4))
