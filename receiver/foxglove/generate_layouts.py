"""Generate Foxglove desktop layouts (version 1 mosaic export format)."""

import json
from pathlib import Path


def split(direction, first, second, percentage=50):
    return {"direction": direction, "first": first, "second": second, "splitPercentage": percentage}


def plot(title, series, units, maximum=None):
    result = {"title": title, "paths": [
        {"value": path, "label": label, "color": colour, "enabled": True,
         "timestampMethod": "receiveTime", "showLine": True}
        for path, label, colour in series], "xAxisVal": "timestamp", "showLegend": True,
        "legendDisplay": "top", "showPlotValuesInLegend": True, "isSynced": True,
        "timeWindowMode": "sliding", "followingViewWidth": 15, "minYValue": 0,
        "yAxisLabel": units, "showXAxisLabels": True, "showYAxisLabels": True}
    if maximum is not None:
        result["maxYValue"] = maximum
    return result


def make_layout(video):
    diag = "/ceres/diagnostics."
    panels = {
        "Image!camera": {"title": "Outward camera", "imageMode": {"imageTopic": video}, "synchronize": False},
        "3D!tracking": {"title": "Head and hands", "fixedFrame": "ceres_origin", "followTf": "ceres_origin",
            "followMode": "follow-none", "cameraState": {"distance": 2.4, "perspective": True,
                "target": [0.25, 0, 1.25], "targetOffset": [0, 0, 0], "targetOrientation": [0, 0, 0, 1],
                "thetaOffset": 45, "phi": 65, "fovy": 45, "near": 0.01, "far": 100},
            "scene": {"enableStats": True, "backgroundColor": "#11161e"},
            "topics": {"/ceres/scene": {"visible": True},
                "/ceres/camera/calibration": {"visible": True, "distance": 0.36},
                "/ceres/camera/projection": {"visible": True, "cameraInfoTopic": "/ceres/camera/calibration",
                    "distance": 0.36, "planarProjectionFactor": 1, "color": "#ffffff80"}}, "transforms": {}, "layers": {}},
        "Plot!rates": plot("Received frame rates", [(diag + "video_fps", "Video", "#b4d67e"),
            (diag + "motion_fps", "Head", "#cbd5e1"), (diag + "left_fps", "Left", "#26bfff"),
            (diag + "right_fps", "Right", "#ff8c26")], "Frames/s"),
        "Plot!age": plot("Pose age and clock uncertainty", [(diag + "head_age_ms", "Head age", "#cbd5e1"),
            (diag + "left_age_ms", "Left age", "#26bfff"), (diag + "right_age_ms", "Right age", "#ff8c26"),
            (diag + "clock_uncertainty_ms", "Clock uncertainty", "#d9a6ff")], "Milliseconds"),
        "Plot!pinch": plot("Thumb to index distance", [(diag + "left_pinch_m", "Left", "#26bfff"),
            (diag + "right_pinch_m", "Right", "#ff8c26")], "Metres", 0.15),
        "RawMessages!details": {"title": "Stream diagnostics", "topicPath": "/ceres/diagnostics", "defaultExpanded": True},
        "RawMessages!left": {"title": "All 25 left joints", "topicPath": "/ceres/left/joints", "defaultExpanded": True},
        "RawMessages!right": {"title": "All 25 right joints", "topicPath": "/ceres/right/joints", "defaultExpanded": True},
        "Plot!position": plot("Head position", [("/ceres/head/pose.pose.position." + axis, axis.upper(), colour)
            for axis, colour in zip("xyz", ("#f87171", "#4ade80", "#60a5fa"))], "Metres"),
    }
    panels["Plot!position"].pop("minYValue")
    indicators = []
    for name, path, raw, label in (("connection", "connection", "connected", "Connected"),
                                  ("head", "head_tracked", "true", "Head tracked"),
                                  ("left", "left_tracked", "true", "Left tracked"),
                                  ("right", "right_tracked", "true", "Right tracked")):
        identifier = "Indicator!" + name
        indicators.append(identifier)
        panels[identifier] = {"title": label, "path": diag + path, "style": "background", "fontSize": 20,
            "fallbackColor": "#7f1d1d", "fallbackLabel": "Disconnected" if name == "connection" else "Not tracked",
            "rules": [{"operator": "=", "rawValue": raw, "color": "#14532d", "label": label}]}
    panels["Tab!analysis"] = {"activeTabIdx": 0, "tabs": [
        {"title": "Rates, age and pinch", "layout": split("row", "Plot!rates", split("row", "Plot!age", "Plot!pinch"), 34)},
        {"title": "Head position and diagnostics", "layout": split("row", "Plot!position", "RawMessages!details")},
        {"title": "Joint poses and validity", "layout": split("row", "RawMessages!left", "RawMessages!right")}]}
    return {"version": 1, "configById": panels, "globalVariables": {}, "userNodes": {},
        "playbackConfig": {"speed": 1}, "layout": split("column",
            split("row", split("row", *indicators[:2]), split("row", *indicators[2:])),
            split("column", split("row", "Image!camera", "3D!tracking", 45), "Tab!analysis", 65), 9)}


if __name__ == "__main__":
    package_data = Path(__file__).parents[1] / "src" / "ceres_bridge" / "data"
    package_data.mkdir(parents=True, exist_ok=True)
    for filename, topic in (("layout.json", "/ceres/camera/video"), ("vp8-layout.json", "/ceres/camera/projection")):
        content = json.dumps(make_layout(topic), indent=2) + "\n"
        Path(__file__).with_name(filename).write_text(content, encoding="utf-8")
        (package_data / filename).write_text(content, encoding="utf-8")
    ros = {"version": 1, "globalVariables": {}, "userNodes": {}, "playbackConfig": {"speed": 1},
           "configById": {"Image!camera": {"imageMode": {"imageTopic": "/ceres/camera/image"}},
                          "3D!tracking": {"topics": {"/ceres/scene": {"visible": True}}}},
           "layout": split("row", "Image!camera", "3D!tracking")}
    content = json.dumps(ros, indent=2) + "\n"
    Path(__file__).with_name("ros-layout.json").write_text(content, encoding="utf-8")
    (package_data / "ros-layout.json").write_text(content, encoding="utf-8")
