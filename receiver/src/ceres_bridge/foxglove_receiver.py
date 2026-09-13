"""Keep Foxglove consumers alive across receiver transport interruptions."""

import asyncio
import time

from .client import IPCProtocolError, Receiver, expire_snapshot


class FoxgloveReceiver:
    """Reconnect one independent IPC consumer without reusing frame leases."""

    def __init__(self, path=None, *, video=True, encoded=False, factory=Receiver, retry_delay=.25):
        self.path, self.options = path, {"video": video, "encoded": encoded}
        self.factory, self.retry_delay = factory, retry_delay
        self.receiver = self.connecting = self.request = None
        self.retry_at = 0.0
        self.generation = 0
        self.keyframe = encoded
        self.closed = False
        self.metadata = {"version": 1, "epoch": 0, "space_epoch": None,
                         "description": None, "codec": None, "clock": None,
                         "counts": dict.fromkeys(("frames", "received", "rejected", "gaps",
                                                  "late", "future", "duplicate", "malformed"), 0)}

    def disconnected(self):
        return {**self.metadata, "connection": "disconnected", "poses": {},
                "frame": None, "encoded": None, "audio": None,
                "ipc_generation": self.generation, "now_us": time.monotonic_ns() // 1000}

    async def latest(self, *, keyframe=False):
        if self.closed:
            raise RuntimeError("Foxglove receiver is closed")
        self.keyframe |= keyframe
        if self.receiver is None:
            if self.connecting is not None and self.connecting.done():
                connecting, self.connecting = self.connecting, None
                try:
                    self.receiver = connecting.result()
                except IPCProtocolError:
                    raise
                except OSError:
                    self.retry_at = time.monotonic() + self.retry_delay
                else:
                    self.generation += 1
                    self.keyframe |= self.options["encoded"]
                    self.metadata["counts"] = dict.fromkeys(self.metadata["counts"], 0)
            if self.receiver is None:
                if self.connecting is None and time.monotonic() >= self.retry_at:
                    self.connecting = asyncio.create_task(asyncio.to_thread(
                        self.factory, self.path, **self.options))
                return self.disconnected()

        if self.request is None:
            self.request = asyncio.create_task(asyncio.to_thread(self.receiver.latest, keyframe=self.keyframe))
            self.keyframe = False
        # Continue publishing loss/neutral state while a socket read is pending.
        # Only one read can own this connection and its frame leases at a time.
        done, _ = await asyncio.wait((self.request,), timeout=.005)
        if not done:
            return self.disconnected()
        try:
            snapshot = self.request.result()
        except IPCProtocolError:
            raise
        except OSError:
            self.receiver.close()
            self.receiver = None
            self.retry_at = time.monotonic() + self.retry_delay
            self.keyframe |= self.options["encoded"]
            return self.disconnected()
        finally:
            self.request = None
        # A completed read may wait behind rendering or solving. Apply the same
        # freshness bounds again at delivery, releasing leases before retrying.
        self.keyframe |= expire_snapshot(snapshot)
        self.metadata.update({key: snapshot[key] for key in self.metadata if key in snapshot})
        return {**snapshot, "ipc_generation": self.generation}

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.request is not None:
            await asyncio.gather(self.request, return_exceptions=True)
            self.request = None
        if self.connecting is not None:
            result, = await asyncio.gather(self.connecting, return_exceptions=True)
            self.connecting = None
            if not isinstance(result, BaseException):
                result.close()
        if self.receiver is not None:
            self.receiver.close()
            self.receiver = None
