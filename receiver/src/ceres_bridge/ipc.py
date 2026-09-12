"""Private Unix IPC with two leased RGB frame slots per subscribing process."""

import asyncio
import json
import mmap
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading

from .state import LatestState, monotonic_us

MAX_CONSUMERS = 8
MAX_FRAME_BYTES = 640 * 1280 * 3
MAX_ENCODED_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 48_000 * 2 * 120 // 1000
MAX_MESSAGE_BYTES = 32_768
IPC_TIMEOUT = 0.1


def runtime_dir() -> Path:
    path = Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/ceres-bridge-{os.getuid()}")) / "ceres-bridge"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise PermissionError("Bridge runtime directory must be private to this user")
    return path


class FrameMailbox:
    def __init__(self, capacity=MAX_FRAME_BYTES):
        self.capacity = capacity
        self.file = tempfile.TemporaryFile(prefix="ceres-frame-", dir="/dev/shm")
        self.file.truncate(capacity * 2)
        self.memory = mmap.mmap(self.file.fileno(), capacity * 2)
        self.path = f"/proc/{os.getpid()}/fd/{self.file.fileno()}"
        self.leased: set[int] = set()
        self.latest = None
        self.generation = 0
        self.drops = 0

    def publish(self, data, width, height, stride, received_us, epoch, pts_ns):
        if len(data) > self.capacity or stride * height != len(data):
            self.drops += 1
            return
        slot = next((i for i in (0, 1) if i not in self.leased), None)
        if slot is None:
            self.drops += 1
            return
        offset = slot * self.capacity
        self.memory[offset:offset + len(data)] = data
        self.generation += 1
        self.latest = {"slot": slot, "generation": self.generation, "offset": offset, "bytes": len(data),
                       "width": width, "height": height, "stride": stride, "format": "RGB",
                       "received_us": received_us, "epoch": epoch, "pts_ns": pts_ns}

    def acquire(self, now):
        if not self.latest or now - self.latest["received_us"] > 100_000 or self.latest["slot"] in self.leased:
            return None
        result = dict(self.latest)
        self.leased.add(result["slot"])
        self.latest = None
        return result

    def close(self):
        self.memory.close()
        self.file.close()


class EncodedMailbox(FrameMailbox):
    def __init__(self):
        super().__init__(MAX_ENCODED_BYTES)
        self.needs_keyframe = True

    def acquire(self, now):
        if self.latest and now - self.latest["received_us"] > 100_000:
            self.latest = None
            self.needs_keyframe = True
            self.drops += 1
        return super().acquire(now)

    def publish_access_unit(self, data, keyframe, received_us, epoch, pts_ns):
        if self.latest is not None or len(self.leased) == 2 or len(data) > self.capacity:
            self.needs_keyframe = True
            self.latest = None
            self.drops += 1
        if self.needs_keyframe and not keyframe:
            return False
        if len(self.leased) == 2 or len(data) > self.capacity:
            return False
        super().publish(data, len(data), 1, len(data), received_us, epoch, pts_ns)
        self.latest.update(format="h264", keyframe=keyframe)
        self.needs_keyframe = False
        return True


