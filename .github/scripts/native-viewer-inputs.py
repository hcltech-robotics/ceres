"""Record the release package's build inputs without build-machine paths."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def compiler_version(build):
    files = sorted((build / "CMakeFiles").glob("*/CMakeCXXCompiler.cmake"))
    if len(files) != 1:
        raise ValueError("The build must contain one C++ compiler configuration")
    text = files[0].read_text(encoding="utf-8")
    identity = re.search(r'set\(CMAKE_CXX_COMPILER_ID "([A-Za-z0-9]+)"\)', text)
    version = re.search(r'set\(CMAKE_CXX_COMPILER_VERSION "([0-9.]+)"\)', text)
    if not identity or not version:
        raise ValueError("The compiler identity or version is missing")
    return f"{identity[1]} {version[1]}"


def tool_version(command, pattern):
    text = subprocess.check_output(command, text=True)
    match = re.search(pattern, text)
    if not match:
        raise ValueError(f"Cannot identify {command[0]} version")
    return match[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--platform", choices=["windows-x64", "linux-x64", "linux-arm64", "linux-arm64-jetpack6"], required=True)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--image")
    parser.add_argument("--cuda", required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--package-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    configured_revision = os.environ.get("CERES_SOURCE_REVISION")
    result = subprocess.run(["git", "-C", str(args.root), "rev-parse", "HEAD"], text=True, capture_output=True)
    git_revision = result.stdout.strip() if result.returncode == 0 else None
    if configured_revision and git_revision and configured_revision != git_revision:
        raise ValueError("Configured source revision differs from Git")
    revision = configured_revision or git_revision or ""
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("The source revision is not a full commit")
    ffmpeg = subprocess.check_output([str(args.ffmpeg), "-version"], text=True).splitlines()[0]
    if not ffmpeg.startswith("ffmpeg version "):
        raise ValueError("The FFmpeg version could not be identified")
    cache = (args.build / "CMakeCache.txt").read_text(encoding="utf-8")
    architectures = re.search(r"^CMAKE_CUDA_ARCHITECTURES:[^=]*=([0-9;]+)$", cache, re.MULTILINE)
    if not architectures:
        raise ValueError("The configured CUDA architectures are missing")
    release_version = json.loads((args.root / "package.json").read_text(encoding="utf-8"))["version"]
    manifest = json.loads(args.package_manifest.read_text(encoding="utf-8-sig"))
    if manifest.get("platform") != args.platform or manifest.get("source_revision") != revision or manifest.get("release_version") != release_version:
        raise ValueError("Package manifest identity differs from the build inputs")
    sys.path.insert(0, str(args.root.resolve() / "native/viewer/scripts"))
    from qualification import runtime_dependency_hashes
    result = {
        "schema": "ceres-native-build-inputs",
        "version": 1,
        "platform": args.platform,
        "source_revision": revision,
        "release_version": release_version,
        "toolchain": {
            "runner": args.runner,
            "build_image": args.image,
            "cuda": args.cuda,
            "rust": tool_version(["rustc", "--version"], r"rustc ([0-9.]+)"),
            "cmake": tool_version(["cmake", "--version"], r"cmake version ([0-9.]+)"),
            "ninja": tool_version(["ninja", "--version"], r"([0-9.]+)"),
            "cuda_architectures": architectures[1],
            "compiler": compiler_version(args.build),
        },
        "ffmpeg": {"version": ffmpeg},
        "runtime_dependencies": runtime_dependency_hashes(manifest),
    }
    if args.platform == "linux-arm64-jetpack6":
        if manifest.get("video_backend") != "JETSON" or not manifest.get("jetson_linux_release"):
            raise ValueError("Jetson package omits its backend or JetPack driver identity")
        result["toolchain"].update({"video_backend": "JETSON",
                                     "jetson_linux_release": manifest["jetson_linux_release"]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
