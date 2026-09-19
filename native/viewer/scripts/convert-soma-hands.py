#!/usr/bin/env python3
"""Bake the pinned SOMA-X native hand rig into the viewer's CHM2 asset format.

Conversion requires NumPy and OpenUSD. The packaged viewer reads the baked files
directly and has no Python, PyTorch or model-download dependency.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct

import numpy as np
from pxr import Usd, UsdGeom, UsdSkel


RELEASE = "0.3.1"
SOURCE_REVISION = "cc1f3967755f8e36d187d2e26114633dbd651cd5"
ASSET_REVISION = "104578ed58857f6faa7592fb83d0a2dad43c36fa"
SOURCES = {
    "SOMAHand.npz": "233e9225c1da05c6a3dd98107b9f027f2366e3b972bbe67e0d164e5d28619fff",
    "SOMA_template_rig.usda": "a952cb7bdf4ccd801e355d53122d395b985b69d0d9181439edad5081bb171856",
    "LICENSE": "d1a7d615ab8eff4de143b1456f46dabf232f54daf0fcf9a70442bb6f637a9e95",
}
JOINTS = ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"]
for _finger in ("index", "middle", "ring", "pinky"):
    JOINTS.extend(f"{_finger}-finger-{part}" for part in (
        "metacarpal", "phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip"))
PARENTS = np.array([0, 0, 1, 2, 3, 0, 5, 6, 7, 8, 0, 10, 11, 12, 13, 0, 15, 16, 17, 18, 0, 20, 21, 22, 23])


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_hands(source):
    for name, checksum in SOURCES.items():
        if sha256(source / name) != checksum:
            raise ValueError(f"Pinned source checksum differs: {name}")
    stage = Usd.Stage.Open(str(source / "SOMA_template_rig.usda"))
    skeleton = UsdSkel.Skeleton(stage.GetPrimAtPath("/OUTPUT/c_skeleton_grp/Root"))
    mesh = UsdGeom.Mesh(stage.GetPrimAtPath("/OUTPUT/c_geometry_grp/MainMesh/Meshes/c_skin_mid"))
    binding = UsdSkel.BindingAPI(mesh)
    joint_names = [str(name).split("/")[-1] for name in skeleton.GetJointsAttr().Get()]
    mesh_joint_names = [str(name).split("/")[-1] for name in binding.GetJointsAttr().Get()]
    if len(set(joint_names)) != len(joint_names) or len(set(mesh_joint_names)) != len(mesh_joint_names):
        raise ValueError("Ambiguous source joint names")
    # Gf matrices use row vectors. Convert them once to column-vector notation.
    bind_world = np.asarray(skeleton.GetBindTransformsAttr().Get(), dtype=np.float64).transpose(0, 2, 1)
    geometry_bind = np.asarray(binding.GetGeomBindTransformAttr().Get(), dtype=np.float64).T
    points = np.asarray(mesh.GetPointsAttr().Get(), dtype=np.float64)
    points_world = (np.c_[points, np.ones(len(points))] @ geometry_bind.T)[:, :3]
    count = binding.GetJointWeightsPrimvar().GetElementSize()
    source_bones = np.asarray(binding.GetJointIndicesPrimvar().ComputeFlattened(), dtype=np.int32).reshape(-1, count)
    source_weights = np.asarray(binding.GetJointWeightsPrimvar().ComputeFlattened(), dtype=np.float64).reshape(-1, count)
    if mesh.GetOrientationAttr().Get() != "rightHanded" or UsdGeom.GetStageMetersPerUnit(stage) != 0.01:
        raise ValueError("Unexpected source orientation or units")
    mappings = np.load(source / "SOMAHand.npz", allow_pickle=False)
    result = []
    for side in ("left", "right"):
        names = mappings[f"{side}_pose_reference_joint_names"].tolist()
        expected_names = [side.title() + "Hand"]
        expected_names += [side.title() + "HandThumb" + part for part in ("1", "2", "3", "End")]
        for finger in ("Index", "Middle", "Ring", "Pinky"):
            expected_names += [side.title() + "Hand" + finger + part for part in ("1", "2", "3", "4", "End")]
        if names != expected_names or not np.array_equal(mappings[f"{side}_joint_parent_ids"], PARENTS):
            raise ValueError("Source hand topology differs from the explicit WebXR mapping")
        joint_ids = np.array([joint_names.index(name) for name in names])
        vertex_ids = mappings[f"{side}_vert_ids"]
        faces = mappings[f"{side}_triangles"].astype(np.uint32)
        wrist_inverse = np.linalg.inv(bind_world[joint_ids[0]])
        local_bind = wrist_inverse[None] @ bind_world[joint_ids]
        vertices = (np.c_[points_world[vertex_ids], np.ones(len(vertex_ids))] @ wrist_inverse.T)[:, :3] * 0.01
        rest = local_bind[:, :3, 3] * 0.01
        local_bind[:, :3, 3] *= 0.01
        if not np.allclose(rest[0], 0, atol=1e-12) or np.any(np.linalg.norm(rest[1:] - rest[PARENTS[1:]], axis=1) < 0.001):
            raise ValueError("Invalid source hand landmarks")
        hand_weights = np.zeros((len(vertex_ids), 25), dtype=np.float64)
        source_to_hand = {mesh_joint_names.index(name): index for index, name in enumerate(names)}
        for source_joint, hand_joint in source_to_hand.items():
            hand_weights[:, hand_joint] = np.where(source_bones[vertex_ids] == source_joint, source_weights[vertex_ids], 0).sum(axis=1)
        # Match SOMAHandLayer._hand_weights exactly at the cut wrist boundary.
        boundary = mappings[f"{side}_boundary_loop"]
        hand_weights[boundary] = 0
        hand_weights[boundary, 0] = 1
        sums = hand_weights.sum(axis=1)
        if np.any(sums <= 0) or np.any(hand_weights < 0):
            raise ValueError("Unweighted or negative-weight source vertex")
        hand_weights /= sums[:, None]
        active = (hand_weights > 0).sum(axis=1)
        if active.max() > 16:
            raise ValueError("Source skinning exceeds the lossless CHM2 influence capacity")
        normals = np.zeros_like(vertices)
        triangles = vertices[faces]
        face_normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        for corner in range(3):
            np.add.at(normals, faces[:, corner], face_normals)
        lengths = np.linalg.norm(normals, axis=1)
        if np.any(lengths < 1e-14):
            raise ValueError("Degenerate source vertex normal")
        normals /= lengths[:, None]
        result.append(dict(side=side, vertices=vertices, normals=normals, faces=faces, rest=rest,
                           weights=hand_weights, source_joint_names=names, bind_frames=local_bind,
                           boundary_vertices=len(boundary), max_influences=int(active.max())))
    return result


def encode(hands):
    payload = bytearray(b"CHM2")
    for hand in hands:
        vertices, weights, faces = hand["vertices"], hand["weights"], hand["faces"]
        payload.extend(np.asarray(hand["rest"], dtype="<f4").tobytes())
        payload.extend(struct.pack("<II", len(vertices), faces.size))
        for index, vertex in enumerate(vertices):
            joint_ids = np.flatnonzero(weights[index] > 0)
            bones, values = np.zeros(16, dtype="<u4"), np.zeros(16, dtype="<f4")
            bones[:len(joint_ids)] = joint_ids
            values[:len(joint_ids)] = weights[index, joint_ids]
            payload.extend(np.asarray(np.r_[vertex, hand["normals"][index], 0, 0], dtype="<f4").tobytes())
            payload.extend(bones[:4].tobytes())
            payload.extend(values[:4].tobytes())
            payload.extend(bones[4:].tobytes())
            payload.extend(values[4:].tobytes())
        payload.extend(np.asarray(faces, dtype="<u4").tobytes())
    return bytes(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    hands = extract_hands(args.source)
    payload = encode(hands)
    metadata = {
        "schema": "ceres-hand-assets", "version": 2, "name": "soma-hand-mid",
        "retargeting": "webxr-anatomical-v1", "skin_influences": 16, "units": "metres",
        "licence": "Apache-2.0", "material": "untextured", "joint_names": JOINTS,
        "geometry_sha256": hashlib.sha256(payload).hexdigest(),
        "source": {"project": "NVIDIA SOMA-X", "release": RELEASE,
                   "repository": "https://github.com/NVlabs/SOMA-X", "revision": SOURCE_REVISION,
                   "assets_repository": "https://huggingface.co/nvidia/SOMA-X", "assets_revision": ASSET_REVISION,
                   "files": SOURCES, "identity": "native template bind shape", "lod": "mid"},
        "conversion": "Wrist-local metres with source topology and hand weights. Wrist boundary weights follow SOMAHandLayer. Area-weighted vertex normals. No textures or optional identity backends.",
        "hands": {hand["side"]: {"vertices": len(hand["vertices"]), "triangles": len(hand["faces"]),
                  "max_influences": hand["max_influences"], "wrist_boundary_vertices": hand["boundary_vertices"],
                  "source_joint_names": hand["source_joint_names"],
                  "source_bind_frames_wrist_local": hand["bind_frames"].round(12).tolist()} for hand in hands},
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "geometry.bin").write_bytes(payload)
    (args.output / "model.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=True) + "\n", encoding="utf-8", newline="\n")
    shutil.copyfile(args.source / "LICENSE", args.output / "LICENSE")
    (args.output / "NOTICE").write_text(
        "NVIDIA SOMA-X native hand meshes\nCopyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.\n"
        "Licensed under Apache License 2.0. See LICENSE.\n\n"
        f"Derived from SOMA-X v{RELEASE}, source commit {SOURCE_REVISION}.\n"
        f"Model asset revision {ASSET_REVISION}.\n"
        "https://github.com/NVlabs/SOMA-X\nhttps://huggingface.co/nvidia/SOMA-X\n\n"
        "CERES conversion extracts the native mid-resolution hand topology and rig,\n"
        "converts centimetres to wrist-local metres, retains source hand skinning\n"
        "weights with the published wrist-boundary rule and computes smooth normals.\n"
        "The mesh uses the template bind shape without optional third-party models.\n",
        encoding="utf-8", newline="\n")
    print(json.dumps({"geometry_sha256": metadata["geometry_sha256"], "bytes": len(payload),
                      "hands": {h["side"]: {"vertices": len(h["vertices"]), "triangles": len(h["faces"]),
                                 "max_influences": h["max_influences"]} for h in hands}}, indent=2))


if __name__ == "__main__":
    main()