class AudioMailbox(FrameMailbox):
    def __init__(self):
        super().__init__(MAX_AUDIO_BYTES)

    def publish_audio(self, data, received_us, epoch, pts_ns):
        if not data or len(data) % 2 or len(data) > self.capacity:
            self.drops += 1
            return
        generation = self.generation
        super().publish(data, len(data) // 2, 1, len(data), received_us, epoch, pts_ns)
        if self.generation != generation:
            self.latest.update(format="S16LE", sample_rate=48_000, channels=1, samples=len(data) // 2)


class Broker:
    def __init__(self, state: LatestState):
        self.state = state
        self.lock = threading.Lock()
        self.consumers: dict[int, FrameMailbox | None] = {}
        self.encoded: dict[int, EncodedMailbox] = {}
        self.audio: dict[int, AudioMailbox] = {}
        self.request_keyframe = lambda: None
        self.serial = 0

    def publish_frame(self, data, width, height, stride, epoch, pts_ns=None):
        now = monotonic_us()
        with self.lock:
            for box in self.consumers.values():
                if box:
                    box.publish(data, width, height, stride, now, epoch, pts_ns)
        with self.state.lock:
            self.state.counts["frames"] += 1

    def reset(self):
        with self.lock:
            for box in [*self.consumers.values(), *self.encoded.values(), *self.audio.values()]:
                if box:
                    box.latest = None
                    if isinstance(box, EncodedMailbox):
                        box.needs_keyframe = True

    def publish_encoded(self, data, keyframe, epoch, pts_ns):
        request = False
        with self.lock:
            for box in self.encoded.values():
                if not box.publish_access_unit(data, keyframe, monotonic_us(), epoch, pts_ns):
                    request = True
        if request:
            self.request_keyframe()

    def publish_audio(self, data, epoch, pts_ns):
        with self.lock:
            for box in self.audio.values():
                box.publish_audio(data, monotonic_us(), epoch, pts_ns)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        identity = None
        try:
            peer = writer.get_extra_info("socket")
            _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                return
            with self.lock:
                if len(self.consumers) >= MAX_CONSUMERS:
                    return
                self.serial += 1
                identity = self.serial
                self.consumers[identity] = None
            writer.transport.set_write_buffer_limits(high=MAX_MESSAGE_BYTES, low=0)
            while True:
                # Idle clients may keep leases. Their private slots never affect another client.
                raw = await reader.readline()
                if not raw:
                    break
                if len(raw) > 1024:
                    break
                message = json.loads(raw)
                if message.get("version") != 1:
                    break
                with self.lock:
                    box = self.consumers[identity]
                    if message.get("op") == "subscribe":
                        if message.get("video") and box is None:
                            box = FrameMailbox()
                            self.consumers[identity] = box
                        if message.get("encoded") and identity not in self.encoded:
                            self.encoded[identity] = EncodedMailbox()
                            self.request_keyframe()
                        encoded_box = self.encoded.get(identity)
                        if message.get("audio") and identity not in self.audio:
                            self.audio[identity] = AudioMailbox()
                        audio_box = self.audio.get(identity)
                        result = {"version": 1, "path": box.path if box else None, "size": MAX_FRAME_BYTES * 2 if box else 0,
                                  "encoded_path": encoded_box.path if encoded_box else None,
                                  "encoded_size": MAX_ENCODED_BYTES * 2 if encoded_box else 0,
                                  "audio_path": audio_box.path if audio_box else None,
                                  "audio_size": MAX_AUDIO_BYTES * 2 if audio_box else 0}
                    elif message.get("op") == "diagnostics":
                        result = self.state.diagnostics()
                    elif message.get("op") == "latest":
                        release = message.get("release", [])
                        if not isinstance(release, list) or len(release) > 2 or any(type(i) is not int or i not in (0, 1) for i in release):
                            break
                        if box:
                            box.leased.difference_update(release)
                        encoded_box = self.encoded.get(identity)
                        encoded_release = message.get("encoded_release", [])
                        if not isinstance(encoded_release, list) or len(encoded_release) > 2 or any(type(i) is not int or i not in (0, 1) for i in encoded_release):
                            break
                        if encoded_box:
                            encoded_box.leased.difference_update(encoded_release)
                            if message.get("keyframe"):
                                encoded_box.needs_keyframe = True
                                encoded_box.latest = None
                                self.request_keyframe()
                        result = self.state.snapshot()
                        result["frame"] = box.acquire(monotonic_us()) if box else None
                        result["encoded"] = encoded_box.acquire(monotonic_us()) if encoded_box else None
                        audio_release = message.get("audio_release", [])
                        if not isinstance(audio_release, list) or len(audio_release) > 2 or any(type(i) is not int or i not in (0, 1) for i in audio_release):
                            break
                        audio_box = self.audio.get(identity)
                        if audio_box:
                            audio_box.leased.difference_update(audio_release)
                        result["audio"] = audio_box.acquire(monotonic_us()) if audio_box else None
                        if encoded_box and encoded_box.needs_keyframe:
                            self.request_keyframe()
                        result["buffers"] = {"consumers": len(self.consumers),
                                             "raw_bytes": sum(MAX_FRAME_BYTES * 2 for b in self.consumers.values() if b),
                                             "encoded_bytes": len(self.encoded) * MAX_ENCODED_BYTES * 2,
                                             "audio_bytes": len(self.audio) * MAX_AUDIO_BYTES * 2,
                                             "frame_drops": box.drops if box else 0}
                    else:
                        break
                encoded = json.dumps(result, allow_nan=False, separators=(",", ":")).encode() + b"\n"
                if len(encoded) > MAX_MESSAGE_BYTES:
                    break
                writer.write(encoded)
                await asyncio.wait_for(writer.drain(), IPC_TIMEOUT)
        except (ValueError, OSError, TimeoutError, asyncio.LimitOverrunError):
            pass
        finally:
            if identity is not None:
                with self.lock:
                    box = self.consumers.pop(identity)
                    if box:
                        box.close()
                    encoded_box = self.encoded.pop(identity, None)
                    if encoded_box:
                        encoded_box.close()
                    audio_box = self.audio.pop(identity, None)
                    if audio_box:
                        audio_box.close()
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
