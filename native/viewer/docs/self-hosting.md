# Self-hosted TLS

Both the Python receiver and native viewer connect to a self-hosted CERES server
over HTTPS. A self-signed deployment uses the same certificate for the web
application, pairing API and secure WebSocket signalling.

## Create the certificate

Run the following on the server with OpenSSL 1.1.1 or newer. Replace
`192.168.90.194` and `ceres.local` with the address and hostname used by your
headset and receivers. The URL's host must appear in the subject alternative
names, with an IP address recorded as `IP` and a hostname as `DNS`.

```sh
mkdir -p certs
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout certs/ceres.key -out certs/ceres.crt \
  -subj "/CN=ceres.local" \
  -addext "subjectAltName=DNS:ceres.local,IP:192.168.90.194" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 certs/ceres.key
```

The `.crt` file contains a PEM certificate. Copy it to each receiver and install
it in the trust settings used by the headset browser. Keep the `.key` file on
the server. If your organisation issues certificates through a private CA, use
its server certificate and key on the server and its CA bundle on the clients.
See the [OpenSSL certificate command reference](https://docs.openssl.org/3.0/man1/openssl-req/).

## Start CERES

From a built source checkout or extracted runtime archive:

```sh
export CERES_PUBLIC_ORIGIN=https://192.168.90.194:4317
export CERT_FILE="$PWD/certs/ceres.crt"
export KEY_FILE="$PWD/certs/ceres.key"
export CERES_DATA_DIR="$PWD/data"
export PORT=4317
node dist-server/ceres-server.cjs
```

Open `https://192.168.90.194:4317/bridge/` in the Quest browser after trusting the
certificate there. Desktop receiver trust and headset browser trust are separate.
Use the same origin in the receiver so its pairing link opens this deployment.

## Connect the Python receiver

```sh
export SSL_CERT_FILE=/absolute/path/to/ceres.crt
ceres-bridge listen --app-origin https://192.168.90.194:4317
```

The receiver uses Python's default TLS trust configuration, including
`SSL_CERT_FILE`. See [Python's certificate paths](https://docs.python.org/3/library/ssl.html#ssl.get_default_verify_paths).

## Connect the native viewer

Use a certificate for this invocation:

```sh
ceres-viewer --origin https://192.168.90.194:4317 --ca-cert /absolute/path/to/ceres.crt
```

Or use the same environment variable as the Python receiver:

```sh
export SSL_CERT_FILE=/absolute/path/to/ceres.crt
ceres-viewer --origin https://192.168.90.194:4317
```

On Windows PowerShell:

```powershell
$env:SSL_CERT_FILE = 'D:\certs\ceres.crt'
.\ceres-viewer.exe --origin https://192.168.90.194:4317
```

The viewer selects `--ca-cert` first, then a non-empty `SSL_CERT_FILE`, then
system trust. The explicit bundle replaces the default roots for Bridge HTTPS
and WebSocket connections. It can contain several PEM certificates. Missing,
unreadable or malformed files produce a certificate error. The viewer checks
both the certificate chain and the URL hostname.

## Use system trust on Linux

To make the certificate available to all applications on Ubuntu or Debian:

```sh
sudo install -m 0644 certs/ceres.crt /usr/local/share/ca-certificates/ceres.crt
sudo update-ca-certificates
unset SSL_CERT_FILE
ceres-viewer --origin https://192.168.90.194:4317
```

On Fedora or RHEL, place it under `/etc/pki/ca-trust/source/anchors/` and run
`sudo update-ca-trust`. Restart receivers after updating system trust. The native
viewer uses the distribution's certificate bundle when no override is selected.
See [Ubuntu's certificate installation guide](https://ubuntu.com/server/docs/how-to/security/install-a-root-ca-certificate-in-the-trust-store/).

## Connection errors

For a certificate verification error, check that the selected bundle contains
the deployment's self-signed certificate or issuing CA and that the certificate
is within its validity dates. For a hostname error, regenerate the certificate
with the actual host or IP address in `subjectAltName`. A certificate trusted by
the receiver must also be trusted separately by the headset browser.
