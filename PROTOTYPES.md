# T3 sandbox prototypes

Two development branches compare the boundary and maintenance tradeoffs:

| Branch                        | Runtime                                                                                                                                  | Maintenance cost                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prototype/full-t3-sandbox`   | Upstream T3 web UI, client runtime, Node backend, SQLite orchestration and Pi RPC adapter; a separate sandbox gateway                    | Small changes to upstream launch, authorization and setup/checkpoint paths, but every upstream transport, background task and new host tool needs boundary review. Upstream retains conversation orchestration and protocol ownership.                                                                                 |
| `prototype/t3-ui-own-backend` | Actual upstream T3 web UI and client runtime through a bounded transport adapter, with an owned Pi/Postgres backend and HTTP/SSE adapter | Own auth, durable commands, queue/recovery and streaming; a smaller host attack surface. Owns a compatibility projection and RPC allowlist while retaining the upstream shell, composer, transcript and connection supervision. Contract changes require adapter maintenance; upstream UI upgrades remain substantial. |

Upstream: <https://github.com/pingdotgg/t3code>, originally vendored at commit
`2c7a446e657e705c257db28540819f4c0115b2fc`; the current upstream base is recorded in
`UPSTREAM` (synced by merge commits). The initial vendor commit preserves
upstream source and MIT `LICENSE`, plus included third-party licenses and notices.
Pi is pinned to `@earendil-works/pi-coding-agent@1.1.0`, the Pi distribution used
by this T3 revision. Prototype additions are covered by the repository MIT license.

These are local prototypes, not a production multitenant service. The full T3
server is single-owner: use a separate T3 server, state directory and signing key
for each owner. Its gateway supports distinct scoped owners/conversations, but
T3's own project/thread database is not a multitenant authorization layer.
The owned backend authenticates owners with configured bearer-token bindings.
Do not expose either prototype directly to the public Internet.

## Full T3 startup

Use the existing checkout; cloud tasks are already isolated, so do not create a
worktree unless requested. Requires Node 24 and pnpm 11.10.0.

```sh
pnpm --filter t3... --filter @t3tools/web... --filter @t3tools/scripts... install --frozen-lockfile
npm ci --prefix prototypes/runtime
# Node 24 fetch uses the managed HTTP proxy when present; keep CA/TLS verification.
NODE_USE_ENV_PROXY=1 VITE_SANDBOX_BOUNDARY=1 VITE_SANDBOX_STATUS=1 pnpm --dir apps/web exec vp build
pnpm --dir apps/server exec vp pack
mkdir -p apps/server/dist/client
cp -a apps/web/dist/. apps/server/dist/client/
npm run build --prefix prototypes/runtime
node prototypes/full/start.mjs
```

The default host harness is an explicitly deterministic Pi RPC fixture (no LLM).
Use the server's pairing flow, select **Pi / Deterministic fixture**, and create a
root-workspace thread. `/fixture write hello.txt Hello sandbox`, `/fixture read
hello.txt`, and `/fixture bash pwd` exercise tools through the gateway. Ordinary
prompts return a labelled fixture response. The fixture supports `/fixture wait` followed by native steering or interruption. It models protocol ordering, not live model cancellation timing.

State and local signing keys live under ignored `.t3/full`; the runner never uses
the default `~/.t3` state. `FULL_HOME`, `FULL_PORT` (default 43191), and
`SANDBOX_PORT` (default 43190) select separate instances. Stop the runner with
Ctrl-C; it stops only children it spawned. The UI includes upstream features
whose backend routes are explicitly disabled, so they may display errors.

For a live host Pi harness, set `HARNESS_MODE=pi` on the first startup of a fresh
`FULL_HOME` and configure model credentials in your secure runtime environment.
No model credentials were available during development. The harness remains on
the host; its read/write/edit/bash tools call the gateway with a signed
conversation-only capability. Its process does not receive the gateway signing
key or remote sandbox credential. Extensions, MCP, skills, context-file discovery,
attachments, direct shell shorthand, terminals, worktrees, Git/PR workflows,
previews, devices and setup scripts are disabled in restricted mode. Other
provider implementations remain upstream; restricted mode rejects opening their
sessions until they support this boundary. Normal upstream mode is retained but
does not have these sandbox guarantees.

## Owned backend startup

Check out `prototype/t3-ui-own-backend`. The full runner exists on the other
branch; the upstream backend is retained as reference but is not run here.
Requires Node 24, pnpm 11.10.0 and a **dedicated development Postgres database**.

```sh
pnpm --filter @t3tools/owned-prototype-web... --filter @t3tools/web... install --frozen-lockfile
npm ci --prefix prototypes/runtime
npm run build --prefix prototypes/runtime
pnpm --dir apps/owned-web exec vp build
node prototypes/runtime/init-auth.mjs
# Provide DATABASE_URL securely. Example for an isolated local development DB:
export DATABASE_URL=postgresql://postgres@127.0.0.1:43210/t3prototype
export OWN_AUTH_FILE="$PWD/.t3/own/auth.json"
export OWN_WEB_DIST="$PWD/apps/owned-web/dist"
npm run own --prefix prototypes/runtime
```

An isolated local database can be started with Docker (development only):

```sh
docker run --name t3-prototype-postgres -d -p 127.0.0.1:43210:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=t3prototype postgres:16-alpine
```

Use password/TLS authentication for any nonlocal database. Never point this
prototype or its tests at production data.

Open `http://127.0.0.1:43220`. The generated ignored auth file maps a random
owner token to `local-owner`; paste that token into the UI. Never commit this
file or database credentials. For a separate frontend, omit `OWN_WEB_DIST` and
run `pnpm --dir apps/owned-web exec vp dev`; its development proxy targets the
backend. Browser requests use relative URLs, so the same built assets work when
served by the backend. `OWN_PORT`, `OWN_BACKEND_URL` (dev proxy only),
`OWN_AUTH_FILE` and `PI_HOST_DIR` select custom instances. `OWNER_TOKENS` is an
optional JSON token-to-owner binding supplied securely in the environment.
Tokens must have at least 32 characters. No token appears in startup logs.

