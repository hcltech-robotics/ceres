"""Print non-secret GStreamer runtime capabilities for acceptance setup."""
import asyncio
import gi
gi.require_version("Gst", "1.0")
gi.require_version("GstWebRTC", "1.0")
from gi.repository import Gst
from ceres_bridge.media import MediaPeer
from ceres_bridge.ipc import Broker
from ceres_bridge.state import LatestState


async def main():
    state = LatestState()
    import os
    peer = MediaPeer(state, Broker(state), lambda _: None, bind_address=os.environ.get("BRIDGE_TEST_BIND_ADDRESS"))
    try:
        ice = peer.webrtc.get_property("ice-agent")
        print("ICE properties:", [(p.name, p.value_type.name) for p in ice.list_properties()])
        print("ICE implementation:", ice.__gtype__.name)
    finally:
        peer.close()


asyncio.run(main())
