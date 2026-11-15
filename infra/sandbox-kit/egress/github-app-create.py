#!/usr/bin/env python3
"""Create the Linguini GitHub App from github-app-manifest.json (GitHub's manifest flow).

Run it on your own computer (stdlib only), signed in to GitHub in your browser as the account that
should own the App:

    python3 github-app-create.py --out ./linguini-github-app.pem          # personal account
    python3 github-app-create.py --org my-org --out ./linguini-github-app.pem

It serves a page on http://127.0.0.1:8719/ that posts the manifest to GitHub. You review and click
"Create GitHub App"; GitHub redirects back here with a one-time code, which this script exchanges
(POST /app-manifests/{code}/conversions) for the App's ID and private key. The key is written to
--out (mode 0600) and never printed; the client secret and webhook secret are discarded (the App
uses neither). Then install the App and copy the key to the node (see GITHUB.md).
"""

from __future__ import annotations

import argparse
import html
import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))


def build_manifest(path: str, port: int, name: str | None) -> dict:
    with open(path) as f:
        manifest = json.load(f)
    manifest["redirect_url"] = f"http://127.0.0.1:{port}/callback"
    if name:
        manifest["name"] = name
    perms = manifest.get("default_permissions", {})
    if "workflows" in perms or manifest.get("public") is not False:
        raise SystemExit("refusing: the manifest must be private and must not request workflows")
    return manifest


def form_page(github: str, org: str | None, state: str, manifest: dict) -> bytes:
    target = (f"{github}/organizations/{org}/settings/apps/new" if org else f"{github}/settings/apps/new")
    return f"""<!doctype html><meta charset="utf-8"><title>Create the Linguini GitHub App</title>
<body style="font-family:system-ui;max-width:40em;margin:3em auto">
<h1>Create the Linguini GitHub App</h1>
<p>This sends the manifest below to GitHub. Review it there and click <b>Create GitHub App</b>.</p>
<form id="f" method="post" action="{html.escape(target)}?state={state}">
<input type="hidden" name="manifest" value="{html.escape(json.dumps(manifest))}">
<button type="submit">Continue to GitHub</button></form>
<pre>{html.escape(json.dumps(manifest, indent=2))}</pre></body>""".encode()


def convert(api: str, code: str) -> dict:
    req = urllib.request.Request(f"{api}/app-manifests/{code}/conversions", data=b"", method="POST",
                                 headers={"Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28",
                                          "User-Agent": "linguini-github-app-create"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def write_key(path: str, pem: str):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(pem)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True, help="where to write the App's private key (must not exist)")
    p.add_argument("--org", help="create the App under this organization instead of your account")
    p.add_argument("--name", help="App name (globally unique on GitHub; default from the manifest)")
    p.add_argument("--port", type=int, default=8719)
    p.add_argument("--manifest", default=os.path.join(HERE, "github-app-manifest.json"))
    p.add_argument("--github", default="https://github.com", help=argparse.SUPPRESS)
    p.add_argument("--api-url", default="https://api.github.com", help=argparse.SUPPRESS)
    p.add_argument("--no-browser", action="store_true")
    a = p.parse_args(argv)
    if os.path.exists(a.out):
        p.error(f"{a.out} exists; refusing to overwrite a key")
    manifest = build_manifest(a.manifest, a.port, a.name)
    state = secrets.token_urlsafe(24)
    result: dict = {}
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status: int, body: bytes, ctype="text/html; charset=utf-8"):
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/":
                return self._send(200, form_page(a.github, a.org, state, manifest))
            if url.path != "/callback":
                return self._send(404, b"not found")
            q = parse_qs(url.query)
            if q.get("state") != [state] or len(q.get("code", [])) != 1:
                return self._send(400, b"state mismatch or no code; start again from /")
            try:
                app = convert(a.api_url, q["code"][0])
                write_key(a.out, app["pem"])
            except (urllib.error.URLError, KeyError, ValueError, OSError) as e:
                result["error"] = f"{type(e).__name__}: {e}"
                done.set()
                return self._send(500, f"failed: {html.escape(result['error'])}".encode())
            result.update(id=app.get("id"), slug=app.get("slug"), html_url=app.get("html_url"),
                          owner=(app.get("owner") or {}).get("login"))
            done.set()
            self._send(200, f"""<!doctype html><meta charset="utf-8"><body style="font-family:system-ui">
<h1>Created {html.escape(str(result['slug']))}</h1><p>App ID {result['id']}. Private key written to
<code>{html.escape(os.path.abspath(a.out))}</code>. You can close this tab; next steps are in the terminal.</p>""".encode())

    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    start = f"http://127.0.0.1:{a.port}/"
    print(f"Open {start} (signed in to GitHub as the owner), review the App, click Create.")
    if not a.no_browser:
        webbrowser.open(start)
    try:
        done.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        server.shutdown()
    if "error" in result:
        print(f"Failed: {result['error']}", file=sys.stderr)
        return 1
    print(json.dumps({"app_id": result["id"], "slug": result["slug"], "owner": result["owner"],
                      "private_key_file": os.path.abspath(a.out)}, indent=2))
    print(f"Next: install it on the repositories Linguini may read: https://github.com/apps/{result['slug']}/installations/new")
    print("Then copy the key to the node and configure the proxy (infra/sandbox-kit/egress/GITHUB.md).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
