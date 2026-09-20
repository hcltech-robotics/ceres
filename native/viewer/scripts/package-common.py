#!/usr/bin/env python3
"""Create deterministic package provenance, SPDX inventory and content hashes."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib
import uuid

PLATFORMS = {"windows-x64", "linux-x64", "linux-arm64", "linux-arm64-jetpack6"}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def release_identity(source):
    version = json.loads((source / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid root release version")
    if os.environ.get("CERES_RELEASE_VERSION", version) != version:
        raise ValueError("CERES_RELEASE_VERSION differs from root package.json")
    revision = os.environ.get("CERES_SOURCE_REVISION")
    if not revision and (source / ".git").exists():
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if not revision:
        raise ValueError("Set CERES_SOURCE_REVISION when packaging a source archive")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("CERES_SOURCE_REVISION must be a full commit SHA")
    return version, revision


def package_files(root):
    files = sorted(path for path in root.rglob("*") if path.is_file() or path.is_symlink())
    for path in files:
        if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError("Unresolved or external package link: " + str(path))
    return files


def toolchain_versions(build, values):
    versions = {}
    for name, command, pattern in (
        ("cmake", ["cmake", "--version"], r"cmake version ([0-9.]+)"),
        ("rust", ["rustc", "--version"], r"rustc ([0-9.]+)"),
        ("cargo", ["cargo", "--version"], r"cargo ([0-9.]+)"),
        ("ninja", [values["CMAKE_MAKE_PROGRAM"], "--version"], r"([0-9.]+)"),
    ):
        output = subprocess.check_output(command, text=True)
        match = re.search(pattern, output)
        if not match:
            raise ValueError("Cannot identify the " + name + " build tool")
        versions[name] = match.group(1)
    configurations = sorted((build / "CMakeFiles").glob("*/CMakeCXXCompiler.cmake"))
    if len(configurations) != 1:
        raise ValueError("Expected one C++ compiler configuration")
    configuration = configurations[0].read_text(encoding="utf-8")
    for key, variable in (("compiler_id", "CMAKE_CXX_COMPILER_ID"), ("compiler_version", "CMAKE_CXX_COMPILER_VERSION")):
        match = re.search(r'set\(' + variable + r' "([^"]+)"\)', configuration)
        if not match:
            raise ValueError("Compiler provenance is missing " + variable)
        versions[key] = match.group(1)
    return versions


def create_metadata(package, source, platform, build, cuda_architectures):
    if platform not in PLATFORMS:
        raise ValueError("Unsupported package platform: " + platform)
    version, revision = release_identity(source)
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "946684800"))
    created = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    cache = (build / "CMakeCache.txt").read_text(encoding="utf-8", errors="replace")
    values = dict(re.findall(r"^([A-Za-z_][^:=\r\n]*):[^=\r\n]*=(.*)$", cache, re.MULTILINE))
    source_record = {
        "release_version": version, "source_revision": revision,
        "exporter_source": "native/lerobot-exporter", "exporter_revision": revision,
        "platform": platform, "cuda_architectures": re.split("[;,]", cuda_architectures),
        "build_type": values.get("CMAKE_BUILD_TYPE", "Release"), "source_date_epoch": epoch,
        "toolchain": toolchain_versions(build, values),
    }
    backend = values.get("CERES_SELECTED_VIDEO_BACKEND", "CUVID")
    if (platform == "linux-arm64-jetpack6") != (backend == "JETSON"):
        raise ValueError("Package platform does not match the configured video backend")
    source_record["video_backend"] = backend
    if backend == "JETSON":
        release = (package / "provenance/nv_tegra_release").read_text(encoding="utf-8").strip()
        if not re.match(r"^# R36 ", release):
            raise ValueError("JetPack 6 packaging requires a Jetson Linux R36 driver")
        source_record["jetson_linux_release"] = release
    write_json(package / "provenance/source.json", source_record)
    components = [{"name": "ceres-viewer", "version": version, "revision": revision},
                  {"name": "ceres-native-exporter", "version": version, "revision": revision}]
    if backend == "JETSON":
        components.append({"name": "jetson-multimedia-api", "version": source_record["jetson_linux_release"],
                           "source_info": "NVIDIA helper source and redistribution notices are included in licences/jetson-multimedia-api."})
    hand_metadata = json.loads((package / "assets/hands/model.json").read_text(encoding="utf-8"))
    hand_source = hand_metadata["source"]
    components.append({"name": "SOMA-X-native-hand-mid", "version": hand_source["release"],
                       "license": "Apache-2.0", "copyright": "Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.",
                       "download": hand_source["assets_repository"] + "/tree/" + hand_source["assets_revision"],
                       "source_info": "Converted native template hand assets. Source revision " + hand_source["revision"]
                                      + ". Geometry SHA-256 " + hand_metadata["geometry_sha256"] + "."})
    dependencies = (source / "native/viewer/cmake/Dependencies.cmake").read_text(encoding="utf-8")
    dependencies += (source / "native/viewer/CMakeLists.txt").read_text(encoding="utf-8")
    for name, declaration in re.findall(r"FetchContent_Declare\((\w+)\s+([^\n]+)\)", dependencies):
        match = re.search(r"GIT_TAG\s+(\S+)|/archive/([^/ ]+)\.tar\.gz", declaration)
        if match:
            components.append({"name": name, "version": match.group(1) or match.group(2)})
    lock = tomllib.loads((source / "native/lerobot-exporter/Cargo.lock").read_text(encoding="utf-8"))
    for entry in lock["package"]:
        component = {"name": entry["name"], "version": entry["version"]}
        if "checksum" in entry:
            component["checksum"] = entry["checksum"]
        components.append(component)
    ffmpeg_receipt = package / "provenance/ffmpeg-source-lock.json"
    if ffmpeg_receipt.exists():
        source_record["ffmpeg_source_lock"] = json.loads(ffmpeg_receipt.read_text(encoding="utf-8"))
        write_json(package / "provenance/source.json", source_record)
    ffmpeg_version_file = package / "provenance/ffmpeg-version.txt"
    if ffmpeg_version_file.exists():
        match = re.search(r"^ffmpeg version (\S+)", ffmpeg_version_file.read_text(encoding="utf-8"))
        if not match:
            raise ValueError("FFmpeg version is missing from package provenance")
        components.append({"name": "ffmpeg", "version": match.group(1)})
    if ffmpeg_receipt.exists():
        receipt = source_record["ffmpeg_source_lock"]
        if "x264" in receipt:
            components.append({"name": "x264", "version": receipt["x264"].get("revision", "NOASSERTION")})
    cuda_configs = sorted((build / "CMakeFiles").glob("*/CMakeCUDACompiler.cmake"))
    if cuda_configs:
        match = re.search(r'set\(CMAKE_CUDA_COMPILER_VERSION "([^"]+)"\)', cuda_configs[-1].read_text(encoding="utf-8"))
        if not match:
            raise ValueError("CUDA compiler version is missing")
        components.append({"name": "nvidia-cuda", "version": match.group(1)})
        source_record["cuda_compiler_version"] = match.group(1)
        write_json(package / "provenance/source.json", source_record)
    runtime_origin = package / "licences/microsoft-runtime/runtime-origin.txt"
    if runtime_origin.exists():
        match = re.search(r"Microsoft Visual C\+\+ runtime (\S+)", runtime_origin.read_text(encoding="utf-8"))
        if match:
            components.append({"name": "microsoft-visual-c-runtime", "version": match.group(1)})
    inventory = []
    for path in package_files(package):
        relative = path.relative_to(package).as_posix()
        if relative in {"SHA256SUMS", "MANIFEST.json", "SBOM.spdx.json"}:
            continue
        inventory.append({"SPDXID": "SPDXRef-File-" + hashlib.sha256(relative.encode()).hexdigest()[:24],
                          "fileName": "./" + relative, "checksums": [{"algorithm": "SHA256", "checksumValue": sha256(path)}],
                          "licenseConcluded": "Apache-2.0" if relative.startswith("assets/hands/") else "NOASSERTION",
                          "copyrightText": "Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES."
                                           if relative.startswith("assets/hands/") else "NOASSERTION"})
    spdx_packages = []
    for index, item in enumerate(components):
        entry = {"SPDXID": f"SPDXRef-Package-{index}", "name": item["name"], "versionInfo": item["version"],
                 "downloadLocation": item.get("download", "NOASSERTION"), "filesAnalyzed": False,
                 "licenseConcluded": item.get("license", "NOASSERTION"), "licenseDeclared": item.get("license", "NOASSERTION"),
                 "copyrightText": item.get("copyright", "NOASSERTION")}
        if "source_info" in item:
            entry["sourceInfo"] = item["source_info"]
        if "checksum" in item:
            entry["checksums"] = [{"algorithm": "SHA256", "checksumValue": item["checksum"]}]
        spdx_packages.append(entry)
    relationships = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Package-0"}]
    relationships += [{"spdxElementId": "SPDXRef-Package-0", "relationshipType": "CONTAINS", "relatedSpdxElement": entry["SPDXID"]} for entry in inventory]
    relationships += [{"spdxElementId": "SPDXRef-Package-0", "relationshipType": "DEPENDS_ON", "relatedSpdxElement": entry["SPDXID"]} for entry in spdx_packages[1:]]
    write_json(package / "SBOM.spdx.json", {
        "spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"ceres-viewer-{version}-{platform}",
        "documentNamespace": "https://ceres.cam/spdx/" + str(uuid.uuid5(uuid.NAMESPACE_URL, f"{version}/{revision}/{platform}")),
        "creationInfo": {"created": created, "creators": ["Tool: ceres-viewer-package-1"]},
        "packages": spdx_packages, "files": inventory, "relationships": relationships,
    })
    files = {}
    for path in package_files(package):
        relative = path.relative_to(package).as_posix()
        if relative in {"SHA256SUMS", "MANIFEST.json"}:
            continue
        item = {"sha256": sha256(path), "size": path.stat().st_size}
        if path.is_symlink():
            item["symlink"] = os.readlink(path)
        files[relative] = item
    manifest = {"schema": "ceres-viewer-package", "version": 1, **source_record, "files": files}
    write_json(package / "MANIFEST.json", manifest)
    lines = [f"{sha256(path)}  {path.relative_to(package).as_posix()}\n" for path in package_files(package) if path.relative_to(package).as_posix() != "SHA256SUMS"]
    (package / "SHA256SUMS").write_text("".join(lines), encoding="utf-8", newline="\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--cuda-architectures", required=True)
    args = parser.parse_args()
    create_metadata(args.package, args.source, args.platform, args.build, args.cuda_architectures)
