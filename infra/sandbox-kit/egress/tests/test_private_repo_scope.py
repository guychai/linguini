"""Q1 loosening: a conversation sensitive only from private-repo reads (policy taintScope
"private-repo") still GETs package registries; everything else stays closed.

  "$EGRESS_VENV/bin/python" -m unittest discover -s tests -p 'test_*.py'   (needs mitmproxy)
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "addon"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sandbox_egress as se  # noqa: E402
from test_request_limits import flow  # noqa: E402

KEY = "abcdefabcdef1234"
SRC = "10.200.0.2"
RULES = [
    {"host": "registry.npmjs.org"},
    {"host": "pypi.org"},
    {"host": "files.pythonhosted.org"},
    {"host": "registry-1.docker.io"},
    {"host": "*.docker.com"},
    {"host": "api.example"},
    {"host": "cdn.example", "allowWhenTainted": True},
]


class PrivateRepoScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        for sub in ("sources", "policies", "sensitive"):
            os.makedirs(os.path.join(d, sub))
        with open(os.path.join(d, "sources", SRC), "w") as f:
            f.write(KEY)
        self.addon = se.SandboxEgress()
        self.addon.cfg = {"sources_dir": os.path.join(d, "sources"), "policy_dir": os.path.join(d, "policies"),
                          "sensitive_dir": os.path.join(d, "sensitive")}
        self.addon.open_web = {"enabled": True, "ports": [443], "max_url": 2048, "max_query": 512}
        self.addon.github = None
        self.addon.deny_hosts = []

    def tearDown(self):
        self.tmp.cleanup()

    def policy(self, **extra):
        with open(os.path.join(self.addon.cfg["policy_dir"], f"{KEY}.json"), "w") as f:
            json.dump({"version": 1, "conversationKey": KEY, "workspaceId": "w", "rules": RULES, **extra}, f)

    def decide(self, host, method="GET", path="/"):
        return self.addon.decide(SRC, host, 443, "https", method, path)

    def test_private_repo_scope_registry_reads_only(self):
        self.policy(tainted=True, taintScope="private-repo")
        for host in ("registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "registry-1.docker.io",
                     "production.cloudflare.docker.com"):
            d = self.decide(host, "GET", "/pkg")
            self.assertTrue(d.allow, host)
            self.assertEqual(d.reason, "tainted-registry-read")
            self.assertTrue(d.rule["_registry_read"])
            self.assertTrue(self.decide(host, "HEAD").allow, host)
            self.assertTrue(self.addon.decide(SRC, host, 443, "https").allow, host)  # CONNECT
            for m in ("POST", "PUT", "PATCH", "DELETE"):
                self.assertEqual(self.decide(host, m).reason, "tainted-registry-method", (host, m))
        # Other listed hosts and new hosts stay closed; allowWhenTainted hosts work as before.
        self.assertEqual(self.decide("api.example").reason, "tainted")
        self.assertEqual(self.decide("unlisted.example").reason, "tainted-new-host")
        self.assertEqual(self.decide("cdn.example").reason, "rule")

    def test_full_taint_keeps_registries_closed(self):
        self.policy(tainted=True)
        for host in ("registry.npmjs.org", "pypi.org", "registry-1.docker.io"):
            self.assertEqual(self.decide(host).reason, "tainted", host)
        self.policy(tainted=True, taintScope="something-else")
        self.assertEqual(self.decide("registry.npmjs.org").reason, "tainted")

    def test_clean_conversation_unchanged(self):
        self.policy(tainted=False)
        d = self.decide("registry.npmjs.org", "PUT")
        self.assertTrue(d.allow)
        self.assertEqual(d.reason, "rule")

    def test_proxy_marker_alone_is_private_repo_scope(self):
        self.policy(tainted=False)
        self.addon._mark_sensitive(KEY)
        self.assertEqual(self.decide("registry.npmjs.org").reason, "tainted-registry-read")
        self.assertEqual(self.decide("registry.npmjs.org", "PUT").reason, "tainted-registry-method")
        self.assertEqual(self.decide("api.example").reason, "tainted")

    def test_registry_read_caps_and_no_body(self):
        rule = {"host": "registry.npmjs.org", "maxUrl": 99999, "maxQuery": 99999, "_registry_read": True}
        self.assertIsNone(self.addon._limits(flow("/pkg?" + "a" * 500), rule))
        self.assertEqual(self.addon._limits(flow("/pkg?" + "a" * 513), rule), "query-too-long")
        self.assertEqual(self.addon._limits(flow("/" + "a" * 1025), rule), "url-too-long")
        self.assertEqual(self.addon._limits(flow("/x", headers={"content-length": "3"}), rule),
                         "tainted-registry-body")
        self.assertEqual(self.addon._limits(flow("/x", headers={"transfer-encoding": "chunked"}), rule),
                         "tainted-registry-body")


if __name__ == "__main__":
    unittest.main()
