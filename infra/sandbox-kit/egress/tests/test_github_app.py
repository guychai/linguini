"""Unit tests for addon/github_app.py (no network, no mitmproxy): repository parsing, header
forms, download-token scrubbing, App JWT, and repo-scoped token minting and caching against a
mocked GitHub API.

  EGRESS_VENV=/path/to/venv; "$EGRESS_VENV/bin/python" -m unittest discover -s tests -p 'test_*.py'
(needs `cryptography`, which the egress venv has through mitmproxy).
"""

import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "addon"))
import github_app as gh  # noqa: E402

from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import padding, rsa  # noqa: E402


class ParseTests(unittest.TestCase):
    def p(self, host, method, path):
        r = gh.parse_repo_request(host, method, path)
        return (r.full_name, r.kind, r.service) if r else None

    def test_smart_http(self):
        self.assertEqual(self.p("github.com", "GET", "/Octo/Repo.git/info/refs?service=git-upload-pack"),
                         ("octo/repo", "git-read", "git-upload-pack"))
        self.assertEqual(self.p("github.com", "GET", "/octo/repo/info/refs?service=git-upload-pack"),
                         ("octo/repo", "git-read", "git-upload-pack"))
        self.assertEqual(self.p("github.com", "POST", "/octo/repo.git/git-upload-pack"),
                         ("octo/repo", "git-read", "git-upload-pack"))
        self.assertEqual(self.p("GitHub.com.", "POST", "/octo/repo/git-upload-pack"),
                         ("octo/repo", "git-read", "git-upload-pack"))
        self.assertEqual(self.p("github.com", "GET", "/octo/repo.git/info/refs?service=git-receive-pack"),
                         ("octo/repo", "git-write", "git-receive-pack"))
        self.assertEqual(self.p("github.com", "POST", "/octo/repo.git/git-receive-pack"),
                         ("octo/repo", "git-write", "git-receive-pack"))
        self.assertEqual(self.p("github.com", "GET", "/my-org/some.repo_name-2/info/refs?service=git-upload-pack"),
                         ("my-org/some.repo_name-2", "git-read", "git-upload-pack"))

    def test_smart_http_rejects(self):
        for method, path in [
            ("GET", "/octo/repo/info/refs"),  # dumb HTTP
            ("GET", "/octo/repo/info/refs?service=git-upload-pack&service=git-receive-pack"),
            ("GET", "/octo/repo/info/refs?service=other"),
            ("POST", "/octo/repo/info/refs?service=git-upload-pack"),
            ("GET", "/octo/repo/git-upload-pack"),  # data is POST only
            ("POST", "/a/b/c/git-upload-pack"),
            ("POST", "/octo/../repo/git-upload-pack"),
            ("POST", "/octo/%2e%2e/git-upload-pack"),
            ("POST", "/octo%2Frepo/x/git-upload-pack"),
            ("POST", "//octo/repo/git-upload-pack"),
            ("POST", "/-octo/repo/git-upload-pack"),  # logins never start with "-"
            ("POST", "/octo/repo%00/git-upload-pack"),
            ("POST", "/octo/rep o/git-upload-pack"),
            ("POST", "/octo/.git/git-upload-pack"),
            ("GET", "/octo/repo"),
            ("GET", "/octo/repo/archive/refs/heads/main.tar.gz"),
            ("POST", "/octo/repo.git/info/lfs/objects/batch"),
        ]:
            with self.subTest(path=path):
                self.assertIsNone(self.p("github.com", method, path))

    def test_api(self):
        self.assertEqual(self.p("api.github.com", "GET", "/repos/Octo/Repo"), ("octo/repo", "api", None))
        self.assertEqual(self.p("api.github.com", "GET", "/repos/octo/repo/contents/a/b.md?ref=main"),
                         ("octo/repo", "api", None))
        for path in ["/user", "/repositories/123/contents", "/repos/octo", "/repos/octo/repo.git",
                     "/repos/../x/y", "/graphql", "/search/code?q=x"]:
            with self.subTest(path=path):
                self.assertIsNone(self.p("api.github.com", "GET", path))
        self.assertTrue(gh.is_archive_api_path("/repos/octo/repo/tarball/main"))
        self.assertTrue(gh.is_archive_api_path("/repos/octo/repo/zipball"))
        self.assertFalse(gh.is_archive_api_path("/repos/octo/repo/contents/tarball"))

    def test_raw_and_codeload(self):
        self.assertEqual(self.p("raw.githubusercontent.com", "GET", "/octo/repo/main/README.md"),
                         ("octo/repo", "raw", None))
        self.assertEqual(self.p("raw.githubusercontent.com", "GET", "/octo/repo/refs/heads/main/a/b.txt"),
                         ("octo/repo", "raw", None))
        self.assertIsNone(self.p("raw.githubusercontent.com", "GET", "/octo/repo/main"))
        self.assertIsNone(self.p("raw.githubusercontent.com", "GET", "/octo/repo/main/"))
        self.assertEqual(self.p("codeload.github.com", "GET", "/octo/repo/tar.gz/refs/heads/main"),
                         ("octo/repo", "codeload", None))
        self.assertIsNone(self.p("codeload.github.com", "GET", "/octo/repo/blob/main"))
        self.assertIsNone(self.p("evil.example", "GET", "/octo/repo/main/README.md"))
        self.assertIsNone(self.p("gist.github.com", "GET", "/octo/abc"))

    def test_credential_allowed(self):
        r = lambda h, m, p: gh.parse_repo_request(h, m, p)  # noqa: E731
        self.assertTrue(gh.credential_allowed(r("github.com", "POST", "/o/r/git-upload-pack"), "POST", "/o/r/git-upload-pack"))
        self.assertTrue(gh.credential_allowed(r("api.github.com", "GET", "/repos/o/r/issues"), "GET", "/repos/o/r/issues"))
        self.assertFalse(gh.credential_allowed(r("api.github.com", "POST", "/repos/o/r/issues"), "POST", "/repos/o/r/issues"))
        self.assertFalse(gh.credential_allowed(r("api.github.com", "GET", "/repos/o/r/tarball/main"), "GET", "/repos/o/r/tarball/main"))
        self.assertTrue(gh.credential_allowed(r("raw.githubusercontent.com", "GET", "/o/r/main/x"), "GET", "/o/r/main/x"))
        self.assertFalse(gh.credential_allowed(r("codeload.github.com", "GET", "/o/r/zip/main"), "GET", "/o/r/zip/main"))
        w = r("github.com", "POST", "/o/r/git-receive-pack")
        self.assertFalse(gh.credential_allowed(w, "POST", "/o/r/git-receive-pack"))


