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

Request limits (V1.1a): every request's path and query are length-capped (generous for listed
hosts, tight for the open-web tier); outbound URLs, headers and bodies are scanned for credentials
(node secrets, minted GitHub tokens, well-known key formats) and refused on a match. The optional
open-web tier (node config `open_web_read`, off by default) lets an unlisted host take GET/HEAD
without a body, never for a tainted (sensitive) conversation.

GitHub (github_app.py): the guest's own credentials never reach GitHub; git push is refused;
reads of one repository get a token minted for that repository only, when the node has a
GitHub App configured and the conversation's policy enables it (`github.app`).

Sensitive flag (V1.1c): serving a private repository with an App token makes the conversation
sensitive. The proxy writes `<sensitive_dir>/<key>` before forwarding, treats the conversation as
tainted from then on, and the backend picks the marker up and sets its own flag. A sensitive
conversation reaches GitHub only for installed private repositories (App token), never public
ones or other GitHub requests.
"""


import asyncio
import collections
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

# Sibling module (mitmproxy puts this script's directory on sys.path while loading it).
import github_app as gh

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
# Default GitHub App lookups (installation + mint) one conversation may cause per window: a hostile
# guest naming endless repositories must not use up the App's API rate limit for everyone.
# Node config: github_app.conversation_budget = {"calls": 100, "window_s": 600}.
GITHUB_API_BUDGET = {"calls": 100, "window_s": 600}
# How long a DNS answer we gave a sandbox stays a valid transparent destination for that name.
RESOLVED_TTL = 3600.0
# allowWhenTainted is ignored on these hosts and all their subdomains, and on wildcard rules: data
# can ride in the path or query of a GET (api.github.com/repos/<data>/…, registry.npmjs.org/<data>)
# and the registry, or whoever owns the named package or repository, sees it. Keep in sync with
# prototypes/runtime/src/egress-rules.ts TAINT_UNSAFE_SUFFIXES (the backend refuses to start with
# such a rule; this covers rules that reach the policy any other way).
TAINT_UNSAFE_SUFFIXES = (
    "github.com", "githubusercontent.com", "ghcr.io",
    "npmjs.org", "npmjs.com", "yarnpkg.com",
    "pypi.org", "pythonhosted.org",
    "docker.io", "docker.com",
)


def taint_exempt(rule: dict) -> bool:
    """Whether a rule really keeps its host reachable after taint."""
    if rule.get("allowWhenTainted") is not True:
        return False
    host = _norm_host(str(rule.get("host", "")))
    if not host or "*" in host:
        return False
    return not any(host == s or host.endswith("." + s) for s in TAINT_UNSAFE_SUFFIXES)


# Length caps on the request target (path + query). Listed hosts: generous (signed download URLs
# carry long queries); a rule may set maxUrl / maxQuery. Open-web tier: tight, data rides in URLs.
LISTED_LIMITS = {"max_url": 8192, "max_query": 4096}
OPEN_WEB_LIMITS = {"max_url": 2048, "max_query": 512}
# The synthetic rule the open-web tier matches with: GET/HEAD only, no websocket, no injection.
OPEN_WEB_RULE = {"host": "*open-web*", "methods": ["GET", "HEAD"], "_open_web": True}
# Bodies larger than this are not scanned for credentials (and are refused on the open-web tier).
SCAN_BODY_LIMIT = 1024 * 1024
# Well-known credential formats. A match anywhere outbound is refused; the audit names the rule only.
SECRET_PATTERNS = [
    ("github-token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})")),
    ("aws-access-key", re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(rb"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("openai-style-key", re.compile(rb"\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{32,}")),
    ("google-api-key", re.compile(rb"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("private-key", re.compile(rb"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
]


def scan_secrets(data: bytes, exact: list[bytes]) -> str | None:
    """The name of the first credential found in data, or None. `exact` are node secret values."""
    if not data:
        return None
    for value in exact:
        if value and value in data:
            return "node-secret"
    for name, pattern in SECRET_PATTERNS:
        if pattern.search(data):
            return name
    return None


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
    policy: dict | None = None


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
        self.github: gh.GitHubApp | None = None
        self._github_calls: dict[str, collections.deque] = {}
        self.github_budget = dict(GITHUB_API_BUDGET)
        self._audit_lock = threading.Lock()
        self._tunnels: dict[str, Tunnel] = {}
        # (sandbox source IP, name) -> {address: expiry}: what our DNS told that sandbox. In
        # transparent mode a connection's original destination must be one of these for its SNI
        # (no fronting an allowed name onto an address the sandbox picked itself).
        self._resolved: dict[tuple[str, str], dict[str, float]] = {}
        self.open_web = {"enabled": False, "ports": [443], **OPEN_WEB_LIMITS}
        self._secret_values: dict[str, tuple[float, bytes]] = {}
        self._sensitive_keys: set[str] = set()

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
        # Optional: the Linguini GitHub App (private key file root:sandbox-egress 0640).
        self.github = gh.GitHubApp(self.cfg["github_app"]) if self.cfg.get("github_app") else None
        self.github_budget = {**GITHUB_API_BUDGET, **(self.cfg.get("github_app") or {}).get("conversation_budget", {})}
        ow = self.cfg.get("open_web_read") or {}
        self.open_web = {"enabled": ow.get("enabled") is True, "ports": ow.get("ports", [443]),
                         "max_url": int(ow.get("max_url", OPEN_WEB_LIMITS["max_url"])),
                         "max_query": int(ow.get("max_query", OPEN_WEB_LIMITS["max_query"]))}
        self._secret_values: dict[str, tuple[float, bytes]] = {}

    def _exact_secrets(self) -> list[bytes]:
        """Values the node holds that must never leave in a request: injected secrets (re-read when
        their file changes) and GitHub tokens the proxy minted."""
        out = []
        for name, s in self.secrets.items():
            path = s.get("value_file")
            try:
                mtime = os.stat(path).st_mtime
                cached = self._secret_values.get(name)
                if not cached or cached[0] != mtime:
                    with open(path, "rb") as f:
                        cached = (mtime, f.read().strip())
                    self._secret_values[name] = cached
                if len(cached[1]) >= 8:
                    out.append(cached[1])
            except OSError:
                continue
        if self.github:
            out.extend(tok.encode() for tok, _exp in list(self.github._tokens.values()) if tok)
        return out

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
        if policy.get("version") != 1 or policy.get("conversationKey") != key:
            return None
        if not policy.get("tainted") and self._sensitive(key):
            policy["tainted"] = True  # the proxy saw a private-repo read before the backend did
            policy["_sensitive_marker"] = True
        return policy

    def _sensitive(self, key: str) -> bool:
        d = self.cfg.get("sensitive_dir")
        if d:
            return os.path.exists(os.path.join(d, key))
        return key in self._sensitive_keys

    def _mark_sensitive(self, key: str):
        """Record that this conversation read private data. Raises when it cannot be recorded."""
        self._sensitive_keys.add(key)
        d = self.cfg.get("sensitive_dir")
        if not d:
            return
        os.makedirs(d, mode=0o750, exist_ok=True)
        target = os.path.join(d, key)
        tmp = f"{target}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
        try:
            os.write(fd, json.dumps({"reason": "private-repo", "ts": int(time.time())}).encode())
        finally:
            os.close(fd)
        os.replace(tmp, target)

    def _github_sensitive_ok(self, policy: dict) -> bool:
        """A sensitive conversation may still reach GitHub, for installed private repos only
        (enforced per request in _github_auth)."""
        return bool(self.github and (policy.get("github") or {}).get("app") is True)

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
            if policy.get("tainted") and not taint_exempt(rule) and not (
                    host in gh.GITHUB_HOSTS and self._github_sensitive_ok(policy)):
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
            return Decision(True, "rule", key, rule, policy)
        if first_miss:
            return first_miss
        if literal:
            return Decision(False, "raw-ip", key)
        # Open-web tier: an unlisted host may take GET/HEAD (no body, tight caps; checked per
        # request). Never for a tainted (sensitive) conversation: no new hosts there.
        if self.open_web["enabled"] and scheme == "https" and port in self.open_web["ports"]:
            if policy.get("tainted"):
                return Decision(False, "tainted-new-host", key)
            if method is not None and method.upper() not in OPEN_WEB_RULE["methods"]:
                return Decision(False, "open-web-method", key)
            return Decision(True, "open-web", key, OPEN_WEB_RULE, policy)
        return Decision(False, "host-not-allowed", key)

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
    def _deny(flow: http.HTTPFlow, status: int, reason: str, detail: str | None = None):
        # text/plain: git shows the body of a failed smart-HTTP request as "remote: …" lines.
        body = f"egress denied: {reason}" + (f": {detail}" if detail else "") + "\n"
        flow.response = http.Response.make(
            status, body.encode(), {"content-type": "text/plain; charset=utf-8", "x-egress-denied": reason}
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
    async def requestheaders(self, flow: http.HTTPFlow):
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
        repo = gh.parse_repo_request(host, flow.request.method, flow.request.path) if host in gh.GITHUB_HOSTS else None
        detail = None
        if reason is None and repo and repo.kind == "git-write":
            # Phase 1: no push, whatever the rules say (receive-pack discovery and data alike).
            reason, detail = "git-push-not-enabled", gh.denial_message(repo, "push", False)
        if reason is None:
            reason = self._limits(flow, d.rule or {})
        if reason is None:
            reason = self._scan_head(flow, host, d.rule or {})
        if reason:
            reason, _, secret_rule = reason.partition(":")
            if secret_rule:
                base["path"] = "[redacted]"  # the credential may be in the path itself
            self.audit(**base, sandbox=d.key, decision="deny", reason=reason, secret_rule=secret_rule or None,
                       repo=repo.full_name if repo else None, git_service=repo.service if repo else None)
            return self._deny(flow, 403, reason, detail)
        policy = d.policy or {}
        if host in gh.GITHUB_HOSTS and policy.get("tainted"):
            # Sensitive: only installed private repositories, with the App's token.
            github = await self._github_auth(flow, host, repo, policy)
            if not (github.get("github") == "app" and github.get("github_private") is True):
                why = "sensitive-github"
                self.audit(**base, sandbox=d.key, decision="deny", reason=why,
                           repo=repo.full_name if repo else None, git_service=repo.service if repo else None)
                return self._deny(flow, 403, why, gh.denial_message(repo, why, True) if repo else None)
            injected = None
        else:
            injected = self._inject(flow, host, d.rule or {})
            github = None
            if host in gh.GITHUB_HOSTS and not injected:
                github = await self._github_auth(flow, host, repo, policy)
            if github and github.get("github") == "app" and github.get("github_private") is not False:
                # A private (or unknown) repository read through the App: sensitive from now on.
                try:
                    self._mark_sensitive(d.key)
                except OSError:
                    self.audit(**base, sandbox=d.key, decision="deny", reason="sensitive-mark-failed",
                               repo=repo.full_name if repo else None)
                    return self._deny(flow, 503, "sensitive-mark-failed")
                github["sensitive_marked"] = True
        flow.metadata["egress"] = {**base, "sandbox": d.key, "injected": injected, "websocket": is_ws or None,
                                   "open_web": True if (d.rule or {}).get("_open_web") else None,
                                   "started": time.monotonic(), **(github or {})}

    def _limits(self, flow: http.HTTPFlow, rule: dict) -> str | None:
        """Length caps on the request target, and no body on the open-web tier."""
        open_web = rule.get("_open_web") is True
        lim = self.open_web if open_web else LISTED_LIMITS
        max_url = int(rule.get("maxUrl", lim["max_url"])) if not open_web else lim["max_url"]
        max_query = int(rule.get("maxQuery", lim["max_query"])) if not open_web else lim["max_query"]
        target = flow.request.path
        query = target.split("?", 1)[1] if "?" in target else ""
        if len(target) > max_url:
            return "url-too-long"
        if len(query) > max_query:
            return "query-too-long"
        if open_web:
            h = flow.request.headers
            if h.get("transfer-encoding") or int(h.get("content-length", "0") or "0") > 0:
                return "open-web-body"
        return None

    def _scan_head(self, flow: http.HTTPFlow, host: str, rule: dict) -> str | None:
        """Credentials in the URL or headers. Headers the proxy replaces anyway (the injected
        secret's header; the guest's auth headers on GitHub) are not the guest's to send, so skip."""
        skip = set()
        name = rule.get("inject")
        if name and self.secrets.get(name):
            skip.add(self.secrets[name]["header"].lower())
        if host in gh.GITHUB_HOSTS:
            skip.update(gh.GUEST_AUTH_HEADERS)
        parts = [flow.request.path.encode("utf-8", "replace")]
        parts += [f"{k}: {v}".encode("utf-8", "replace") for k, v in flow.request.headers.items(multi=True)
                  if k.lower() not in skip]
        hit = scan_secrets(b"\n".join(parts), self._exact_secrets())
        return f"secret-detected:{hit}" if hit else None

    def request(self, flow: http.HTTPFlow):
        """Bodies: scanned for credentials once mitmproxy has read them (up to SCAN_BODY_LIMIT)."""
        meta = flow.metadata.get("egress")
        if not meta or flow.response is not None:
            return
        body = flow.request.raw_content or b""
        if not body:
            return
        if meta.get("open_web"):
            hit = "open-web-body"
        else:
            found = scan_secrets(body[:SCAN_BODY_LIMIT], self._exact_secrets())
            hit = f"secret-detected:{found}" if found else None
        if hit:
            flow.metadata.pop("egress", None)
            reason, _, rule = hit.partition(":")
            self.audit(**{k: v for k, v in meta.items() if k != "started"}, decision="deny", reason=reason,
                       secret_rule=rule or None)
            self._deny(flow, 403, reason)

    async def _github_auth(self, flow: http.HTTPFlow, host: str, repo, policy: dict) -> dict:
        """Strip the guest's credentials; add a token for this one repository when allowed."""
        for h in gh.GUEST_AUTH_HEADERS:
            flow.request.headers.pop(h, None)
        if repo is None:
            return {"github": "anonymous"}
        app_enabled = bool(self.github and (policy.get("github") or {}).get("app") is True)
        out = {"repo": repo.full_name, "git_service": repo.service, "github_kind": repo.kind,
               "github": "anonymous", "github_app_enabled": app_enabled}
        if not app_enabled or flow.request.scheme != "https" or not gh.credential_allowed(
                repo, flow.request.method, flow.request.path):
            out["github_reason"] = "app-disabled" if not app_enabled else "not-credentialed"
            return out
        if self.github.needs_api(repo.full_name) and not self._github_budget(policy.get("conversationKey", "")):
            out["github_reason"] = "rate-limited"
            return out
        res = await self.github.token_for(repo.owner, repo.repo)
        out["github_reason"] = res.reason
        if res.token:
            flow.request.headers["authorization"] = gh.auth_header_value(host, res.token)
            out["github"] = "app"
            out["github_cached"] = res.cached
            out["github_private"] = self.github.is_private(repo.full_name)
        return out

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
        if meta.get("repo"):
            self._github_response(flow, meta)
        location = None
        if 300 <= flow.response.status_code < 400 and "location" in flow.response.headers:
            loc = flow.response.headers["location"]
            location = loc.split("?", 1)[0][:200]
        self.audit(**meta, decision="allow", status=flow.response.status_code,
                   bytes_out=len(flow.request.raw_content or b""), bytes_in=len(flow.response.raw_content or b""),
                   redirect=location, ms=int((time.monotonic() - started) * 1000) if started else None)

    def _github_budget(self, key: str) -> bool:
        limit, window = int(self.github_budget["calls"]), float(self.github_budget["window_s"])
        now = time.monotonic()
        q = self._github_calls.setdefault(key, collections.deque())
        while q and q[0] < now - window:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        if len(self._github_calls) > 10_000:
            self._github_calls = {k: v for k, v in self._github_calls.items() if v and v[-1] >= now - window}
        return True

    def _github_response(self, flow: http.HTTPFlow, meta: dict):
        """Readable failures for git, and no download tokens back into the sandbox."""
        status = flow.response.status_code
        host = meta.get("host")
        if meta.get("github") == "app":
            if status == 401:  # revoked or expired early: mint again next time
                self.github.forget(meta["repo"])
            # Private content links (download_url, archive redirects) carry ?token=…: drop it.
            loc = flow.response.headers.get("location")
            if loc and "token=" in loc:
                flow.response.headers["location"] = gh.scrub_download_tokens(loc.encode())[0].decode()
            ctype = flow.response.headers.get("content-type", "")
            if host == gh.GITHUB_API and "json" in ctype and b"token=" in (flow.response.content or b""):
                flow.response.content = gh.scrub_download_tokens(flow.response.content)[0]
        if host == gh.GITHUB_WEB and meta.get("github_kind") == "git-read" and status in (401, 403, 404):
            # 401 would make git prompt for a password; the sandbox never has one to give.
            reason = meta.get("github_reason", "")
            if meta.get("github") == "app":
                reason = "refused"
            msg = gh.denial_message(gh.RepoRequest(*meta["repo"].split("/", 1), "git-read"), reason,
                                    bool(meta.get("github_app_enabled")))
            flow.response = http.Response.make(
                403 if status == 401 else status, f"egress: {msg}\n".encode(),
                {"content-type": "text/plain; charset=utf-8", "x-egress-github": reason or "anonymous"})
            meta["github_rewritten"] = status

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
        if q and not d.allow and d.reason == "host-not-allowed" and self.open_web["enabled"]:
            d = self.decide(src, name, self.open_web["ports"][0], "https")  # open-web names resolve
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
