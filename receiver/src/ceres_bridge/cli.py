"""CERES Bridge command-line entry points."""

import argparse
import asyncio
import json
import platform
import socket
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Receive live CERES video and poses")
    commands = parser.add_subparsers(dest="command", required=True)
    listen = commands.add_parser("listen", help="Start or reconnect the receiver")
    listen.add_argument("--name", default=socket.gethostname(), help="Name shown on the headset")
    listen.add_argument("--relay", default="https://ceres.ceres-relay.workers.dev", help="Public CERES signalling origin")
    listen.add_argument("--app-origin", default="https://ceres.cam", help="CERES browser origin")
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
    commands.add_parser("doctor", help="Check the Linux media runtime")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Run the receiver on Linux")
    try:
        if args.command == "listen":
            from .worker import run
            asyncio.run(run(args))
        elif args.command == "foxglove":
            from .foxglove_output import run
            asyncio.run(run(args))
        elif args.command == "doctor":
            from .media import Gst, GstWebRTC
            required = ("webrtcbin", "nicesrc", "dtlssrtpdec", "sctpdec", "rtph264depay", "h264parse", "avdec_h264", "rtpvp8depay", "vp8dec", "videoconvert", "appsink")
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
