# Hosting on a single node (tailnet only)

Placeholders: `<host-ip>` = the node's Tailscale IPv4 (`OWN_HOST` in `agent-platform.env`), `<service>` = your Tailscale Service name, `<tailnet>` = your tailnet's MagicDNS name (`<tailnet>.ts.net`). Set them in `/etc/agent-platform/agent-platform.env` before starting the service.

- `agent-platform.service`: owned Pi/Postgres backend serving the T3 UI, user `agentplat`, bound to the Tailscale IP only (`OWN_HOST`). Config `agent-platform.env` (non-secret, `/etc/agent-platform/`), secrets `/etc/agent-platform/secrets.env` (root 0600, `ANTHROPIC_API_KEY` and `BETTER_AUTH_SECRET`, plus the S3 keys below; written via stdin over ssh, never in git). Auth defaults to `AUTH_MODE=better-auth` (accounts, `BETTER_AUTH_URL`, `ADMIN_EMAILS`, `SIGNUP_ENABLED=false` except while creating accounts); `AUTH_MODE=tailnet` (no sign-in, tailnet access = owner) is for single-user nodes only. Browser requests with a session cookie (or tailnet identity) must be `Sec-Fetch-Site: same-origin` and carry `X-Linguini-Client: 1` (the web client adds it); terminal WebSocket upgrades instead need an `Origin` matching the Host (browsers send no Sec-Fetch-Site there); bearer-token clients are exempt.
- `nomad.service`: persistent single-node Nomad (server+client, loopback, `/var/lib/nomad`), configs `/etc/nomad.d/{kit.hcl,server.hcl}`.
- Postgres: distro `postgresql`, localhost only, db/role `agentplat` via peer auth on the unix socket.
- `10-setup-host.sh`: Node 24, account, app tree at `/opt/agent-platform` (`prototypes/runtime`, `web`, `infra/sandbox-kit/nomad/hands.job.json`), Postgres, owner token, Nomad config.
- Egress backend rights: run `infra/sandbox-kit/linux/45-egress.sh` with `EGRESS_BACKEND_USER=agentplat` so the sudoers netctl rule, the sandbox-egress group and the policy dir belong to the service user (the default is the user running the installer).
- Model: `PI_MODEL=claude-opus-5-5`, `PI_THINKING_LEVEL=medium` (Pi maps it to Anthropic adaptive thinking `output_config.effort=medium`).
- Harness: Pi Durable only (`prototypes/runtime/DESIGN-durable.md`), Node >= 22.19. Transcripts are append-only logs in the `agentplat` database (`prototype_durable_log`), fenced by the conversation lease; nothing is kept on disk, so the database backup covers them. Code mode is on (`PI_DURABLE_CODEMODE=0` turns it off). `HARNESS_MODE` must stay unset (`fixture` is for tests). Upgrading from the Pi harness: wipe the database; old threads are not migrated.
- Idle stop: `SANDBOX_IDLE_TIMEOUT` (`15m` by default here; `30s`, `off`). A sandbox is stopped when its conversation has no queued/running turn and no journal activity (prompts, tool calls/results) for that long; the check and the move to `stopping` are one row-locked step, so a turn in progress is never cut. The next tool call allocates a fresh generation (an in-flight stop is awaited, not failed). The stop goes through `SandboxSuspender` (`prototypes/runtime/src/idle.ts`): today `StopOnIdle` (workspace contents are lost). **Hook for the real platform:** replace it with a suspender that dumps selected sandbox paths to S3-compatible storage before stopping, plus a matching restore before the first tool call of the next generation (not built).
- Terminals (T3 drawer): the shell runs inside the conversation's Kata sandbox through Nomad's exec WebSocket with a TTY (`prototypes/runtime/src/terminal.ts`, `nomad-exec.ts`); the backend's environment is never passed (exec gets only the sandbox task env). User-only: Pi never sees terminal I/O; egress is the same allowlist as tools. Opening provisions the sandbox. Scrollback is a 256 KiB in-memory ring per terminal; shells end on backend restart or sandbox stop. Limits `TERMINALS_PER_CONVERSATION` (4) and `TERMINALS_PER_NODE` (16). Idle: an attached terminal used within `SANDBOX_IDLE_TIMEOUT` keeps the sandbox, at most `TERMINAL_KEEPALIVE_CAP` (2h) past the conversation's last journal activity. Browser API: POST `/api/conversations/:id/terminal/{open,write,resize,clear,restart,close}` and WebSocket `/api/terminal-stream?kind=attach|observe|metadata|events` (token mode: subprotocol `t3.bearer.<token>`). Non-GET requests and WebSocket upgrades must carry no Origin or an Origin whose host equals Host (Tailscale serve forwards it), or one listed in `OWN_ALLOWED_ORIGINS`. Logs: open/close/exit with byte counts only.
- HTTPS via a Tailscale Service `svc:<service>` (Tailscale ≥ 1.104, tagged node):
  `sudo tailscale serve --service=svc:<service> --https=443 http://<host-ip>:43220` (persisted by tailscaled;
  check `sudo tailscale serve status`; remove with `sudo tailscale serve clear svc:<service>`). URL
  `https://<service>.<tailnet>.ts.net/` once an admin approves the node as a host of the service (admin console →
  Services → <service>). HTTPS is a secure context, so the insecure-context fallbacks are not used there. The
  backend has no Host/Origin allowlist, so the service hostname needs no app change. The tailnet-IP bind stays.
