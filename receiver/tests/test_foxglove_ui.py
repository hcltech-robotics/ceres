import json
from urllib.parse import parse_qs, urlsplit

import pytest

from ceres_bridge.foxglove_ui import LAYOUTS, connection_links, layout_bytes


def test_bundled_layouts_resolve_every_panel_and_use_the_expected_camera():
    for name, topic in zip(LAYOUTS, ("/ceres/camera/video", "/ceres/camera/projection", "/ceres/camera/image")):
        layout = json.loads(layout_bytes(name))
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
