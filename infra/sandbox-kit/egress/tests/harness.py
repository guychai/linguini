"""Test harness for the egress proxy. Subcommands:

  serve --dir D --listen IP:PORT --dns IP:PORT [--source IP=KEY ...] [--private CIDR ...]
      Creates a test CA and upstream certificate, starts an HTTPS upstream (echo, redirect,
      websocket) and a raw TCP upstream on 127.0.0.1, writes node config, secret, per-sandbox
      policies (as the backend would), and runs the real proxy (run-proxy.sh). Writes
      D/state.json when ready and serves until killed.
  dns-query SERVER PORT NAME [QTYPE] prints the rcode and A answers (QTYPE 28 = AAAA)
  tcp-probe PROXY_HOST PROXY_PORT HOST PORT   CONNECT, send a non-HTTP line, print what came back
  policy --dir D --key KEY [--tainted] [--no-github-app]   rewrite one sandbox policy (trusted-host side)

GitHub (github-test.sh): github.com, api.github.com and raw.githubusercontent.com resolve to the
same upstream, which plays GitHub: git smart HTTP via `git http-backend` over bare repos in
D/git (octo/open and octo/public anonymous; octo/private and octo/hidden need a token minted for
that very repo; the App is installed on octo/public and octo/private only), a few REST paths, and the App API on https://localhost:<port> (JWT checked against the
test App key, tokens minted per repository). /_stats (localhost) reports mints, never tokens.

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
NAMES = ["api.test", "cdn.test", "denied.test", "metadata.test", "rebind.test", "denied-for-secret.test", "tp.test",
         "github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "localhost"]
GITHUB_NAMES = ["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com"]
# The mock App: installation 7 on owner "octo" includes only these repositories.
GH_INSTALLED = {"public", "private"}
GH_PRIVATE = {"private", "hidden"}


class MockGitHub:
    """State of the fake GitHub (shared by the upstream handler threads)."""

    def __init__(self, d: str):
        self.dir = d
        self.lock = threading.Lock()
        self.tokens: dict[str, str] = {}  # token -> "octo/<repo>"
        self.mints: list[str] = []  # repo names minted for, in order
        self.bad_jwt = 0
        self.public_key = None

    def check_jwt(self, auth: str | None) -> bool:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        try:
            assert auth and auth.startswith("Bearer ")
            h, p, sig = auth[7:].split(".")
            pad = lambda x: x + "=" * (-len(x) % 4)  # noqa: E731
            self.public_key.verify(base64.urlsafe_b64decode(pad(sig)), f"{h}.{p}".encode(),
                                   padding.PKCS1v15(), hashes.SHA256())
            claims = json.loads(base64.urlsafe_b64decode(pad(p)))
            return claims["iss"] == "4242" and claims["exp"] > time.time()
        except Exception:
            with self.lock:
                self.bad_jwt += 1
            return False

    def token_repo(self, auth: str | None) -> str | None:
        """The repository a request's token was minted for (Basic, Bearer or token forms)."""
        if not auth:
            return None
        kind, _, value = auth.partition(" ")
        tok = value
        if kind.lower() == "basic":
            try:
                tok = base64.b64decode(value).decode().split(":", 1)[1]
            except Exception:
                return None
        return self.tokens.get(tok)

    def auth_class(self, auth: str | None) -> str:
        if not auth:
            return "none"
        repo = self.token_repo(auth)
        return f"app:{repo}" if repo else "invalid"


GH: MockGitHub | None = None