- The service gets its own VIP (a Tailscale address separate from `<host-ip>`). A service definition can only be deleted in the Tailscale admin UI. Clients need an ACL/grant to reach the service VIP; MagicDNS only resolves the name for clients that are allowed.
- Default egress allowlist: `EGRESS_DEFAULT_RULES_FILE=/etc/agent-platform/egress-default-rules.json` (copy in `infra/hosting/egress-default-rules.json`). Prepended to every conversation's policy, before per-owner `EGRESS_RULES_FILE` rules. npm, PyPI, GitHub (github.com, codeload, objects/raw.githubusercontent, api), Docker Hub (registry-1, auth, production.cloudflare/cloudfront.docker.com), each `methods: ["GET","HEAD"]`, no injection. The mitmproxy addon enforces `methods` (403 `method-not-allowed`). Docker uses HEAD for manifests. The rules apply on the conversation's next tool call (policy rewritten before each call).
- Git: the default rules include `{ "host": "github.com", "methods": ["POST"], "paths": ["/*/*/git-upload-pack", "/*/*.git/git-upload-pack"] }` next to GET on github.com, so HTTPS clone/fetch of public repositories works (GitHub has no dumb HTTP). Push is refused by the proxy itself (403 `git-push-not-enabled`, both `info/refs?service=git-receive-pack` and `git-receive-pack`), whatever the rules say. Private repositories: the proxy mints a token per repository from the Linguini GitHub App for owners in `GITHUB_APP_OWNERS`; the guest's own GitHub credentials are always dropped. Setup and details: `infra/sandbox-kit/egress/GITHUB.md`.
- The inner-docker CA for nested containers is `/local/egress-ca.pem` in the sandbox (mount it and set NODE_EXTRA_CA_CERTS / pip --cert / npm cafile).
- Egress rule `paths` (addon): globs where `*` = one segment, `**` = any; combined with `methods`. Several rules per host are alternatives; the first whose methods and paths both match wins (deny reasons `method-not-allowed` / `path-not-allowed`). Path-restricted rules never match ambiguous paths (dot segments, `//`, encoded `/` `\\` `.`). Tests: `tests/proxy-test.sh` (43 checks).
- Note: restarting `sandbox-egress` is safe for policies/sources on disk, but running sandboxes briefly lose egress during the restart.
- Workspace persistence (`SANDBOX_PERSISTENCE=s3`, `prototypes/runtime/src/persistence.ts`): on idle stop, `S3SandboxSuspender` stops the inner containers (graceful), tars+gzips `/workspace` and the inner Docker named volumes (with labels) inside the sandbox, streams it out over `nomad alloc exec`, gunzip-checks it and uploads it in one PUT to `s3://linguini-sandboxes/sandboxes/<workspaceId>/workspace.tar.gz`, then stops. The next generation restores it (NomadKataHands `afterReady`) before any tool call or terminal sees the sandbox; only snapshots from an older generation are applied. Not persisted: running processes/containers, pulled images, mise installs outside /workspace, terminal scrollback. A failed save keeps the sandbox and retries on the next sweep (stops anyway after 3); a failed restore records `workspace.restore_failed` (amber banner in the UI), writes /workspace/RESTORE_FAILED.md, and the next save goes beside the good copy instead of over it. Any other value of `SANDBOX_PERSISTENCE` keeps `StopOnIdle`; if S3 is unreachable at startup the backend logs it and falls back to `StopOnIdle`.
- Storage: SeaweedFS in Docker (`seaweedfs/compose.yml`, named volume `linguini-s3_seaweedfs-data`, S3 on 127.0.0.1:8333 only) run by `linguini-s3.service`; `40-seaweedfs.sh` installs it and generates the S3 keys into secrets.env (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) plus the SeaweedFS identity file (`/etc/agent-platform/seaweedfs-s3.json`, uid 1000, 0400). Local dev: `cd infra/hosting/seaweedfs && cp s3.example.json s3.json && docker compose up -d`, then set `SANDBOX_PERSISTENCE=s3 S3_ENDPOINT=http://127.0.0.1:8333 S3_ACCESS_KEY_ID=local-dev-key S3_SECRET_ACCESS_KEY=local-dev-secret-change-me`.
- E2E: `prototypes/runtime/scripts/e2e-persistence.ts e2e-persist-<n>` run as agentplat with the service env (systemd-run); it uses its own conversation, then delete that conversation by SQL.
- Preview ports (`PREVIEW_PUBLIC_ORIGIN`, `prototypes/runtime/src/preview.ts`): `https://<service>.<tailnet>.ts.net/preview/<conversationId>/<port>/…` forwards HTTP and WebSocket to that conversation's own sandbox address (host → sandbox bridge IP, validated 10.x) on ports the conversation shared; anything else is 404. Shares live in `prototype_preview_ports` (conversation_id, owner, port, label, csp_sandbox always true (legacy column), created_at; created only if missing, ON DELETE CASCADE). Pi uses the `share_port` / `unshare_port` tools; the UI shows a Preview chip (open / ×) and `POST|GET /api/conversations/:id/previews`, `DELETE …/previews/:port`. Forwarded requests lose Cookie (except the preview's own `lpv_*` cookies), Authorization, Tailscale identity and X-Forwarded-* headers; responses always get `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob:; form-action 'self'; base-uri 'self'; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline' data: blob:` (`PREVIEW_CSP`; no opt-out; the page's requests stay on the preview itself) and lose `Service-Worker-Allowed` / `Clear-Site-Data`, `Referrer-Policy: same-origin`, Set-Cookie renamed to `lpv_*` and path-scoped to the preview, and root-relative redirects kept inside the prefix. Linguini's API and terminal WebSocket refuse requests with `Origin: null` or a `/preview/` Referer. The sandbox gets `/etc/linguini/preview.env` (PREVIEW_BASE_URL, PREVIEW_BASE_URL_<port>; sourced by the bash tool, login shells and .bashrc) and `preview-url <port>`. Opening a preview starts a stopped sandbox; preview requests within the idle window or an open preview WebSocket keep it alive up to `TERMINAL_KEEPALIVE_CAP` (2h). The app must listen on 0.0.0.0. Previews need a signed-in user who can see the conversation; a deleted conversation's previews answer 404 and open preview connections close within `goneRecheckMs` (5 s).
- Visual replies (`html_preview` / `html_render`, `prototypes/runtime/src/{visual,html-render,render-browser,render-worker}.ts`): upstream T3's tool names and result shapes, so upstream's `HtmlRenderFrame` card shows them unchanged (the owned web answers its `assets.createUrl` with `POST /api/renders/url`). Pages are rendered by `linguini-render.service` (`50-render-worker.sh`): Chrome for Testing's headless shell (pinned version + sha256, `/opt/chrome-headless-shell/current`; Ubuntu's chromium is a snap) as system user `linguini-render`, Chrome's sandbox on, a fresh profile per job, CDP over `--remote-debugging-pipe` (no port), `PrivateNetwork=yes`, socket `/run/linguini-render/render.sock` (0660, group linguini-render; the backend joins that group via `SupplementaryGroups`). The backend never runs Chromium (`RENDER_IN_PROCESS=1` is for local single-user dev only). No network: in the render browser every request except the page itself is failed by Fetch interception (plus a dead proxy, a resolver that resolves nothing and no RTCPeerConnection); pages are served with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms` (no allow-popups / allow-same-origin), nosniff, no referrer, never Service-Worker-Allowed / Clear-Site-Data. The app's own CSP allows frames only from `<host>/render/`. Images: absolute `/workspace/...` paths in the page are read from the conversation's own sandbox through the files API (realpath-confined to /workspace, image bytes checked) and inlined; nothing is read from the host. Storage: `prototype_html_renders` (owner, conversation, page, bytes; ON DELETE CASCADE with the conversation; `RENDER_QUOTA_MB` per user, default 200). URLs: `/render/<id>.html?c=<conversation>&e=<expiry>&s=<HMAC>` (1 h, key derived from `BETTER_AUTH_SECRET`), checked against the row's owner and conversation, a live conversation, and (cookie/tailnet) the signed-in user being that owner. Limits: 512k characters of HTML, 5 MiB per image, 8 MiB per page, 32 images, 20 s per job, `RENDER_CONCURRENCY` (2, node) and `RENDER_PER_USER_CONCURRENCY` (1) with short queues. Screenshots go to the model only; the ledger/journal keep the text result.
- Deploy (patch layout): from a clean checkout, `DEV_SSH=<user>@<host-ip> DEV_SSH_KEY=<key> infra/hosting/deploy-dev.sh`. It assembles the tree in a temp dir, builds owned-web there, and ships the runtime, infra/hosting and the web build. `deploy-node.sh` then runs on the node:
  - Activity check: a running sandbox, or journal events in the last `ACTIVE_MINUTES` (10), blocks a backend restart unless `FORCE=1`. A web-only change still deploys.
  - Backup: pg_dump, runtime src/scripts/package files, web and `DEPLOYED_COMMIT` go to `/opt/agent-platform/backup-<ts>-deploy`.
  - Install: runtime files are rsynced. `npm ci` runs only when package*.json changed, and the backend restarts only when runtime files changed. The web goes in as a new directory that keeps the old hashed assets, so open tabs keep working.
  - Checks: `/health` and the served index.html. A failed check restores the backup automatically.
  - `DEPLOYED_COMMIT` gets `commit=` (ours), `upstream_tag=` (when pinned to a release), `upstream_pin=`, `assembled_tree=`, `deployed=` and `backend_restarted=`.
  - Units and the env file are not installed; it says when they differ. `DRY_RUN=1` stops after the checks.