class HeaderTests(unittest.TestCase):
    def test_forms(self):
        v = gh.auth_header_value("github.com", "ghs_abc")
        self.assertTrue(v.startswith("Basic "))
        self.assertEqual(base64.b64decode(v[6:]).decode(), "x-access-token:ghs_abc")
        self.assertEqual(gh.auth_header_value("api.github.com", "ghs_abc"), "Bearer ghs_abc")
        self.assertEqual(gh.auth_header_value("raw.githubusercontent.com", "ghs_abc"), "token ghs_abc")
        self.assertIn("authorization", gh.GUEST_AUTH_HEADERS)

    def test_scrub(self):
        body = b'{"download_url":"https://raw.githubusercontent.com/o/r/main/a?token=GHSAT0AAA.b-c","x":"?q=1&token=Z9"}'
        out, n = gh.scrub_download_tokens(body)
        self.assertEqual(n, 2)
        self.assertNotIn(b"GHSAT0AAA", out)
        self.assertNotIn(b"Z9", out)
        self.assertIn(b"?q=1&token=REDACTED", out)
        self.assertEqual(gh.scrub_download_tokens(b"no tokens here")[1], 0)

    def test_messages(self):
        req = gh.RepoRequest("octo", "secret", "git-read", "git-upload-pack")
        self.assertIn("install the App", gh.denial_message(req, "not-installed", True))
        self.assertIn("not enabled for this account", gh.denial_message(req, "not-installed", False))
        self.assertIn("not enabled in this sandbox", gh.denial_message(req, "push", True))
        self.assertIn("too many", gh.denial_message(req, "rate-limited", True))
        for reason in ("not-installed", "error", "refused", "rate-limited"):
            self.assertIn("github.com/octo/secret", gh.denial_message(req, reason, True))


