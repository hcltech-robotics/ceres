"""Persistent receiver identity and disposable WebRTC connection generations."""

import asyncio
import contextlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import time
from urllib.parse import urlparse

import aiohttp

from .ipc import Broker, runtime_dir
from .state import LatestState


class RelayError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def state_path():
    directory = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "ceres-bridge"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise PermissionError("Bridge state directory must be private to this user")
    return directory / "receiver.json"


def save_state(path: Path, value):
    temporary = path.with_suffix(".pending")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_state(path: Path):
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise PermissionError("Receiver identity must be readable only by this user")
    value = json.loads(path.read_text())
    if value.get("version") != 1 or any(not isinstance(value.get(k), str) for k in ("bindingId", "deviceId", "secret", "relay")):
        raise ValueError("Invalid saved receiver identity")
    return value


class Relay:
    def __init__(self, session, base):
        parsed = urlparse(base)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")):
            raise ValueError("Relay URL must use HTTPS")
        self.http = session
        self.base = base.rstrip("/") + "/api/bridge/v1"

    async def request(self, path, body):
        async with self.http.post(self.base + path, json=body, timeout=aiohttp.ClientTimeout(total=10)) as response:
            raw = await response.content.read(8193)
            if len(raw) > 8192:
                raise ValueError("Relay response exceeds its budget")
            value = json.loads(raw)
            if response.status >= 400:
                raise RelayError(response.status, value.get("error", "Pairing failed"))
            return value


async def invitation(relay, args, path):
    for _ in range(5):
        identity = {"version": 1, "bindingId": secrets.token_urlsafe(32), "deviceId": secrets.token_urlsafe(32),
                    "secret": secrets.token_urlsafe(32), "invitationSecret": secrets.token_urlsafe(32),
                    "code": "".join(secrets.choice("ABCDEFGHJKMNPQRSTUVWXYZ") for _ in range(9)),
                    "label": args.name, "appOrigin": args.app_origin.rstrip("/"), "relay": args.relay,
                    "invitation_expires": time.time() + 300}
        # Save before creation so a lost HTTP response cannot discard a claimed identity.
        save_state(path, identity)
        try:
            session = await relay.request("/bindings", identity)
            identity["epoch"] = session["epoch"]
            save_state(path, identity)
            return identity
        except RelayError as error:
            if error.status != 409:
                raise
    raise RuntimeError("Cannot allocate a receiver code")


def show_invitation(identity, qr_path=None):
    if identity.get("invitation_expires", 0) <= time.time():
        return
    link = f"{identity['appOrigin']}/bridge/?code={identity['code']}"
    print(f"Pairing code: {identity['code']}", flush=True)
    print(f"Open {link}", flush=True)
    if qr_path:
        import qrcode
        from qrcode.image.svg import SvgPathImage
        target = Path(qr_path).expanduser().resolve()
        qrcode.make(link, image_factory=SvgPathImage, box_size=10, border=4).save(str(target))
        print(f"Pairing QR: {target}", flush=True)