def make_repos(d: str):
    """Bare repos for the mock github.com, each with one commit and a README naming it."""
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@test", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@test", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null")
    for name in ("open", "public", "private", "hidden"):
        work = f"{d}/git-work/{name}"
        os.makedirs(work, exist_ok=True)
        subprocess.run(["git", "init", "-q", "-b", "main", work], check=True, env=env)
        with open(f"{work}/README.md", "w") as f:
            f.write(f"repo octo/{name}\n")
        subprocess.run(["git", "-C", work, "add", "README.md"], check=True, env=env)
        subprocess.run(["git", "-C", work, "commit", "-q", "-m", "init"], check=True, env=env)
        bare = f"{d}/git/octo/{name}.git"
        subprocess.run(["git", "clone", "-q", "--bare", work, bare], check=True, env=env)
        # Pushes would be accepted by the mock (so a 403 can only come from the proxy).
        subprocess.run(["git", "-C", bare, "config", "http.receivepack", "true"], check=True, env=env)


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

    def _body(self) -> bytes:
        if "chunked" in self.headers.get("transfer-encoding", "").lower():
            out = b""
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _host(self) -> str:
        return (self.headers.get("host") or "").rsplit(":", 1)[0].lower()

    def _github(self, method: str) -> bool:
        """The fake GitHub; True when it answered."""
        host, (path, _, query) = self._host(), self.path.partition("?")
        auth = self.headers.get("authorization")
        if host == "localhost":  # the App API (called by the proxy itself, never by a sandbox)
            body = self._body() if method == "POST" else b""
            parts = path.strip("/").split("/")
            if path == "/_stats":
                return self._json(200, {"mints": GH.mints, "bad_jwt": GH.bad_jwt}) or True
            if not GH.check_jwt(auth):
                return self._json(401, {"message": "bad JWT"}) or True
            if method == "GET" and len(parts) == 4 and parts[0] == "repos" and parts[3] == "installation":
                if parts[1] == "octo" and parts[2] in GH_INSTALLED:
                    return self._json(200, {"id": 7}) or True
                return self._json(404, {"message": "Not Found"}) or True
            if method == "POST" and parts[:3] == ["app", "installations", "7"] and parts[3:] == ["access_tokens"]:
                req = json.loads(body)
                repos = req.get("repositories") or []
                if len(repos) != 1 or repos[0] not in GH_INSTALLED or req.get("permissions") != {"contents": "read", "metadata": "read"}:
                    return self._json(422, {"message": "bad scope"}) or True
                tok = "ghs_" + secrets.token_hex(16)
                with GH.lock:
                    GH.tokens[tok] = f"octo/{repos[0]}"
                    GH.mints.append(repos[0])
                exp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
                return self._json(201, {"token": tok, "expires_at": exp, "repositories": [{"name": repos[0]}]}) or True
            return self._json(404, {}) or True
        if host == "github.com":
            segs = path.strip("/").split("/")
            if len(segs) < 3 or segs[0] != "octo":
                return False
            name = segs[1][:-4] if segs[1].endswith(".git") else segs[1]
            if not os.path.isdir(f"{GH.dir}/git/octo/{name}.git"):
                return False
            if name in GH_PRIVATE and GH.token_repo(auth) != f"octo/{name}":
                self.send_response(401)  # what GitHub answers an anonymous/unauthorized git client
                self.send_header("www-authenticate", 'Basic realm="GitHub"')
                self.send_header("content-length", "0")
                self.end_headers()
                return True
            self._git_backend(method, f"/octo/{name}.git/" + "/".join(segs[2:]), query)
            return True
        if host == "api.github.com":
            segs = path.strip("/").split("/")
            if len(segs) >= 4 and segs[0] == "repos" and segs[1] == "octo":
                cls = GH.auth_class(auth)
                if segs[3] in ("auth-echo", "tarball"):
                    return self._json(200, {"auth": cls}) or True
                if segs[3] == "contents" and cls == f"app:octo/{segs[2]}":
                    return self._json(200, {"name": segs[-1], "download_url":
                        f"https://raw.githubusercontent.com/octo/{segs[2]}/main/{segs[-1]}?token=GHSAT0SECRETDOWNLOAD"}) or True
                return self._json(404, {"message": "Not Found"}) or True
            return False
        if host == "raw.githubusercontent.com":
            segs = path.strip("/").split("/")
            if len(segs) >= 4 and segs[0] == "octo":
                if segs[1] in GH_PRIVATE and GH.token_repo(auth) != f"octo/{segs[1]}":
                    return self._json(404, {"auth": GH.auth_class(auth)}) or True
                body = f"raw octo/{segs[1]} auth={GH.auth_class(auth)}\n".encode()
                self.send_response(200)
                self.send_header("content-type", "text/plain")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return True
        return False

    def _git_backend(self, method: str, path_info: str, query: str):
        body = self._body() if method == "POST" else b""
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GIT_PROJECT_ROOT": f"{GH.dir}/git",
               "GIT_HTTP_EXPORT_ALL": "1", "PATH_INFO": path_info, "QUERY_STRING": query,
               "REQUEST_METHOD": method, "CONTENT_TYPE": self.headers.get("content-type", ""),
               "CONTENT_LENGTH": str(len(body)), "REMOTE_USER": "egress-test", "REMOTE_ADDR": "127.0.0.1",
               "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
        for h in ("content-encoding", "git-protocol"):
            if self.headers.get(h):
                env["HTTP_" + h.upper().replace("-", "_")] = self.headers[h]
        out = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True).stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        status, headers = 200, []
        for line in head.decode(errors="replace").split("\r\n"):
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            elif k:
                headers.append((k, v.strip()))
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if GH and self._github("POST"):
            return
        self._body()
        self._json(501, {"error": "not implemented"})

    def do_GET(self):
        if GH and self._github("GET"):
            return
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