class FakeGitHub:
    """GitHub's App endpoints: installations per owner, repos per installation."""

    def __init__(self, public_key, installs):
        self.public_key = public_key
        self.installs = installs  # installation id -> (owner, {repos})
        self.calls = []
        self.fail_mint = None
        self.n = 0

    def verify_jwt(self, auth):
        assert auth.startswith("Bearer ")
        h, p, s = auth[7:].split(".")
        pad = lambda x: x + "=" * (-len(x) % 4)  # noqa: E731
        self.public_key.verify(base64.urlsafe_b64decode(pad(s)), f"{h}.{p}".encode(), padding.PKCS1v15(), hashes.SHA256())
        assert json.loads(base64.urlsafe_b64decode(pad(h))) == {"alg": "RS256", "typ": "JWT"}
        claims = json.loads(base64.urlsafe_b64decode(pad(p)))
        assert claims["iss"] == "12345" and claims["exp"] - claims["iat"] <= 600
        return claims

    async def __call__(self, method, url, headers, body):
        self.calls.append((method, url))
        self.verify_jwt(headers["Authorization"])
        path = url.split("://", 1)[1].split("/", 1)[1]
        parts = path.split("/")
        if method == "GET" and parts[0] == "repos" and parts[3] == "installation":
            for iid, (owner, repos) in self.installs.items():
                if owner == parts[1] and parts[2] in repos:
                    return 200, {"id": iid}
            return 404, {"message": "Not Found"}
        if method == "POST" and parts[:2] == ["app", "installations"] and parts[3] == "access_tokens":
            if self.fail_mint:
                return self.fail_mint, {}
            req = json.loads(body)
            assert len(req["repositories"]) == 1, req
            assert req["permissions"] == {"contents": "read", "metadata": "read"}, req
            iid = int(parts[2])
            if req["repositories"][0] not in self.installs[iid][1]:
                return 422, {"message": "repository not in installation"}
            self.n += 1
            return 201, {"token": f"ghs_fake{self.n}", "expires_at": "2030-01-01T01:00:00Z",
                         "repositories": [{"name": req["repositories"][0]}]}
        return 404, {}


