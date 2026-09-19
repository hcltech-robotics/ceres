#!/usr/bin/env python3
"""Extract and verify a viewer release, including an actual bundled export."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tarfile
import zipfile

PLATFORMS = {"windows-x64": ("pe", 0x8664), "linux-x64": ("elf", 62), "linux-arm64": ("elf", 183)}
WINDOWS_SYSTEM = set("kernel32 kernelbase user32 gdi32 gdi32full ws2_32 advapi32 shell32 ole32 oleaut32 crypt32 bcrypt bcryptprimitives ncrypt secur32 normaliz iphlpapi comdlg32 comctl32 version winmm ntdll msvcrt shlwapi setupapi dwmapi cfgmgr32 wintrust powrprof imm32 usp10 ucrtbase winhttp netapi32 psapi wtsapi32 authz dbghelp dxgi d3d11 dxva2 mf mfplat mfuuid avrt shcore srvcli netutils opengl32 mswsock winspool dnsapi wldap32 rpcrt4 hid propsys dwrite usp10 dhcpcsvc dhcpcsvc6 userenv win32u avicap32 d2d1".split())
LINUX_SYSTEM = re.compile(r"^(?:ld-linux[^/]*\.so(?:\.[0-9]+)*|lib(?:c|m|dl|pthread|rt|resolv|util|cuda|nvcuvid|nvidia[^/]*|GL|GLX[^/]*|OpenGL|EGL|GLdispatch)\.so(?:\.[0-9]+)*)$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, document):
    Path(path).write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def safe_name(name):
    require("\\" not in name and ":" not in name and "\x00" not in name, "Unsafe archive path")
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.parts and all(part not in (".", "..") for part in path.parts), "Unsafe archive path")
    require(all(part.rstrip(" .") == part for part in path.parts), "Ambiguous archive path")
    require(not any(re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part, re.IGNORECASE) for part in path.parts), "Reserved archive path")
    return path


def extract_archive(archive, destination):
    """Extract regular files and internal symbolic links without trusting archive paths."""
    destination.mkdir(parents=True, exist_ok=False)
    names, roots, links = set(), set(), []
    total = 0

    def entry(name, size, is_directory=False):
        nonlocal total
        path = safe_name(name.rstrip("/"))
        canonical = str(path).casefold()
        require(canonical not in names, "Duplicate archive path: " + name)
        names.add(canonical)
        roots.add(path.parts[0])
        total += size
        require(len(names) <= 50000 and total <= 4 * 1024 ** 3, "Archive exceeds package limits")
        target = destination.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        if is_directory:
            target.mkdir(exist_ok=True)
        return target

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as stream:
            for member in stream.infolist():
                mode = member.external_attr >> 16
                require(not stat.S_ISLNK(mode), "ZIP symbolic links are unsupported")
                target = entry(member.filename, member.file_size, member.is_dir())
                if not member.is_dir():
                    with stream.open(member) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
    else:
        with tarfile.open(archive, "r:gz") as stream:
            for member in stream:
                require(member.isfile() or member.isdir() or member.issym(), "Unsupported archive entry: " + member.name)
                target = entry(member.name, member.size, member.isdir())
                if member.issym():
                    link = safe_name(member.linkname)
                    links.append((target, str(link)))
                elif member.isfile():
                    with stream.extractfile(member) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
                    target.chmod(member.mode & 0o777)
        for target, link in links:
            os.symlink(link, target)
        for target, _ in links:
            require(target.resolve().is_relative_to(destination.resolve()) and target.is_file(), "Unresolved or external package link")
    require(len(roots) == 1, "Archive must contain one package directory")
    root = destination / next(iter(roots))
    require(root.is_dir() and not root.is_symlink(), "Invalid package directory")
    return root


def binary_info(path):
    """Read ELF64 dynamic dependencies or PE32+ imports without executing the file."""
    data = Path(path).read_bytes()
    if data[:4] == b"\x7fELF":
        require(len(data) >= 64 and data[4:6] == b"\x02\x01", "Expected little-endian ELF64: " + str(path))
        machine = struct.unpack_from("<H", data, 18)[0]
        phoff = struct.unpack_from("<Q", data, 32)[0]
        phsize, phcount = struct.unpack_from("<HH", data, 54)
        require(phsize >= 56 and phoff + phsize * phcount <= len(data), "Invalid ELF program headers")
        segments = [struct.unpack_from("<IIQQQQQQ", data, phoff + index * phsize) for index in range(phcount)]
        dynamic = next((item for item in segments if item[0] == 2), None)
        needed, strings = [], None
        if dynamic:
            require(dynamic[2] + dynamic[5] <= len(data), "Invalid ELF dynamic segment")
            for offset in range(dynamic[2], dynamic[2] + dynamic[5], 16):
                tag, value = struct.unpack_from("<qQ", data, offset)
                if tag == 0:
                    break
                if tag == 1:
                    needed.append(value)
                elif tag == 5:
                    strings = value
        imports = []
        if needed:
            segment = next((item for item in segments if item[0] == 1 and item[3] <= strings < item[3] + item[5]), None)
            require(segment is not None, "ELF dynamic strings are unmapped")
            base = segment[2] + strings - segment[3]
            for offset in needed:
                end = data.find(b"\0", base + offset)
                require(end >= 0, "Invalid ELF dependency name")
                imports.append(data[base + offset:end].decode("ascii"))
        return {"format": "elf", "machine": machine, "imports": sorted(set(imports))}
    if data[:2] != b"MZ":
        return None
    require(len(data) >= 64, "Invalid PE header")
    pe = struct.unpack_from("<I", data, 60)[0]
    require(data[pe:pe + 4] == b"PE\0\0", "Invalid PE signature")
    machine, count = struct.unpack_from("<HH", data, pe + 4)
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    require(struct.unpack_from("<H", data, optional)[0] == 0x20B, "Expected PE32+ executable")
    table = optional + optional_size
    sections = [struct.unpack_from("<8sIIIIIIHHI", data, table + index * 40) for index in range(count)]

    def rva(address):
        for section in sections:
            if section[2] <= address < section[2] + max(section[1], section[3]):
                return section[4] + address - section[2]
        raise ValueError("Unmapped PE address")

    def name(address):
        offset = rva(address)
        end = data.find(b"\0", offset)
        require(end >= 0, "Invalid PE dependency name")
        return data[offset:end].decode("ascii").lower()

    imports = []
    directory_count = struct.unpack_from("<I", data, optional + 108)[0]
    if directory_count > 1:
        address, size = struct.unpack_from("<II", data, optional + 112 + 8)
        if address:
            offset = rva(address)
            for index in range(size // 20):
                descriptor = struct.unpack_from("<IIIII", data, offset + index * 20)
                if not any(descriptor):
                    break
                imports.append(name(descriptor[3]))
    if directory_count > 13:
        address, size = struct.unpack_from("<II", data, optional + 112 + 13 * 8)
        if address:
            offset = rva(address)
            for index in range(size // 32):
                descriptor = struct.unpack_from("<8I", data, offset + index * 32)
                if not any(descriptor):
                    break
                require(descriptor[0] & 1, "Unsupported absolute PE delay imports")
                imports.append(name(descriptor[1]))
    return {"format": "pe", "machine": machine, "imports": sorted(set(imports))}


def verify_asset_checksums(directory):
    manifest = directory / "checksums.json"
    if not manifest.exists():
        return
    for name, record in json.loads(manifest.read_text(encoding="utf-8")).items():
        relative = safe_name(name)
        require(record["file"] == name, "Asset checksum filename differs")
        path = directory.joinpath(*relative.parts)
        require(path.resolve().is_relative_to(directory.resolve()), "External asset checksum path")
        require(path.stat().st_size == record["bytes"] and sha256(path) == record["sha256"], "Asset source checksum differs: " + name)


def verify_contents(root, platform, version):
    require(platform in PLATFORMS, "Unsupported platform")
    manifest = json.loads((root / "MANIFEST.json").read_text(encoding="utf-8"))
    require(manifest.get("schema") == "ceres-viewer-package" and manifest.get("version") == 1, "Invalid manifest schema")
    require(manifest.get("platform") == platform and manifest.get("release_version") == version, "Package platform or version differs")
    require(re.fullmatch(r"[0-9a-f]{40}", manifest.get("source_revision", "")), "Invalid source revision")
    files = {path.relative_to(root).as_posix(): path for path in root.rglob("*") if path.is_file() or path.is_symlink()}
    expected = set(manifest["files"]) | {"MANIFEST.json", "SHA256SUMS"}
    require(set(files) == expected, "Package file inventory differs from manifest")
    sums = {}
    for line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        require(re.fullmatch(r"[0-9a-f]{64}  .+", line), "Invalid checksum line")
        digest, path = line.split("  ", 1)
        safe_name(path)
        require(path not in sums, "Duplicate checksum path")
        sums[path] = digest
    require(set(sums) == expected - {"SHA256SUMS"}, "Checksum inventory differs")
    for relative, path in files.items():
        safe_name(relative)
        require(path.resolve().is_relative_to(root.resolve()), "External package link")
        if relative != "SHA256SUMS":
            require(sha256(path) == sums[relative], "Checksum mismatch: " + relative)
        if relative in manifest["files"]:
            record = manifest["files"][relative]
            require(record["sha256"] == sums[relative] and record["size"] == path.stat().st_size, "Manifest mismatch: " + relative)
            require(record.get("symlink") == (os.readlink(path) if path.is_symlink() else None), "Package link differs")
        require(".git" not in path.relative_to(root).parts, "Package contains Git metadata")
    assets = json.loads((root / "assets/redistributable.json").read_text(encoding="utf-8"))
    allowed_assets = {"assets/" + name for name in assets["files"]} | {"assets/redistributable.json"}
    require({name for name in files if name.startswith("assets/")} == allowed_assets, "Asset inventory differs")
    require(not any("mano" in name.lower() for name in allowed_assets), "Package contains a licensed MANO asset")
    verify_asset_checksums(root / "assets/quest3")
    source = json.loads((root / "provenance/source.json").read_text(encoding="utf-8"))
    for key in ("platform", "release_version", "source_revision"):
        require(source[key] == manifest[key], "Source provenance differs: " + key)
    require(source["exporter_revision"] == source["source_revision"], "Exporter source revision differs")
    require(json.loads((root / "provenance/package.json").read_text(encoding="utf-8"))["version"] == version, "Root source version differs")
    sbom = json.loads((root / "SBOM.spdx.json").read_text(encoding="utf-8"))
    require(sbom["spdxVersion"] == "SPDX-2.3" and sbom["name"] == f"ceres-viewer-{version}-{platform}", "SBOM identity differs")
    sbom_files = {}
    for item in sbom["files"]:
        relative = item["fileName"].removeprefix("./")
        require(relative not in sbom_files, "Duplicate SBOM file")
        sbom_files[relative] = item["checksums"]
        require(item["checksums"] == [{"algorithm": "SHA256", "checksumValue": sums[relative]}], "SBOM checksum differs")
    require(set(sbom_files) == expected - {"SHA256SUMS", "MANIFEST.json", "SBOM.spdx.json"}, "SBOM inventory differs")
    binary_paths = {name: path for name, path in files.items() if "/" not in name or name.startswith("lib/")}
    binaries = {}
    for name, path in binary_paths.items():
        info = binary_info(path)
        if info:
            require((info["format"], info["machine"]) == PLATFORMS[platform], "Binary architecture differs: " + name)
            binaries[name] = info
    suffix = ".exe" if platform.startswith("windows") else ""
    viewer = "ceres-viewer.exe" if suffix else "ceres-viewer.bin"
    for name in [viewer, "ceres-native-exporter" + suffix, "ffmpeg" + suffix, "ffprobe" + suffix]:
        require(name in binaries, "Required executable is missing: " + name)
    require(("Ceres viewer " + version).encode("ascii") + b"\0" in (root / viewer).read_bytes(), "Compiled viewer version differs")
    packaged = {Path(name).name.lower() if suffix else Path(name).name for name in binaries}
    system = set()
    for name, info in binaries.items():
        for dependency in info["imports"]:
            require("/" not in dependency and "\\" not in dependency, "Dependency contains a path")
            if dependency in packaged:
                continue
            if suffix:
                allowed = dependency.startswith(("api-ms-", "ext-ms-")) or dependency in {"nvcuda.dll", "nvcuvid.dll"} or dependency.removesuffix(".dll") in WINDOWS_SYSTEM
            else:
                allowed = bool(LINUX_SYSTEM.fullmatch(dependency))
            require(allowed, f"Unbundled dependency {dependency} required by {name}")
            system.add(dependency)
    return manifest, binaries, {"passed": True, "system_dependencies": sorted(system)}


def isolated_environment(root, workspace):
    environment = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"}}
    if os.name == "nt":
        system = Path(environment["SYSTEMROOT"])
        environment["PATH"] = os.pathsep.join(map(str, [root, system / "System32", system]))
    else:
        environment["PATH"] = str(root) + ":/usr/bin:/bin"
        environment["LD_LIBRARY_PATH"] = str(root / "lib")
    home = workspace / "home"
    home.mkdir(exist_ok=True)
    environment["HOME"] = str(home)
    environment["USERPROFILE"] = str(home)
    return environment


def run_tool(arguments, environment, cwd, timeout=90):
    result = subprocess.run([str(value) for value in arguments], cwd=cwd, env=environment, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, errors="replace", timeout=timeout)
    require(result.returncode == 0, f"{Path(arguments[0]).name} failed ({result.returncode}): {result.stderr[-4000:]}")
    return result.stdout


def mcap_record(opcode, body):
    return bytes([opcode]) + struct.pack("<Q", len(body)) + body


def mcap_string(value):
    encoded = value.encode("utf-8")
    return struct.pack("<I", len(encoded)) + encoded


def write_fixture(path, access_units):
    """Write three observed video/pose samples and genuine fingertip measurements."""
    magic = b"\x89MCAP0\r\n"
    records = [mcap_record(1, mcap_string("") + mcap_string("ceres-package-verifier")),
               mcap_record(4, struct.pack("<HH", 1, 0) + mcap_string("ceres/events") + mcap_string("ceres-session-v1") + struct.pack("<I", 0))]

    def event(kind, time, sequence, payload, attributes=None):
        header = {"version": 1, "kind": kind, "receive_us": 1000000 + time, "time_us": 1000000 + time,
                  "session_receive_us": time, "session_time_us": time, "epoch": 1, "space_epoch": 0,
                  "sequence": sequence, "rtp_timestamp": sequence * 3000, "keyframe": True, "stream": "video", "attributes": attributes or {}}
        encoded = json.dumps(header, separators=(",", ":")).encode()
        envelope = b"CSE1" + struct.pack("<I", len(encoded)) + encoded + payload
        records.append(mcap_record(5, struct.pack("<HIQQ", 1, sequence, time * 1000, time * 1000) + envelope))

    for sequence, access_unit in enumerate(access_units):
        time = sequence * 33333
        head = bytearray(68)
        head[:4] = b"CBR1"
        head[4:7] = bytes([1, 1, 1])
        struct.pack_into("<I", head, 8, 1)
        struct.pack_into("<IIQQ", head, 16, sequence, 28, time, time)
        struct.pack_into("<f", head, 40, 0.01 * sequence)
        struct.pack_into("<f", head, 64, 1.0)
        event("pose", time, sequence, head)
        for side in (2, 3):
            hand = bytearray(844)
            hand[:40] = head[:40]
            hand[5] = side
            struct.pack_into("<I", hand, 20, 804)
            struct.pack_into("<I", hand, 40, (1 << 4) | (1 << 9))
            for joint in (4, 9):
                offset = 44 + joint * 32
                struct.pack_into("<3f", hand, offset, 0.1 * side, 0.03 if joint == 9 else 0, 0)
                struct.pack_into("<2f", hand, offset + 24, 1, 0.01)
            event("pose", time, sequence, hand)
        event("video", time, sequence, access_unit, {"head_sequence": sequence, "head_pose": [0.01 * sequence, 0, 0, 0, 0, 0, 1]})
    event("metadata", 100000, 3, b"{}")
    records.extend([mcap_record(15, struct.pack("<I", 0)), mcap_record(2, struct.pack("<QQI", 0, 0, 0))])
    path.write_bytes(magic + b"".join(records) + magic)


def export_fixture(root, workspace):
    workspace.mkdir(parents=True, exist_ok=False)
    environment = isolated_environment(root, workspace)
    suffix = ".exe" if os.name == "nt" else ""
    ffmpeg, ffprobe = root / ("ffmpeg" + suffix), root / ("ffprobe" + suffix)
    helper = root / ("ceres-native-exporter" + suffix)
    release_version = json.loads((root / "provenance/package.json").read_text(encoding="utf-8"))["version"]
    require(run_tool([helper, "--version"], environment, workspace).strip() == "ceres-native-exporter " + release_version,
            "Compiled exporter version differs")
    capabilities = json.loads(run_tool([helper, "--capabilities"], environment, workspace))
    require(capabilities.get("schema") == "ceres-native-export-capabilities" and capabilities.get("default_profile") == "ceres-bridge-lerobot3-v1"
            and capabilities.get("action_dimension") == 2 and capabilities.get("ceres_episode_shards") is True,
            "Exporter capabilities differ")
    source = workspace / "source.h264"
    run_tool([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=30",
              "-frames:v", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "0", "-threads", "1",
              "-x264-params", "aud=1:keyint=1:repeat-headers=1", "-f", "h264", source], environment, workspace)
    data = source.read_bytes()
    starts = [index for index in range(len(data) - 4) if data[index:index + 4] == b"\x00\x00\x00\x01" and data[index + 4] & 31 == 9]
    require(len(starts) == 3 and starts[0] == 0, "Fixture access units differ")
    units = [data[start:end] for start, end in zip(starts, starts[1:] + [len(data)])]
    session = workspace / "session.mcap"
    write_fixture(session, units)
    job = workspace / "job.json"
    write_json(job, {"schema": "ceres-native-export", "version": 1, "session": str(session), "output": str(workspace / "dataset"),
                     "fps": 30, "ffmpeg": str(ffmpeg), "episodes": [{"start_us": 0, "end_us": 100000, "task": "Move the tracked hands"}],
                     "video": {"stream": "video", "width": 64, "height": 48, "source_dimensions": True}})
    progress = run_tool([helper, "--job", job], environment, workspace)
    (workspace / "export-progress.jsonl").write_text(progress, encoding="utf-8")
    dataset = workspace / "dataset"
    info = json.loads((dataset / "meta/info.json").read_text(encoding="utf-8"))
    require(info.get("total_frames") == 3 and info.get("total_episodes") == 1 and info.get("total_tasks") == 1, "Export row accounting differs")
    require(info.get("ceres_profile") == "ceres-bridge-lerobot3-v1" and info["features"]["action"]["shape"] == [2], "Export action schema differs")
    parquet = sorted((dataset / "data").rglob("*.parquet"))
    require(bool(parquet), "Export observation table is missing")
    for path in parquet:
        content = path.read_bytes()
        require(content[:4] == b"PAR1" and content[-4:] == b"PAR1" and len(content) > 100, "Export Parquet framing differs")
    videos = sorted((dataset / "videos").rglob("*.mp4"))
    require(len(videos) == 1, "Export video inventory differs")
    probe = json.loads(run_tool([ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                                 "stream=width,height,nb_read_frames,codec_name", "-of", "json", videos[0]], environment, workspace))
    video = probe["streams"][0]
    require((video["width"], video["height"], int(video["nb_read_frames"]), video["codec_name"]) == (64, 48, 3, "h264"), "Export video differs")
    run_tool([ffmpeg, "-v", "error", "-i", videos[0], "-f", "null", "-"], environment, workspace)
    require(bool(list((dataset / "shards").rglob("info.json"))), "CERES episode shard is missing")
    return {"passed": True, "session": str(session), "job": str(job), "dataset": str(dataset), "frames": 3,
            "episodes": 1, "video": video, "capabilities": capabilities}


def verify_package(archive, expected_platform, expected_version, output_directory):
    archive, output = Path(archive).resolve(), Path(output_directory).resolve()
    require(not output.exists() or (output.is_dir() and not any(output.iterdir())), "Verification output must be empty")
    output.mkdir(parents=True, exist_ok=True)
    root = extract_archive(archive, output / "extracted")
    manifest, binaries, closure = verify_contents(root, expected_platform, expected_version)
    fixture = export_fixture(root, output / "export-fixture")
    report = {"schema": "ceres-viewer-package-verification", "version": 1, "passed": True,
              "platform": expected_platform, "release_version": expected_version, "source_revision": manifest["source_revision"],
              "archive_sha256": sha256(archive), "package_root": str(root), "report_path": str(output / "report.json"),
              "manifest": manifest, "binaries": binaries, "closure": closure, "export_fixture": fixture}
    write_json(output / "report.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    result = verify_package(arguments.archive, arguments.platform, arguments.version, arguments.output)
    print(json.dumps({key: result[key] for key in ("schema", "passed", "platform", "release_version", "archive_sha256", "report_path")}))
