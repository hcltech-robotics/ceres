"""Synchronous, dependency-free access to the current receiver observations."""

import json
import mmap
from pathlib import Path
import socket
import time


class Frame:
    def __init__(self, receiver, metadata, encoded=False, audio=False):
        self.receiver, self.metadata = receiver, metadata
        self.encoded = encoded
        self.audio = audio
        self._released = False

    @property
    def data(self):
        if self._released:
            raise RuntimeError("Bridge frame lease has been released")
        m = self.metadata
        memory = self.receiver.audio_memory if self.audio else self.receiver.encoded_memory if self.encoded else self.receiver.memory
        return memoryview(memory)[m["offset"]:m["offset"] + m["bytes"]].toreadonly()

    def release(self):
        if not self._released:
            (self.receiver.audio_releases if self.audio else self.receiver.encoded_releases if self.encoded else self.receiver.releases).append(self.metadata["slot"])
            self._released = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.release()


class Receiver:
    def __init__(self, path: str | Path | None = None, *, video: bool = True, encoded: bool = False, audio: bool = False):
        if path is None:
            from .ipc import runtime_dir
            path = runtime_dir() / "receiver.sock"
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(1)
        self.socket.connect(str(path))
        # Read complete response lines in blocks. Raw SocketIO.readline reads
        # one byte per syscall and can expire poses when consumers run together.
        self.stream = self.socket.makefile("rb", buffering=65_536)
        self.releases = []
        self.encoded_releases = []
        self.audio_releases = []
        self.audio_memory = None
        self.audio_file = None
        self.encoded_memory = None
        self.encoded_file = None
        self.needs_keyframe = False
        self.memory = None
        self.mapping_file = None
        result = self._request({"op": "subscribe", "video": video, "encoded": encoded, "audio": audio})
        if result["path"]:
            self.mapping_file = open(result["path"], "rb")
            self.memory = mmap.mmap(self.mapping_file.fileno(), result["size"], access=mmap.ACCESS_READ)
        if result["encoded_path"]:
            self.encoded_file = open(result["encoded_path"], "rb")
            self.encoded_memory = mmap.mmap(self.encoded_file.fileno(), result["encoded_size"], access=mmap.ACCESS_READ)
        if result.get("audio_path"):
            self.audio_file = open(result["audio_path"], "rb")
            self.audio_memory = mmap.mmap(self.audio_file.fileno(), result["audio_size"], access=mmap.ACCESS_READ)

    def _request(self, message):
        self.socket.sendall(json.dumps({"version": 1, **message}, separators=(",", ":")).encode() + b"\n")
        raw = self.stream.readline(32_769)
        if not raw.endswith(b"\n") or len(raw) > 32_768:
            raise ConnectionError("Bridge receiver closed the IPC connection")
        response = json.loads(raw)
        if response.get("version") != 1:
            raise ValueError("Incompatible Bridge IPC version")
        return response

    def latest(self, *, keyframe: bool = False) -> dict:
        result = self._request({"op": "latest", "release": self.releases, "encoded_release": self.encoded_releases,
                                "audio_release": self.audio_releases,
                                "keyframe": keyframe or self.needs_keyframe})
        self.needs_keyframe = False
        self.releases.clear()
        self.encoded_releases.clear()
        self.audio_releases.clear()
        # The application may have stalled after the worker wrote its response.
        now = time.monotonic_ns() // 1000
        for component in result["poses"].values():
            if now - result["now_us"] + (component["age_us"] or 0) + (result["clock"] or {}).get("uncertainty_us", 0) > 50_000:
                component.update(pose=None, fresh=False, tracked=False)
        frame = result["frame"]
        if frame and (frame["epoch"] != result["epoch"] or now - frame["received_us"] > 100_000):
            self.releases.append(frame["slot"])
            frame = None
        result["frame"] = Frame(self, frame) if frame else None
        encoded = result["encoded"]
        if encoded and (encoded["epoch"] != result["epoch"] or now - encoded["received_us"] > 100_000):
            self.encoded_releases.append(encoded["slot"])
            self.needs_keyframe = True
            encoded = None
        result["encoded"] = Frame(self, encoded, True) if encoded else None
        audio = result.get("audio")
        if audio and (audio["epoch"] != result["epoch"] or now - audio["received_us"] > 100_000):
            self.audio_releases.append(audio["slot"])
            audio = None
        result["audio"] = Frame(self, audio, audio=True) if audio else None
        return result

    def diagnostics(self):
        return self._request({"op": "diagnostics"})

    def close(self):
        self.stream.close()
        self.socket.close()
        if self.memory:
            self.memory.close()
        if self.mapping_file:
            self.mapping_file.close()
        if self.encoded_memory:
            self.encoded_memory.close()
        if self.encoded_file:
            self.encoded_file.close()
        if self.audio_memory:
            self.audio_memory.close()
        if self.audio_file:
            self.audio_file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
