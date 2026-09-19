"""Qualify native release packages and enforce reusable hardware evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone

PLATFORMS = ("windows-x64", "linux-x64", "linux-arm64")
CHECKS = {"package", "cuda", "nvdec", "render", "record", "replay", "dual_camera", "depth", "export"}
TEXT_SUFFIXES = {".cpp", ".hpp", ".h", ".cu", ".cuh", ".cmake", ".json", ".py", ".ps1", ".sh", ".cmd", ".rs", ".toml", ".lock", ".yml", ".txt"}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path.name}")
    return value


def runtime_dependency_hashes(manifest: dict) -> dict[str, str]:
    if manifest.get("schema") != "ceres-viewer-package" or manifest.get("version") != 1 or not isinstance(manifest.get("files"), dict):
        raise ValueError("Unsupported package manifest for runtime dependencies")
    selected = {}
    executables = {"ffmpeg": 0, "ffprobe": 0}
    for name, entry in manifest["files"].items():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError("Unsafe runtime dependency path")
        basename = path.name.lower()
        executable = basename.removesuffix(".exe")
        if executable in executables:
            executables[executable] += 1
        if executable in executables or basename.endswith(".dll") or (name.startswith("lib/") and re.search(r"\.so(?:\.[A-Za-z0-9._-]+)?$", basename)):
            checksum = entry.get("sha256", "") if isinstance(entry, dict) else ""
            if not re.fullmatch(r"[a-f0-9]{64}", checksum):
                raise ValueError(f"Invalid runtime dependency hash: {name}")
            selected[name] = checksum
    if any(count != 1 for count in executables.values()):
        raise ValueError("Runtime dependencies require one packaged FFmpeg and FFprobe")
    return dict(sorted(selected.items()))


def validate_package_runtime(inputs: dict, archive: Path, archive_sha256: str) -> None:
    manifest = read_json(Path(str(archive) + ".manifest.json"))
    suffix = ".zip" if inputs["platform"] == "windows-x64" else ".tar.gz"
    report = read_json(archive.with_name(archive.name.removesuffix(suffix) + ".verification.json"))
    for document in (manifest, report):
        for key in ("platform", "release_version", "source_revision"):
            if document.get(key) != inputs.get(key):
                raise ValueError("Verified package identity differs from the runtime inputs")
    if report.get("schema") != "ceres-viewer-package-verification" or report.get("version") != 1 or report.get("passed") is not True:
        raise ValueError("Runtime dependencies require a successful package verification")
    if report.get("archive_sha256") != archive_sha256 or report.get("manifest") != manifest:
        raise ValueError("Runtime dependency manifest differs from the verified archive")
    if runtime_dependency_hashes(manifest) != inputs.get("runtime_dependencies"):
        raise ValueError("Packaged runtime dependencies differ from the build inputs")


def runtime_files(root: Path) -> dict[str, str]:
    paths = []
    for name in ("native/viewer", "native/lerobot-exporter", "wasm/lerobot-exporter/src"):
        directory = root / name
        if not directory.is_dir():
            raise ValueError(f"Missing qualification input directory: {name}")
        for path in directory.rglob("*"):
            relative = path.relative_to(root)
            parts = relative.parts
            if any(part in {".git", "__pycache__", "target", "dist", "artifacts", "qualification", "docs"}
                   or part.startswith("build") for part in parts[:-1]):
                continue
            if path.is_symlink():
                raise ValueError(f"Qualification inputs cannot contain symlinks: {relative}")
            if not path.is_file() or path.name in {"AGENTS.md", "import-provenance.json", ".gitignore", ".clang-format"}:
                continue
            if path.suffix == ".md":
                continue
            paths.append(path)
    for name in ("wasm/lerobot-exporter/Cargo.toml", "wasm/lerobot-exporter/Cargo.lock",
                 ".github/workflows/native-viewer.yml", ".github/scripts/native-viewer-inputs.py",
                 ".github/scripts/install-native-tools.py", ".github/scripts/build-native-ffmpeg.sh",
                 ".github/scripts/native-build-requirements.txt"):
        path = root / name
        if not path.is_file():
            raise ValueError(f"Missing qualification input: {name}")
        paths.append(path)
    result = {}
    for path in sorted(set(paths)):
        data = path.read_bytes()
        if path.suffix in TEXT_SUFFIXES or path.name == "CMakeLists.txt":
            data = data.replace(b"\r\n", b"\n")
        result[path.relative_to(root).as_posix()] = hashlib.sha256(data).hexdigest()
    return result


def qualification_inputs(root: Path, inputs: dict) -> dict:
    if inputs.get("schema") != "ceres-native-build-inputs" or inputs.get("version") != 1:
        raise ValueError("Unsupported native build input manifest")
    if inputs.get("platform") not in PLATFORMS:
        raise ValueError("Unsupported native platform")
    if not re.fullmatch(r"[a-f0-9]{40}", inputs.get("source_revision", "")):
        raise ValueError("Build inputs must identify an immutable source revision")
    toolchain = inputs.get("toolchain", {})
    for key in ("cuda", "rust", "cmake", "cuda_architectures", "compiler"):
        if not toolchain.get(key):
            raise ValueError(f"Build inputs omit the {key} toolchain identity")
    if not inputs.get("ffmpeg", {}).get("version"):
        raise ValueError("Build inputs omit the FFmpeg identity")
    dependencies = inputs.get("runtime_dependencies")
    if not isinstance(dependencies, dict) or not dependencies:
        raise ValueError("Build inputs omit packaged runtime dependency hashes")
    checked = runtime_dependency_hashes({"schema": "ceres-viewer-package", "version": 1,
                                         "files": {name: {"sha256": value} for name, value in dependencies.items()}})
    if checked != dependencies:
        raise ValueError("Build inputs contain an invalid runtime dependency inventory")
    return {"schema": "ceres-native-qualification-inputs", "version": 1,
            "platform": inputs["platform"], "files": runtime_files(root),
            "toolchain": {k: v for k, v in toolchain.items() if k != "runner"},
            "ffmpeg": inputs["ffmpeg"], "runtime_dependencies": dependencies}


def fingerprint(root: Path, inputs: dict) -> str:
    return hashlib.sha256(canonical(qualification_inputs(root, inputs))).hexdigest()


def archive_name(inputs: dict) -> str:
    suffix = ".zip" if inputs["platform"] == "windows-x64" else ".tar.gz"
    version = inputs.get("release_version", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid native release version")
    return f"ceres-viewer-{version}-{inputs['platform']}{suffix}"


def validate_receipt(receipt: dict, expected: str, target: str) -> None:
    if receipt.get("schema") != "ceres-native-hardware-qualification" or receipt.get("version") != 1:
        raise ValueError(f"Unsupported hardware receipt for {target}")
    if receipt.get("status") != "passed" or receipt.get("platform") != target:
        raise ValueError(f"Hardware qualification did not pass for {target}")
    if receipt.get("input_sha256") != expected:
        raise ValueError(f"Fresh NVIDIA hardware qualification is required for {target}")
    if set(receipt.get("checks", {})) != CHECKS or not all(v is True for v in receipt["checks"].values()):
        raise ValueError(f"Hardware receipt omits required checks for {target}")
    if not re.fullmatch(r"[a-f0-9]{64}", receipt.get("archive_sha256", "")):
        raise ValueError(f"Hardware receipt omits the tested archive hash for {target}")
    graphics = receipt.get("graphics", {})
    if "nvidia" not in str(graphics.get("vendor", "")).lower() or not graphics.get("renderer"):
        raise ValueError(f"Hardware receipt lacks an NVIDIA graphics context for {target}")
    if not receipt.get("gpu") or not receipt.get("driver") or not receipt.get("completed_at"):
        raise ValueError(f"Hardware receipt omits device identity for {target}")


def check(root: Path, artifacts: Path, receipts: Path) -> dict:
    version = read_json(root / "package.json")["version"]
    paths = sorted(set(artifacts.rglob("workflow-inputs.json")) | set(artifacts.rglob("*.inputs.json")))
    by_platform = {}
    for path in paths:
        inputs = read_json(path)
        target = inputs.get("platform")
        if target in by_platform:
            raise ValueError(f"Duplicate build manifest for {target}")
        if target not in PLATFORMS or inputs.get("release_version") != version:
            raise ValueError("Native build manifest platform/version differs from this release")
        if os.environ.get("GITHUB_SHA") and inputs.get("source_revision") != os.environ["GITHUB_SHA"]:
            raise ValueError("Native build manifest revision differs from the release revision")
        expected = fingerprint(root, inputs)
        receipt_path = receipts / f"{target}.json"
        if not receipt_path.is_file():
            raise ValueError(f"Initial NVIDIA hardware qualification is required for {target}")
        receipt = read_json(receipt_path)
        validate_receipt(receipt, expected, target)
        archives = list(artifacts.rglob(archive_name(inputs)))
        if len(archives) != 1:
            raise ValueError(f"Expected exactly one archive for {target}")
        actual = digest(archives[0])
        validate_package_runtime(inputs, archives[0], actual)
        by_platform[target] = {"input_sha256": expected, "archive_sha256": actual,
                               "qualification_archive_sha256": receipt["archive_sha256"],
                               "qualification_reused": actual != receipt["archive_sha256"]}
    if set(by_platform) != set(PLATFORMS):
        raise ValueError("All three native platform manifests are required")
    return {"status": "passed", "platforms": by_platform}


def run(command: list[str], cwd: Path, log: Path, *, env: dict | None = None, timeout: int = 180) -> str:
    completed = subprocess.run(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=timeout)
    log.write_bytes(completed.stdout)
    if completed.returncode:
        tail = completed.stdout.decode("utf-8", errors="replace")[-4000:]
        raise RuntimeError(f"{Path(command[0]).name} failed ({completed.returncode}): {tail}")
    return completed.stdout.decode("utf-8", errors="replace")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("check")
    verify.add_argument("--root", type=Path, required=True)
    verify.add_argument("--artifacts", type=Path, required=True)
    verify.add_argument("--receipts", type=Path, required=True)
    identify = commands.add_parser("fingerprint")
    identify.add_argument("--root", type=Path, required=True)
    identify.add_argument("--inputs", type=Path, required=True)
    capture = commands.add_parser("record")
    for option in ("root", "archive", "inputs", "build-tests", "output", "work-dir"):
        capture.add_argument(f"--{option}", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "check":
        result = check(args.root.resolve(), args.artifacts.resolve(), args.receipts.resolve())
    elif args.command == "fingerprint":
        result = {"input_sha256": fingerprint(args.root.resolve(), read_json(args.inputs))}
    else:
        from qualify_hardware import record
        result = record(args)
    print(json.dumps(result, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Native hardware qualification failed: {error}", file=sys.stderr)
        raise SystemExit(1)