The default harness is labelled deterministic. Try `/fixture write hello.txt
Hello`, `/fixture read hello.txt`, `/fixture wait` followed by **Steer** or
**Cancel**, and queued prompts. History and event cursors live in Postgres.
Retries retain command IDs; reconnect replays events after the last cursor.
An interrupted running turn is never automatically replayed after a worker
restart; queued prompts resume. One worker per database is enforced by a
Postgres advisory lock. This is not horizontal worker orchestration.

`HARNESS_MODE=pi`, `PI_PROVIDER`, `PI_MODEL`, and secure model credentials enable
real in-process host Pi. Its builtin host tools and discovery are disabled;
only four registered sandbox tools are callable. Native Pi session headers and
entries persist in Postgres, preserving roles and tool-call/result IDs. Checkpoints
are durable before tool dispatch. Restart repairs missing results from confirmed
receipts or marks them uncertain errors; it never replays uncertain tools. Partial
cancelled/interrupted text can be recovered as an explicitly aborted entry with
synthetic zero usage, not as a completed model response. Live model calls remain
unverified.

The frontend imports `apps/web/src/main.tsx` directly. Its original composer,
transcript, tool presentation, sidebar, stores and client connection runtime run
unchanged. Vite substitutes the client runtime's session factory with the owned
HTTP/SSE adapter; no upstream server orchestration is imported. The adapter owns
schema-validated config, lifecycle, shell/thread snapshots and a bounded command
allowlist (launch, send, steer, queue edit/reorder/cancel, interrupt and metadata).
Unsupported filesystem, assets, setup, terminals, worktrees, Git and export RPCs
fail closed. Some upstream controls remain visible and report denial; legacy
permission notices are retained rather than granting fake host permissions.
`OWN_WEB_DIST` already permits serving the separate frontend's assets from the
backend process later without rebuilding browser URLs. Whole snapshots currently
replace event deltas, so large histories require pagination work.

## Sandbox interface and taint

