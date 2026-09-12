from glob import glob
from setuptools import setup

setup(name="ceres_bridge_ros", version="1.0.0", packages=["ceres_bridge_ros"],
      data_files=[("share/ament_index/resource_index/packages", ["resource/ceres_bridge_ros"]),
                  ("share/ceres_bridge_ros", ["package.xml"]),
                  ("share/ceres_bridge_ros/launch", glob("launch/*.launch.py"))],
      install_requires=["setuptools"], zip_safe=True,
      maintainer="Chris von Csefalvay", maintainer_email="chris@chrisvoncsefalvay.com",
      description="ROS 2 output for the CERES Linux receiver", license="MIT",
      entry_points={"console_scripts": ["receiver = ceres_bridge_ros.node:main"]})
