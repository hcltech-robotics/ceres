import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
os.chdir(root)
metadata = json.loads((root / "package.json").read_text())
version = metadata["version"]
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", "HEAD"], text=True).strip())
release = root / "release"
release.mkdir(exist_ok=True)
identity = json.dumps({"version": version, "commit": commit, "repository": "https://github.com/hcltech-robotics/ceres"}, indent=2).encode() + b"\n"

def archive(name, content):
    with (release / name).open("wb") as destination:
        with gzip.GzipFile(filename="", mode="wb", fileobj=destination, mtime=epoch) as compressed:
            with tarfile.open(mode="w", fileobj=compressed, format=tarfile.PAX_FORMAT) as result:
                for filename, data, mode in sorted(content):
                    entry = tarfile.TarInfo(filename)
                    entry.size, entry.mode, entry.mtime = len(data), mode, epoch
                    result.addfile(entry, io.BytesIO(data))

source = subprocess.check_output(["git", "archive", "--format=tar", "HEAD"])
with tarfile.open(fileobj=io.BytesIO(source)) as original:
    content = []
    for member in original.getmembers():
        if member.isdir():
            continue
        if not member.isfile():
            raise ValueError("Release source must contain regular files")
        content.append((member.name, original.extractfile(member).read(), member.mode))
archive(f"ceres-{version}-source.tar.gz", content + [("SOURCE.json", identity, 0o644)])

runtime = []
for directory in ["dist", "dist-server", "third-party"]:
    for item in sorted((root / directory).rglob("*")):
        if item.is_symlink():
            raise ValueError("Runtime package must contain regular files")
        if item.is_file():
            runtime.append((item.relative_to(root).as_posix(), item.read_bytes(), 0o644))
for filename in ["LICENCE.md", "CITATION.cff", "citation.bib", "README.md", "compose.yaml", "Dockerfile", "start.ps1"]:
    runtime.append((filename, (root / filename).read_bytes(), 0o644))
runtime.append(("SOURCE.json", identity, 0o644))
archive(f"ceres-{version}-runtime.tar.gz", runtime)
print(f"Packaged CERES {version} from public commit {commit}")