class AppTests(unittest.TestCase):
    def setUp(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.dir = tempfile.mkdtemp()
        self.key_file = os.path.join(self.dir, "app.pem")
        with open(self.key_file, "wb") as f:
            f.write(self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                           serialization.NoEncryption()))
        self.now = 1893456000.0  # 2030-01-01T00:00:00Z
        self.fake = FakeGitHub(self.key.public_key(), {7: ("octo", {"private", "other"})})
        self.app = gh.GitHubApp({"app_id": 12345, "private_key_file": self.key_file, "api_url": "https://api.test"},
                                http=self.fake, clock=lambda: self.now)

    def run_(self, coro):
        return asyncio.run(coro)

    def test_requires_config(self):
        with self.assertRaises(ValueError):
            gh.GitHubApp({"app_id": 1})
        with self.assertRaises(ValueError):
            gh.GitHubApp({"app_id": 1, "private_key_file": "x", "permissions": {"workflows": "write"}})

    def test_mint_scoped_and_cached(self):
        r = self.run_(self.app.token_for("octo", "private"))
        self.assertEqual((r.token, r.reason, r.installation_id, r.cached), ("ghs_fake1", "app", 7, False))
        self.assertEqual(self.fake.calls, [("GET", "https://api.test/repos/octo/private/installation"),
                                           ("POST", "https://api.test/app/installations/7/access_tokens")])
        # cached: no new GitHub calls
        r = self.run_(self.app.token_for("octo", "private"))
        self.assertEqual((r.token, r.cached), ("ghs_fake1", True))
        self.assertEqual(len(self.fake.calls), 2)
        # another repo in the same installation: its own token (no shared token across repos)
        r = self.run_(self.app.token_for("octo", "other"))
        self.assertEqual(r.token, "ghs_fake2")
        self.assertEqual(self.app.mints, 2)

    def test_refresh_before_expiry(self):
        self.run_(self.app.token_for("octo", "private"))
        self.now += 3600 - 301  # still 301 s left: cached
        self.assertTrue(self.run_(self.app.token_for("octo", "private")).cached)
        self.now += 2  # 299 s left: inside the 300 s margin, minted again
        r = self.run_(self.app.token_for("octo", "private"))
        self.assertEqual((r.token, r.cached), ("ghs_fake2", False))
        # the installation lookup is cached (1 h), only the mint repeats
        self.assertEqual([c[0] for c in self.fake.calls], ["GET", "POST", "POST"])

    def test_needs_api(self):
        self.assertTrue(self.app.needs_api("octo/private"))
        self.run_(self.app.token_for("octo", "private"))
        self.assertFalse(self.app.needs_api("octo/private"))  # cached token
        self.run_(self.app.token_for("someone", "x"))
        self.assertFalse(self.app.needs_api("someone/x"))  # remembered failure
        self.now += 61
        self.assertTrue(self.app.needs_api("someone/x"))

    def test_forget(self):
        self.run_(self.app.token_for("octo", "private"))
        self.app.forget("octo/private")
        self.assertEqual(self.run_(self.app.token_for("octo", "private")).token, "ghs_fake2")

    def test_not_installed_negative_cache(self):
        r = self.run_(self.app.token_for("someone", "public-repo"))
        self.assertEqual((r.token, r.reason), (None, "not-installed"))
        n = len(self.fake.calls)
        self.assertEqual(self.run_(self.app.token_for("someone", "public-repo")).reason, "not-installed")
        self.assertEqual(len(self.fake.calls), n)  # remembered
        self.now += 61
        self.fake.installs[8] = ("someone", {"public-repo"})  # installed later: picked up after the TTL
        self.assertEqual(self.run_(self.app.token_for("someone", "public-repo")).token, "ghs_fake1")

    def test_repo_not_in_installation(self):
        self.fake.installs = {7: ("octo", {"private"})}
        # The lookup says 404 for repos the installation does not include.
        self.assertEqual(self.run_(self.app.token_for("octo", "elsewhere")).reason, "not-installed")

    def test_mint_errors(self):
        self.fake.fail_mint = 500
        r = self.run_(self.app.token_for("octo", "private"))
        self.assertEqual((r.token, r.reason), (None, "error"))
        self.assertEqual(self.app.last_error, "GitHubAppError")
        self.fake.fail_mint = None
        self.now += 61
        self.assertEqual(self.run_(self.app.token_for("octo", "private")).reason, "app")

    def test_wrong_scope_from_github_is_not_used(self):
        async def bad(method, url, headers, body):
            if method == "GET":
                return 200, {"id": 7}
            return 201, {"token": "ghs_wide", "expires_at": "2030-01-01T01:00:00Z",
                         "repositories": [{"name": "private"}, {"name": "other"}]}
        app = gh.GitHubApp({"app_id": 12345, "private_key_file": self.key_file}, http=bad, clock=lambda: self.now)
        r = self.run_(app.token_for("octo", "private"))
        self.assertEqual((r.token, r.reason), (None, "mint-failed"))

    def test_concurrent_requests_mint_once(self):
        async def many():
            return await asyncio.gather(*[self.app.token_for("octo", "private") for _ in range(10)])
        results = self.run_(many())
        self.assertEqual({r.token for r in results}, {"ghs_fake1"})
        self.assertEqual(self.app.mints, 1)

    def test_jwt_cached_and_rotates(self):
        j1 = self.app.app_jwt()
        self.assertEqual(self.app.app_jwt(), j1)
        self.now += 481
        self.assertNotEqual(self.app.app_jwt(), j1)
        self.fake.verify_jwt("Bearer " + self.app.app_jwt())


if __name__ == "__main__":
    unittest.main()
