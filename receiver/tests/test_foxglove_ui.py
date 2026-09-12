import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from ceres_bridge.foxglove_ui import LAYOUTS, connection_links, layout_bytes


def test_bundled_layouts_resolve_every_panel_and_use_the_expected_camera():
    cameras = {
        "layout.json": "/ceres/camera/video",
        "vp8-layout.json": "/ceres/camera/projection",
        "ros-layout.json": "/ceres/camera/image",
        "dual-arm-layout.json": "/ceres/camera/video",
        "dual-arm-vp8-layout.json": "/ceres/camera/projection",
    }
    assert set(LAYOUTS) == set(cameras)
    for name, topic in cameras.items():
        layout = json.loads(layout_bytes(name))
        source = Path(__file__).parents[1] / "foxglove" / name
        assert layout == json.loads(source.read_text(encoding="utf-8"))
        assert layout["version"] == 1
        panels = layout["configById"]
        assert panels["Image!camera"]["imageMode"]["imageTopic"] == topic

        def resolve(node):
            if isinstance(node, str):
                assert node in panels
                for tab in panels[node].get("tabs", []):
                    resolve(tab["layout"])
            else:
                resolve(node["first"])
                resolve(node["second"])

        resolve(layout["layout"])
    with pytest.raises(ValueError):
        layout_bytes("../worker.py")


def visible_panels(layout):
    panels = layout["configById"]

    def walk(node):
        if isinstance(node, str):
            tabs = panels[node].get("tabs")
            if tabs:
                yield from walk(tabs[panels[node]["activeTabIdx"]]["layout"])
            else:
                yield node
        else:
            yield from walk(node["first"])
            yield from walk(node["second"])

    return {identifier: panels[identifier] for identifier in walk(layout["layout"])}


@pytest.mark.parametrize("name", ["layout.json", "vp8-layout.json", "dual-arm-layout.json", "dual-arm-vp8-layout.json"])
def test_live_overview_exposes_signed_wrist_waveforms_rates_and_cpu(name):
    layout = json.loads(layout_bytes(name))
    visible = visible_panels(layout)
    paths = {series["value"] for identifier, panel in visible.items()
             if identifier.startswith("Plot!") for series in panel["paths"]}
    for side in ("left", "right"):
        assert {f"/ceres/{side}/motion.position.{axis}" for axis in "xyz"} <= paths
        assert {f"/ceres/{side}/motion.rotation.{axis}" for axis in ("roll", "pitch", "yaw")} <= paths
    assert "/ceres/diagnostics.video_fps" in paths
    assert "/ceres/diagnostics.process_cpu_percent" in paths
    assert not any("/joints.joints[" in path for path in paths)
    if not name.startswith("dual-arm"):
        assert {f"/ceres/head/motion.position.{axis}" for axis in "xyz"} <= paths
        assert {f"/ceres/head/motion.rotation.{axis}" for axis in ("roll", "pitch", "yaw")} <= paths
    for identifier, panel in layout["configById"].items():
        if identifier.startswith("Plot!") and panel["yAxisLabel"] in ("Metres", "Radians") and identifier != "Plot!pinch":
            assert "minYValue" not in panel
            assert "maxYValue" not in panel


@pytest.mark.parametrize("name", ["dual-arm-layout.json", "dual-arm-vp8-layout.json"])
def test_dual_arm_overview_separates_robot_acquisition_video_and_joint_plots(name):
    visible = visible_panels(json.loads(layout_bytes(name)))
    assert {identifier for identifier in visible if identifier.startswith("3D!")} == {"3D!robot", "3D!tracking"}
    assert visible["3D!robot"]["fixedFrame"] == "ceres_robot_base"
    assert visible["3D!tracking"]["fixedFrame"] == "ceres_origin"
    assert visible["3D!robot"]["topics"]["/ceres/scene"]["visible"] is False
    assert visible["3D!tracking"]["topics"]["/ceres/robot/scene"]["visible"] is False
    assert visible["3D!tracking"]["topics"]["/ceres/camera/projection"]["visible"] is True
    assert visible["Image!camera"]["synchronize"] is False
    assert "/ceres/robot/diagnostics.update_fps" in {series["value"] for series in visible["Plot!rates"]["paths"]}
    for side in ("left", "right"):
        paths = [series["value"] for series in visible[f"Plot!robot-{side}"]["paths"]]
        assert len(paths) == 6
        assert all(path.startswith(f"/ceres/robot/joints.{side}.") for path in paths)


@pytest.mark.parametrize("host,expected", [
    ("10.0.0.77", "ws://10.0.0.77:8765/"),
    ("0.0.0.0", "ws://127.0.0.1:8765/"),
    ("::", "ws://[::1]:8765/"),
])
def test_desktop_connection_links_round_trip_the_receiver_address(host, expected):
    links = connection_links(host, 8765)
    assert links["websocket"] == expected
    parameters = parse_qs(urlsplit(links["open"]).query)
    assert parameters == {"ds": ["foxglove-websocket"], "ds.url": [expected]}
    assert links["layout"].endswith("/layouts/layout.json")
