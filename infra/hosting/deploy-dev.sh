#!/usr/bin/env bash
# Deploy this repo's HEAD to a node (patch layout). Run from a clean checkout:
#   DEV_SSH=user@host [DEV_SSH_KEY=~/.ssh/key] infra/hosting/deploy-dev.sh
# 1. Assembles the build tree (.linguini/assemble into a temp dir, never your .linguini/build),
#    installs, and builds owned-web there.
# 2. Ships prototypes/runtime (src, scripts, package*.json), infra/hosting, and the web build.
# 3. On the node (deploy-node.sh): activity check (a running Nomad job, or journal events in
#    the last ACTIVE_MINUTES (10), blocks a backend restart unless FORCE=1; a web-only deploy
#    goes ahead), then backup (pg_dump, runtime src/scripts/package files, web,
#    DEPLOYED_COMMIT) under /opt/agent-platform/backup-<ts>-deploy, then install. The web is
#    swapped as a new directory that keeps the old hashed assets, so open tabs keep loading
#    their chunks. npm ci runs only if package*.json changed, and the backend restarts only if
#    runtime files changed. /health and index.html are checked, and a failed check restores
#    the backup.
# 4. DEPLOYED_COMMIT records our commit, the upstream pin (and its release tag) and the assembled tree id.
# Service units and the env file are not installed. If they differ, it says so; install them
# by hand (see README). DRY_RUN=1 stops after the checks on the node.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${DEV_SSH:?set DEV_SSH=user@host}"
SSH=(ssh -o BatchMode=yes ${DEV_SSH_KEY:+-i "$DEV_SSH_KEY"} "$DEV_SSH")
SCP=(scp -q -o BatchMode=yes ${DEV_SSH_KEY:+-i "$DEV_SSH_KEY"})
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
commit=$(git rev-parse HEAD)
pin=$(sed -n 's/^commit=//p' .linguini/upstream.pin)
pin_tag=$(sed -n 's/^tag=//p' .linguini/upstream.pin)
upstream=$(sed -n 's/^repo=//p' .linguini/upstream.pin)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
.linguini/assemble "$work/build"
tree=$(git -C "$work/build" rev-parse HEAD^{tree})
(cd "$work/build" && pnpm install --frozen-lockfile >/dev/null && cd apps/owned-web && pnpm run build >/dev/null)
mkdir -p "$work/pkg/runtime"
B=$work/build
cp -a "$B/prototypes/runtime/src" "$B/prototypes/runtime/scripts" "$B/prototypes/runtime/package.json" \
  "$B/prototypes/runtime/package-lock.json" "$work/pkg/runtime/"
cp -a "$B/infra/hosting" "$work/pkg/hosting"
cp -a "$B/apps/owned-web/dist" "$work/pkg/web"
{ printf 'repo=%s\ncommit=%s\nupstream=%s\n' \
    "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" "$commit" "$upstream"
  [ -z "$pin_tag" ] || printf 'upstream_tag=%s\n' "$pin_tag"
  printf 'upstream_pin=%s\nassembled_tree=%s\n' "$pin" "$tree"; } >"$work/pkg/DEPLOYED_COMMIT"
tar -C "$work/pkg" -czf "$work/deploy.tgz" .
sum=$(sha256sum "$work/deploy.tgz" | cut -d' ' -f1)
"${SCP[@]}" "$work/deploy.tgz" "$ROOT/infra/hosting/deploy-node.sh" "$DEV_SSH:/tmp/"
"${SSH[@]}" "FORCE=${FORCE:-} DRY_RUN=${DRY_RUN:-} ACTIVE_MINUTES=${ACTIVE_MINUTES:-10} bash /tmp/deploy-node.sh /tmp/deploy.tgz $sum"