async def run(args):
    from .media import MediaPeer

    directory = runtime_dir()
    lock = open(directory / "worker.lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise RuntimeError("A CERES receiver is already running for this user") from error
    path = state_path()
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, stopped.set)
    state = LatestState()
    broker = Broker(state)
    ipc_path = Path(args.socket) if args.socket else directory / "receiver.sock"
    if ipc_path.exists():
        if not ipc_path.is_socket() or ipc_path.stat().st_uid != os.getuid():
            raise PermissionError("Receiver socket path belongs to another resource")
        ipc_path.unlink()
    server = await asyncio.start_unix_server(broker.handle, path=str(ipc_path), limit=1024)
    os.chmod(ipc_path, 0o600)
    try:
        async with aiohttp.ClientSession() as http:
            identity = read_state(path)
            relay = Relay(http, identity["relay"] if identity else args.relay)
            if args.forget:
                if identity:
                    identity["revoked"] = True
                    save_state(path, identity)
                    try:
                        await relay.request(f"/bindings/{identity['bindingId']}/revoke", {**identity, "role": "receiver"})
                    except RelayError as error:
                        if error.status not in (403, 404, 410):
                            raise
                    path.unlink()
                print("Receiver pairing forgotten", flush=True)
                return
            if identity and identity.get("revoked"):
                try:
                    await relay.request(f"/bindings/{identity['bindingId']}/revoke", {**identity, "role": "receiver"})
                except RelayError as error:
                    if error.status not in (403, 404, 410):
                        raise
                path.unlink()
                identity = None
            if identity:
                try:
                    session = await relay.request(f"/bindings/{identity['bindingId']}/session", {**identity, "role": "receiver"})
                except RelayError as error:
                    if error.status not in (403, 404, 410):
                        raise
                    identity = None
                else:
                    if not session["paired"] and identity.get("invitation_expires", 0) <= time.time():
                        await relay.request(f"/bindings/{identity['bindingId']}/revoke", {**identity, "role": "receiver"})
                        identity = None
            if not identity:
                identity = await invitation(relay, args, path)
            print(f"Receiver: {identity['label']}", flush=True)
            show_invitation(identity, args.qr_code)
            print(f"Python socket: {ipc_path}", flush=True)
            restart_after = identity.get("epoch")
            while not stopped.is_set():
                peer = None
                try:
                    session = await relay.request(f"/bindings/{identity['bindingId']}/session", {
                        **identity, "role": "receiver", **({"restartAfter": restart_after} if restart_after is not None else {})})
                    identity["epoch"] = session["epoch"]
                    if not session["paired"] and identity.get("invitation_expires", 0) <= time.time():
                        await relay.request(f"/bindings/{identity['bindingId']}/revoke", {**identity, "role": "receiver"})
                        identity = await invitation(relay, args, path)
                        show_invitation(identity, args.qr_code)
                        restart_after = None
                        continue
                    if session["paired"]:
                        identity.pop("code", None)
                        identity.pop("invitationSecret", None)
                        identity.pop("invitation_expires", None)
                    save_state(path, identity)
                    epoch = session["epoch"]
                    state.reset(epoch)
                    outgoing = asyncio.Queue(maxsize=64)

                    def send_signal(value):
                        try:
                            outgoing.put_nowait(value)
                        except asyncio.QueueFull:
                            peer.error = "Bridge signalling queue is full"
                            peer.changed.set()

                    peer = MediaPeer(state, broker, send_signal, jitter_ms=args.jitter_ms, bind_address=args.bind_address)
                    ws_url = relay.base.replace("https://", "wss://").replace("http://", "ws://") + f"/bindings/{identity['bindingId']}/signal"
                    async with http.ws_connect(ws_url, max_msg_size=32768, heartbeat=None) as ws:
                        await ws.send_json({**{k: identity[k] for k in ("deviceId", "secret")},
                                            "type": "register", "version": 1, "epoch": epoch, "role": "receiver"})

                        async def transmit():
                            while True:
                                await ws.send_json({"type": "signal", "epoch": epoch, "signal": await outgoing.get()})

                        async def receive():
                            async for message in ws:
                                if message.type != aiohttp.WSMsgType.TEXT:
                                    break
                                value = json.loads(message.data)
                                if value.get("epoch") == epoch and value.get("type") == "signal":
                                    await peer.signal(value["signal"])
                            if not peer.setup_complete and not stopped.is_set():
                                raise RuntimeError("Pairing connection closed before setup completed")

                        tasks = [asyncio.create_task(transmit()), asyncio.create_task(receive())]
                        started = time.monotonic()
                        disconnected = None
                        last_ping = 0.0
                        try:
                            while not stopped.is_set():
                                now = time.monotonic()
                                for task in tasks:
                                    if task.done() and not task.cancelled() and task.exception():
                                        raise task.exception()
                                if peer.error:
                                    raise RuntimeError(peer.error)
                                if now - last_ping >= 0.25:
                                    peer.ping()
                                    last_ping = now
                                if peer.setup_complete:
                                    if not ws.closed and outgoing.empty():
                                        await ws.close(code=1000, message=b"Direct stream established")
                                        print(f"Streaming, connection epoch {epoch}", flush=True)
                                    disconnected = None
                                elif ws.closed or now - started > 30:
                                    disconnected = disconnected or now
                                    if now - disconnected >= 3:
                                        break
                                peer.changed.clear()
                                try:
                                    await asyncio.wait_for(peer.changed.wait(), 0.1)
                                except TimeoutError:
                                    pass
                        finally:
                            for task in tasks:
                                task.cancel()
                            await asyncio.gather(*tasks, return_exceptions=True)
                    restart_after = epoch
                except RelayError as error:
                    if error.status in (403, 404, 410):
                        raise RuntimeError("Receiver pairing was revoked. Run ceres-bridge listen --forget before pairing again") from error
                    print(f"Pairing retry: {error}", flush=True)
                except (OSError, RuntimeError, ValueError, asyncio.TimeoutError, aiohttp.ClientError) as error:
                    print(f"Connection retry: {error}", flush=True)
                    restart_after = state.epoch or restart_after
                finally:
                    if peer:
                        peer.close()
                    with state.lock:
                        state.poses.clear()
                        state.connection = "waiting"
                if not stopped.is_set():
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(stopped.wait(), 3)
    finally:
        server.close()
        await server.wait_closed()
        ipc_path.unlink(missing_ok=True)
        lock.close()