Allocation is lazy: opening a conversation or sending a text-only fixture prompt
does not allocate a sandbox. The first filesystem/bash call allocates one using
an owner/conversation idempotency key. Fixture files, results, command receipts
and irreversible taint are durable. Reusing a command ID with different content
fails; an ambiguous remote result after a crash is never automatically replayed.

The deterministic sandbox supports read/write/exact edit and three fixed bash
responses (`pwd`, `ls`, `fixture:production-read`). It never invokes a local shell
and is **not Nomad/Kata isolation**. Production-data ingress is simulated only by
the last response, which commits taint with its result. After taint, PR/publication
requests return 403 and all bash is rejected, including shell publication bypasses.
There is no public reset or downgrade action. Even clean PR/publication actions
are disabled (501), so these prototypes never create PRs or publish anything.

`SANDBOX_PROVIDER=remote`, `SANDBOX_URL=https://...`, and `SANDBOX_TOKEN` select
the remote adapter. A trusted service must implement POST `/allocate`
(`owner`, `conversationId`, `idempotencyKey` -> `sandboxId`) and POST `/classify`
(`sandboxId`, `id`, `tool`, `args` -> `dataClass`: ordinary/production/unknown), then POST `/execute`
(`sandboxId`, `id`, `tool`, `args`, `expectedDataClass`, `denyExports` -> `text`, `productionData`). That service owns real process,
filesystem, network, credentials and export isolation. It must enforce
idempotency, sandbox scope, cancellation and export-egress denial itself.
Production or unknown ingress commits and emits taint **before** dispatch, even when classification/dispatch fails. Ordinary coding operations remain clean. The service must enforce classification atomically with execution and reject a mismatched classification; these service guarantees are unverified.
No Nomad/Kata service was configured or verified here. Do not attach arbitrary
host execution behind this interface and call it isolated.

## Validation

```sh
npm run typecheck --prefix prototypes/runtime
npm run build --prefix prototypes/runtime
npm test --prefix prototypes/runtime
pnpm exec tsc -p apps/server/tsconfig.json --noEmit
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
pnpm exec vp test run apps/server/src/sandbox/policy.test.ts packages/provider-pi/src/server/sandboxLaunch.test.ts packages/provider-pi/src/server/adapter.test.ts apps/server/src/orchestration-v2/ThreadStream.test.ts apps/server/src/orchestration-v2/RestartContinuation.test.ts
```

The full HTTP/RPC smoke check mints its own local pairing credential without
printing it. Against a fresh fixture server:

```sh
FULL_HOME=.t3/full-smoke FULL_PORT=43203 SANDBOX_PORT=43202 node prototypes/full/start.mjs
# in another shell, from the checkout root:
FULL_HOME=.t3/full-smoke FULL_PORT=43203 node --import ./prototypes/runtime/node_modules/tsx/dist/loader.mjs prototypes/full/smoke.mjs
# restart the same instance, then run with SMOKE_RESUME=1 to check persisted history
```

Full validation exercised served assets, pairing authentication, client-runtime
RPC, streaming, tool results, duplicate launch, transport denial, SQLite gateway
ownership/lazy allocation/taint, and upstream Pi/reconnect/recovery tests.
No mobile/desktop build, live model, real Nomad/Kata
isolation, external publication, or production load/security audit was performed.

Owned validation (run on the owned branch):

```sh
npm run typecheck --prefix prototypes/runtime
npm run build --prefix prototypes/runtime
TEST_DATABASE_URL="$DATABASE_URL" npm test --prefix prototypes/runtime
pnpm exec tsc -p apps/owned-web/tsconfig.json --noEmit
pnpm --dir apps/owned-web exec vp build
TEST_DATABASE_URL="$DATABASE_URL" node --import ./prototypes/runtime/node_modules/tsx/dist/loader.mjs --test apps/owned-web/src/adapter.test.ts
```

