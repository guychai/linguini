"""GitHub access for sandboxes through the egress proxy (git-via-egress, phase 1: reads).

The proxy, never the sandbox, holds GitHub credentials. For a request to a supported GitHub host
that names one repository, it:
  - always drops the guest's own Authorization (a sandbox never authenticates to GitHub itself);
  - asks GitHub which installation of the Linguini GitHub App covers that repository
    (GET /repos/{owner}/{repo}/installation, signed with the App's JWT);
  - mints an installation token limited to that ONE repository and to read permissions
    (POST /app/installations/{id}/access_tokens, repositories=[repo]) and caches it per repository
    until shortly before it expires;
  - adds it in the form that host expects.
When the App is not configured, not enabled for the conversation, or has no access to the
repository, the request goes out anonymously: public repositories keep working, private ones get
GitHub's 401/404, which the addon turns into a message the agent can read.

Pure Python (stdlib + cryptography, which mitmproxy already depends on). No mitmproxy imports, so
it is unit-testable on its own (tests/test_github_app.py). Token values are never logged.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Awaitable, Callable
from urllib.parse import parse_qs

GITHUB_WEB = "github.com"
GITHUB_API = "api.github.com"
GITHUB_RAW = "raw.githubusercontent.com"
GITHUB_CODELOAD = "codeload.github.com"
GITHUB_HOSTS = frozenset({GITHUB_WEB, GITHUB_API, GITHUB_RAW, GITHUB_CODELOAD})

# Phase 1 is read-only. Phase 2 adds contents:write / pull_requests:write (never workflows).
DEFAULT_PERMISSIONS = {"contents": "read", "metadata": "read"}

# GitHub logins: alphanumerics and single hyphens, at most 39. Repository names: [A-Za-z0-9._-].
_OWNER = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,38})\Z")
_REPO = re.compile(r"[a-z0-9._-]{1,100}\Z")


@dataclass(frozen=True)
class RepoRequest:
    """One request that targets exactly one repository."""

    owner: str  # lowercased
    repo: str  # lowercased, without .git
    # git-read (upload-pack: clone/fetch/ls-remote), git-write (receive-pack: push), api, raw,
    # codeload (archive downloads; never credentialed, see credential_allowed)
    kind: str
    service: str | None = None  # git-upload-pack / git-receive-pack for smart HTTP

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"


def _segments(path: str) -> list[str] | None:
    """Path segments with the query stripped, or None for anything ambiguous (encoded
    characters, dot segments, empty segments, backslashes). Ambiguous paths never get a
    credential."""
    p = path.split("?", 1)[0].split("#", 1)[0]
    if not p.startswith("/") or "%" in p or "\\" in p or "//" in p:
        return None
    segs = p[1:].split("/")
    if any(s in (".", "..") for s in segs):
        return None
    return segs


def _name(owner: str, repo: str) -> tuple[str, str] | None:
    o = owner.lower()
    r = repo.lower()
    if r.endswith(".git"):
        r = r[:-4]
    if not _OWNER.match(o) or not _REPO.match(r) or r in (".", ".."):
        return None
    return o, r


def _query(path: str) -> dict[str, list[str]]:
    q = path.split("?", 1)[1] if "?" in path else ""
    try:
        return parse_qs(q.split("#", 1)[0], keep_blank_values=True, strict_parsing=False)
    except ValueError:
        return {}


def parse_repo_request(host: str, method: str, path: str) -> RepoRequest | None:
    """The single repository a request to a GitHub host targets, or None (not repo-scoped,
    unsupported or ambiguous: such requests go out without any credential)."""
    host = host.strip().rstrip(".").lower()
    method = method.upper()
    segs = _segments(path)
    if not segs:
        return None
    if host == GITHUB_WEB:
        # Smart HTTP: /<o>/<r>[.git]/info/refs?service=…, /<o>/<r>[.git]/git-upload-pack|git-receive-pack
        if len(segs) == 4 and segs[2:] == ["info", "refs"] and method in ("GET", "HEAD"):
            service = _query(path).get("service", [])
            if len(service) != 1 or service[0] not in ("git-upload-pack", "git-receive-pack"):
                return None  # dumb HTTP (GitHub does not serve it) or ambiguous
            n = _name(segs[0], segs[1])
            kind = "git-read" if service[0] == "git-upload-pack" else "git-write"
            return RepoRequest(*n, kind, service[0]) if n else None
        if len(segs) == 3 and segs[2] in ("git-upload-pack", "git-receive-pack") and method == "POST":
            n = _name(segs[0], segs[1])
            kind = "git-read" if segs[2] == "git-upload-pack" else "git-write"
            return RepoRequest(*n, kind, segs[2]) if n else None
        return None
    if host == GITHUB_API:
        # REST: /repos/<o>/<r>[/...]. (/repositories/<id>/… is not repo-name scoped: anonymous.)
        if len(segs) >= 3 and segs[0] == "repos" and not segs[2].lower().endswith(".git"):
            n = _name(segs[1], segs[2])
            return RepoRequest(*n, "api") if n else None
        return None
    if host == GITHUB_RAW:
        # /<o>/<r>/<ref…>/<path>: at least one ref segment and one path segment.
        if len(segs) >= 4 and all(segs):
            n = _name(segs[0], segs[1])
            return RepoRequest(*n, "raw") if n else None
        return None
    if host == GITHUB_CODELOAD:
        # /<o>/<r>/(tar.gz|zip|legacy.tar.gz|legacy.zip)/<ref…>
        if len(segs) >= 4 and segs[2] in ("tar.gz", "zip", "legacy.tar.gz", "legacy.zip"):
            n = _name(segs[0], segs[1])
            return RepoRequest(*n, "codeload") if n else None
        return None
    return None


def credential_allowed(req: RepoRequest, method: str, path: str) -> bool:
    """Whether phase 1 attaches a token to this request at all.

    Reads only: git-write (push) is refused before this is reached, and codeload is never
    credentialed. Neither are the API's tarball/zipball endpoints: GitHub answers them with a
    redirect whose URL carries a download token, and that URL would reach the sandbox (git clone
    works for private repositories instead)."""
    m = method.upper()
    if req.kind == "git-read":
        return m in ("GET", "HEAD", "POST")
    if req.kind == "api":
        return m in ("GET", "HEAD") and not is_archive_api_path(path)
    if req.kind == "raw":
        return m in ("GET", "HEAD")
    return False


def is_archive_api_path(path: str) -> bool:
    segs = _segments(path) or []
    return len(segs) >= 4 and segs[0] == "repos" and segs[3] in ("tarball", "zipball")


def auth_header_value(host: str, token: str) -> str:
    """The Authorization value GitHub expects on each host for an installation token."""
    if host == GITHUB_WEB:
        # Smart HTTP takes Basic auth; any username works, x-access-token is GitHub's convention.
        return "Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()
    if host == GITHUB_API:
        return f"Bearer {token}"
    return f"token {token}"  # raw.githubusercontent.com


# Headers a sandbox might use to authenticate to GitHub itself. Always removed on GitHub hosts.
GUEST_AUTH_HEADERS = ("authorization", "proxy-authorization", "cookie")

_TOKEN_QUERY = re.compile(rb"([?&])token=[A-Za-z0-9_.\-%]+")


def scrub_download_tokens(data: bytes) -> tuple[bytes, int]:
    """Remove `token=` query parameters (GitHub's short-lived download tokens for private
    content, e.g. in `download_url`) from a response body or Location header."""
    return _TOKEN_QUERY.subn(rb"\1token=REDACTED-by-egress", data)


# ---- the App: JWT, installation lookup, repo-scoped token minting with a cache ----

HttpFn = Callable[[str, str, dict, bytes | None], Awaitable[tuple[int, dict]]]


class GitHubAppError(Exception):
    pass


@dataclass
class TokenResult:
    token: str | None
    # app (token minted or cached), not-installed, mint-failed, error, not-configured
    reason: str
    installation_id: int | None = None
    cached: bool = False


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _parse_expiry(value: str | None, now: float) -> float:
    if not value:
        return now + 3600
    try:
        import datetime

        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return now + 600


class GitHubApp:
    """App credentials from node config (`github_app` in the egress config):

      app_id            the App's numeric ID (or client ID); used as the JWT issuer
      private_key_file  PEM private key, 0640 root:sandbox-egress; read at use, never logged
      api_url           default https://api.github.com (tests point it at a mock)
      ca_file           extra CA bundle for api_url (tests only)
      permissions       default {"contents": "read", "metadata": "read"}
      refresh_margin_s  re-mint when a cached token has less than this left (default 300)
      negative_ttl_s    remember "no installation/no access" this long (default 60)
      timeout_s         per GitHub API call (default 10)
    """

    def __init__(self, cfg: dict, http: HttpFn | None = None, clock: Callable[[], float] = time.time):
        if not cfg.get("app_id") or not cfg.get("private_key_file"):
            raise ValueError("github_app: app_id and private_key_file are required")
        self.app_id = str(cfg["app_id"])
        self.key_file = cfg["private_key_file"]
        self.api_url = str(cfg.get("api_url", "https://api.github.com")).rstrip("/")
        self.permissions = dict(cfg.get("permissions") or DEFAULT_PERMISSIONS)
        if any(k == "workflows" for k in self.permissions):
            raise ValueError("github_app: the workflows permission is never requested")
        self.refresh_margin = float(cfg.get("refresh_margin_s", 300))
        self.negative_ttl = float(cfg.get("negative_ttl_s", 60))
        self.timeout = float(cfg.get("timeout_s", 10))
        self.clock = clock
        self._ssl = ssl.create_default_context(cafile=cfg.get("ca_file")) if cfg.get("ca_file") else None
        self._http = http or self._urllib
        self._jwt: tuple[str, float] | None = None
        # repo full name -> (installation id or None, valid until)
        self._installations: dict[str, tuple[int | None, float]] = {}
        # repo full name -> (token, expires at)
        self._tokens: dict[str, tuple[str, float]] = {}
        # repo full name -> failure remembered until
        self._failures: dict[str, tuple[str, float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.mints = 0  # for tests and metrics; never the token itself
        self.last_error: str | None = None  # exception type of the last failed mint

    # -- HTTP --
    async def _urllib(self, method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, dict]:
        def call():
            req = urllib.request.Request(url, data=body, method=method, headers=headers)
            # Direct to GitHub like every other upstream connection of the proxy: no env proxies.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                 urllib.request.HTTPSHandler(context=self._ssl))
            try:
                with opener.open(req, timeout=self.timeout) as r:
                    return r.status, json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                try:
                    data = json.loads(e.read() or b"{}")
                except ValueError:
                    data = {}
                return e.code, data if isinstance(data, dict) else {}

        return await asyncio.to_thread(call)

    # -- JWT (RS256), cached for 8 minutes of its 10 --
    def app_jwt(self) -> str:
        now = self.clock()
        if self._jwt and self._jwt[1] > now:
            return self._jwt[0]
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        with open(self.key_file, "rb") as f:
            key = serialization.load_pem_private_key(f.read(), password=None)
        header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        # iat 60 s in the past for clock drift; GitHub allows exp at most 10 minutes ahead.
        claims = {"iat": int(now) - 60, "exp": int(now) + 540, "iss": self.app_id}
        payload = _b64url(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{header}.{payload}".encode()
        sig = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())  # type: ignore[union-attr]
        token = f"{header}.{payload}.{_b64url(sig)}"
        self._jwt = (token, now + 480)
        return token

    def _headers(self, auth: str) -> dict:
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": auth,
            "User-Agent": "linguini-sandbox-egress",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    # -- cache --
    def cached_token(self, full_name: str) -> str | None:
        hit = self._tokens.get(full_name)
        if hit and hit[1] - self.refresh_margin > self.clock():
            return hit[0]
        return None

    def needs_api(self, full_name: str) -> bool:
        """Whether token_for would call GitHub (no cached token, no remembered failure)."""
        if self.cached_token(full_name):
            return False
        fail = self._failures.get(full_name)
        return not (fail and fail[1] > self.clock())

    def forget(self, full_name: str):
        """Drop a cached token (e.g. GitHub answered 401 with it)."""
        self._tokens.pop(full_name, None)

    async def token_for(self, owner: str, repo: str) -> TokenResult:
        """A token for exactly owner/repo with self.permissions, minted on demand and cached."""
        full = f"{owner}/{repo}"
        tok = self.cached_token(full)
        if tok:
            inst = self._installations.get(full, (None, 0))[0]
            return TokenResult(tok, "app", inst, cached=True)
        lock = self._locks.setdefault(full, asyncio.Lock())
        async with lock:
            tok = self.cached_token(full)  # minted by a concurrent request while we waited
            if tok:
                return TokenResult(tok, "app", self._installations.get(full, (None, 0))[0], cached=True)
            now = self.clock()
            fail = self._failures.get(full)
            if fail and fail[1] > now:
                return TokenResult(None, fail[0])
            try:
                result = await self._mint(owner, repo)
            except Exception as e:  # network, key file, bad JSON: anonymous, retried after the TTL
                result = TokenResult(None, "error")
                self.last_error = type(e).__name__
            if result.token is None:
                self._failures[full] = (result.reason, self.clock() + self.negative_ttl)
            else:
                self._failures.pop(full, None)
            if len(self._locks) > 10_000:
                self._locks = {k: v for k, v in self._locks.items() if v.locked()}
            return result

    async def _mint(self, owner: str, repo: str) -> TokenResult:
        full = f"{owner}/{repo}"
        now = self.clock()
        inst, until = self._installations.get(full, (None, 0))
        if until <= now:
            status, data = await self._http(
                "GET", f"{self.api_url}/repos/{owner}/{repo}/installation",
                self._headers(f"Bearer {self.app_jwt()}"), None)
            if status == 200 and isinstance(data.get("id"), int):
                inst = data["id"]
                self._installations[full] = (inst, now + 3600)
            elif status in (404, 403):
                self._installations[full] = (None, now + self.negative_ttl)
                return TokenResult(None, "not-installed")
            else:
                raise GitHubAppError(f"installation lookup: HTTP {status}")
        if inst is None:
            return TokenResult(None, "not-installed")
        body = json.dumps({"repositories": [repo], "permissions": self.permissions}).encode()
        headers = {**self._headers(f"Bearer {self.app_jwt()}"), "Content-Type": "application/json"}
        status, data = await self._http(
            "POST", f"{self.api_url}/app/installations/{inst}/access_tokens", headers, body)
        if status == 201 and isinstance(data.get("token"), str) and data["token"]:
            repos = data.get("repositories")
            # GitHub must have honoured the down-scoping; anything else is not used.
            if isinstance(repos, list) and [str(r.get("name", "")).lower() for r in repos] != [repo]:
                return TokenResult(None, "mint-failed", inst)
            expires = _parse_expiry(data.get("expires_at"), now)
            self._tokens[full] = (data["token"], expires)
            self.mints += 1
            return TokenResult(data["token"], "app", inst)
        if status in (404, 422, 403):
            # The installation exists but does not include this repository (or lost access).
            self._installations.pop(full, None)
            return TokenResult(None, "not-installed", inst)
        raise GitHubAppError(f"token mint: HTTP {status}")


def denial_message(req: RepoRequest, reason: str, app_enabled: bool) -> str:
    """Plain text the agent sees (git prints it as `remote: …`)."""
    repo = f"github.com/{req.full_name}"
    if reason == "push":
        return (f"git push to {repo} is not enabled in this sandbox yet. Clone and fetch work; "
                "commit locally and tell the user the change is ready instead of pushing.")
    if not app_enabled:
        return (f"{repo}: not found, or private. Public repositories clone anonymously; private "
                "repositories need the Linguini GitHub App, which is not enabled for this account. "
                "Tell the user; do not ask for or use a personal token.")
    if reason in ("not-installed", "mint-failed"):
        return (f"{repo}: not found, or private and the Linguini GitHub App has no access to it. "
                "Ask the user to install the App on this repository (or check the name). "
                "Do not ask for or use a personal token.")
    if reason == "rate-limited":
        return (f"{repo}: too many different GitHub repositories from this conversation in the last "
                "few minutes; private access is paused. Wait and retry, or tell the user.")
    if reason == "error":
        return (f"{repo}: could not get GitHub App credentials right now (GitHub API error). "
                "Retry in a minute; if it keeps failing tell the user.")
    return (f"{repo}: GitHub refused access with the Linguini GitHub App's token. The repository "
            "may not exist or the App's installation may not include it.")
