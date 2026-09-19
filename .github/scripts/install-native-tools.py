"""Install checksum-pinned CMake and Ninja archives for a native build worker."""

import argparse
import hashlib
import os
from pathlib import Path
import tarfile
from urllib.request import urlopen
import zipfile

TOOLS = {
    "windows-x64": (
        "cmake-3.31.8-windows-x86_64.zip", "81aa9964dbabd71fe02e7ec50472fd3ad56138c49944515ece9001efbff8d719",
        "ninja-win.zip", "07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65",
    ),
    "linux-x64": (
        "cmake-3.31.8-linux-x86_64.tar.gz", "630615d8e98ac33eba7fbe472626dff5c899c85af3c024585ae109166a6909d0",
        "ninja-linux.zip", "5749cbc4e668273514150a80e387a957f933c6ed3f5f11e03fb30955e2bbead6",
    ),
    "linux-arm64": (
        "cmake-3.31.8-linux-aarch64.tar.gz", "609735983e3bdf24b6ab379d918458d64196fe72b98226f62dd5e9fe7b2997cc",
        "ninja-linux-aarch64.zip", "fd2cacc8050a7f12a16a2e48f9e06fca5c14fc4c2bee2babb67b58be17a607fc",
    ),
}


def download(url, filename, expected):
    digest = hashlib.sha256()
    with urlopen(url, timeout=120) as response, filename.open("xb") as stream:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            stream.write(chunk)
    if digest.hexdigest() != expected:
        raise ValueError(f"Build tool checksum differs: {filename.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=TOOLS, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    destination = args.directory.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    cmake_name, cmake_hash, ninja_name, ninja_hash = TOOLS[args.platform]
    for name, digest, base in [
        (cmake_name, cmake_hash, "https://github.com/Kitware/CMake/releases/download/v3.31.8/"),
        (ninja_name, ninja_hash, "https://github.com/ninja-build/ninja/releases/download/v1.13.2/"),
    ]:
        archive = destination / name
        download(base + name, archive, digest)
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as source:
                for member in source.infolist():
                    if not (destination / member.filename).resolve().is_relative_to(destination):
                        raise ValueError("Unsafe tool archive member")
                source.extractall(destination)
        else:
            with tarfile.open(archive) as source:
                source.extractall(destination, filter="data")
    cmake_root = cmake_name.removesuffix(".zip").removesuffix(".tar.gz")
    if args.platform.startswith("linux-"):
        (destination / "ninja").chmod(0o755)
    paths = [destination / cmake_root / "bin", destination]
    if os.environ.get("GITHUB_PATH"):
        with open(os.environ["GITHUB_PATH"], "a", encoding="utf-8") as stream:
            stream.write("\n".join(map(str, paths)) + "\n")
    print("\n".join(map(str, paths)))


if __name__ == "__main__":
    main()
