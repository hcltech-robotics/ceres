"""Synchronous, dependency-free access to the current receiver observations."""

import json
import mmap
from pathlib import Path
import socket
import time


class IPCProtocolError(ConnectionError):
    """An IPC response is malformed rather than a disconnected transport."""


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


def expire_snapshot(snapshot, now_us=None):
    """Expire observations at delivery and report a discarded encoded lease."""
    now = time.monotonic_ns() // 1000 if now_us is None else now_us
    for component in snapshot["poses"].values():
        if now - snapshot["now_us"] + (component.get("age_us") or 0) + (snapshot.get("clock") or {}).get("uncertainty_us", 0) > 50_000:
            component.update(pose=None, fresh=False, tracked=False)
    keyframe = False
    for kind in ("frame", "encoded", "audio"):
        frame = snapshot.get(kind)
        if frame is not None and (now - frame.metadata["received_us"] > 100_000
                                  or frame.metadata.get("epoch", snapshot["epoch"]) != snapshot["epoch"]):
            with frame:
                pass
            snapshot[kind] = None
            keyframe |= kind == "encoded"
    return keyframe


class Receiver:
    def __init__(self, path: str | Path | None = None, *, video: bool = True, encoded: bool = False, audio: bool = False):
        if path is None:
            from .ipc import runtime_dir
            path = runtime_dir() / "receiver.sock"
        self.socket = self.stream = None
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
        try:
            self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.socket.settimeout(1)
            self.socket.connect(str(path))
            # Read complete response lines in blocks. Raw SocketIO.readline reads
            # one byte per syscall and can expire poses when consumers run together.
            self.stream = self.socket.makefile("rb", buffering=65_536)
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
        except BaseException:
            self.close()
            raise

    def _request(self, message):
        self.socket.sendall(json.dumps({"version": 1, **message}, separators=(",", ":")).encode() + b"\n")
        raw = self.stream.readline(32_769)
        if not raw or (len(raw) <= 32_768 and not raw.endswith(b"\n")):
            raise ConnectionError("Bridge receiver closed the IPC connection")
        if len(raw) > 32_768:
            raise IPCProtocolError("Bridge receiver closed the IPC connection with an invalid response boundary")
        response = json.loads(raw)
        if not isinstance(response, dict):
            raise IPCProtocolError("Bridge IPC response must be an object")
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
        frame = result["frame"]
        result["frame"] = Frame(self, frame) if frame else None
        encoded = result["encoded"]
        result["encoded"] = Frame(self, encoded, True) if encoded else None
        audio = result.get("audio")
        result["audio"] = Frame(self, audio, audio=True) if audio else None
        self.needs_keyframe = expire_snapshot(result)
        return result

    def diagnostics(self):
        return self._request({"op": "diagnostics"})

    def close(self):
        for name in ("stream", "socket", "memory", "mapping_file", "encoded_memory",
                     "encoded_file", "audio_memory", "audio_file"):
            resource = getattr(self, name, None)
            if resource is not None:
                resource.close()
                setattr(self, name, None)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