## External links

Links in replies never point straight out. The web UI rewrites every external http(s) link to
`/out?u=<url>` (`apps/web/src/lib/externalLinks.ts`), and the runtime serves a click-through page
there (`prototypes/runtime/src/out.ts`): it shows the full URL with the host called out, and
leaves only when the user clicks Continue (no redirect, no script, `Referrer-Policy:
no-referrer`). Other schemes are dropped; generated images stay blocked.

## Host tools, entitlements and Trino

- Host tools (`prototypes/runtime/src/host-tools.ts`) run on the backend, not in the sandbox:
  share_port / unshare_port, html_preview / html_render, trino_query and
  github_create_pr. Each declares the kinds of place it may write; the broker checks the
  concrete destinations before the ledger intent and again inside it (403 `destination_denied`).
  There is no sensitive-thread state.
- Entitlements (`entitlements.ts`) are on whenever `AUTH_MODE=better-auth`; `ENTITLEMENTS=0`
  turns them off. trino_query, github_create_pr, MCP servers and GitHub reads (scope
  `github_read`, which replaces `GITHUB_APP_OWNERS` in this mode) need an allow. Admins edit the
  org/role/user rules with `GET/PUT /api/admin/entitlements`; users see theirs at
  `GET /api/me/entitlements`. Precedence: org deny > project deny > role/user deny > user allow >
  role allow > org allow.
