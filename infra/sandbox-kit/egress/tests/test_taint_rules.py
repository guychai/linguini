"""Unit tests for the proxy's allowWhenTainted guard (addon/sandbox_egress.py taint_exempt).

  "$EGRESS_VENV/bin/python" -m unittest discover -s tests -p 'test_*.py'   (needs mitmproxy)
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "addon"))
import sandbox_egress as se  # noqa: E402


class TaintExemptTests(unittest.TestCase):
    def test_flag_required(self):
        self.assertFalse(se.taint_exempt({"host": "cdn.example"}))
        self.assertFalse(se.taint_exempt({"host": "cdn.example", "allowWhenTainted": False}))
        self.assertFalse(se.taint_exempt({"host": "cdn.example", "allowWhenTainted": "yes"}))
        self.assertTrue(se.taint_exempt({"host": "cdn.example", "allowWhenTainted": True}))

    def test_registries_and_code_hosts_refused(self):
        for host in ("github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com",
                     "objects.githubusercontent.com", "ghcr.io", "registry.npmjs.org", "registry.yarnpkg.com",
                     "pypi.org", "files.pythonhosted.org", "registry-1.docker.io", "auth.docker.io",
                     "production.cloudflare.docker.com", "GitHub.com.", " API.GITHUB.COM "):
            self.assertFalse(se.taint_exempt({"host": host, "allowWhenTainted": True}), host)

    def test_lookalikes_are_not_suffix_matches(self):
        self.assertTrue(se.taint_exempt({"host": "notgithub.com", "allowWhenTainted": True}))
        self.assertTrue(se.taint_exempt({"host": "github.com.internal.example", "allowWhenTainted": True}))

    def test_wildcards_and_empty_refused(self):
        for host in ("*.example.com", "*.internal", "*", ""):
            self.assertFalse(se.taint_exempt({"host": host, "allowWhenTainted": True}), host)


if __name__ == "__main__":
    unittest.main()
