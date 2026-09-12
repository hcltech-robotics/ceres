"""Open the dual-arm Foxglove example on an existing CERES Bridge receiver.

Usage: python examples/dual_arm.py --socket /path/to/receiver.sock
       python examples/dual_arm.py --retargeter isaacteleop
       python examples/dual_arm.py --robot-origin 0 0 0.2 --robot-yaw 90
"""

import sys

from ceres_bridge.cli import main


if __name__ == "__main__":
    sys.argv[1:1] = ["foxglove", "--robot", "xlerobot"]
    main()
