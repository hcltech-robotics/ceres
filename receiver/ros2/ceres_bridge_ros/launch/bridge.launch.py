from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([Node(package="ceres_bridge_ros", executable="receiver", output="screen")])
