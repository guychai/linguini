"""Sandbox egress policy for mitmproxy (prototype; see ../../DESIGN-egress.md).

Runs on the node, outside every sandbox. Each request is decided from:
  - the sandbox identity: the client source IP, mapped to a conversation key by the node's
    network setup (sources/<ip>), which also pins that IP to the sandbox's own interface;
  - the conversation policy: policies/<key>.json, written by the trusted backend only;
  - node config: secrets (injected by destination), static hosts, private-upstream allowances.

Default deny everywhere: unknown source, no policy, host not allowlisted, raw IP literal,
plain HTTP, websocket without opt-in, non-HTTP payloads, blocked upstream addresses
(metadata and link-local always). The audit log carries decisions and sizes, never
headers, bodies, query strings or secret values.
"""


import asyncio
import ipaddress
import re
import json
import os
import threading
import time
from dataclasses import dataclass, field

from mitmproxy import ctx, dns, http, tcp
from mitmproxy.net.dns import response_codes
from mitmproxy.proxy import server_hooks
from mitmproxy.tls import ClientHelloData

# Never reachable, whatever the node config says: cloud metadata and link-local.
ALWAYS_BLOCKED = [
    ipaddress.ip_network(n)
    for n in (
        "169.254.0.0/16",  # link-local, incl. 169.254.169.254 (AWS/GCP/Azure metadata)
        "100.100.100.200/32",  # Alibaba Cloud metadata
        "fe80::/10",  # IPv6 link-local
        "fd00:ec2::/32",  # AWS IPv6 metadata (fd00:ec2::254)
        "0.0.0.0/8",
        "224.0.0.0/4",
        "ff00::/8",
        "255.255.255.255/32",
    )
]
# How long a DNS answer we gave a sandbox stays a valid transparent destination for that name.
RESOLVED_TTL = 3600.0
# Blocked unless the node config lists them in allow_private_upstreams.
PRIVATE = [
    ipaddress.ip_network(n)
    for n in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "::1/128",
        "fc00::/7",
        "::ffff:0:0/96",
    )
]


def _ip(value: str):
    try:
        ip = ipaddress.ip_address(value.split("%")[0])
    except ValueError:
        return None
    # ::ffff:169.254.169.254 is 169.254.169.254: check mapped addresses as IPv4.
    return (ip.ipv4_mapped or ip) if ip.version == 6 else ip


def _norm_host(host: str) -> str:
    return host.strip().rstrip(".").lower()


def _source(peername) -> str:
    ip = _ip(peername[0]) if peername else None
    if ip is not None and ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return str(ip) if ip else "?"


@dataclass
class Decision:
    allow: bool
    reason: str
    key: str | None = None
    rule: dict | None = None


