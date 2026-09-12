"""Connection links and bundled layouts for the standard Foxglove application."""

from importlib.resources import files
from urllib.parse import urlencode

LAYOUTS = ("layout.json", "vp8-layout.json", "ros-layout.json", "dual-arm-layout.json", "dual-arm-vp8-layout.json")


def layout_bytes(name):
    if name not in LAYOUTS:
        raise ValueError("Unknown Bridge layout")
    return files("ceres_bridge").joinpath("data", name).read_bytes()


def connection_links(host, port):
    # A wildcard is a listening address, not an address a viewer can open.
    host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    websocket = f"ws://{authority}/"
    return {
        "websocket": websocket,
        "open": "foxglove://open?" + urlencode({"ds": "foxglove-websocket", "ds.url": websocket}),
        "layout": f"http://{authority}/layouts/layout.json",
    }
