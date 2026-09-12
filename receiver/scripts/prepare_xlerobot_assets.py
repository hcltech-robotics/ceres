"""Prepare the pinned XLeRobot URDF visual meshes as cacheable GLB assets."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import struct
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np

REVISION = "3d14695e40c9c68229c0aacffca6053c75cd3eb6"
REPOSITORY = "Vector-Wangel/XLeRobot"
ROOT = f"https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}/"
MODEL = "simulation/Maniskill/assets/xlerobot/"
# Foxglove converts standard glTF Y-up coordinates into its Z-up scene.
GLTF_FROM_LINK = np.array(((1, 0, 0), (0, 0, 1), (0, -1, 0)), dtype=float)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def numbers(value, default):
    return [float(part) for part in (value or default).split()]


def rotation(rpy):
    roll, pitch, yaw = rpy
    cx, sx, cy, sy, cz, sz = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
    return np.array(((cz, -sz, 0), (sz, cz, 0), (0, 0, 1))) @ np.array(((cy, 0, sy), (0, 1, 0), (-sy, 0, cy))) @ np.array(((1, 0, 0), (0, cx, -sx), (0, sx, cx)))


def fetch(path, cache):
    target = cache / path
    if not target.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(ROOT + path, timeout=30) as response:
            target.write_bytes(response.read())
    return target.read_bytes()


def visual_recipe(link, materials):
    result = []
    for visual in link.findall("visual"):
        mesh = visual.find("geometry/mesh")
        if mesh is None:
            raise ValueError("The upstream visual is not a mesh")
        origin = visual.find("origin")
        material = visual.find("material")
        name = material.get("name") if material is not None else None
        inline_colour = material.find("color") if material is not None else None
        colour = numbers(inline_colour.get("rgba"), "0.7 0.7 0.7 1") if inline_colour is not None else materials.get(name, [.7, .7, .7, 1])
        result.append({"mesh": mesh.get("filename"), "scale": numbers(mesh.get("scale"), "1 1 1"),
            "xyz": numbers(origin.get("xyz") if origin is not None else None, "0 0 0"),
            "rpy": numbers(origin.get("rpy") if origin is not None else None, "0 0 0"),
            "rgba": colour})
    return result


def glb(recipes, mesh_bytes):
    binary = bytearray()
    document = {"asset": {"version": "2.0", "generator": "CERES XLeRobot visual conversion",
        "copyright": "Vector-Wangel/XLeRobot contributors, Apache-2.0"},
        "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [], "materials": [],
        "buffers": [], "bufferViews": [], "accessors": []}
    triangles = 0
    all_positions = []

    def accessor(values, component_type, kind, target, bounds=False):
        while len(binary) % 4:
            binary.append(0)
        index = len(document["bufferViews"])
        payload = values.tobytes()
        document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload), "target": target})
        binary.extend(payload)
        record = {"bufferView": index, "componentType": component_type, "count": len(values), "type": kind}
        if bounds:
            record.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
        document["accessors"].append(record)
        return len(document["accessors"]) - 1

    for recipe in recipes:
        data = mesh_bytes[recipe["mesh"]]
        count = struct.unpack_from("<I", data, 80)[0]
        if len(data) != 84 + 50 * count:
            raise ValueError("Expected a binary STL triangle mesh")
        records = np.frombuffer(data, dtype=np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")]), offset=84)
        original = records["vertices"].astype(float)
        placed = (original * recipe["scale"]) @ rotation(recipe["rpy"]).T + recipe["xyz"]
        positions = placed @ GLTF_FROM_LINK.T
        normals = np.cross(positions[:, 1] - positions[:, 0], positions[:, 2] - positions[:, 0])
        lengths = np.linalg.norm(normals, axis=1)
        usable = lengths > 1e-12
        positions, normals, lengths = positions[usable], normals[usable], lengths[usable]
        normals = normals / lengths[:, None]
        packed = np.concatenate((positions.reshape(-1, 3), np.repeat(normals, 3, axis=0)), axis=1).astype("<f4")
        vertices, indices = np.unique(packed, axis=0, return_inverse=True)
        positions = vertices[:, :3].copy()
        normal_values = vertices[:, 3:].copy()
        index_type = "<u2" if len(vertices) < 65536 else "<u4"
        indices = indices.astype(index_type)
        p = accessor(positions, 5126, "VEC3", 34962, bounds=True)
        n = accessor(normal_values, 5126, "VEC3", 34962)
        i = accessor(indices, 5123 if index_type == "<u2" else 5125, "SCALAR", 34963)
        material = len(document["materials"])
        document["materials"].append({"name": Path(recipe["mesh"]).stem, "pbrMetallicRoughness": {
            "baseColorFactor": recipe["rgba"], "metallicFactor": 0, "roughnessFactor": 0.8}, "doubleSided": False})
        mesh = len(document["meshes"])
        document["meshes"].append({"primitives": [{"attributes": {"POSITION": p, "NORMAL": n}, "indices": i, "material": material}]})
        node = len(document["nodes"])
        document["nodes"].append({"mesh": mesh, "name": Path(recipe["mesh"]).stem, "extras": recipe})
        document["scenes"][0]["nodes"].append(node)
        triangles += len(indices) // 3
        all_positions.append(positions)
    while len(binary) % 4:
        binary.append(0)
    document["buffers"] = [{"byteLength": len(binary)}]
    header = json.dumps(document, separators=(",", ":")).encode("utf-8")
    header += b" " * (-len(header) % 4)
    payload = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(header) + 8 + len(binary))
    payload += struct.pack("<II", len(header), 0x4E4F534A) + header
    payload += struct.pack("<II", len(binary), 0x004E4942) + binary
    bounds = np.concatenate(all_positions)
    return payload, triangles, [bounds.min(axis=0).tolist(), bounds.max(axis=0).tolist()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).parents[1] / "src" / "ceres_bridge" / "data" / "xlerobot")
    args = parser.parse_args()
    cache, output = args.source_cache.resolve() / REVISION, args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    urdf = fetch(MODEL + "xlerobot.urdf", cache)
    licence = fetch("LICENSE", cache)
    robot = ET.fromstring(urdf)
    materials = {material.get("name"): numbers(material.find("color").get("rgba"), ".7 .7 .7 1")
                 for material in robot.findall("material")}
    recipes = {link.get("name"): visual_recipe(link, materials) for link in robot.findall("link") if link.find("visual") is not None}
    names = sorted({recipe["mesh"] for visuals in recipes.values() for recipe in visuals})
    with ThreadPoolExecutor(max_workers=6) as executor:
        downloaded = list(executor.map(lambda name: fetch(MODEL + name, cache), names))
    sources = dict(zip(names, downloaded))
    manifest = {"version": 1, "repository": "https://github.com/" + REPOSITORY, "revision": REVISION,
        "licence": "Apache-2.0", "source_urdf_sha256": digest(urdf), "gltf_from_link": GLTF_FROM_LINK.tolist(),
        "source_files": {name: {"url": ROOT + MODEL + name, "sha256": digest(data), "bytes": len(data)} for name, data in sources.items()},
        "models": {}, "joints": []}
    seen = {}
    for name, recipe in recipes.items():
        signature = json.dumps(recipe, sort_keys=True)
        if signature not in seen:
            payload, triangles, bounds = glb(recipe, sources)
            sha = digest(payload)
            filename = name.lower() + "-" + sha[:12] + ".glb"
            (output / filename).write_bytes(payload)
            seen[signature] = {"file": filename, "sha256": sha, "bytes": len(payload), "triangles": triangles, "gltf_bounds": bounds}
        manifest["models"][name] = {**seen[signature], "visuals": recipe}
    for joint in robot.findall("joint"):
        origin = joint.find("origin")
        manifest["joints"].append({"name": joint.get("name"), "parent": joint.find("parent").get("link"),
            "child": joint.find("child").get("link"),
            "xyz": numbers(origin.get("xyz") if origin is not None else None, "0 0 0"),
            "rpy": numbers(origin.get("rpy") if origin is not None else None, "0 0 0")})
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "xlerobot.urdf").write_bytes(urdf)
    (output / "LICENSE.txt").write_bytes(licence)
    notice = f"XLeRobot visual models\n\nSource: https://github.com/{REPOSITORY}/tree/{REVISION}/{MODEL}\nRevision: {REVISION}\nLicence: Apache-2.0 (see LICENSE.txt).\n\nCERES modifications: converted upstream STL visual meshes to GLB, applied the URDF visual origins, scales and materials, and converted link coordinates to glTF Y-up. The original triangle geometry is retained apart from zero-area faces. Sources and generated files are recorded in manifest.json.\n"
    (output / "NOTICE.txt").write_text(notice, encoding="utf-8")
    print(json.dumps({"models": len(manifest["models"]), "unique_glbs": len(seen), "triangles": sum(item["triangles"] for item in seen.values()),
        "glb_bytes": sum(item["bytes"] for item in seen.values()), "source_bytes": sum(len(data) for data in sources.values())}))


if __name__ == "__main__":
    main()
