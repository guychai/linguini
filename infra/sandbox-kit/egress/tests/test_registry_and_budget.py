"""Unit tests for the registry read-only rule and the open-web budget (addon/sandbox_egress.py).

  "$EGRESS_VENV/bin/python" -m unittest discover -s tests -p 'test_*.py'   (needs mitmproxy)
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "addon"))
import sandbox_egress as se  # noqa: E402


class RegistryHostTests(unittest.TestCase):
    def test_registries(self):
        for host in ("registry.npmjs.org", "www.npmjs.com", "registry.yarnpkg.com", "pypi.org",
                     "files.pythonhosted.org", "registry-1.docker.io", "auth.docker.io",
                     "production.cloudflare.docker.com", "PyPI.org.", " REGISTRY.NPMJS.ORG "):
            self.assertTrue(se.registry_host(host), host)

    def test_not_registries(self):
        for host in ("github.com", "notnpmjs.org", "pypi.org.evil.example", "example.com"):
            self.assertFalse(se.registry_host(host), host)


class OpenWebBudgetTests(unittest.TestCase):
    def proxy(self, **budget):
        p = se.SandboxEgress()
        p.open_web["budget"] = {**se.OPEN_WEB_BUDGET, **budget}
        return p

    def test_defaults(self):
        self.assertEqual(se.OPEN_WEB_BUDGET, {"requests": 300, "url_bytes": 256 * 1024, "hosts": 30, "window_s": 600})
        self.assertTrue(se.SandboxEgress().open_web["enabled"])

    def test_requests(self):
        p = self.proxy(requests=3)
        self.assertEqual([p._open_web_budget("k", "a.test", 10) for _ in range(4)],
                         [None, None, None, "budget-requests"])
        self.assertIsNone(p._open_web_budget("other", "a.test", 10))  # per conversation

    def test_url_bytes(self):
        p = self.proxy(url_bytes=100)
        self.assertIsNone(p._open_web_budget("k", "a.test", 60))
        self.assertEqual(p._open_web_budget("k", "a.test", 60), "budget-url-bytes")
        self.assertIsNone(p._open_web_budget("k", "a.test", 40))

    def test_hosts(self):
        p = self.proxy(hosts=2)
        self.assertIsNone(p._open_web_budget("k", "a.test", 1))
        self.assertIsNone(p._open_web_budget("k", "b.test", 1))
        self.assertEqual(p._open_web_budget("k", "c.test", 1), "budget-hosts")
        self.assertIsNone(p._open_web_budget("k", "a.test", 1))  # a host already used is fine

    def test_window_slides(self):
        p = self.proxy(requests=1, window_s=10)
        with mock.patch.object(se.time, "monotonic", return_value=100.0):
            self.assertIsNone(p._open_web_budget("k", "a.test", 1))
            self.assertEqual(p._open_web_budget("k", "a.test", 1), "budget-requests")
        with mock.patch.object(se.time, "monotonic", return_value=111.0):
            self.assertIsNone(p._open_web_budget("k", "a.test", 1))


if __name__ == "__main__":
    unittest.main()
