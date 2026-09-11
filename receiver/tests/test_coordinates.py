import unittest
from ceres_bridge.coordinates import ros_orientation, ros_position


def multiply(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx,
            aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz)


def rotate(q, vector):
    return multiply(multiply(q, (*vector, 0)), (-q[0], -q[1], -q[2], q[3]))[:3]


class CoordinateTests(unittest.TestCase):
    def test_forward_up_and_right(self):
        self.assertEqual(ros_position((0, 0, -1)), (1, 0, 0))
        self.assertEqual(ros_position((0, 1, 0)), (0, 0, 1))
        self.assertEqual(ros_position((1, 0, 0)), (0, -1, 0))

    def test_basis_conversion_preserves_rotated_vectors(self):
        q = (0.5, 0.5, 0.5, 0.5)
        v = (1, 2, 3)
        self.assertEqual(ros_position(rotate(q, v)), rotate(ros_orientation(q), ros_position(v)))


if __name__ == "__main__":
    unittest.main()
