"""Exercise the native Bridge HTTPS and WSS clients against local TLS servers."""

import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import ssl
import struct
import subprocess
import tempfile
import threading


def certificate(openssl, directory, name, hosts):
    cert, key = directory / f"{name}.crt", directory / f"{name}.key"
    config = directory / "openssl.cnf"
    config.write_text("[req]\ndistinguished_name = dn\n[dn]\n", encoding="ascii")
    subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
         "-config", str(config),
         "-days", "2", "-keyout", str(key), "-out", str(cert),
         "-subj", f"/CN={name}", "-addext", f"subjectAltName={hosts}",
         "-addext", "basicConstraints=critical,CA:TRUE",
         "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
         "-addext", "extendedKeyUsage=serverAuth"],
        check=True, capture_output=True,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return cert, context


class Relay(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, context, websocket_context, marker):
        self.context = context
        self.websocket_context = websocket_context
        self.marker = marker
        self.posts = 0
        self.failure = None
        super().__init__(("127.0.0.1", 0), Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        try:
            return self.context.wrap_socket(connection, server_side=True), address
        except Exception:
            connection.close()
            raise


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ssl.SSLEOFError):
            # Negative trust cases close the TLS socket before sending HTTP.
            pass

    def log_message(self, *_args):
        pass

    def do_POST(self):
        json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.posts += 1
        payload = b'{"epoch":1,"paired":false}'
        if self.path.endswith("/session"):
            self.server.context = self.server.websocket_context
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.close_connection = True
        try:
            assert self.path.endswith("/signal")
            assert self.headers["Upgrade"].lower() == "websocket"
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            first, second = self.rfile.read(2)
            assert first == 0x81 and second & 0x80
            length = second & 0x7f
            if length == 126:
                length = struct.unpack("!H", self.rfile.read(2))[0]
            assert length <= 8192
            mask = self.rfile.read(4)
            payload = self.rfile.read(length)
            message = json.loads(bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload)))
            assert message["type"] == "register" and message["role"] == "receiver"
            self.server.marker.write_text("registered", encoding="ascii")
            try:
                self.rfile.read(1)
            except OSError:
                pass
        except Exception as error:
            self.server.failure = repr(error)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", required=True)
    parser.add_argument("--openssl", required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ceres-bridge-tls-") as temporary:
        directory = Path(temporary)
        good, context = certificate(args.openssl, directory, "localhost", "DNS:localhost,IP:127.0.0.1")
        unrelated, unrelated_context = certificate(
            args.openssl, directory, "unrelated", "DNS:localhost,IP:127.0.0.1")
        wrong_host, wrong_host_context = certificate(
            args.openssl, directory, "wrong-host", "DNS:wrong-host.invalid")
        malformed = directory / "malformed.pem"
        malformed.write_text("not a certificate", encoding="ascii")
        combined = directory / "combined.pem"
        combined.write_bytes(good.read_bytes() + wrong_host.read_bytes())

        def run(name, ca="-", environment=None, expected=True, server_context=context,
                websocket_context=None, expected_posts=None, error_text=None):
            case = directory / name
            case.mkdir(mode=0o700)
            marker = case / "registered"
            relay = Relay(server_context, websocket_context or server_context, marker)
            thread = threading.Thread(target=relay.serve_forever, daemon=True)
            thread.start()
            env = os.environ.copy()
            env.pop("SSL_CERT_FILE", None)
            if environment is not None:
                env["SSL_CERT_FILE"] = str(environment)
            try:
                result = subprocess.run(
                    [args.probe, f"https://127.0.0.1:{relay.server_port}", str(ca),
                     str(case / "receiver.identity"), str(marker)],
                    env=env, capture_output=True, text=True, timeout=15,
                )
                assert (result.returncode == 0) == expected, (name, result.stdout, result.stderr)
                assert marker.exists() == expected, (name, relay.failure)
                if expected_posts is not None:
                    assert relay.posts == expected_posts, (name, relay.posts, result.stderr)
                if error_text:
                    assert error_text in result.stderr, (name, result.stderr)
                if expected:
                    assert relay.posts == 2 and relay.failure is None, (name, relay.failure)
                print(f"PASS: {name}")
            finally:
                relay.shutdown()
                relay.server_close()
                thread.join()

        run("explicit-certificate", good)
        run("environment-certificate", environment=good)
        run("explicit-precedence", good, environment=directory / "missing.pem")
        run("missing-explicit", directory / "missing.pem", environment=good, expected=False,
            expected_posts=0, error_text="Cannot read CA certificate file")
        run("missing-environment", environment=directory / "missing.pem", expected=False,
            expected_posts=0, error_text="Cannot read CA certificate file")
        run("malformed-certificate", malformed, expected=False, expected_posts=0,
            error_text="valid PEM certificates")
        run("system-trust-rejects-self-signed", expected=False, expected_posts=0)
        run("empty-environment-uses-system-trust", environment="", expected=False, expected_posts=0)
        run("wrong-https-trust", unrelated, expected=False, expected_posts=0)
        run("wrong-https-hostname", wrong_host, server_context=wrong_host_context,
            expected=False, expected_posts=0)
        run("wrong-websocket-trust", good, websocket_context=unrelated_context,
            expected=False, expected_posts=2)
        run("wrong-websocket-hostname", combined, websocket_context=wrong_host_context,
            expected=False, expected_posts=2)


if __name__ == "__main__":
    main()
