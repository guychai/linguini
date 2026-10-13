#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016  # pass/fail/info always return 0 (safe "&& ||"); single-quoted $ expands inside the container
# Steps 3 and 4 of the handoff's inside-out plan: an inner Docker daemon inside one Kata guest,
# with no access to the node daemon's socket. Build, pull from the approved registry, volume
# writes, port access, a small Compose workload, resource limits and cleanup; then the inner
# storage facts (Engine version, image store / snapshotter, data roots, backing filesystems).
#
# Storage is inspected before anything is prescribed (handoff section 11): phase A starts the
# inner daemon on the image's default /var/lib/docker volume (shared into the guest by Kata over
# virtio-fs) and records what dockerd chose and whether it works. Kata's DinD how-to says
# virtio-fs cannot be an overlayfs upper layer; phase B uses that default only if the probe
# proves it works with the overlayfs snapshotter, otherwise a guest-local tmpfs (Kata's
# documented memory-backed workaround), and says which.
#   INNER_STORAGE=auto|default|tmpfs   (default auto)   KATA_RUNTIME=kata|kata-db   KEEP=1 skips cleanup
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root_tools
RT="${KATA_RUNTIME:-kata}"
MODE="${INNER_STORAGE:-auto}"
NAME=kit-dind
WS=kit-dind-workspace
PORT=18080
ENTRY="$(cat "$KIT_DIR/inner/dind-entry.sh")"
dk info --format '{{json .Runtimes}}' | jq -e --arg rt "$RT" '.[$rt]' >/dev/null || die runtime "Docker has no '$RT' runtime; run 20-install-docker-kata.sh"
vmm_count() { pgrep -fc "^$KIT_QEMU" || true; }
vmm_before=$(vmm_count)
ix() { dk exec "$NAME" sh -c "$1"; }
cleanup() {
  dk_rm "$NAME" || die cleanup "container $NAME could not be removed within 60 s"
}
cleanup
dk volume create "$WS" >/dev/null
dk pull -q "$KIT_DIND_IMAGE" >/dev/null && pass dind-image "$KIT_DIND_IMAGE"

