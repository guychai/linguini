"""github-app-create.py against a mock GitHub (no real App is created): the manifest page, the
state check, the code exchange, and the key written 0600 and never printed."""

import json
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "github-app-create.py")
MANIFEST = os.path.join(HERE, "..", "github-app-manifest.json")
PEM = "-----BEGIN RSA PRIVATE KEY-----\nTESTKEYNOTREAL\n-----END RSA PRIVATE KEY-----\n"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Conversions(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        Conversions.seen.append(self.path)
        body = json.dumps({"id": 777, "slug": "linguini-test", "html_url": "https://github.com/apps/linguini-test",
                           "owner": {"login": "guychai"}, "pem": PEM, "client_secret": "cs-SECRET",
                           "webhook_secret": "wh-SECRET"}).encode()
        self.send_response(201)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class CreateTests(unittest.TestCase):
    def test_manifest_is_private_read_only(self):
        m = json.load(open(MANIFEST))
        self.assertIs(m["public"], False)
        self.assertEqual(m["default_permissions"], {"contents": "read", "metadata": "read"})
        self.assertFalse(m["hook_attributes"]["active"])
        self.assertEqual(m["default_events"], [])

    def test_flow(self):
        api = ThreadingHTTPServer(("127.0.0.1", 0), Conversions)
        threading.Thread(target=api.serve_forever, daemon=True).start()
        port = free_port()
        out = os.path.join(tempfile.mkdtemp(), "app.pem")
        proc = subprocess.Popen([sys.executable, SCRIPT, "--out", out, "--port", str(port), "--no-browser",
                                 "--api-url", f"http://127.0.0.1:{api.server_address[1]}"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            for _ in range(100):
                try:
                    page = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read().decode()
                    break
                except OSError:
                    time.sleep(0.05)
            self.assertIn('action="https://github.com/settings/apps/new?state=', page)
            self.assertIn(f"http://127.0.0.1:{port}/callback", page)
            state = re.search(r"state=([A-Za-z0-9_-]+)", page).group(1)
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/callback?code=abc&state=wrong", timeout=5)
            self.assertEqual(e.exception.code, 400)
            done = urllib.request.urlopen(f"http://127.0.0.1:{port}/callback?code=abc&state={state}", timeout=5).read()
            self.assertIn(b"App ID 777", done)
            stdout, _ = proc.communicate(timeout=10)
        finally:
            proc.kill()
            api.shutdown()
        self.assertEqual(proc.returncode, 0, stdout)
        self.assertEqual(Conversions.seen, ["/app-manifests/abc/conversions"])
        self.assertEqual(open(out).read(), PEM)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertIn('"app_id": 777', stdout)
        for secret in ("TESTKEYNOTREAL", "cs-SECRET", "wh-SECRET"):
            self.assertNotIn(secret, stdout)


if __name__ == "__main__":
    unittest.main()
