"""Unit tests for outbound secret scanning and the request caps (addon/sandbox_egress.py).

  "$EGRESS_VENV/bin/python" -m unittest discover -s tests -p 'test_*.py'   (needs mitmproxy)
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "addon"))
import sandbox_egress as se  # noqa: E402
from mitmproxy.test import tflow, tutils  # noqa: E402


def flow(path="/", method="GET", headers=None, content=b""):
    req = tutils.treq(method=method.encode(), path=path.encode(), content=content)
    req.headers.clear()
    for k, v in (headers or {}).items():
        req.headers[k] = v
    return tflow.tflow(req=req)


class ScanSecretsTests(unittest.TestCase):
    def test_patterns(self):
        cases = {
            "github-token": b"t=ghp_" + b"a" * 36,
            "aws-access-key": b"key AKIAABCDEFGHIJKLMNOP end",
            "slack-token": b"xoxb-1234567890-abcdef",
            "openai-style-key": b"Bearer sk-proj-" + b"x" * 40,
            "google-api-key": b"?key=AIza" + b"B" * 35,
            "private-key": b"-----BEGIN RSA PRIVATE KEY-----\nMII",
        }
        for rule, data in cases.items():
            self.assertEqual(se.scan_secrets(data, []), rule, rule)

    def test_clean_and_lookalikes(self):
        for data in (b"", b"GET /desk-" + b"a" * 40, b"ghp_short", b"AKIA123", b"hello world",
                     b"-----BEGIN PUBLIC KEY-----", b"want 0123456789abcdef0123456789abcdef01234567"):
            self.assertIsNone(se.scan_secrets(data, []), data)

    def test_exact_values(self):
        self.assertEqual(se.scan_secrets(b"x=opaque-node-secret-123", [b"opaque-node-secret-123"]), "node-secret")
        self.assertIsNone(se.scan_secrets(b"x=other", [b"opaque-node-secret-123"]))


class LimitsTests(unittest.TestCase):
    def setUp(self):
        self.addon = se.SandboxEgress()
        self.addon.open_web = {"enabled": True, "ports": [443], "max_url": 2048, "max_query": 512}

    def test_listed_defaults(self):
        rule = {"host": "api.example"}
        self.assertIsNone(self.addon._limits(flow("/x?" + "a" * 4000), rule))
        self.assertEqual(self.addon._limits(flow("/x?" + "a" * 4100), rule), "query-too-long")
        self.assertEqual(self.addon._limits(flow("/" + "a" * 8200), rule), "url-too-long")
        self.assertIsNone(self.addon._limits(flow("/x", "POST", {"content-length": "10"}), rule))

    def test_rule_overrides(self):
        rule = {"host": "api.example", "maxUrl": 100, "maxQuery": 10}
        self.assertEqual(self.addon._limits(flow("/x?" + "a" * 11), rule), "query-too-long")
        self.assertEqual(self.addon._limits(flow("/" + "a" * 101), rule), "url-too-long")

    def test_open_web(self):
        rule = se.OPEN_WEB_RULE
        self.assertIsNone(self.addon._limits(flow("/x?" + "a" * 500), rule))
        self.assertEqual(self.addon._limits(flow("/x?" + "a" * 513), rule), "query-too-long")
        self.assertEqual(self.addon._limits(flow("/" + "a" * 2049), rule), "url-too-long")
        self.assertEqual(self.addon._limits(flow("/x", headers={"content-length": "1"}), rule), "open-web-body")
        self.assertEqual(self.addon._limits(flow("/x", headers={"transfer-encoding": "chunked"}), rule),
                         "open-web-body")
        # an open-web request cannot widen its own caps with rule keys
        self.assertEqual(self.addon._limits(flow("/x?" + "a" * 513), dict(rule, maxQuery=9999)), "query-too-long")


if __name__ == "__main__":
    unittest.main()