Use a dedicated test database: these checks create durable synthetic conversations.
Without `TEST_DATABASE_URL`, Postgres and process checks are explicitly skipped.
Review verification passed all sixteen runtime tests (including real Postgres), plus
an adapter/process test that serves built assets, streams, reconnects, kills
and restarts the actual worker, resumes its queued prompt, and checks persistent
taint/publication denial. SQLite and Postgres tests cover owner isolation,
duplicate payload conflicts, cancellation retry safety, steering, lazy
allocation and recovery. A credentialless actual Pi SDK test confirms only the
registered sandbox tools are active and exercises their broker integration.
Full review validation passed 122 focused upstream/boundary/worker tests plus six
runtime tests (SQLite and real Postgres provenance checks), builds/typechecks,
expanded HTTP/RPC scenarios and a real Chromium restart/content-blocking test.

Secret review used Gitleaks 8.24.3 on branch history and prototype source.
The initial vendor snapshot has 94 findings in 63 files: checked-in test TLS
keys, synthetic test/example values, public OAuth/Clerk identifiers and code
strings falsely classified as credentials. Every finding's file is byte-for-byte
identical to the pinned upstream snapshot. No local signing keys, owner tokens,
model credentials or database data are tracked. The added prototype code had
no findings. This is a secret review, not a full security audit.

## Review evidence and browser boundary

The owned branch also passed a real Chromium test of the retained T3 UI: native
composer submission, tool transcript, sidebar, reload, worker restart and a second
owner sharing browser caches. Hostile Markdown images, JavaScript links and frames,
plus independent DOM image/frame CSP probes caused zero external canary requests.
Generated images are deliberately rendered as blocked labels. Explicit HTTP(S)
links remain navigable; the application uses `Referrer-Policy: no-referrer`.
CSP restricts scripts, connections and media to approved same-origin destinations,
blocks frames/objects, and hashes the fixed upstream theme bootstrap. This browser
boundary is independent of sandbox egress. These checks do not establish Nomad,
Kata, remote service networking, full-app multitenancy or working publication.

Run the browser check after building frontend/backend, sequentially with the
process test because both use the database's single-worker lease:

```sh
TEST_DATABASE_URL="$DATABASE_URL" PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  CHROMIUM_PATH=/usr/bin/chromium node --test apps/owned-web/src/browser.test.mjs
```

Repository visibility was public during this review. Fix commits remain local;
pushing is blocked until GitHub private visibility can be verified. No PR,
deployment or old environment changes were made.

Owned compatibility footprint at review: 366 lines across boot, transport,
projection and REST/SSE helper modules (dense TypeScript), plus Vite/TypeScript
configuration and the copied 494-line upstream HTML entry. The client-runtime
package has zero source edits; the original web UI has four added lines in
ChatMarkdown plus the small content-policy module. This retains a large upstream
frontend bundle, not a reduced application. It avoids upstream backend changes
but must track every used frontend contract, native session/config schema and
projection invariant. Full T3 instead retains orchestration, recovery and Pi RPC
but carries security-sensitive backend patches. Neither cost is just a thin
visual wrapper. Count tracked and untracked additions after committing with
`git diff --numstat f3376fe HEAD -- apps/web apps/server packages/client-runtime apps/owned-web`.

## Matching scenario evidence

| Scenario                     | Full T3                                                                                                                  | Owned backend                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Command deduplication        | Repeated launch and queued message via actual client-runtime RPC; one message/run                                        | Durable command fingerprint, conflict rejection, HTTP/SSE process test                                    |
| Steering and queued prompts  | Waiting Pi-RPC fixture, steer through T3, queued sandbox write completes                                                 | Waiting SDK fixture, durable queue including edit/reorder/cancel, steer completes                         |
| Cancellation                 | Repeated native interrupt settles the targeted run as interrupted/cancelled; upstream claim-registration race test       | Controllers register before claim; deterministic claim pause on both stores proves no harness/tools start |
| Reconnect and worker restart | Actual server/gateway restart preserves original history; browser reload preserves taint                                 | Real worker crash/restart, queue recovery, history and durable native Pi entries; browser reload          |
| Owner/conversation isolation | Scoped gateway capability/receipt tests only; full app requires one instance per owner                                   | Authenticated Postgres owner scope plus actual shared browser-cache separation                            |
| Lazy allocation              | Actual full RPC text-only conversation leaves sandbox unallocated                                                        | Empty/text-only conversations, cancelled claim window, first tool allocates once                          |
| Taint enforcement            | Same broker provenance scenarios; authenticated status polling and browser restart; unsupported transport exports denied | Same provenance cases, SSE taint change and reconnect snapshot, server/tool action rejection              |

