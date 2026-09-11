"""Right-handed WebXR to ROS body-frame basis conversion."""


def ros_position(values):
    return (-values[2], -values[0], values[1])


def ros_orientation(values):
    # q_ros = q_basis * q_xr * inverse(q_basis).
    return (-values[2], -values[0], values[1], values[3])


HAND_BONES = tuple((i, i + 1) for i in range(25) if i not in (0, 4, 9, 14, 19, 24)) + tuple((0, i) for i in (1, 5, 10, 15, 20))