def write_policy(d, key, tainted, https_port, tcp_port, only=None, github_app=True):
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
        # GitHub as in infra/hosting/egress-default-rules.json (on the test upstream's port).
        {"host": "github.com", "ports": [https_port], "methods": ["GET", "HEAD"]},
        {"host": "github.com", "ports": [https_port], "methods": ["POST"],
         "paths": ["/*/*/git-upload-pack", "/*/*.git/git-upload-pack"]},
        {"host": "api.github.com", "ports": [https_port], "methods": ["GET", "HEAD"]},
        {"host": "raw.githubusercontent.com", "ports": [https_port], "methods": ["GET", "HEAD"]},
    ]
    if only:
        rules = [r for r in rules if r["host"] in only]
    policy = {"version": 1, "conversationKey": key, "workspaceId": f"ws-{key}", "tainted": tainted, "rules": rules}
    if github_app:
        policy["github"] = {"app": True}
    tmp = f"{d}/policies/{key}.json.tmp"
    with open(tmp, "w") as f:
        json.dump(policy, f)
    os.replace(tmp, f"{d}/policies/{key}.json")


def cmd_serve(a):
    d = os.path.abspath(a.dir)
    for sub in ("policies", "sources", "secrets", "ca"):
        os.makedirs(f"{d}/{sub}", exist_ok=True)
    make_certs(d)
    global GH
    GH = MockGitHub(d)
    make_repos(d)
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    GH.public_key = app_key.public_key()
    fd = os.open(f"{d}/secrets/github-app.pem", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, app_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    os.close(fd)
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
                         "tp.test": "198.51.100.7", **{n: "127.0.0.1" for n in GITHUB_NAMES}},
        "github_app": {"app_id": 4242, "private_key_file": f"{d}/secrets/github-app.pem",
                       "api_url": f"https://localhost:{hp[0]}", "ca_file": f"{d}/upstream-ca.pem",
                       "conversation_budget": {"calls": 20, "window_s": 600}},
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
             "token_file": f"{d}/secrets/testsvc.token", "audit": f"{d}/audit.jsonl",
             "upstream_ca": f"{d}/upstream-ca.pem"}
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
    write_policy(a.dir, a.key, a.tainted, st["https_port"], st["tcp_port"], a.only, not a.no_github_app)


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
    s.add_argument("--no-github-app", action="store_true", help="policy without github.app (owner not enabled)")
    s = sub.add_parser("dns-query")
    s.add_argument("server"); s.add_argument("port"); s.add_argument("name")
    s.add_argument("qtype", nargs="?", default="1", help="1 = A (default), 28 = AAAA")
    s = sub.add_parser("tcp-probe")
    s.add_argument("proxy_host"); s.add_argument("proxy_port"); s.add_argument("host"); s.add_argument("port")
    a = p.parse_args()
    {"serve": cmd_serve, "policy": cmd_policy, "dns-query": cmd_dns, "tcp-probe": cmd_tcp}[a.cmd](a)


if __name__ == "__main__":
    main()