Full browser command: `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test prototypes/full/browser.test.mjs` after copying built web assets into server dist.
Full provenance and owned provenance scenarios exercise the same classifications
and failed-dispatch ordering. The full UI's supplemental status polls an
authenticated read-only endpoint once per second; durable gateway commits emit
before dispatch, but UI notification can lag by that interval. It never obtains
host signing capabilities. Native title generation is suppressed on launch and
message dispatch because it is a separate background operation outside Pi.

Cancellation semantics differ: full T3 normally marks an active interruption
`interrupted` and retains its native queue policy; owned cancel marks running and
queued jobs `cancelled`. The tests compare observable prevention/settlement and
recovery, not identical storage vocabularies. Full app multitenancy, live model
state across an actual API call, remote classification atomicity, real sandbox
network/process isolation, production-load behavior, clean PR/publication success
and mobile/desktop builds remain unverified. Fixture bash never executes a shell;
Pi SDK/RPC and Postgres actually execute. Disabled exports demonstrate denial only.

Full compatibility footprint: upstream UI changes consist of the Markdown guard,
two CSP meta tags and a supplemental status initializer/module. Client-runtime
source is unchanged. Backend changes include launch/title sanitization, transport
allowlists, isolated Pi launch, checkpoint/setup suppression and the status proxy.
Measure the exact changed-file/line footprint from vendor baseline with the diff
command above; new policy modules and tests are counted separately from modified
upstream files. Browser CSP and remote media guards require the documented build
flags; serving an upstream build without those flags is unsupported.

At the final visibility recheck the public page returned 404, Git refs remained
readable, and authenticated REST/GraphQL visibility queries were blocked by the
environment network policy. This does not verify private visibility; pushes remain
blocked. Allow authenticated read access to `api.github.com` in environment settings
so the private flag can be checked before pushing.

Measured footprint against vendor `f3376fe` (source counts before this report's
final prose edits): full branch changes 37 files, including 13 modified upstream
files (+131/-14), and its web/client-runtime scope is five files (+39/-0).
Owned changes 37 files, including four modified upstream files (+377/-36,
mostly dependency/configuration records); web/client-runtime scope is two files
(+11/-0). Eleven owned frontend files contain the entry, adapter, config and tests.
No client-runtime source file is changed on either branch. These counts include
new prototype modules; they do not imply 37 upstream UI edits. The native tool
activity fold/expander is exercised by the owned browser check, including its
actual argument viewer.

Adapter scope limitation: the owned projection does not implement T3's execution
attempt/node/provider-thread graph; those arrays are empty. Steering is a durable
owned job linked to its target, not a transplanted T3 orchestrator run. Native
presentation and client state code are retained, but advanced execution-graph
features and native-session management are denied. Tool activity and argument
expansion use T3's actual inspector; tool-start and result events link by call ID with stable item identities, so the native UI can show running tool activity and later its actual arguments/results.

Legacy owned conversations without native Pi entries import available journal
roles, arguments and tool IDs once, with an explicit synthetic-metadata marker.
Missing legacy tool outcomes become errors, queued jobs are not consumed, and
cancelled text stays aborted. Historical native metadata never recorded by the
old prototype cannot be recovered; this migration does not claim otherwise.

## Repo layout: upstream pin + patches

The repo holds only Linguini's code. Upstream T3 Code is pinned in `.linguini/upstream.pin` and
changed by per-file patches in `.linguini/patches/`, and upstream files we drop are listed in
`.linguini/deleted`. `.linguini/assemble` builds the full tree in `.linguini/build`, which is
where you build, test, and edit. `.linguini/regen` writes edits back, `.linguini/status` (or the
opt-in pre-commit hook) catches edits not yet written back, and `.linguini/bump` moves the pin.
CI assembles first and checks that the patches reproduce. Deploys use
`infra/hosting/deploy-dev.sh`. Details: `.linguini/README.md`.
