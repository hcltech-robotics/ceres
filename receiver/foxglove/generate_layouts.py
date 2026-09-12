"""Generate Foxglove desktop layouts (version 1 mosaic export format)."""

import json
from pathlib import Path


HEAD_COLOURS = ("#f87171", "#4ade80", "#60a5fa")
HAND_COLOURS = {
    "left": ("#38bdf8", "#22d3ee", "#a5f3fc"),
    "right": ("#fb923c", "#fbbf24", "#fed7aa"),
}
ROBOT_JOINTS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper")
ROBOT_COLOURS = ("#f87171", "#fb923c", "#facc15", "#4ade80", "#38bdf8", "#a78bfa")


def split(direction, first, second, percentage=50):
    return {"direction": direction, "first": first, "second": second, "splitPercentage": percentage}


def three_columns(first, second, third):
    return split("row", first, split("row", second, third), 34)


def plot(title, series, units, *, minimum=None, maximum=None):
    result = {"foxglovePanelTitle": title, "paths": [
        {"value": path, "label": label, "color": colour, "enabled": True,
         "timestampMethod": "receiveTime", "showLine": True}
        for path, label, colour in series], "xAxisVal": "timestamp", "showLegend": True,
        "legendDisplay": "left", "sidebarDimension": 120, "showPlotValuesInLegend": False, "isSynced": True,
        "timeWindowMode": "sliding", "followingViewWidth": 15,
        "yAxisLabel": units, "showXAxisLabels": True, "showYAxisLabels": True}
    if minimum is not None:
        result["minYValue"] = minimum
    if maximum is not None:
        result["maxYValue"] = maximum
    return result


def motion_series(names, field, axes):
    return [(f"/ceres/{name}/motion.{field}.{axis}", f"{name.capitalize()} {axis.upper() if field == 'position' else axis}", colour)
            for name in names
            for axis, colour in zip(axes, HEAD_COLOURS if name == "head" else HAND_COLOURS[name])]


def scene_panel(title, frame, topics, *, distance, target):
    return {"foxglovePanelTitle": title, "fixedFrame": frame, "followTf": frame,
        "followMode": "follow-none", "cameraState": {"distance": distance, "perspective": True,
            "target": target, "targetOffset": [0, 0, 0], "targetOrientation": [0, 0, 0, 1],
            "thetaOffset": 45, "phi": 65, "fovy": 45, "near": 0.01, "far": 100},
        "scene": {"enableStats": True, "backgroundColor": "#11161e",
                  "transforms": {"visible": False, "showLabel": False}},
        "topics": topics, "transforms": {}, "layers": {}}


