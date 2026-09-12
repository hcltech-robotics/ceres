"""CERES Bridge command-line entry points."""

import argparse
import asyncio
import json
import os
import platform
import socket
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Receive live CERES video and poses")
    commands = parser.add_subparsers(dest="command", required=True)
    listen = commands.add_parser("listen", help="Start or reconnect the receiver")
    listen.add_argument("--name", default=socket.gethostname(), help="Name shown on the headset")
    listen.add_argument("--relay", help="Signalling origin, defaults to the browser origin")
    listen.add_argument("--app-origin", default=os.environ.get("CERES_PUBLIC_ORIGIN", "http://127.0.0.1:4317"), help="CERES browser origin")
    listen.add_argument("--bind-address", help="Local LAN address used for ICE gathering")
    listen.add_argument("--jitter-ms", type=int, choices=(0, 5, 10), default=5)
    listen.add_argument("--socket", help="Private Unix socket path")
    listen.add_argument("--qr-code", help="Write the current pairing invitation as an SVG QR image")
    listen.add_argument("--forget", action="store_true", help="Revoke and remove the remembered headset")
    status = commands.add_parser("status", help="Read current receiver status")
    status.add_argument("--socket")
    foxglove = commands.add_parser("foxglove", help="Expose the existing receiver to Foxglove")
    foxglove.add_argument("--socket")
    foxglove.add_argument("--host", default="127.0.0.1")
    foxglove.add_argument("--port", type=int, default=8765)
    foxglove.add_argument("--assets", help="Directory containing quest-3.glb and authorised mano-left/right.json assets")
    foxglove.add_argument("--robot", choices=("xlerobot",), help="Retarget both wrists to the XLeRobot arm model")
    foxglove.add_argument("--retargeter", choices=("cpu", "isaacteleop"), default="cpu",
                         help="Wrist target adapter for the dual-arm example")
    foxglove.add_argument("--robot-rate", type=int, choices=range(1, 121), default=60, metavar="1-120",
                         help="Maximum robot update rate in Hz (default: 60)")
    foxglove.add_argument("--position-scale", type=float, default=0.6,
                         help="Scale absolute wrist positions before the fixed robot transform (default: 0.6)")
    foxglove.add_argument("--robot-origin", type=float, nargs=3, metavar=("X", "Y", "Z"), default=(0.0, 0.0, 0.0),
                         help="Position of the scaled CERES origin in the robot base, in metres (default: 0 0 0)")
    foxglove.add_argument("--robot-yaw", type=float, default=0.0,
                         help="Fixed CERES-to-robot rotation about Z, in degrees (default: 0)")
    foxglove.add_argument("--tracking-grace", type=float, default=0.5,
                         help="Seconds to continue towards the last target after tracking loss before returning to neutral (default: 0.5)")
    commands.add_parser("doctor", help="Check the Linux media runtime")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Run the receiver on Linux")
    try:
        if args.command == "listen":
            args.relay = args.relay or args.app_origin
            from .worker import run
            asyncio.run(run(args))
        elif args.command == "foxglove":
            from .foxglove_output import run
            asyncio.run(run(args))
        elif args.command == "doctor":
            from .media import Gst, GstWebRTC
            required = ("webrtcbin", "nicesrc", "dtlssrtpdec", "sctpdec", "rtph264depay", "h264parse", "avdec_h264", "rtpvp8depay", "vp8dec", "videoconvert", "rtpopusdepay", "opusdec", "audioconvert", "audioresample", "appsink")
            missing = [name for name in required if not Gst.ElementFactory.find(name)]
            print(f"Linux {platform.machine()}, Python {platform.python_version()}, {Gst.version_string()}")
            if missing:
                raise RuntimeError("Missing GStreamer plugins: " + ", ".join(missing))
            print("Receiver media dependencies are ready")
        else:
            from .client import Receiver
            with Receiver(args.socket, video=False) as receiver:
                print(json.dumps(receiver.latest(), indent=2))
    except (RuntimeError, ValueError, OSError, ImportError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