capargs=(); IFS=, read -ra caps <<< "$KIT_INNER_CAPS"; for c in "${caps[@]}"; do capargs+=(--cap-add "$c"); done
start_dind() {
  local storage=() t0
  [ "$1" = tmpfs ] && storage=(--mount "type=tmpfs,dst=/var/lib/docker,tmpfs-size=$((KIT_INNER_TMPFS_MB * 1048576))")
  t0=$(date +%s%N)
  dk run -d --name "$NAME" --runtime "$RT" \
    --cpus "$KIT_SANDBOX_CPUS" --memory "${KIT_SANDBOX_MEMORY_MB}m" --pids-limit "$KIT_SANDBOX_PIDS" \
    "${capargs[@]}" --sysctl net.ipv4.ip_forward=1 -e DOCKER_TLS_CERTDIR= \
    --mount "type=volume,src=$WS,dst=/workspace" "${storage[@]}" \
    -p "127.0.0.1:$PORT:$PORT" \
    --entrypoint sh "$KIT_DIND_IMAGE" -c "$ENTRY" >/dev/null
  for _ in $(seq 1 90); do
    if ix 'docker info >/dev/null 2>&1'; then
      info "dind-ready-$1" "inner dockerd answered after $(( ($(date +%s%N) - t0) / 1000000 )) ms"
      return 0
    fi
    [ "$(dk inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] || break
    sleep 2
  done
  dk logs --tail 80 "$NAME" > "$KIT_EVIDENCE/$KIT_SCRIPT.dockerd-$1.log" 2>&1 || true
  return 1
}
storage_facts() {
  ix 'docker info --format "{{json .}}"' | jq '{ServerVersion, Driver, DriverStatus, DockerRootDir, CgroupDriver, CgroupVersion, SecurityOptions, Runtimes: (.Runtimes|keys), DefaultRuntime, ID}' > "$KIT_EVIDENCE/$KIT_SCRIPT.storage-$1.json"
  record "storage-$1-paths" dk exec "$NAME" sh -c '
    echo "## containerd config used by dockerd"; cat /var/run/docker/containerd/containerd.toml 2>/dev/null | grep -E "^(root|state)|^\s*(root|state) =" || echo "no managed containerd.toml";
    echo "## processes"; ps -o pid,args | grep -E "dockerd|containerd" | grep -v grep;
    for p in /var/lib/docker /var/lib/docker/containerd/daemon /var/lib/containerd /run/containerd /workspace; do
      echo "## $p"; [ -e "$p" ] && { df -T "$p" 2>/dev/null | tail -1; grep -E " $(df "$p" | awk "NR==2 {print \$6}") " /proc/mounts | head -2; du -sh "$p" 2>/dev/null; } || echo "absent";
    done'
}

# ---- phase A: what does the default storage do? ----
chosen=tmpfs
if [ "$MODE" != tmpfs ]; then
  if start_dind default; then
    storage_facts default
    backing=$(ix 'df -T /var/lib/docker | awk "NR==2 {print \$2}"')
    snap=$(jq -r '.Driver' "$KIT_EVIDENCE/$KIT_SCRIPT.storage-default.json")
    if ix "docker run --rm $KIT_ALPINE_IMAGE true" >/dev/null 2>"$KIT_EVIDENCE/$KIT_SCRIPT.default-run.stderr"; then
      info storage-probe "default /var/lib/docker on $backing: dockerd chose '$snap' and ran a container"
      [ "$snap" = overlayfs ] || [ "$snap" = overlay2 ] && chosen=default
    else
      info storage-probe "default /var/lib/docker on $backing: dockerd chose '$snap' but could not run a container: $(head -c 300 "$KIT_EVIDENCE/$KIT_SCRIPT.default-run.stderr")"
    fi
  else
    info storage-probe "inner dockerd did not start on the default volume; see $KIT_EVIDENCE/$KIT_SCRIPT.dockerd-default.log"
  fi
  cleanup
fi
[ "$MODE" = default ] && chosen=default
info storage-decision "phase B uses '$chosen' storage for /var/lib/docker (INNER_STORAGE=$MODE)"

# ---- phase B: the workload ----
start_dind "$chosen" || die dind-start "inner dockerd did not start ($chosen storage); log: $(tail -5 "$KIT_EVIDENCE/$KIT_SCRIPT.dockerd-$chosen.log" | tr '\n' ' ')"
pass dind-start "inner dockerd running in Kata guest ($RT, $chosen storage)"
storage_facts "$chosen"

# No host socket: no bind of the node socket, and the inner engine is a different daemon.
mounts=$(dk inspect -f '{{json .Mounts}}' "$NAME")
echo "$mounts" | jq -e 'map(select(.Source|test("docker.sock")))|length==0' >/dev/null && pass no-host-socket "no docker.sock bind; mounts: $(echo "$mounts" | jq -c 'map({Type,Destination})')" || fail no-host-socket "$mounts"
outer_id=$(dk info -f '{{.ID}}'); inner_id=$(ix 'docker info -f "{{.ID}}"')
[ -n "$inner_id" ] && [ "$inner_id" != "$outer_id" ] && pass separate-engine "inner engine ID differs from the node's" || fail separate-engine "inner $inner_id outer $outer_id"
info inner-engine "$(ix 'docker version -f "Engine {{.Server.Version}}, containerd {{range .Server.Components}}{{if eq .Name \"containerd\"}}{{.Version}}{{end}}{{end}}"')"
info inner-storage "$(jq -c '{Driver, DriverStatus, DockerRootDir}' "$KIT_EVIDENCE/$KIT_SCRIPT.storage-$chosen.json")"
jq -e '.DriverStatus|tostring|test("io.containerd.snapshotter.v1")' "$KIT_EVIDENCE/$KIT_SCRIPT.storage-$chosen.json" >/dev/null \
  && info image-store "containerd image store (Engine 29 fresh-install default); containerd data is not under DockerRootDir alone, see storage-$chosen-paths" \
  || info image-store "legacy graph driver $(jq -r .Driver "$KIT_EVIDENCE/$KIT_SCRIPT.storage-$chosen.json")"

# Pull from the approved registry only (pinned digest).
case "$KIT_ALPINE_IMAGE" in docker.io/library/*@sha256:*) ;; *) die approved-registry "$KIT_ALPINE_IMAGE is not a pinned docker.io/library image";; esac
t0=$(date +%s%N)
ix "docker pull -q $KIT_ALPINE_IMAGE" >/dev/null && pass pull "$KIT_ALPINE_IMAGE in $(( ($(date +%s%N) - t0) / 1000000 )) ms" || fail pull "$KIT_ALPINE_IMAGE"

# Build.
# Streamed through exec, not `docker cp`: the dind script mounts a tmpfs over /tmp inside the
# guest, which would hide files copied into the container rootfs from the outside.
tar -C "$KIT_DIR/inner/build" -cf - . | sudo docker exec -i "$NAME" sh -c 'rm -rf /kit-build && mkdir -p /kit-build && tar -C /kit-build -xf -' 
t0=$(date +%s%N)
if ix 'docker build -q -t kit/web:1 /kit-build' > "$KIT_EVIDENCE/$KIT_SCRIPT.build.txt" 2>&1; then
  pass build "kit/web:1 built in $(( ($(date +%s%N) - t0) / 1000000 )) ms"
else
  fail build "$(tail -5 "$KIT_EVIDENCE/$KIT_SCRIPT.build.txt" | tr '\n' ' ')"
fi

# Volume writes, read back from a second container.
w=$(ix "docker volume create kitvol >/dev/null && docker run --rm -v kitvol:/data $KIT_ALPINE_IMAGE sh -c 'dd if=/dev/urandom of=/data/blob bs=1M count=64 2>/dev/null && sync && sha256sum /data/blob'" | awk '{print $1}')
r=$(ix "docker run --rm -v kitvol:/data $KIT_ALPINE_IMAGE sha256sum /data/blob" | awk '{print $1}')
[ -n "$w" ] && [ "$w" = "$r" ] && pass volume "64 MiB written and read back (sha256 ${w:0:16}…)" || fail volume "write $w read $r"
# The workspace volume outlives compute: written by an inner container, read on the node.
ix "docker run --rm -v /workspace:/w $KIT_ALPINE_IMAGE sh -c 'echo kit-workspace-ok > /w/probe.txt'"
ws=$(dk run --rm --runtime runc -v "$WS:/w:ro" "$KIT_BUSYBOX_IMAGE" cat /w/probe.txt 2>/dev/null || true)
[ "$ws" = kit-workspace-ok ] && pass workspace-volume "inner write to /workspace visible in node volume $WS" || fail workspace-volume "read '$ws'"

# Port access: inside the guest, and from the node through the outer publish.
ix "docker rm -f web >/dev/null 2>&1; docker run -d --name web -p $PORT:8080 kit/web:1" >/dev/null || fail inner-nonroot "kit/web:1 (USER web) did not start"
sleep 2
inside=$(ix "wget -qO- http://127.0.0.1:$PORT/" || true)
[[ "$inside" == kit-inner-build-ok* ]] && pass port-inner "guest-local 127.0.0.1:$PORT -> inner container" || fail port-inner "got '$inside'"
outside=$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/" || true)
[[ "$outside" == kit-inner-build-ok* ]] && pass port-node "node 127.0.0.1:$PORT -> Kata guest -> inner container" || fail port-node "got '$outside'"
ix 'docker rm -f web' >/dev/null

# Compose.
if ix 'docker compose version' > "$KIT_EVIDENCE/$KIT_SCRIPT.compose-version.txt" 2>&1; then
  if ix 'cd /kit-build && docker compose up --build --abort-on-container-exit --exit-code-from probe' > "$KIT_EVIDENCE/$KIT_SCRIPT.compose.txt" 2>&1; then
    pass compose "web + probe; probe reached web over the Compose network ($(cat "$KIT_EVIDENCE/$KIT_SCRIPT.compose-version.txt"))"
  else
    fail compose "$(tail -5 "$KIT_EVIDENCE/$KIT_SCRIPT.compose.txt" | tr '\n' ' ')"
  fi
  ix 'cd /kit-build && docker compose down -v --rmi local' >/dev/null 2>&1 || true
else
  fail compose "docker compose plugin missing in $KIT_DIND_IMAGE"
fi

# Resource limits: the guest is sized from the container limits; inner limits are enforced by
# the guest kernel.
info guest-size "nproc=$(ix nproc) MemTotal=$(ix "awk '/MemTotal/ {printf \"%d MiB\", \$2/1024}' /proc/meminfo") for --cpus $KIT_SANDBOX_CPUS --memory ${KIT_SANDBOX_MEMORY_MB}m"
info pids "outer --pids-limit $KIT_SANDBOX_PIDS; guest pids.max=$(ix 'cat /sys/fs/cgroup/pids.max 2>/dev/null || echo n/a')"
info var-lib-docker "$(ix 'df -h /var/lib/docker | tail -1')"
ix "docker rm -f kit-oom >/dev/null 2>&1; docker run --name kit-oom -m 64m --memory-swap 64m $KIT_ALPINE_IMAGE tail /dev/zero" >/dev/null 2>&1 || true
oom=$(ix 'docker inspect -f "{{.State.OOMKilled}} {{.State.ExitCode}}" kit-oom' || true)
[ "$oom" = "true 137" ] && pass inner-memory-limit "64 MiB inner container OOM-killed (exit 137)" || fail inner-memory-limit "state '$oom'"
ix 'docker rm -f kit-oom' >/dev/null 2>&1 || true
pids=$(ix "docker run --rm --pids-limit 32 $KIT_ALPINE_IMAGE sh -c 'for i in \$(seq 1 64); do sleep 5 & done; wait' 2>&1 | grep -c 'can.t fork\|Resource temporarily unavailable' || true")
[ "${pids:-0}" -gt 0 ] && pass inner-pids-limit "--pids-limit 32 refused forks ($pids errors)" || fail inner-pids-limit "no fork errors under --pids-limit 32"

storage_facts after-workload
ix 'docker system df' > "$KIT_EVIDENCE/$KIT_SCRIPT.system-df.txt" 2>&1 || true

if [ "${KEEP:-0}" = 1 ]; then
  info keep "KEEP=1: leaving $NAME running"
  finish
fi
# --volumes only prunes anonymous volumes since Engine 23; -a on volume prune takes named ones.
ix 'docker system prune -af --volumes && docker volume prune -af' >/dev/null 2>&1 || true
left=$(ix 'docker ps -aq | wc -l; docker volume ls -q | wc -l' | tr '\n' ' ')
[ "$left" = "0 0 " ] && pass inner-cleanup "no inner containers or volumes left" || fail inner-cleanup "containers/volumes left: $left"
cleanup
dk volume rm "$WS" >/dev/null
sleep 3
[ "$(vmm_count)" -le "$vmm_before" ] && pass cleanup "kit-dind removed; no extra Kata VMM processes" || fail cleanup "$(vmm_count) VMM processes vs $vmm_before before"
[ -z "$(dk ps -aq --filter "name=^$NAME$")" ] && [ -z "$(dk volume ls -q --filter "name=^$WS$")" ] && pass outer-cleanup "container and workspace volume removed" || fail outer-cleanup "leftovers"
finish
