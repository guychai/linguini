# GitHub through the egress proxy

Sandboxes use plain `git` (and `curl` against the REST API) over HTTPS. They never hold GitHub
credentials. The egress proxy (`addon/sandbox_egress.py` + `addon/github_app.py`) decides and
authenticates every GitHub request on the node. Design: git-via-egress (phases 0 and 1: reads).

## What the proxy does

For `github.com`, `api.github.com`, `raw.githubusercontent.com` and `codeload.github.com`
(still subject to the conversation's allowlist rules and taint):

| Request | Result |
| --- | --- |
| Anything | The guest's `Authorization`, `Proxy-Authorization` and `Cookie` headers are dropped |
| Clone / fetch / ls-remote (`GET …/info/refs?service=git-upload-pack`, `POST …/git-upload-pack`) | Token for that one repository if the App can read it and the conversation is enabled; otherwise anonymous (public repositories work) |
| Push (`…/info/refs?service=git-receive-pack`, `POST …/git-receive-pack`) | Always 403 `git-push-not-enabled` (phase 2) |
| `GET api.github.com/repos/<owner>/<repo>/…` | Bearer token for that repository when available; `token=` download links in JSON bodies and redirects are redacted |
| `GET api.github.com/repos/<o>/<r>/tarball|zipball/…`, `codeload.github.com` | Never credentialed (the redirect URL would carry a download token into the sandbox): public only |
| `GET raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` | `token` header for that repository when available |
| Everything else on these hosts (`/user`, `/graphql`, `/search`, `/repositories/<id>`) | Anonymous |

Tokens:
- Minted by the proxy with the App's JWT: `GET /repos/{o}/{r}/installation`, then
  `POST /app/installations/{id}/access_tokens` with `repositories: [<repo>]` and
  `permissions: {contents: read, metadata: read}`. GitHub enforces that scope, so a token can never
  reach another repository even if the proxy's URL parsing were wrong.
- Cached per repository until 5 minutes before expiry (GitHub issues them for 1 hour). A "not
  installed" answer is remembered for 60 seconds, so a fresh installation is picked up within a
  minute.
- Never written to disk, logs, policies, responses or the sandbox.
- Each conversation may cause at most 100 uncached App lookups per 10 minutes (configurable), so
  a guest naming endless repositories cannot use up the App's API rate limit for everyone.

Failures the agent can read: a refused clone becomes `403` with a `text/plain` body, which git
prints as `remote: egress: github.com/<o>/<r>: not found, or private and the Linguini GitHub App
has no access to it. …` (no password prompt). The sandbox image also sets `GIT_TERMINAL_PROMPT=0`
and rewrites `git@github.com:` / `ssh://` URLs to HTTPS.

Who may use the App: the backend writes `"github": {"app": true}` into a conversation's policy
only for owners listed in `GITHUB_APP_OWNERS` (backend env; Better Auth user ids, comma-separated;
empty by default). The App acts as itself, not as the Linguini user, so every listed owner can read
every repository the App is installed on. Tainted conversations never get a token (and the default
rules give them no GitHub access at all).

Access log: every GitHub request is a line in the proxy's audit log with `sandbox` (the
conversation key), `repo`, `git_service`, `github` (`app` or `anonymous`) and `github_reason`
(`app`, `not-installed`, `app-disabled`, `error`, …). Never headers or tokens. For example:

```sh
sudo jq -c 'select(.repo) | {ts, sandbox, repo, method, git_service, github, github_reason, status}' \
  /var/log/sandbox-egress/audit.jsonl
```

## Setup (once, by the App owner)

1. **Create the App** from `github-app-manifest.json` (private, `contents: read` +
   `metadata: read`, no webhook, no events, no workflow permission). On your own computer, signed in
   to GitHub as the owner (guychai):

   ```sh
   python3 infra/sandbox-kit/egress/github-app-create.py --out ./linguini-github-app.pem
   ```

   It opens `http://127.0.0.1:8719/`, which posts the manifest to GitHub. Review, click
   **Create GitHub App**; GitHub redirects back, the script exchanges the code and writes the
   private key (0600) and prints the App ID. If the name is taken, add `--name <other>`. (Manual
   alternative: GitHub → Settings → Developer settings → GitHub Apps → New, with the manifest's
   values, then "Generate a private key".)
2. **Install it** (the script prints the link, `https://github.com/apps/<slug>/installations/new`):
   choose **Only select repositories** and pick the private repositories Linguini may read. Public
   repositories need no installation.
3. **Put the key on the node**, readable by the proxy only, then delete the local copy:

   ```sh
   scp ./linguini-github-app.pem <node>:/tmp/gh-app.pem
   ssh <node> 'sudo install -m 0640 -o root -g sandbox-egress /tmp/gh-app.pem /etc/sandbox-egress/github-app.pem && shred -u /tmp/gh-app.pem'
   shred -u ./linguini-github-app.pem   # or rm -P on macOS
   ```
4. **Configure the proxy**: add to `/etc/sandbox-egress/config.json` (root:sandbox-egress 0640):

   ```json
   "github_app": { "app_id": 123456, "private_key_file": "/etc/sandbox-egress/github-app.pem" }
   ```

   Optional keys: `api_url`, `permissions` (default read-only; `workflows` is refused),
   `refresh_margin_s` (300), `negative_ttl_s` (60), `timeout_s` (10),
   `conversation_budget` (`{"calls": 100, "window_s": 600}`: App API lookups one conversation
   may cause; beyond it, uncached repositories go anonymous with reason `rate-limited`).
5. **Install the addon and restart the proxy** (re-run `linux/45-egress.sh`, or copy
   `addon/sandbox_egress.py` and `addon/github_app.py` to `/opt/sandbox-egress/addon/` with
   `sudo install -m 0644`), then `sudo systemctl restart sandbox-egress`. Running sandboxes lose
   egress for the few seconds of the restart.
6. **Enable owners**: `GITHUB_APP_OWNERS=<your Linguini user id>` in
   `/etc/agent-platform/agent-platform.env`, restart the backend. Your user id:
   `sudo -u agentplat psql agentplat -Atc "select id from \"user\" where email = '<you>'"`.
   Policies are rewritten before each tool call, so it applies from the next call.

Rotate the key: generate a new one in the App settings, replace the file, restart
`sandbox-egress`, delete the old key on GitHub. Revoke everything: uninstall the App or delete the
key.

## Tests

- `tests/test_github_app.py`: URL parsing, header forms, token scrubbing, JWT, minting and caching
  against a mocked GitHub API (unit, no network).
- `tests/test_github_app_create.py`: the manifest flow against a mock GitHub.
- `tests/github-test.sh`: real git clients through the real proxy against a mock GitHub
  (`git http-backend`, App API): anonymous public clone, private clone with a repo-scoped token,
  token cache, readable failures, guest credentials ignored, push refused, API/raw injection,
  owner not enabled, taint, and nothing secret in the audit.

```sh
EGRESS_VENV=/path/to/venv "$EGRESS_VENV/bin/python" -m unittest discover -s tests -p 'test_*.py'
EGRESS_VENV=/path/to/venv bash tests/github-test.sh
```

## Not yet (phase 2+)

- Push to `linguini/*` branches (receive-pack command parsing, write tokens), the bot as commit
  author with the user as `Co-authored-by`, a typed `github_create_pr` tool replacing the 501
  `create_pr`/`publish` stubs, `git.pushed` journal events.
- Asking the user before reaching a repository (the audit's per-conversation `repo` lines are the
  input for that UI).
- LFS, GraphQL, `gh` CLI placeholder token.
