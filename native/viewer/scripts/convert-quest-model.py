#!/usr/bin/env python3
"""Convert the supplied Quest 3 USDZ into the native static-model format.

Usage: python scripts/convert-quest-model.py SOURCE.usdz assets/quest3

Conversion uses usd-core, NumPy and Pillow on the CPU. Runtime files have no
headers: vertices.bin contains little-endian float32 position[3], normal[3]
and UV[2], while indices.bin contains little-endian uint32 triangle indices.
Textures are RGBA8 with bottom-up rows, retaining the source UV coordinates.
model.json describes counts, material maps and a column-major rigid transform.

The input hash is pinned because the geometric landmarks refer to this model's
vertex topology. The source scene scale is removed but the model proportions
are preserved. Its lens-surface midpoint supplies a geometric alignment proxy,
not a measured eye position or optical calibration.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile

import numpy as np
from PIL import Image, __version__ as PILLOW_VERSION
from pxr import Usd, UsdGeom, UsdShade


SOURCE_SHA256 = "d8a19a3eed3edad501b1199aaa2a8b55e9aebf0952201324becc93565937deb3"
MESH_PATH = (
    "/scene/Meshes/Sketchfab_model/root/GLTF_SceneRootNode/"
    "Quest3HMD_0/Object_4/Object_0"
)
SCENE_PRIM = "/scene/Meshes/Sketchfab_model"
MODEL_URL = "https://sketchfab.com/3d-models/meta-quest-3-65a813833dc04eeeb7d33bdca58c184c"
AXES_URL = "https://www.w3.org/TR/webxr/#xrreferencespace"
SPEC_URL = "https://www.meta.com/quest/quest-3/#specs"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_bytes(path: Path, data: bytes) -> dict:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)
    return {"file": path.name, "bytes": len(data), "sha256": sha256(data)}


def write_json(path: Path, value: dict) -> dict:
    return write_bytes(path, (json.dumps(value, indent=2, ensure_ascii=True) + "\n").encode("ascii"))


def connected_vertices(faces: np.ndarray, vertex_count: int, seeds: list[int]) -> list[np.ndarray]:
    """Find fixed source landmarks without changing topology or merging seams."""
    parents = list(range(vertex_count))

    def find(value: int) -> int:
        while parents[value] != value:
            parents[value] = parents[parents[value]]
            value = parents[value]
        return value

    for a, b, c in faces.tolist():
        root = find(a)
        parents[find(b)] = root
        parents[find(c)] = root
    labels = np.asarray([find(i) for i in range(vertex_count)])
    return [np.flatnonzero(labels == find(seed)) for seed in seeds]


def bounds(points: np.ndarray) -> list[list[float]]:
    return [points.min(axis=0).tolist(), points.max(axis=0).tolist()]


def convert(source: Path, destination: Path) -> dict:
    archive_bytes = source.read_bytes()
    if sha256(archive_bytes) != SOURCE_SHA256:
        raise ValueError("The source hash differs from the inspected Quest 3 model")
    stage = Usd.Stage.Open(str(source.resolve()))
    if not stage:
        raise ValueError("The source USD stage could not be opened")
    meshes = [p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh)]
    if len(meshes) != 1 or str(meshes[0].GetPath()) != MESH_PATH:
        raise ValueError("The source mesh path or mesh count changed")
    prim = meshes[0]
    mesh = UsdGeom.Mesh(prim)
    points = np.asarray(mesh.GetPointsAttr().Get(), dtype=np.float64)
    counts = np.asarray(mesh.GetFaceVertexCountsAttr().Get(), dtype=np.int64)
    source_indices = np.asarray(mesh.GetFaceVertexIndicesAttr().Get(), dtype=np.int64)
    if len(points) != 47622 or len(counts) != 76260 or not np.all(counts == 3):
        raise ValueError("The source triangle topology changed")
    if source_indices.min() < 0 or source_indices.max() >= len(points):
        raise ValueError("The source contains an invalid vertex index")
    if str(mesh.GetOrientationAttr().Get()) != "rightHanded":
        raise ValueError("The source triangle orientation changed")
    if str(mesh.GetNormalsInterpolation()) != "vertex":
        raise ValueError("Expected vertex-interpolated normals")
    source_normals = np.asarray(mesh.GetNormalsAttr().Get(), dtype=np.float64)
    uv_primvar = UsdGeom.PrimvarsAPI(prim).GetPrimvar("st0")
    if str(uv_primvar.GetInterpolation()) != "vertex" or uv_primvar.IsIndexed():
        raise ValueError("Expected unindexed vertex-interpolated UV coordinates")
    uv = np.asarray(uv_primvar.Get(), dtype=np.float64)
    if source_normals.shape != points.shape or uv.shape != (len(points), 2):
        raise ValueError("The source vertex attributes have different lengths")
    if not all(np.isfinite(x).all() for x in (points, source_normals, uv)):
        raise ValueError("The source contains a non-finite vertex attribute")

    metres_per_unit = UsdGeom.GetStageMetersPerUnit(stage)
    if not math.isclose(metres_per_unit, 0.01) or str(UsdGeom.GetStageUpAxis(stage)) != "Y":
        raise ValueError("The source stage units or up axis changed")
    matrix = np.asarray(
        UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default()),
        dtype=np.float64,
    )
    scene = np.asarray(UsdGeom.Xformable(stage.GetPrimAtPath(SCENE_PRIM)).GetLocalTransformation())
    singular = np.linalg.svd(scene[:3, :3], compute_uv=False)
    if not np.allclose(singular, 1.975856900215149, rtol=1e-7) or not np.allclose(scene[3, :3], 0):
        raise ValueError("The inspected outer scene scale changed")
    scene_scale = float(singular.mean())
    correction = 1.0 / scene_scale
    world = (np.c_[points, np.ones(len(points))] @ matrix)[:, :3] * metres_per_unit
    positions = world * correction
    normals = source_normals @ np.linalg.inv(matrix[:3, :3]).T
    lengths = np.linalg.norm(normals, axis=1)
    if np.any(lengths < 1e-12) or np.linalg.det(matrix[:3, :3]) <= 0:
        raise ValueError("The source normal transform or handedness is invalid")
    normals /= lengths[:, None]
    vertices = np.column_stack([positions, normals, uv]).astype("<f4")
    indices = source_indices.astype("<u4")

    # Both optical surfaces are identifiable in the CPU rear-view projection.
    # Their connected components and fixed vertex seeds are source-hash pinned.
    faces = source_indices.reshape(-1, 3)
    lens_a, lens_b, shell = connected_vertices(faces, len(points), [18528, 18767, 29852])
    if [len(lens_a), len(lens_b), len(shell)] != [241, 241, 2541]:
        raise ValueError("The inspected lens or shell topology changed")
    lens_centres = np.asarray([
        (positions[v].min(axis=0) + positions[v].max(axis=0)) * 0.5 for v in (lens_a, lens_b)
    ])
    lens_midpoint = lens_centres.mean(axis=0)
    # Source +Z is the front sensor face and +Y is the top strap. WebXR uses
    # -Z forward and +Y up, which requires this proper (determinant +1) rotation.
    model_to_head = np.diag([-1.0, 1.0, -1.0, 1.0])
    model_to_head[:3, 3] = -model_to_head[:3, :3] @ lens_midpoint
    head_positions = (np.c_[positions, np.ones(len(points))] @ model_to_head.T)[:, :3]

    material_path = "/scene/Materials/Quest3HMD"
    surface = UsdShade.Shader(stage.GetPrimAtPath(material_path + "/pbr_shader"))
    if str(surface.GetIdAttr().Get()) != "UsdPreviewSurface":
        raise ValueError("The inspected material shader changed")
    texture_nodes = {
        "base_colour": "tex_base",
        "normal": "tex_normal",
        "occlusion": "tex_occlusion",
        "roughness": "tex_roughness",
        "metallic": "tex_metallic",
    }
    images = {}
    texture_sources = {}
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        for role, node in texture_nodes.items():
            shader = UsdShade.Shader(stage.GetPrimAtPath(material_path + "/" + node))
            entry = shader.GetInput("file").Get().path
            encoded = archive.read(entry)
            with Image.open(io.BytesIO(encoded)) as image:
                image.load()
                if image.size != (2048, 2048):
                    raise ValueError("The source texture dimensions changed")
                images[role] = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
                texture_sources[role] = {
                    "archive_entry": entry,
                    "shader": str(shader.GetPath()),
                    "encoded_sha256": sha256(encoded),
                    "encoded_bytes": len(encoded),
                    "encoded_format": image.format,
                    "encoded_mode": image.mode,
                    "width": image.width,
                    "height": image.height,
                    "source_colour_space": str(shader.GetInput("sourceColorSpace").Get() or "auto"),
                    "source_channel": "rgb" if role in ("base_colour", "normal") else "r",
                    "wrap_s": str(shader.GetInput("wrapS").Get()),
                    "wrap_t": str(shader.GetInput("wrapT").Get()),
                }

    orm = np.empty_like(images["base_colour"])
    orm[:, :, 0] = images["occlusion"][:, :, 0]
    orm[:, :, 1] = images["roughness"][:, :, 0]
    orm[:, :, 2] = images["metallic"][:, :, 0]
    orm[:, :, 3] = 255
    payloads = {
        "vertices.bin": vertices.tobytes(order="C"),
        "indices.bin": indices.tobytes(order="C"),
        "base-colour.rgba": images["base_colour"][::-1].tobytes(order="C"),
        "normal.rgba": images["normal"][::-1].tobytes(order="C"),
        "orm.rgba": orm[::-1].tobytes(order="C"),
    }
    destination.mkdir(parents=True, exist_ok=True)
    files = {name: write_bytes(destination / name, payload) for name, payload in payloads.items()}
    textures = {}
    for role, name, colour_space in (
        ("base_colour", "base-colour.rgba", "srgb"),
        ("normal", "normal.rgba", "linear"),
        ("orm", "orm.rgba", "linear"),
    ):
        textures[role] = {
            **files[name],
            "width": 2048,
            "height": 2048,
            "format": "rgba8",
            "colour_space": colour_space,
            "row_order": "bottom_up",
            "wrap_s": "repeat",
            "wrap_t": "repeat",
        }

    metadata = {
        "schema": "ceres-static-model",
        "version": 1,
        "name": "Meta Quest 3",
        "vertex_count": len(points),
        "index_count": len(indices),
        "triangle_count": len(faces),
        "vertex_file": "vertices.bin",
        "index_file": "indices.bin",
        "vertex_stride_bytes": 32,
        "vertex_attributes": [
            {"name": "position", "type": "float32", "count": 3, "offset_bytes": 0},
            {"name": "normal", "type": "float32", "count": 3, "offset_bytes": 12},
            {"name": "uv", "type": "float32", "count": 2, "offset_bytes": 24},
        ],
        "byte_order": "little_endian",
        "index_type": "uint32",
        "topology": "triangles",
        "front_face": "counter_clockwise",
        "double_sided": bool(mesh.GetDoubleSidedAttr().Get()),
        "units": "metres",
        "base_colour_factor": [1.0, 1.0, 1.0, 1.0],
        "metallic_factor": 1.0,
        "roughness_factor": 1.0,
        "normal_scale": 1.0,
        "occlusion_strength": 1.0,
        "emissive_factor": list(surface.GetInput("emissiveColor").Get()),
        "textures": textures,
        "normal_map": {"space": "tangent", "decode_scale": 2.0, "decode_bias": -1.0},
        "orm_channels": {"r": "occlusion", "g": "roughness", "b": "metallic", "a": "one"},
        "model_to_head": model_to_head.flatten(order="F").tolist(),
        "bounds_metres": bounds(positions),
        "head_bounds_metres": bounds(head_positions),
        "alignment": {
            "method": "lens_surface_midpoint",
            "calibrated_to_device": False,
            "source_forward": "+Z",
            "source_up": "+Y",
            "head_forward": "-Z",
            "head_up": "+Y",
            "rotation": "180 degrees about +Y",
            "origin_model_metres": lens_midpoint.tolist(),
            "eye_relief_offset_metres": 0.0,
            "origin_evidence": (
                "Midpoint of the axis-aligned bounds centres of the two source lens surfaces. "
                "The USDZ contains no eye or tracking-origin calibration. No unmeasured eye-relief offset is added."
            ),
            "orientation_evidence": (
                "CPU orthographic source projection identifies the three front sensor pills on +Z "
                "and the arching top strap on +Y."
            ),
            "webxr_axes_source": AXES_URL,
            "lens_surface_vertex_seeds": [18528, 18767],
            "lens_surface_vertex_counts": [len(lens_a), len(lens_b)],
            "lens_surface_bounds_metres": [bounds(positions[lens_a]), bounds(positions[lens_b])],
            "lens_surface_centres_metres": lens_centres.tolist(),
            "lens_surface_centre_spacing_metres": float(np.linalg.norm(lens_centres[0] - lens_centres[1])),
        },
        "source": {
            "file": source.name,
            "sha256": SOURCE_SHA256,
            "bytes": len(archive_bytes),
            "mesh": MESH_PATH,
            "material": material_path,
            "stage_metres_per_unit": metres_per_unit,
            "stage_up_axis": "Y",
            "mesh_to_stage_row_major": matrix.tolist(),
            "original_bounds_metres": bounds(world),
            "scene_scale_prim": SCENE_PRIM,
            "original_scene_scale": scene_scale,
            "baked_scale_correction": correction,
            "scale_basis": (
                "Remove the uniform outer Sketchfab scene scale while retaining source model proportions. "
                "This changes the main shell height from 193.37 mm to 97.86 mm and lens-surface "
                "centre spacing from 143.54 mm to 72.65 mm. The artist model does not encode a physical "
                "scale calibration. Meta specifies mechanical lens spacing of 58-70 mm."
            ),
            "physical_lens_spacing_reference_metres": [0.058, 0.070],
            "physical_lens_spacing_source": SPEC_URL,
            "main_shell_vertex_seed": 29852,
            "main_shell_vertex_count": len(shell),
            "main_shell_bounds_metres": bounds(positions[shell]),
            "layer_metadata": stage.GetRootLayer().customLayerData,
            "texture_sources": texture_sources,
        },
        "conversion": {
            "script": "scripts/convert-quest-model.py",
            "usd_version": list(Usd.GetVersion()),
            "numpy_version": np.__version__,
            "pillow_version": PILLOW_VERSION,
            "changes": [
                "Bake the complete USD transform hierarchy and metres-per-unit conversion",
                "Remove the inspected outer uniform scene scale",
                "Transform and normalise authored vertex normals",
                "Retain every source triangle index and UV coordinate",
                "Decode the source JPEG maps without resizing",
                "Pack source red channels as occlusion, roughness and metallic",
                "Reverse texture row order for OpenGL sampling without changing UV coordinates",
                "Describe a rigid lens-midpoint alignment in WebXR axes",
            ],
        },
        "files": files,
        "payload_bytes": sum(len(value) for value in payloads.values()),
    }
    notice = (
        "Meta Quest 3\n"
        "3D model and textures by Elin (https://sketchfab.com/ElinHohler).\n"
        f"Source: {MODEL_URL}\n"
        "Licence: Creative Commons Attribution 4.0 International (CC-BY-4.0).\n"
        "https://creativecommons.org/licenses/by/4.0/\n\n"
        "Changes: converted the USDZ geometry into native float32/uint32 buffers,\n"
        "baked its transforms, removed its outer presentation scale, converted\n"
        "textures to bottom-up RGBA8, packed occlusion/roughness/metallic channels\n"
        "and added a geometric lens-midpoint alignment in WebXR coordinates.\n"
        "Triangle topology and UV coordinates are preserved.\n\n"
        f"Supplied USDZ SHA256: {SOURCE_SHA256}\n"
        "The source author and Meta do not endorse this conversion or application.\n"
    )
    format_text = (
        "# Quest 3 native asset\n\n"
        "model.json uses ceres-static-model version 1. All vertex and index files\n"
        "are little-endian without a header. vertices.bin has one 32-byte record\n"
        "per vertex, containing float32 position[3], normal[3] and UV[2].\n"
        "indices.bin has uint32 indices in the original triangle order. Positions\n"
        "are metres with the USD hierarchy and documented scale correction baked.\n\n"
        "The three texture files contain tightly packed RGBA8, 2048 x 2048 pixels,\n"
        "with the bottom row first. Use repeat wrapping. base-colour.rgba is sRGB.\n"
        "normal.rgba and orm.rgba are linear. ORM channels are R=occlusion,\n"
        "G=roughness, B=metallic and A=255. Decode tangent-space normal RGB as\n"
        "2 * sample - 1. Tangents can be reconstructed from positions and UVs.\n"
        "No texture resizing, UV inversion or channel gamma conversion is applied.\n\n"
        "model_to_head is a 16-value column-major rigid matrix. Multiply a source\n"
        "vertex by model_to_head, then the tracked head transform. It rotates the\n"
        "model by 180 degrees around Y and places the measured lens-surface\n"
        "midpoint at the head origin. This is a geometric proxy because the\n"
        "artist asset supplies no eye-relief or tracking-origin calibration.\n\n"
        "Source hashes, mesh landmarks, material provenance, original transforms\n"
        "and scale correction are preserved in model.json. NOTICE accompanies\n"
        "the model and its textures whenever this local asset is redistributed.\n"
    )
    files_to_check = dict(files)
    files_to_check["NOTICE"] = write_bytes(destination / "NOTICE", notice.encode("ascii"))
    files_to_check["FORMAT.md"] = write_bytes(destination / "FORMAT.md", format_text.encode("ascii"))
    files_to_check["model.json"] = write_json(destination / "model.json", metadata)
    write_json(destination / "checksums.json", files_to_check)
    # Check exactly the files the native loader consumes after serialisation.
    loaded_vertices = np.fromfile(destination / "vertices.bin", dtype="<f4").reshape(-1, 8)
    loaded_indices = np.fromfile(destination / "indices.bin", dtype="<u4")
    if not np.array_equal(loaded_vertices[:, 6:], uv.astype("<f4")):
        raise RuntimeError("Serialised UV coordinates differ from the source")
    if not np.array_equal(loaded_indices, source_indices):
        raise RuntimeError("Serialised triangle indices differ from the source")
    if not np.allclose(np.linalg.norm(loaded_vertices[:, 3:6], axis=1), 1.0, atol=1e-6):
        raise RuntimeError("Serialised vertex normals are not unit length")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="Path to the inspected Meta_Quest_3.usdz")
    parser.add_argument("output", type=Path, help="Destination for the native model and textures")
    arguments = parser.parse_args()
    metadata = convert(arguments.source, arguments.output)
    print(json.dumps({
        "output": str(arguments.output.resolve()),
        "source_sha256": SOURCE_SHA256,
        "vertices": metadata["vertex_count"],
        "triangles": metadata["triangle_count"],
        "payload_bytes": metadata["payload_bytes"],
        "scale_correction": metadata["source"]["baked_scale_correction"],
        "model_bounds_metres": metadata["bounds_metres"],
        "head_bounds_metres": metadata["head_bounds_metres"],
        "origin_model_metres": metadata["alignment"]["origin_model_metres"],
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
