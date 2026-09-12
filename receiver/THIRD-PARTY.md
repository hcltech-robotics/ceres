# Third-party attribution

The XLeRobot arm joint origins, axes and limits in `src/ceres_bridge/teleop_model.py` are derived from [Vector-Wangel/XLeRobot](https://github.com/Vector-Wangel/XLeRobot/blob/3d14695e40c9c68229c0aacffca6053c75cd3eb6/simulation/Maniskill/assets/xlerobot/xlerobot.urdf), commit `3d14695e40c9c68229c0aacffca6053c75cd3eb6`.

XLeRobot is distributed under Apache-2.0. Its [full licence](examples/dual_arm_xlerobot.LICENCE.txt) accompanies the source and Python distributions. The Foxglove robot uses the upstream cart, arm, gripper and camera mesh geometry, converted from STL to GLB with the URDF visual origins, scales and materials. The conversion preserves the original triangles apart from zero-area faces and maps the link coordinates into glTF's Y-up convention. The packaged [asset manifest](src/ceres_bridge/data/xlerobot/manifest.json) records the source revision, source hashes and generated model hashes. The original URDF, licence and conversion notice are included beside the models. Original upstream material retains its Apache-2.0 terms.

IsaacTeleop is an optional, separately installed NVIDIA package. The adapter uses its public Python retargeting interface.