def make_layout(video, *, dual_arm=False):
    diag = "/ceres/diagnostics."
    rates = [(diag + "video_fps", "Video", "#b4d67e"),
             (diag + "motion_fps", "Head", "#cbd5e1"),
             (diag + "left_fps", "Left hand", "#26bfff"),
             (diag + "right_fps", "Right hand", "#ff8c26")]
    timings = [(diag + "loop_ms", "Viewer loop", "#cbd5e1")]
    if dual_arm:
        rates.append(("/ceres/robot/diagnostics.update_fps", "Robot", "#d9a6ff"))
        timings.append(("/ceres/robot/diagnostics.solve_ms", "Retargeting", "#d9a6ff"))
    panels = {
        "Image!camera": {"foxglovePanelTitle": "Quest live video", "imageMode": {"imageTopic": video}, "synchronize": False},
        "3D!tracking": scene_panel("Quest acquisition", "ceres_origin", {
            "/ceres/scene": {"visible": True},
            "/ceres/robot/scene": {"visible": False},
            "/ceres/camera/calibration": {"visible": True, "distance": 0.216},
            "/ceres/camera/projection": {"visible": True, "cameraInfoTopic": "/ceres/camera/calibration",
                "distance": 0.216, "planarProjectionFactor": 1, "color": "#ffffff80"}},
            distance=2.4, target=[0.25, 0, 1.25]),
        "Plot!rates": plot("Received frame rates", rates, "Frames/s", minimum=0),
        "Plot!load": plot("Viewer CPU load", [(diag + "process_cpu_percent", "CPU", "#d9a6ff")],
            "Percent of one CPU core", minimum=0),
        "Plot!memory": plot("Viewer resident memory", [(diag + "process_rss_mb", "RSS", "#d9a6ff")],
            "MiB", minimum=0),
        "Plot!timings": plot("Processing time", timings, "Milliseconds", minimum=0),
        "Plot!age": plot("Pose age and clock uncertainty", [(diag + "head_age_ms", "Head age", "#cbd5e1"),
            (diag + "left_age_ms", "Left age", "#26bfff"), (diag + "right_age_ms", "Right age", "#ff8c26"),
            (diag + "clock_uncertainty_ms", "Clock uncertainty", "#d9a6ff")], "Milliseconds", minimum=0),
        "Plot!pinch": plot("Thumb to index distance", [(diag + "left_pinch_m", "Left", "#26bfff"),
            (diag + "right_pinch_m", "Right", "#ff8c26")], "Metres", minimum=0, maximum=0.15),
        "RawMessages!details": {"foxglovePanelTitle": "Stream diagnostics", "topicPath": "/ceres/diagnostics", "defaultExpanded": True},
        "RawMessages!left": {"foxglovePanelTitle": "Left joint details", "topicPath": "/ceres/left/joints", "defaultExpanded": True},
        "RawMessages!right": {"foxglovePanelTitle": "Right joint details", "topicPath": "/ceres/right/joints", "defaultExpanded": True},
        "Plot!head-position": plot("Head position", motion_series(("head",), "position", "xyz"), "Metres"),
        "Plot!head-rotation": plot("Head rotation", motion_series(("head",), "rotation", ("roll", "pitch", "yaw")), "Radians"),
        "Plot!hand-position": plot("Wrist position", motion_series(("left", "right"), "position", "xyz"), "Metres"),
        "Plot!hand-rotation": plot("Wrist rotation", motion_series(("left", "right"), "rotation", ("roll", "pitch", "yaw")), "Radians"),
    }
    indicators = []
    for name, path, raw, label in (("connection", "connection", "connected", "Connected"),
                                  ("head", "head_tracked", "true", "Head tracked"),
                                  ("left", "left_tracked", "true", "Left tracked"),
                                  ("right", "right_tracked", "true", "Right tracked")):
        identifier = "Indicator!" + name
        indicators.append(identifier)
        panels[identifier] = {"foxglovePanelTitle": label, "path": diag + path, "style": "background", "fontSize": 20,
            "fallbackColor": "#7f1d1d", "fallbackLabel": "Disconnected" if name == "connection" else "Not tracked",
            "rules": [{"operator": "=", "rawValue": raw, "color": "#14532d", "label": label}]}

    visual_views = split("row", "3D!tracking", "Image!camera", 60)
    signal_views = three_columns(
        split("column", "Plot!head-position", "Plot!head-rotation"),
        split("column", "Plot!hand-position", "Plot!hand-rotation"),
        split("column", "Plot!rates", "Plot!load"))
    if dual_arm:
        panels["3D!robot"] = scene_panel("Dual robot arms", "ceres_robot_base", {
            "/ceres/robot/scene": {"visible": True},
            "/ceres/scene": {"visible": False},
            "/ceres/camera/calibration": {"visible": False},
            "/ceres/camera/projection": {"visible": False}}, distance=1.6, target=[0.05, 0, 0.8])
        for side in ("left", "right"):
            panels[f"Plot!robot-{side}"] = plot(f"{side.capitalize()} arm joints", [
                (f"/ceres/robot/joints.{side}.{joint}", joint.replace("_", " ").capitalize(), colour)
                for joint, colour in zip(ROBOT_JOINTS, ROBOT_COLOURS)], "Radians")
        panels["RawMessages!robot"] = {"foxglovePanelTitle": "Robot diagnostics", "topicPath": "/ceres/robot/diagnostics", "defaultExpanded": True}
        visual_views = split("row", split("row", "3D!robot", "3D!tracking"), "Image!camera", 76)
        signal_views = three_columns(
            split("column", "Plot!hand-position", "Plot!hand-rotation"),
            split("column", "Plot!robot-left", "Plot!robot-right"),
            split("column", "Plot!rates", "Plot!load"))

    detail_views = split("column", three_columns("Plot!age", "Plot!timings", "Plot!memory"),
        split("row", "RawMessages!details", "RawMessages!robot" if dual_arm else "Plot!pinch"))
    tabs = [
        {"title": "Live monitoring", "layout": split("column", visual_views, signal_views, 46)},
        {"title": "Performance and diagnostics", "layout": detail_views},
        {"title": "Joint details", "layout": split("row", "RawMessages!left", "RawMessages!right")},
    ]
    if dual_arm:
        tabs.append({"title": "Head and grasp", "layout": split("column",
            split("row", "Plot!head-position", "Plot!head-rotation"), "Plot!pinch", 70)})
    panels["Tab!workspace"] = {"activeTabIdx": 0, "tabs": tabs}
    return {"version": 1, "configById": panels, "globalVariables": {}, "userNodes": {},
        "playbackConfig": {"speed": 1}, "layout": split("column",
            split("row", split("row", *indicators[:2]), split("row", *indicators[2:])),
            "Tab!workspace", 7)}


if __name__ == "__main__":
    package_data = Path(__file__).parents[1] / "src" / "ceres_bridge" / "data"
    package_data.mkdir(parents=True, exist_ok=True)
    for filename, topic, dual_arm in (
        ("layout.json", "/ceres/camera/video", False),
        ("vp8-layout.json", "/ceres/camera/projection", False),
        ("dual-arm-layout.json", "/ceres/camera/video", True),
        ("dual-arm-vp8-layout.json", "/ceres/camera/projection", True),
    ):
        content = json.dumps(make_layout(topic, dual_arm=dual_arm), indent=2) + "\n"
        Path(__file__).with_name(filename).write_text(content, encoding="utf-8", newline="\n")
        (package_data / filename).write_text(content, encoding="utf-8", newline="\n")
    ros = {"version": 1, "globalVariables": {}, "userNodes": {}, "playbackConfig": {"speed": 1},
           "configById": {"Image!camera": {"imageMode": {"imageTopic": "/ceres/camera/image"}},
                          "3D!tracking": {"topics": {"/ceres/scene": {"visible": True}}}},
           "layout": split("row", "Image!camera", "3D!tracking")}
    content = json.dumps(ros, indent=2) + "\n"
    Path(__file__).with_name("ros-layout.json").write_text(content, encoding="utf-8", newline="\n")
    (package_data / "ros-layout.json").write_text(content, encoding="utf-8", newline="\n")