- Seeding: `ENTITLEMENTS_SEED_FILE` points at a JSON rule list applied at startup only while
  there are no admin rules. `entitlements.dev.json` allows the three gated objects for the
  `admin` role, for the dev box.
- trino_query is a placeholder: `TRINO_MODE=fake` offers it with an in-memory catalog, queried
  as the user's email local part (no email: refused). `TRINO_URL`'s host is added to the sandbox
  deny list (`EGRESS_DENY_HOSTS`), so no egress rule may admit it.

## GitHub publishing (github_create_pr)

- Two GitHub Apps. The reader App (egress proxy) stays read-only on all repos; the **publishing
  App** (`GITHUB_PUBLISH_APP_ID`, `GITHUB_PUBLISH_KEY_FILE`, `GITHUB_PUBLISH_REPOS`) has contents
  + pull requests write and metadata read, no workflows, and is installed on selected repos. Its
  key is readable only by the backend user. Unset: no tool. Public repos clone anonymously and
  need neither App.
- The tool reads the change set out of the sandbox (merge base with `origin/<base>`, untracked
  files included, the user's index untouched), then creates blobs, tree, commit, a
  `linguini/<slug>-<exec>` branch and the PR through the API with a token minted for that one
  repo. The sandbox never pushes.
- Refused: repos outside the allowlist (403 `destination_denied`), repos GitHub reports as
  public (403 `github_public_repo`), `.github/workflows` changes, change sets with a well-known
  credential format (422 `github_secret_in_changes`, same patterns as the egress proxy), and
  users without the `github_create_pr` entitlement.
- Co-author: `Co-authored-by: <display name> <login email>`. Convention: a user's login email is
  their GitHub email; there is no account linking or lookup. No email: no trailer.

## Projects

- On whenever `AUTH_MODE=better-auth` (no flag). Tables `prototype_projects*` and
  `prototype_project_store` are created at startup. Managed in Settings → Projects (upstream
  T3 has no project-management UI for a hosted backend); T3's sidebar labels project threads
  with the project's name.
- Roles: owner (members, invites by email of an existing user, join link, archive), editor (new
  threads in the project, write the project store), viewer (read). Join links default to viewer;
  resetting one revokes the old link.
- Members read each other's project threads read-only
  (`GET /api/projects/:id/threads/:owner/:conv`); a member never drives another member's thread,
  terminal or sandbox. Turns that used an entitled data tool (`trino_query`) are hidden whole
  from members without that entitlement (project-scoped rules apply).
- Member previews: a signed-in project member may open another member's shared preview port; no
  grant cookie is issued and access is re-checked while the connection lives.
- Project store: text artifacts copied (not mounted) into a thread's
  `/workspace/.project/<name>` on grant.
