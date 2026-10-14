#!/usr/bin/env bash
# Node half of deploy-dev.sh: deploy-node.sh <deploy.tgz> <sha256>. Needs sudo.
set -euo pipefail
tgz=$1 sum=$2
A=/opt/agent-platform R=$A/prototypes/runtime
echo "$sum  $tgz" | sha256sum -c --quiet -
new=$(mktemp -d)
trap 'rm -rf "$new" "$tgz" /tmp/deploy-node.sh' EXIT
tar -xzf "$tgz" -C "$new"
same() { diff -rq "$1" "$2" >/dev/null 2>&1; }
backend=0 deps=0
same "$new/runtime/src" "$R/src" && same "$new/runtime/scripts" "$R/scripts" || backend=1
cmp -s "$new/runtime/package-lock.json" "$R/package-lock.json" && cmp -s "$new/runtime/package.json" "$R/package.json" || { backend=1; deps=1; }
for u in agent-platform.service linguini-render.service; do
  cmp -s "$new/hosting/$u" "/etc/systemd/system/$u" || echo "note: $u differs from the installed unit (not installed by this script)"
done
running=$(nomad job status 2>/dev/null | awk 'NR>1 && $4=="running"' | wc -l)
recent=$(sudo -u agentplat psql -d agentplat -Atc "select count(*) from prototype_events where ts > to_char((now() - interval '${ACTIVE_MINUTES:-10} minutes') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')")
echo "backend change: $backend (deps: $deps); running sandboxes: $running; events in last ${ACTIVE_MINUTES:-10}m: $recent"
if [ "$backend" = 1 ] && { [ "$running" != 0 ] || [ "$recent" != 0 ]; } && [ -z "${FORCE:-}" ]; then
  echo "refusing to restart the backend while it is in use (FORCE=1 to override)" >&2
  exit 3
fi
[ -z "${DRY_RUN:-}" ] || { echo "dry run: stopping here"; exit 0; }
bk=$A/backup-$(date -u +%Y%m%dT%H%M%S)-deploy
sudo mkdir -p "$bk/runtime"
sudo sh -c "sudo -u agentplat pg_dump -Fc agentplat > '$bk/agentplat.dump'" && sudo chmod 600 "$bk/agentplat.dump"
sudo cp -a "$R/src" "$R/scripts" "$R/package.json" "$R/package-lock.json" "$bk/runtime/"
sudo cp -a "$A/web" "$bk/web"
sudo cp -a "$A/DEPLOYED_COMMIT" "$bk/" 2>/dev/null || true
echo "backup: $bk"
rollback() {
  echo "ROLLING BACK from $bk" >&2
  sudo rsync -a --delete "$bk/runtime/src/" "$R/src/"
  sudo rsync -a --delete "$bk/runtime/scripts/" "$R/scripts/"
  sudo cp "$bk/runtime/package.json" "$bk/runtime/package-lock.json" "$R/"
  [ ! -d "$R/node_modules.prev-deploy" ] || { sudo rm -rf "$R/node_modules"; sudo mv "$R/node_modules.prev-deploy" "$R/node_modules"; }
  sudo rm -rf "$A/web" && sudo cp -a "$bk/web" "$A/web"
  sudo cp "$bk/DEPLOYED_COMMIT" "$A/DEPLOYED_COMMIT"
  sudo systemctl restart agent-platform
  exit 1
}
sudo rsync -a --delete "$new/hosting/" "$A/infra/hosting/"
if [ "$backend" = 1 ]; then
  sudo rsync -a --delete "$new/runtime/src/" "$R/src/"
  sudo rsync -a --delete "$new/runtime/scripts/" "$R/scripts/"
  sudo cp "$new/runtime/package.json" "$new/runtime/package-lock.json" "$R/"
  if [ "$deps" = 1 ]; then
    sudo rm -rf "$R/node_modules.prev-deploy" && sudo cp -a "$R/node_modules" "$R/node_modules.prev-deploy"
    (cd "$R" && sudo env PATH=/opt/node/bin:$PATH npm ci --no-audit --no-fund >/dev/null) || rollback
  fi
  sudo chown -R root:root "$R/src" "$R/scripts"
fi
# Web: a new directory that also keeps the old hashed assets (open tabs lazy-load them).
sudo rm -rf "$A/web.new" && sudo cp -a "$new/web" "$A/web.new"
sudo cp -a --update=none "$A/web/assets/." "$A/web.new/assets/"
sudo chown -R root:root "$A/web.new"
sudo rm -rf "$A/web.prev" && sudo mv "$A/web" "$A/web.prev" && sudo mv "$A/web.new" "$A/web"
host=$(sudo sed -n 's/^OWN_HOST=//p' /etc/agent-platform/agent-platform.env)
port=$(sudo sed -n 's/^OWN_PORT=//p' /etc/agent-platform/agent-platform.env)
if [ "$backend" = 1 ]; then sudo systemctl restart agent-platform; fi
ok=
for _ in $(seq 1 30); do curl -fsS "http://$host:$port/health" >/dev/null 2>&1 && ok=1 && break; sleep 2; done
[ -n "$ok" ] || rollback
cmp -s <(curl -fsS "http://$host:$port/") "$A/web/index.html" || rollback
{ cat "$new/DEPLOYED_COMMIT"; echo "deployed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "backend_restarted=$backend"; } | sudo tee "$A/DEPLOYED_COMMIT" >/dev/null
echo "deployed:"; cat "$A/DEPLOYED_COMMIT"
