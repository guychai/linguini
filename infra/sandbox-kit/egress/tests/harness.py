"""Test harness for the egress proxy. Subcommands:

  serve --dir D --listen IP:PORT --dns IP:PORT [--source IP=KEY ...] [--private CIDR ...]
      Creates a test CA and upstream certificate, starts an HTTPS upstream (echo, redirect,
      websocket) and a raw TCP upstream on 127.0.0.1, writes node config, secret, per-sandbox
      policies (as the backend would), and runs the real proxy (run-proxy.sh). Writes
      D/state.json when ready and serves until killed.
  dns-query SERVER PORT NAME [QTYPE] prints the rcode and A answers (QTYPE 28 = AAAA)
  tcp-probe PROXY_HOST PROXY_PORT HOST PORT   CONNECT, send a non-HTTP line, print what came back
  policy --dir D --key KEY [--tainted]        rewrite one sandbox policy (trusted-host side)

The upstream never echoes the injected credential: /echo reports a SHA-256 of the
Authorization header, so tests can prove injection without the token reaching the client.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
import secrets
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
NAMES = ["api.test", "cdn.test", "denied.test", "metadata.test", "rebind.test", "denied-for-secret.test", "tp.test"]


def make_certs(d: str):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "egress-test upstream CA")])
    ca = (
        x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "api.test")]))
        .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in NAMES]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    pem = serialization.Encoding.PEM
    with open(f"{d}/upstream-ca.pem", "wb") as f:
        f.write(ca.public_bytes(pem))
    with open(f"{d}/upstream.pem", "wb") as f:
        f.write(cert.public_bytes(pem))
        f.write(key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/echo":
            auth = self.headers.get("authorization")
            return self._json(200, {
                "host": self.headers.get("host"),
                "auth_sha256": hashlib.sha256(auth.encode()).hexdigest() if auth else None,
                "sni": getattr(self.connection, "server_hostname", None),
            })
        if path == "/redirect":
            target = dict(p.split("=", 1) for p in query.split("&") if "=" in p).get("to", "/")
            self.send_response(302)
            self.send_header("location", target)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if path == "/ws" and self.headers.get("upgrade", "").lower() == "websocket":
            accept = base64.b64encode(hashlib.sha1(
                (self.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("upgrade", "websocket")
            self.send_header("connection", "Upgrade")
            self.send_header("sec-websocket-accept", accept)
            self.end_headers()
            payload = b"hello-ws"
            self.wfile.write(bytes([0x81, len(payload)]) + payload + bytes([0x88, 0]))
            self.wfile.flush()
            time.sleep(0.2)
            self.close_connection = True
            return
        self._json(404, {"error": "not found"})


def serve_https(port_holder, cert):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert)
    httpd.socket = tls.wrap_socket(httpd.socket, server_side=True)
    port_holder.append(httpd.server_address[1])
    httpd.serve_forever()


def serve_tcp(port_holder):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    s.listen()
    port_holder.append(s.getsockname()[1])
    while True:
        c, _ = s.accept()
        try:
            c.recv(100)
            c.sendall(b"RAW-TCP-BANNER\n")
        finally:
            c.close()


def write_policy(d, key, tainted, https_port, tcp_port, only=None):
    rules = [
        {"host": "api.test", "ports": [https_port, tcp_port], "inject": "testsvc", "websocket": True},
        {"host": "cdn.test", "ports": [https_port], "allowWhenTainted": True, "methods": ["GET", "HEAD"]},
        # A second rule for the same host: POST only on git fetch paths.
        {"host": "cdn.test", "ports": [https_port], "methods": ["POST"],
         "paths": ["/*/*/git-upload-pack", "/*/*.git/git-upload-pack"]},
        # Allowlisted, but resolves to the metadata address: must still be blocked.
        {"host": "metadata.test", "ports": [https_port, 80], "schemes": ["https", "http"]},
        # Allowlisted, but resolves to a private address the node does not allow.
        {"host": "rebind.test", "ports": [https_port]},
        # The policy asks for the secret on a host the secret's owner did not list.
        {"host": "denied-for-secret.test", "ports": [https_port], "inject": "testsvc"},
        # Transparent mode (netns-test): reached on 443 with no proxy settings in the guest.
        {"host": "tp.test", "ports": [443, 80], "schemes": ["https"], "methods": ["GET", "HEAD"], "websocket": True,
         "inject": "testsvc"},
    ]
    if only:
        rules = [r for r in rules if r["host"] in only]
    policy = {"version": 1, "conversationKey": key, "workspaceId": f"ws-{key}", "tainted": tainted, "rules": rules}
    tmp = f"{d}/policies/{key}.json.tmp"
    with open(tmp, "w") as f:
        json.dump(policy, f)
    os.replace(tmp, f"{d}/policies/{key}.json")


def cmd_serve(a):
    d = os.path.abspath(a.dir)
    for sub in ("policies", "sources", "secrets", "ca"):
        os.makedirs(f"{d}/{sub}", exist_ok=True)
    make_certs(d)
    hp, tp = [], []
    threading.Thread(target=serve_https, args=(hp, f"{d}/upstream.pem"), daemon=True).start()
    threading.Thread(target=serve_tcp, args=(tp,), daemon=True).start()
    while not hp or not tp:
        time.sleep(0.05)
    token = "tok-" + secrets.token_hex(16)
    fd = os.open(f"{d}/secrets/testsvc.token", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, token.encode())
    os.close(fd)
    with open(f"{d}/secrets.json", "w") as f:
        json.dump({"testsvc": {"header": "Authorization", "format": "Bearer {}",
                               "value_file": f"{d}/secrets/testsvc.token", "hosts": ["api.test", "tp.test"]}}, f)
    config = {
        "policy_dir": f"{d}/policies", "sources_dir": f"{d}/sources", "secrets_file": f"{d}/secrets.json",
        "audit_log": f"{d}/audit.jsonl",
        # Only the test upstream's loopback address; 10.x (rebind.test) stays blocked.
        "allow_private_upstreams": a.private or ["127.0.0.1/32"],
        "static_hosts": {"api.test": "127.0.0.1", "cdn.test": "127.0.0.1", "denied.test": "127.0.0.1",
                         "metadata.test": "169.254.169.254", "rebind.test": "10.255.255.1",
                         "denied-for-secret.test": "127.0.0.1",
                         # netns-test maps this TEST-NET address to the local upstream on the node
                         "tp.test": "198.51.100.7"},
    }
    with open(f"{d}/config.json", "w") as f:
        json.dump(config, f)
    for src in a.source or []:
        ip, key = src.split("=", 1)
        with open(f"{d}/sources/{ip}", "w") as f:
            f.write(key)
        write_policy(d, key, False, hp[0], tp[0])
    env = dict(os.environ, EGRESS_VENV=a.venv, EGRESS_CONFIG=f"{d}/config.json", EGRESS_EXPLICIT=a.listen,
               EGRESS_DNS=a.dns, EGRESS_TRANSPARENT=a.transparent or f"{a.listen.rsplit(':', 1)[0]}:0",
               EGRESS_CONFDIR=f"{d}/ca", EGRESS_UPSTREAM_CA=f"{d}/upstream-ca.pem")
    proxy = subprocess.Popen([f"{KIT}/run-proxy.sh"], env=env)
    host, port = a.listen.rsplit(":", 1)
    for _ in range(200):
        if proxy.poll() is not None:
            sys.exit(f"proxy exited with {proxy.returncode}")
        try:
            socket.create_connection((host, int(port)), timeout=0.2).close()
            time.sleep(0.5)  # a script error makes mitmproxy exit right after binding
            if proxy.poll() is None and os.path.exists(f"{d}/ca/mitmproxy-ca-cert.pem"):
                break
        except OSError:
            pass
        time.sleep(0.1)
    else:
        proxy.kill()
        sys.exit("proxy did not start")
    state = {"https_port": hp[0], "tcp_port": tp[0], "proxy": a.listen, "dns": a.dns, "pid": proxy.pid,
             "mitm_ca": f"{d}/ca/mitmproxy-ca-cert.pem", "token_sha256": hashlib.sha256(f"Bearer {token}".encode()).hexdigest(),
             "token_file": f"{d}/secrets/testsvc.token", "audit": f"{d}/audit.jsonl"}
    with open(f"{d}/state.json", "w") as f:
        json.dump(state, f)
    def stop(*_):  # SIGTERM (kill) and SIGINT both take the proxy down with us; it must not outlive us
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        proxy.wait()
    except KeyboardInterrupt:
        proxy.terminate()
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()


def cmd_policy(a):
    st = json.load(open(f"{a.dir}/state.json"))
    write_policy(a.dir, a.key, a.tainted, st["https_port"], st["tcp_port"], a.only)


def cmd_dns(a):
    qid = secrets.randbelow(65535)
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    q += b"".join(bytes([len(p)]) + p.encode() for p in a.name.split(".")) + b"\0" + struct.pack(">HH", int(a.qtype), 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.sendto(q, (a.server, int(a.port)))
        data, _ = s.recvfrom(4096)
    except OSError as e:
        print(f"error {type(e).__name__}")
        return
    rcode = data[3] & 0x0F
    ancount = struct.unpack(">H", data[6:8])[0]
    ips = []
    def skip_name(off):
        while True:
            n = data[off]
            if n == 0:
                return off + 1
            if n & 0xC0 == 0xC0:
                return off + 2
            off += n + 1

    if ancount:
        off = skip_name(12) + 4  # past the question
        for _ in range(ancount):
            off = skip_name(off)
            rtype, _, _, rdlen = struct.unpack(">HHIH", data[off:off + 10])
            off += 10
            if rtype == 1:
                ips.append(socket.inet_ntoa(data[off:off + rdlen]))
            off += rdlen
    print(f"rcode={rcode} answers={','.join(ips) or '-'}")


def cmd_tcp(a):
    s = socket.create_connection((a.proxy_host, int(a.proxy_port)), timeout=5)
    s.sendall(f"CONNECT {a.host}:{a.port} HTTP/1.1\r\nHost: {a.host}:{a.port}\r\n\r\n".encode())
    head = s.recv(4096).decode(errors="replace").splitlines()[0]
    s.sendall(b"SSH-2.0-egress-test\r\n")
    try:
        rest = s.recv(4096)
    except OSError as e:
        rest = f"<{type(e).__name__}>".encode()
    print(f"connect={head!r} after={rest.decode(errors='replace').strip() or '<closed>'}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--dir", required=True)
    s.add_argument("--listen", default="127.0.0.1:0", help="explicit (CONNECT) test listener; never on a node")
    s.add_argument("--dns", default="127.0.0.1:0")
    s.add_argument("--transparent", help="transparent listener (default: listen host, any port)")
    s.add_argument("--source", action="append")
    s.add_argument("--private", action="append")
    s.add_argument("--venv", default=os.environ.get("EGRESS_VENV", "/opt/sandbox-egress/venv"))
    s = sub.add_parser("policy")
    s.add_argument("--dir", required=True)
    s.add_argument("--key", required=True)
    s.add_argument("--tainted", action="store_true")
    s.add_argument("--only", action="append", help="keep only rules for these hosts")
    s = sub.add_parser("dns-query")
    s.add_argument("server"); s.add_argument("port"); s.add_argument("name")
    s.add_argument("qtype", nargs="?", default="1", help="1 = A (default), 28 = AAAA")
    s = sub.add_parser("tcp-probe")
    s.add_argument("proxy_host"); s.add_argument("proxy_port"); s.add_argument("host"); s.add_argument("port")
    a = p.parse_args()
    {"serve": cmd_serve, "policy": cmd_policy, "dns-query": cmd_dns, "tcp-probe": cmd_tcp}[a.cmd](a)


if __name__ == "__main__":
    main()