def _glob_re(pattern: str) -> re.Pattern:
    """Path glob: '*' matches within one segment, '**' across segments; everything else literal."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def _path_allowed(path: str, globs: list) -> bool:
    """Match the request path (query stripped) against a rule's globs. Ambiguous paths (dot
    segments, empty segments, encoded slashes/dots/backslashes) never match a path-restricted rule."""
    p = path.split("?", 1)[0].split("#", 1)[0]
    if not p.startswith("/") or "//" in p or "\\" in p or re.search(r"%(2f|5c|2e)", p, re.I):
        return False
    if any(seg in (".", "..") for seg in p.split("/")):
        return False
    return any(_glob_re(str(g)).match(p) for g in globs)


@dataclass
class Tunnel:
    key: str | None
    host: str
    port: int
    rule: dict | None = None
    allowed: bool = False
    extra: dict = field(default_factory=dict)


class SandboxEgress:
    def __init__(self) -> None:
        self.cfg: dict = {}
        self.secrets: dict = {}
        self._audit_lock = threading.Lock()
        self._tunnels: dict[str, Tunnel] = {}
        # (sandbox source IP, name) -> {address: expiry}: what our DNS told that sandbox. In
        # transparent mode a connection's original destination must be one of these for its SNI
        # (no fronting an allowed name onto an address the sandbox picked itself).
        self._resolved: dict[tuple[str, str], dict[str, float]] = {}

    # ---- configuration ----
    def load(self, loader):
        loader.add_option("egress_config", str, "", "Path to the node egress config (JSON).")

    def configure(self, updated):
        if "egress_config" not in updated or not ctx.options.egress_config:
            return
        with open(ctx.options.egress_config) as f:
            self.cfg = json.load(f)
        for k in ("policy_dir", "sources_dir", "audit_log"):
            if not self.cfg.get(k):
                raise ValueError(f"egress config: {k} is required")
        self.allow_private = [ipaddress.ip_network(n) for n in self.cfg.get("allow_private_upstreams", [])]
        self.static_hosts = {_norm_host(h): ip for h, ip in self.cfg.get("static_hosts", {}).items()}
        self.secrets = {}
        if self.cfg.get("secrets_file"):
            with open(self.cfg["secrets_file"]) as f:
                self.secrets = json.load(f)
        for name, s in self.secrets.items():
            if not s.get("header") or not s.get("value_file") or not s.get("hosts"):
                raise ValueError(f"egress secret {name}: header, value_file and hosts are required")

    # ---- identity and policy ----
    def _key_for(self, source: str) -> str | None:
        if not _ip(source):
            return None
        try:
            with open(os.path.join(self.cfg["sources_dir"], source)) as f:
                key = f.read().strip()
        except OSError:
            return None
        return key if key.isalnum() and key.islower() and 12 <= len(key) <= 40 else None

    def _policy(self, key: str) -> dict | None:
        try:
            with open(os.path.join(self.cfg["policy_dir"], f"{key}.json")) as f:
                policy = json.load(f)
        except (OSError, ValueError):
            return None
        return policy if policy.get("version") == 1 and policy.get("conversationKey") == key else None

    def decide(self, source: str, host: str, port: int, scheme: str,
               method: str | None = None, path: str | None = None) -> Decision:
        """Host-level decision (CONNECT, DNS) when method is None; otherwise the first rule for the
        host whose methods and paths both admit the request. Rules for one host are alternatives."""
        key = self._key_for(source)
        if not key:
            return Decision(False, "unknown-source")
        policy = self._policy(key)
        if not policy:
            return Decision(False, "no-policy", key)
        host = _norm_host(host)
        literal = _ip(host) is not None
        first_miss: Decision | None = None
        for rule in policy.get("rules", []):
            rhost = _norm_host(str(rule.get("host", "")))
            if not rhost:
                continue
            if rhost.startswith("*."):
                match = not literal and host.endswith(rhost[1:]) and host != rhost[2:]
            else:
                match = host == rhost
            if not match:
                continue
            if port not in rule.get("ports", [443]):
                return Decision(False, "port-not-allowed", key, rule)
            if scheme not in rule.get("schemes", ["https"]):
                return Decision(False, "scheme-not-allowed", key, rule)
            if policy.get("tainted") and not rule.get("allowWhenTainted"):
                return Decision(False, "tainted", key, rule)
            if method is not None:
                methods = rule.get("methods")
                if methods and method.upper() not in [m.upper() for m in methods]:
                    first_miss = first_miss or Decision(False, "method-not-allowed", key, rule)
                    continue
                paths = rule.get("paths")
                if paths and not _path_allowed(path or "", paths):
                    # More specific than a method miss on another rule for this host.
                    first_miss = Decision(False, "path-not-allowed", key, rule)
                    continue
            return Decision(True, "rule", key, rule)
        if first_miss:
            return first_miss
        return Decision(False, "raw-ip" if literal else "host-not-allowed", key)

    # ---- audit ----
    def audit(self, **event):
        event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **{k: v for k, v in event.items() if v is not None}}
        line = json.dumps(event, sort_keys=True)
        with self._audit_lock:
            fd = os.open(self.cfg["audit_log"], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
            try:
                os.write(fd, (line + "\n").encode())
            finally:
                os.close(fd)

    @staticmethod
    def _deny(flow: http.HTTPFlow, status: int, reason: str):
        flow.response = http.Response.make(
            status, f"egress denied: {reason}\n".encode(), {"content-type": "text/plain", "x-egress-denied": reason}
        )

    # ---- HTTP CONNECT (explicit proxy) ----
    def http_connect(self, flow: http.HTTPFlow):
        src = _source(flow.client_conn.peername)
        host, port = flow.request.host, flow.request.port
        d = self.decide(src, host, port, "https")
        self._tunnels[flow.client_conn.id] = Tunnel(d.key, _norm_host(host), port, d.rule, d.allow)
        self.audit(event="connect", src=src, sandbox=d.key, host=_norm_host(host), port=port,
                   decision="allow" if d.allow else "deny", reason=d.reason)
        if not d.allow:
            self._deny(flow, 403, d.reason)

    # ---- transparent mode (nftables redirects sandbox TCP 80/443 here; no CONNECT) ----
    @staticmethod
    def _transparent(client) -> bool:
        mode = getattr(client, "proxy_mode", None)
        return getattr(mode, "type_name", "") == "transparent"

    def _remember(self, src: str, name: str, ips: list[str]):
        now = time.monotonic()
        entry = self._resolved.setdefault((src, name), {})
        for ip in ips:
            entry[ip] = now + RESOLVED_TTL
        if len(self._resolved) > 50_000:  # bound memory: drop expired entries
            for k in [k for k, v in self._resolved.items() if max(v.values(), default=0) < now]:
                del self._resolved[k]

    def _was_resolved(self, src: str, name: str, ip: str) -> bool:
        if name in self.static_hosts:
            return _ip(self.static_hosts[name]) == _ip(ip)
        return self._resolved.get((src, name), {}).get(ip, 0) > time.monotonic()

    def _transparent_tunnel(self, data: ClientHelloData) -> Tunnel:
        """Decide a transparent TLS connection from its SNI, like a CONNECT to that name."""
        client = data.context.client
        src = _source(client.peername)
        dst_ip, port = (data.context.server.address or ("", 0))[:2]
        sni = _norm_host(data.client_hello.sni or "")
        if not sni:
            d = Decision(False, "no-sni")
        elif _ip(sni) is not None:
            d = Decision(False, "raw-ip")
        else:
            d = self.decide(src, sni, port, "https")
            if d.allow and not self._was_resolved(src, sni, str(_ip(dst_ip))):
                d = Decision(False, "destination-not-resolved", d.key, d.rule)
        t = Tunnel(d.key, sni or str(dst_ip), port, d.rule, d.allow)
        self._tunnels[client.id] = t
        self.audit(event="connect", mode="transparent", src=src, sandbox=d.key, host=t.host, port=port,
                   dst=str(dst_ip), decision="allow" if d.allow else "deny", reason=d.reason)
        if not d.allow:
            client.error = f"egress: {d.reason}"
        return t

    def tls_clienthello(self, data: ClientHelloData):
        t = self._tunnels.get(data.context.client.id)
        if t is None and self._transparent(data.context.client):
            self._transparent_tunnel(data)
            return
        # Inside a tunnel, the client's SNI must name the CONNECT host (no SNI fronting).
        sni = data.client_hello.sni
        if t and sni and _norm_host(sni) != t.host:
            self.audit(event="tls", src=_source(data.context.client.peername), sandbox=t.key, host=t.host,
                       port=t.port, decision="deny", reason="sni-mismatch")
            data.context.client.error = "egress: SNI does not match the CONNECT host"

    # ---- every HTTP request (in a tunnel or absolute-form) ----
    def requestheaders(self, flow: http.HTTPFlow):
        if flow.request.method == "CONNECT":
            return
        src = _source(flow.client_conn.peername)
        t = self._tunnels.get(flow.client_conn.id)
        # In a tunnel the destination is the CONNECT authority (request.host may already show the
        # pinned upstream IP); otherwise the absolute-form URL's host.
        host, port = (t.host, t.port) if t else (_norm_host(flow.request.host), flow.request.port)
        if t and not t.allowed:
            return self._deny(flow, 403, "connection-not-allowed")  # transparent TLS that was refused
        if not t and self._transparent(flow.client_conn):
            # Plain HTTP redirected from port 80: the destination is the Host header's name.
            hh0 = flow.request.host_header or ""
            host = _norm_host(hh0.rsplit(":", 1)[0] if not hh0.endswith("]") else hh0)
        hh = flow.request.host_header
        hh = _norm_host(hh.rsplit(":", 1)[0] if hh and not hh.endswith("]") else (hh or host))
        base = dict(event="request", src=src, method=flow.request.method, scheme=flow.request.scheme,
                    host=host, port=port, path=flow.request.path.split("?", 1)[0][:200])
        reason = "host-header-mismatch" if hh != host else None
        d = self.decide(src, host, port, flow.request.scheme, flow.request.method, flow.request.path)
        if reason is None and not d.allow:
            reason = d.reason
        is_ws = flow.request.headers.get("upgrade", "").lower() == "websocket"
        if reason is None and is_ws and not (d.rule or {}).get("websocket"):
            reason = "websocket-not-allowed"
        if reason:
            self.audit(**base, sandbox=d.key, decision="deny", reason=reason)
            return self._deny(flow, 403, reason)
        injected = self._inject(flow, host, d.rule or {})
        flow.metadata["egress"] = {**base, "sandbox": d.key, "injected": injected, "websocket": is_ws or None,
                                   "started": time.monotonic()}

    def _inject(self, flow: http.HTTPFlow, host: str, rule: dict) -> str | None:
        name = rule.get("inject")
        secret = self.secrets.get(name) if name else None
        if not secret:
            return None
        if host not in [_norm_host(h) for h in secret["hosts"]] or flow.request.scheme != "https":
            return None  # a policy cannot send a secret anywhere its owner did not list
        header = secret["header"]
        # The guest's own value for this header never reaches the destination.
        flow.request.headers.pop(header, None)
        with open(secret["value_file"]) as f:
            value = f.read().strip()
        flow.request.headers[header] = secret.get("format", "{}").replace("{}", value)
        return name

    def response(self, flow: http.HTTPFlow):
        meta = flow.metadata.get("egress")
        if not meta:
            return
        started = meta.pop("started", None)
        location = None
        if 300 <= flow.response.status_code < 400 and "location" in flow.response.headers:
            loc = flow.response.headers["location"]
            location = loc.split("?", 1)[0][:200]
        self.audit(**meta, decision="allow", status=flow.response.status_code,
                   bytes_out=len(flow.request.raw_content or b""), bytes_in=len(flow.response.raw_content or b""),
                   redirect=location, ms=int((time.monotonic() - started) * 1000) if started else None)

    def websocket_end(self, flow: http.HTTPFlow):
        meta = flow.metadata.get("egress") or {}
        msgs = flow.websocket.messages if flow.websocket else []
        self.audit(event="websocket", src=meta.get("src"), sandbox=meta.get("sandbox"), host=meta.get("host"),
                   messages=len(msgs), bytes=sum(len(m.content) for m in msgs))

    # ---- upstream address check (DNS rebinding, metadata) ----
    async def server_connect(self, data: server_hooks.ServerConnectionHookData):
        host, port = data.server.address
        t = self._tunnels.get(data.client.id)
        if t and t.extra.get("non_http"):
            data.server.error = "egress: non-HTTP traffic is not allowed"
            return
        if t:
            data.server.sni = t.host  # upstream SNI is always the allowed name
            if self._transparent(data.client):
                if not t.allowed:
                    data.server.error = "egress: connection not allowed"
                    return
                # Connect by the allowed name (resolved here), never to the guest's chosen address.
                host = t.host
        name = _norm_host(host)
        if (literal := _ip(name)) is not None:
            candidates = [literal]
        elif name in self.static_hosts:
            candidates = [_ip(self.static_hosts[name])]
        else:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(name, port, type=1)
            except OSError as e:
                data.server.error = f"egress: cannot resolve {name}: {e}"
                return
            candidates = [_ip(i[4][0]) for i in infos]
        for ip in candidates:
            if ip is None or any(ip in n for n in ALWAYS_BLOCKED):
                continue
            if any(ip in n for n in PRIVATE) and not any(ip in n for n in self.allow_private):
                continue
            data.server.address = (str(ip), port)
            return
        self.audit(event="upstream", src=_source(data.client.peername), sandbox=t.key if t else None, host=name,
                   port=port, decision="deny", reason="blocked-address",
                   addresses=[str(c) for c in candidates if c is not None])
        data.server.error = f"egress: every address of {name} is blocked"

    # ---- non-HTTP: default deny ----
    def tcp_start(self, flow: tcp.TCPFlow):
        t = self._tunnels.get(flow.client_conn.id)
        self.audit(event="tcp", src=_source(flow.client_conn.peername), sandbox=t.key if t else None,
                   host=t.host if t else None, port=t.port if t else None, decision="deny", reason="non-http")
        if t:
            t.extra["non_http"] = True
        # With connection_strategy=lazy the upstream is not open yet: refusing it in server_connect
        # makes mitmproxy close the client. tcp_message drops bytes in case it already was.
        flow.server_conn.error = "egress: non-HTTP traffic is not allowed"
        flow.kill()

    def tcp_message(self, flow: tcp.TCPFlow):
        if flow.messages:
            flow.messages[-1].content = b""
        flow.kill()

    def client_disconnected(self, client):
        self._tunnels.pop(client.id, None)

    # ---- DNS (only allowlisted names resolve, IPv4 only; nothing is forwarded) ----
    async def dns_request(self, flow: dns.DNSFlow):
        src = _source(flow.client_conn.peername)
        q = flow.request.questions[0] if flow.request.questions else None
        name = _norm_host(q.name) if q else ""
        d = self.decide(src, name, 443, "https") if q else Decision(False, "no-question")
        if not d.allow and d.reason in ("port-not-allowed", "scheme-not-allowed"):
            d = Decision(True, "rule", d.key, d.rule)  # the name is allowlisted on some port
        answers, given = [], []
        # A only. Sandboxes have no IPv6 (nftables drops it), so an AAAA answer would make a
        # v6-first client try a dead address before falling back. AAAA for an allowed name gets an
        # empty NOERROR (NODATA), which resolvers treat as "no v6 here", never as a failure.
        if d.allow and q and q.type == 1:
            ips = [self.static_hosts[name]] if name in self.static_hosts else []
            if not ips:
                try:
                    infos = await asyncio.get_running_loop().getaddrinfo(name, None, type=1)
                    ips = [i[4][0] for i in infos]
                except OSError:
                    ips = []
            for raw in dict.fromkeys(ips):
                ip = _ip(raw)
                if ip is None or any(ip in n for n in ALWAYS_BLOCKED):
                    continue
                if ip.version == 4:
                    answers.append(dns.ResourceRecord.A(name, ip))
                    given.append(str(ip))
            self._remember(src, name, given)
        self.audit(event="dns", src=src, sandbox=d.key, host=name, qtype=q.type if q else None,
                   decision="allow" if d.allow else "deny", reason=d.reason, answers=len(answers))
        flow.response = flow.request.succeed(answers) if d.allow else flow.request.fail(response_codes.REFUSED)


addons = [SandboxEgress()]
