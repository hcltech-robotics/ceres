"""Read fresh poses and leased RGB frames from the running worker."""

import time
from ceres_bridge import Receiver


with Receiver() as receiver:
    while True:
        observation = receiver.latest()
        head = observation["poses"].get("1", {})
        if head.get("tracked"):
            print("Head", head["pose"]["sequence"], head["pose"]["values"][:3])
        frame = observation["frame"]
        if frame:
            with frame:
                print("Video", frame.metadata["width"], frame.metadata["height"])
        time.sleep(0.01)
