"""Receiver response framing and bounded socket reads over real Unix IPC."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import socket
import tempfile
import time

import pytest

from ceres_bridge import client


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode() + b"\n"


@contextmanager
def receiver_peer(exchange):
    # macOS Unix socket paths are limited to 104 bytes, including the terminator.
    with tempfile.TemporaryDirectory(dir="/tmp") as directory, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        path = directory + "/receiver.sock"
        listener.bind(path)
        listener.listen(1)
        listener.settimeout(2)

        def serve():
            connection, _ = listener.accept()
            with connection, connection.makefile("rb") as requests:
                connection.settimeout(2)
                request = json.loads(requests.readline())
                assert request["op"] == "subscribe" and not request["video"]
                connection.sendall(encoded({"version": 1, "path": None, "encoded_path": None}))
                assert json.loads(requests.readline())["op"] == "diagnostics"
                exchange(connection, requests)

        with ThreadPoolExecutor(max_workers=1) as executor:
            serving = executor.submit(serve)
            try:
                with client.Receiver(path, video=False) as receiver:
                    yield receiver
            finally:
                serving.result(timeout=3)


class CountingSocket(socket.socket):
    reads = 0

    def recv_into(self, *args, **kwargs):
        self.reads += 1
        return super().recv_into(*args, **kwargs)


def test_full_size_response_uses_block_reads_and_preserves_the_next_frame(monkeypatch):
    response = {"version": 1, "padding": ""}
    response["padding"] = "x" * (32_768 - len(encoded(response)))
    wire = encoded(response)
    assert len(wire) == 32_768
    following = {"version": 1, "received": 2}

    def exchange(connection, requests):
        connection.sendall(wire + encoded(following))
        assert json.loads(requests.readline())["op"] == "diagnostics"

    monkeypatch.setattr(client.socket, "socket", CountingSocket)
    with receiver_peer(exchange) as receiver:
        previous = receiver.socket.reads
        assert receiver.diagnostics() == response
        # A full payload must not require one recv syscall per byte. This checks
        # the observed socket traffic without relying on machine-speed timings.
        assert receiver.socket.reads - previous <= 8
        assert receiver.diagnostics() == following


def test_fragmented_response_reassembles_one_json_line():
    response = {"version": 1, "message": "pose" * 2048}
    wire = encoded(response)

    def exchange(connection, _requests):
        for part in (wire[:3], wire[3:4096], wire[4096:]):
            connection.sendall(part)
            time.sleep(.002)

    with receiver_peer(exchange) as receiver:
        assert receiver.diagnostics() == response


@pytest.mark.parametrize("wire", [
    encoded({"version": 1, "padding": "x" * 32_768}),
    b'{"version":1}',
], ids=("oversized", "unterminated"))
def test_invalid_response_boundaries_remain_rejected(wire):
    def exchange(connection, _requests):
        connection.sendall(wire)
        connection.shutdown(socket.SHUT_WR)

    with receiver_peer(exchange) as receiver:
        with pytest.raises(ConnectionError, match="closed the IPC connection"):
            receiver.diagnostics()
