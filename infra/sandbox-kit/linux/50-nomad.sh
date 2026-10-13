#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016  # pass/fail/info always return 0 (safe "&& ||"); single-quoted $ is for jq/remote shells
# Step 5 of the handoff's inside-out plan: Nomad with the fixed hands job template (Kata runtime,
# resource limits). Proves allocation, exec (the broker's transport), stop, restart and failure
# reconciliation, plus the agent's refusals (runc, privileged, host socket). Every hands job runs on
# its conversation's own sandbox network (sandbox-netctl, from 45-egress.sh), and the last section
# proves a Nomad-launched sandbox is behind the egress proxy. Requires 45-egress.sh. Idempotent: it
# purges its own jobs first; the dev agent is reused if already running.
#   KEEP_NOMAD=1 leaves the agent running afterwards (API on the node's 127.0.0.1:4646 only).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root_tools
export NOMAD_ADDR=http://127.0.0.1:4646
KEY=0123456789abcdef0123
GEN=1
JOB="hands-$KEY-g$GEN"
TASK=hands
dk info --format '{{json .Runtimes}}' | jq -e '.kata' >/dev/null || die runtime "Docker has no 'kata' runtime; run 20-install-docker-kata.sh"
EG="$KIT_DIR/egress" OPT=/opt/sandbox-egress RUN=/run/sandbox-egress
NETCTL=$OPT/node/sandbox-netctl GUEST_CA=/var/lib/sandbox-egress/guest-ca.pem TPORT=3130 DNSP=5353 XPORT=13128
[ -x "$NETCTL" ] && systemctl is-active -q sandbox-egress-net && sudo test -s "$GUEST_CA" || die egress-installed "sandbox-netctl / sandbox-egress-net / $GUEST_CA missing: run 45-egress.sh first"
EKEY=e9e9e9e9e9e9e9e9e9e9
EJOB="hands-$EKEY-g1"
api() { curl -fsS --max-time 20 "$NOMAD_ADDR$1" "${@:2}"; }
elapsed() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

# ---- install (pinned, checksum-verified) ----
if [ "$(nomad version 2>/dev/null | awk 'NR==1 {print $2}')" != "v$KIT_NOMAD_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/nomad.zip" "https://releases.hashicorp.com/nomad/$KIT_NOMAD_VERSION/nomad_${KIT_NOMAD_VERSION}_linux_${KIT_ARCH}.zip"
  echo "$KIT_NOMAD_SHA256  $tmp/nomad.zip" | sha256sum -c - >/dev/null || die nomad-sha256 "checksum mismatch"
  unzip -o -q "$tmp/nomad.zip" -d "$tmp" && sudo install -m 0755 "$tmp/nomad" /usr/local/bin/nomad
  rm -rf "$tmp"
fi
pass nomad-binary "$(nomad version | head -1) (zip sha256 $KIT_NOMAD_SHA256)"

# ---- agent config + dev agent ----
sudo install -d -m 0755 /etc/nomad.d
if ! sudo cmp -s "$KIT_DIR/nomad/agent.hcl" /etc/nomad.d/kit.hcl; then
  sudo install -m 0644 "$KIT_DIR/nomad/agent.hcl" /etc/nomad.d/kit.hcl
  sudo systemctl stop nomad-kit 2>/dev/null || true
fi
# Root: Nomad must write Docker-owned cgroups for CPU isolation (Nomad Docker driver docs).
if ! systemctl is-active -q nomad-kit; then
  sudo systemctl reset-failed nomad-kit 2>/dev/null || true
  sudo systemd-run --unit nomad-kit --description "sandbox-kit Nomad dev agent" \
    /usr/local/bin/nomad agent -dev -bind 127.0.0.1 -config /etc/nomad.d/kit.hcl >/dev/null
fi
ready=""
for _ in $(seq 1 60); do
  node=$(api /v1/nodes 2>/dev/null | jq -r '.[0].ID // empty' || true)
  if [ -n "$node" ] && api "/v1/node/$node" | jq -e '.Drivers.docker.Healthy == true' >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || die agent "Nomad dev agent or its docker driver not healthy; journalctl -u nomad-kit"
nodej=$(api "/v1/node/$node")
echo "$nodej" | jq '{Name, Status, Drivers: .Drivers.docker, Attributes: (.Attributes|with_entries(select(.key|test("driver.docker|cpu.|memory.|kernel.|os.|unique.storage"))))}' > "$KIT_EVIDENCE/$KIT_SCRIPT.node.json"
pass agent "node $(echo "$nodej" | jq -r .Name) ready; docker driver healthy ($(echo "$nodej" | jq -r '.Attributes["driver.docker.version"]'))"
runtimes=$(echo "$nodej" | jq -r '.Attributes["driver.docker.runtimes"] // ""')
info node-runtimes "driver.docker.runtimes=$runtimes; cpu.totalcompute=$(echo "$nodej" | jq -r '.Attributes["cpu.totalcompute"]') MHz"
echo "$runtimes" | grep -q kata && pass node-kata "Nomad sees the kata runtime" || fail node-kata "driver.docker.runtimes=$runtimes"

purge() { api "/v1/job/$1?purge=true" -X DELETE >/dev/null 2>&1 || true; }
for j in "$JOB" "$EJOB" kit-neg-runtime-runc kit-neg-privileged kit-neg-host-socket kit-neg-no-runtime; do purge "$j"; done
sleep 2
alloc_of() { api "/v1/job/$1/allocations" | jq -r '[.[] | select(.ClientStatus=="running")] | .[0].ID // empty'; }
wait_running() { # job timeout -> alloc id
  local a=""; for _ in $(seq 1 "$(( $2 / 2 ))"); do a=$(alloc_of "$1" || true); [ -n "$a" ] && { echo "$a"; return 0; }; sleep 2; done; return 1
}
task_events() { api "/v1/allocation/$1" | jq -r --arg t "$2" '.TaskStates[$t].Events[] | "\(.Type): \(.DisplayMessage)"'; }
container_of() { sudo docker ps -q --filter "label=com.hashicorp.nomad.alloc_id=$1"; }
vm_pid_of() { # QEMU pid serving a container: the shim's child whose cmdline names the sandbox id
  local cid; cid=$(sudo docker inspect -f '{{.Id}}' "$1" 2>/dev/null) || return 1
  pgrep -f "^$KIT_QEMU.*${cid:0:12}" | head -1 || pgrep -n -f "^$KIT_QEMU"
}

# ---- template: validated inputs, rendered offline, registered create-only ----
# What the broker does before every submit: the conversation's own network, bound to the proxy.
netvars() { # key ca_file -> -var args for that conversation's sandbox network and the guest CA
  local j; j=$(sudo "$NETCTL" ensure "$1") || return 1
  # NUL-separated: the CA PEM spans several lines.
  printf '%s\0' -var "sandbox_network=$(echo "$j" | jq -r .name)" -var "sandbox_ipv4=$(echo "$j" | jq -r .ipv4)" \
    -var "sandbox_gateway=$(echo "$j" | jq -r .gateway)" -var "egress_ca_pem=$(sudo cat "$2")"
}
mapfile -d '' -t NV < <(netvars "$KEY" "$GUEST_CA") && [ "${#NV[@]}" = 8 ] || die sandbox-network "sandbox-netctl ensure $KEY failed"
NET=${NV[1]#sandbox_network=} NETIP=${NV[3]#sandbox_ipv4=}
pass sandbox-network "$NET ($NETIP) for $KEY, bound to the egress proxy"
nomad job validate -var conversation_key="$KEY" -var generation="$GEN" "${NV[@]}" "$KIT_DIR/nomad/hands.nomad.hcl" >/dev/null && pass template-valid "hands.nomad.hcl validates for key=$KEY gen=$GEN on $NET" || die template-valid "nomad job validate failed"
nomad job validate -var conversation_key='../etc' -var generation=1 "${NV[@]}" "$KIT_DIR/nomad/hands.nomad.hcl" >/dev/null 2>&1 && fail template-input "accepted a traversal-shaped key" || pass template-input "rejects a key outside ^[a-z0-9]{12,40}$"
for bad in bridge host default container:nomad_init; do
  nomad job validate -var conversation_key="$KEY" -var generation="$GEN" "${NV[@]}" -var sandbox_network="$bad" "$KIT_DIR/nomad/hands.nomad.hcl" >/dev/null 2>&1 && fail template-network "accepted network '$bad'" && continue
done; pass template-network "rejects networks other than sbx<key> (bridge, host, default, container:)"
render() { nomad job run -output -var conversation_key="$KEY" -var generation="$GEN" "${NV[@]}" "$KIT_DIR/nomad/hands.nomad.hcl" | jq --arg id "$JOB" '{Job: (.Job | .ID = $id | .Name = $id), EnforceIndex: true, JobModifyIndex: 0}'; }
t0=$(date +%s%N)
reg=$(render | api /v1/jobs -X POST --data @-) && pass register "created $JOB (EnforceIndex, JobModifyIndex 0): $(echo "$reg" | jq -c '{EvalID, JobModifyIndex}')" || die register "registration failed"
alloc=$(wait_running "$JOB" 300) || { record alloc-failure sh -c "curl -s $NOMAD_ADDR/v1/job/$JOB/allocations | jq .; curl -s $NOMAD_ADDR/v1/job/$JOB/evaluations | jq ."; die allocate "no running allocation within 300s"; }
pass allocate "allocation $alloc running after $(elapsed "$t0") ms (includes image pull and Kata boot)"
dup=$(render | curl -sS -o /dev/null -w '%{http_code}' -X POST --data @- "$NOMAD_ADDR/v1/jobs"; true)
[ "$dup" = 500 ] && pass create-only "second create of $JOB refused (HTTP 500 'job already exists'), no second allocation" || fail create-only "second create returned HTTP $dup"
[ "$(api "/v1/job/$JOB/allocations" | jq 'length')" = 1 ] && pass one-allocation "exactly one allocation for $JOB" || fail one-allocation "$(api "/v1/job/$JOB/allocations" | jq -c 'map({ID,ClientStatus})')"

cid=$(container_of "$alloc")
hc=$(sudo docker inspect -f '{{json .HostConfig}}' "$cid")
echo "$hc" | jq '{Runtime, Privileged, CapAdd, PidsLimit, NanoCpus, CpuQuota, CpuPeriod, CpuShares, Memory, Mounts, Binds, Devices, Tmpfs}' > "$KIT_EVIDENCE/$KIT_SCRIPT.hostconfig.json"
[ "$(echo "$hc" | jq -r .Runtime)" = kata ] && [ "$(echo "$hc" | jq -r .Privileged)" = false ] && pass container "runtime=kata privileged=false caps=$(echo "$hc" | jq -c .CapAdd) pids=$(echo "$hc" | jq .PidsLimit) mem=$(( $(echo "$hc" | jq .Memory) / 1048576 ))MiB cpuQuota=$(echo "$hc" | jq .CpuQuota)/$(echo "$hc" | jq .CpuPeriod)" || fail container "$(echo "$hc" | jq -c '{Runtime,Privileged}')"
echo "$hc" | jq -e '[(.Binds // [])[], ((.Mounts // [])[] | .Source // "")] | map(select(test("docker.sock"))) | length == 0' >/dev/null && pass no-host-socket "no Docker socket in the allocation" || fail no-host-socket "docker.sock mounted"
nets=$(sudo docker inspect -f '{{json .NetworkSettings.Networks}}' "$cid" | jq -c 'to_entries | map({(.key): .value.IPAddress}) | add')
[ "$nets" = "{\"$NET\":\"$NETIP\"}" ] && pass container-network "only on $NET at $NETIP (no default bridge, no pause container)" || fail container-network "$nets"

# ---- exec: the broker's transport ----
x() { timeout 120 nomad alloc exec -task "$TASK" "$alloc" "$@"; }
ready=""; for _ in $(seq 1 60); do x docker info >/dev/null 2>&1 && { ready=1; break; }; sleep 2; done
[ -n "$ready" ] && pass exec-inner-docker "nomad alloc exec reaches the inner dockerd" || fail exec-inner-docker "inner dockerd not answering through exec; task events: $(task_events "$alloc" "$TASK" | tail -3 | tr '\n' ' ')"
kk=$(x uname -r 2>/dev/null || true)
[ -n "$kk" ] && [ "$kk" != "$(uname -r)" ] && pass exec-kata-kernel "exec lands in the Kata guest (kernel $kk, node $(uname -r))" || fail exec-kata-kernel "kernel '$kk'"
info guest-size "nproc=$(x nproc 2>/dev/null) MemTotal=$(x awk '/MemTotal/ {printf "%d MiB", $2/1024}' /proc/meminfo 2>/dev/null) for cpu=4000 MHz (hard limit) memory=8192 MiB"
# The sandbox network only reaches the egress proxy (no registry policy for this key), so the inner
# image is built locally from the guest's own busybox + musl instead of pulled.
out=$(x sh -c 'tar -C / -c bin/busybox lib/ld-musl-*.so.1 | docker import - kit-local:1 >/dev/null && docker run --rm --network none kit-local:1 /bin/busybox echo hands-exec-ok' 2>&1 || true)
[ "$(echo "$out" | tail -1)" = hands-exec-ok ] && pass exec-inner-run "inner container ran through exec" || fail exec-inner-run "$(echo "$out" | tr '\n' ' ' | cut -c1-400)"
code=0; x sh -c 'echo to-stderr >&2; exit 7' >/dev/null 2>&1 || code=$?
[ "$code" = 7 ] && pass exec-exit-code "exit status 7 propagated through nomad alloc exec" || fail exec-exit-code "got $code"
x sh -c 'echo marker-$(date +%s) > /workspace/marker' >/dev/null 2>&1 || true

# ---- restart in place ----
cid_before=$(container_of "$alloc"); vm_before=$(vm_pid_of "$cid_before" || true)
t0=$(date +%s%N)
nomad alloc restart "$alloc" "$TASK" >/dev/null 2>&1 && info restart "nomad alloc restart issued"
for _ in $(seq 1 90); do c=$(container_of "$alloc"); [ -n "$c" ] && [ "$c" != "$cid_before" ] && x docker info >/dev/null 2>&1 && break; sleep 2; done
cid_after=$(container_of "$alloc"); vm_after=$(vm_pid_of "$cid_after" || true)
[ -n "$cid_after" ] && [ "$cid_after" != "$cid_before" ] && pass restart "same allocation $alloc, new container and VM (qemu $vm_before -> $vm_after) in $(elapsed "$t0") ms; inner dockerd back" || fail restart "container $cid_before -> '$cid_after'"
kill -0 "$vm_before" 2>/dev/null && fail restart-old-vm "old QEMU $vm_before still running" || pass restart-old-vm "old VM gone"
info restart-workspace "/workspace after restart: $(x cat /workspace/marker 2>/dev/null || echo 'gone (alloc-local, compute restart; see RUNBOOK on workspace lifetime)')"

# ---- failure reconciliation: the VM dies under Nomad ----
vm=$(vm_pid_of "$(container_of "$alloc")" || true)
restarts_before=$(api "/v1/allocation/$alloc" | jq ".TaskStates.$TASK.Restarts" || echo 0)
t0=$(date +%s%N)
[ -n "$vm" ] && sudo kill -9 "$vm" && info vm-killed "SIGKILL to QEMU $vm (simulated sandbox VM crash)"
recovered=""
for _ in $(seq 1 90); do
  r=$(api "/v1/allocation/$alloc" | jq ".TaskStates.$TASK.Restarts" || echo 0)
  if [ "$r" -gt "$restarts_before" ] && x docker info >/dev/null 2>&1; then recovered=1; break; fi
  sleep 2
done
[ -n "$recovered" ] && pass reconcile-crash "Nomad saw the task die and restarted it in allocation $alloc (restarts $restarts_before -> $r) in $(elapsed "$t0") ms" || fail reconcile-crash "no recovery; events: $(task_events "$alloc" "$TASK" | tail -4 | tr '\n' ' ')"
running=$(api "/v1/job/$JOB/allocations" | jq '[.[] | select(.ClientStatus=="running")] | length')
[ "$running" = 1 ] && pass reconcile-single "still exactly one running allocation (no duplicate workspace)" || fail reconcile-single "$running running allocations"
task_events "$alloc" "$TASK" > "$KIT_EVIDENCE/$KIT_SCRIPT.task-events.txt"

# ---- the agent's refusals ----
neg() { # file job expected-substring
  nomad job run -detach "$KIT_DIR/nomad/negative/$1.nomad.hcl" >/dev/null 2>&1 || true
  local msg=""
  for _ in $(seq 1 30); do
    msg=$(api "/v1/job/$2/allocations" | jq -r '[.[].TaskStates[]?.Events[]? | .DisplayMessage + " " + (.DriverError // "") + " " + (.SetupError // "")] | join(" | ")' 2>/dev/null || true)
    echo "$msg" | grep -q "$3" && break; sleep 2
  done
  echo "$msg" > "$KIT_EVIDENCE/$KIT_SCRIPT.neg-$1.txt"
  echo "$msg" | grep -q "$3" && pass "refuse-$1" "\"$3\"" || fail "refuse-$1" "expected '$3'; got: ${msg:0:300}"
  purge "$2"
}
neg runtime-runc kit-neg-runtime-runc 'is not allowed'
neg privileged kit-neg-privileged 'privileged'
neg host-socket kit-neg-host-socket 'volumes are not enabled'
nomad job run -detach "$KIT_DIR/nomad/negative/no-runtime.nomad.hcl" >/dev/null 2>&1 || true
nr="" nrc=""
for _ in $(seq 1 45); do
  nr=$(api /v1/job/kit-neg-no-runtime/allocations | jq -r '.[0].ID // empty')
  nrc=$( [ -n "$nr" ] && container_of "$nr" || true); [ -n "$nrc" ] && break; sleep 2
done
[ -n "$nrc" ] || info no-runtime-alloc "alloc=${nr:-none} $( [ -n "$nr" ] && task_events "$nr" t | tail -4 | tr '\n' ' ')"
nrt=$( [ -n "$nrc" ] && sudo docker inspect -f '{{.HostConfig.Runtime}}' "$nrc" || echo "not started")
# allow_runtimes is not consulted for an empty runtime (drivers/docker/driver.go), so such a job
# gets Docker's default runtime. 20 makes that kata, and the backend refuses to submit any job
# whose tasks do not name runtime=kata (assertKataJob in src/hands.ts). This proves the node half.
if [ "$nrt" = kata ]; then pass no-runtime-gets-kata "a job with no runtime ran with Docker's default runtime 'kata' (HostConfig.Runtime)"
elif [ "$nrt" = "not started" ]; then fail no-runtime-gets-kata "the no-runtime job did not start within 90s; cannot tell which runtime it gets"
else fail no-runtime-gets-kata "a job with no runtime ran with '$nrt': Docker default-runtime is not kata (rerun 20)"; fi
purge kit-neg-no-runtime

# ---- stop ----
cid=$(container_of "$alloc"); vm=$(vm_pid_of "$cid" || true)
t0=$(date +%s%N)
api "/v1/job/$JOB?purge=true" -X DELETE >/dev/null
for _ in $(seq 1 60); do [ -z "$(container_of "$alloc")" ] && break; sleep 1; done
[ -z "$(container_of "$alloc")" ] && pass stop "job purged; container gone in $(elapsed "$t0") ms" || fail stop "container still present"
sleep 2
[ -n "$vm" ] && kill -0 "$vm" 2>/dev/null && fail stop-vm "QEMU $vm still running" || pass stop-vm "VM process gone"
code=$(curl -s -o /dev/null -w '%{http_code}' "$NOMAD_ADDR/v1/job/$JOB")
[ "$code" = 404 ] && pass stop-purged "job no longer exists (404)" || fail stop-purged "GET job returned $code"
sudo "$NETCTL" release "$KEY" >/dev/null && pass network-released "$NET released (network, nft binding, source map)" || fail network-released "sandbox-netctl release $KEY failed"

# ---- egress: a Nomad-launched sandbox is behind the proxy ----
# The test proxy (egress/tests/harness.py: the same mitmproxy + addon, plus a local HTTPS upstream
# that echoes a hash of the Authorization header and a random test token only the proxy can read)
# takes over the production proxy's ports for this section, so the job reaches it exactly as in
# production, with no proxy settings: sbx bridge -> nftables redirect of TCP 443 to :3130 / DNS
# to :5353. The guest dials tp.test (static host 198.51.100.7, TEST-NET-2); a temporary node
# nftables table maps that address to the local upstream. Both are removed and the production
# proxy restarted on exit. The token itself is never printed: only its sha256.
EH=$(mktemp -d); HPID=""
# shellcheck disable=SC2317  # invoked by the EXIT trap
egress_restore() { # every step tolerates failure (set -e): the production proxy must come back
  purge "$EJOB" || true; sudo "$NETCTL" release "$EKEY" >/dev/null 2>&1 || true
  local mp; mp=$(jq -r '.pid // empty' "$EH/state.json" 2>/dev/null || true)
  if [ -n "$HPID" ]; then kill "$HPID" 2>/dev/null || true; fi
  if [ -n "$mp" ]; then kill "$mp" 2>/dev/null || true; fi   # the harness's mitmdump, should it outlive the harness
  for _ in $(seq 1 20); do ss -Hltn "sport = :$TPORT" | grep -q . || break; sleep 0.5; done
  sudo nft delete table ip egress_kit_upstream 2>/dev/null || true
  sudo ip addr del 198.51.100.7/32 dev lo 2>/dev/null || true
  rm -rf "$EH" || true
  sudo systemctl reset-failed sandbox-egress 2>/dev/null || true
  sudo systemctl start sandbox-egress || echo "WARN sandbox-egress did not restart: sudo systemctl start sandbox-egress"
}
trap egress_restore EXIT
sudo systemctl stop sandbox-egress
ln -s "$RUN/sources" "$EH/sources"   # the node's source-IP map, written by sandbox-netctl
"$OPT/venv/bin/python" "$EG/tests/harness.py" serve --dir "$EH" --listen "127.0.0.1:$XPORT" --transparent "0.0.0.0:$TPORT" --dns "0.0.0.0:$DNSP" --venv "$OPT/venv" > "$KIT_EVIDENCE/$KIT_SCRIPT.harness.log" 2>&1 &
HPID=$!
for _ in $(seq 1 60); do [ -s "$EH/state.json" ] && break; sleep 1; done
[ -s "$EH/state.json" ] || die egress-harness "test proxy did not start; see $KIT_SCRIPT.harness.log"
U=$(jq -r .https_port "$EH/state.json")
sudo ip addr add 198.51.100.7/32 dev lo
sudo nft -f - <<NFT || die egress-upstream "temporary upstream mapping failed"
table ip egress_kit_upstream {
  chain out { type nat hook output priority -100; policy accept;
    ip daddr 198.51.100.7 tcp dport 443 dnat to 127.0.0.1:$U
  }
}
NFT
TOKSHA=$(jq -r .token_sha256 "$EH/state.json") TOKFILE=$(jq -r .token_file "$EH/state.json")
# Broker order: network, then the allowlist registered with the proxy, then (only then) the job.
mapfile -d '' -t ENV_ < <(netvars "$EKEY" "$(jq -r .mitm_ca "$EH/state.json")") && [ "${#ENV_[@]}" = 8 ] || die egress-network "sandbox-netctl ensure $EKEY failed"
EGW=${ENV_[5]#sandbox_gateway=}
"$OPT/venv/bin/python" "$EG/tests/harness.py" policy --dir "$EH" --key "$EKEY" && test -s "$EH/policies/$EKEY.json" || die egress-policy "policy registration failed; not submitting"
pass egress-registered "$EKEY: ${ENV_[1]#sandbox_network=} bound, allowlist (api.test with injection; metadata.test listed but resolving to 169.254.169.254) registered before submit"
nomad job run -output -var conversation_key="$EKEY" -var generation=1 "${ENV_[@]}" "$KIT_DIR/nomad/hands.nomad.hcl" \
  | jq --arg id "$EJOB" '{Job: (.Job | .ID = $id | .Name = $id), EnforceIndex: true, JobModifyIndex: 0}' | api /v1/jobs -X POST --data @- >/dev/null || die egress-job "registration failed"
ealloc=$(wait_running "$EJOB" 300) || die egress-job "no running allocation within 300s"
ecid=$(container_of "$ealloc")
[ "$(sudo docker inspect -f '{{.HostConfig.Runtime}}' "$ecid")" = kata ] && pass egress-job "$EJOB running under kata on ${ENV_[1]#sandbox_network=}" || fail egress-job "not kata"
ex() { timeout 60 nomad alloc exec -task "$TASK" "$ealloc" sh -c "$1" 2>&1 || true; }
tls() { # SNI name [address] -> response through the transparent proxy (no proxy settings), TLS
  # verified against the CA template (local/egress-ca.pem)
  ex "printf 'GET /echo HTTP/1.1\\r\\nHost: $1\\r\\nConnection: close\\r\\n\\r\\n' | timeout 15 openssl s_client -quiet -connect ${2:-198.51.100.7}:443 -servername $1 -CAfile /local/egress-ca.pem -verify_return_error; echo rc=\$?"
}
r=$(tls tp.test)
echo "$r" | grep -q "\"auth_sha256\": *\"$TOKSHA\"" && pass egress-allowed-injected "tp.test via the transparent proxy (no proxy env), TLS verified against the template CA; upstream saw the injected Authorization (sha256 matches)" || fail egress-allowed-injected "$(echo "$r" | tail -3 | tr '\n' ' ')"
r=$(tls denied.test)
echo "$r" | grep -q auth_sha256 && fail egress-denied-host "denied.test answered" || pass egress-denied-host "denied.test refused by the proxy ($(echo "$r" | grep -m1 -oE '403 [A-Za-z ]*|rc=[0-9]+'))"
r=$(tls metadata.test 169.254.169.254)
echo "$r" | grep -q auth_sha256 && fail egress-metadata-allowlisted "metadata.test reached" || pass egress-metadata-allowlisted "allowlisted name resolving to 169.254.169.254 still refused"
r=$(ex "wget -S -q -T 6 -O /dev/null http://169.254.169.254/latest/meta-data/ 2>&1 | grep -m1 'HTTP/'")
echo "$r" | grep -q ' 403' && pass egress-metadata-proxy "metadata (port 80) refused by the transparent proxy: $(echo "$r" | head -1)" || fail egress-metadata-proxy "$(echo "$r" | tr '\n' ' ')"
r=$(ex 'wget -q -T 4 -O- http://169.254.169.254:8080/ >/dev/null 2>&1 && echo reached || echo blocked')
[ "$r" = blocked ] && pass egress-metadata-direct "169.254.169.254 on another port unreachable" || fail egress-metadata-direct "$r"
r=$(ex 's=$(date +%s); wget -q -T 10 -O- http://1.1.1.1:8443/ >/dev/null 2>&1 && echo reached || echo "blocked $(( $(date +%s) - s ))s"')
echo "$r" | grep -qE '^blocked [01]s$' && pass egress-no-direct-route "1.1.1.1:8443 rejected at once (no route around the proxy)" || fail egress-no-direct-route "$r"
r=$(ex "curl -s -o /dev/null --max-time 6 --proxy http://$EGW:3128 https://tp.test/ && echo reached || echo blocked")
[ "$r" = blocked ] && pass egress-old-proxy-port "the removed explicit proxy port $EGW:3128 is closed" || fail egress-old-proxy-port "$r"
r=$(ex 'nslookup -timeout=3 exfil.example.com 8.8.8.8 >/dev/null 2>&1 && echo answered || echo refused')
[ "$r" = refused ] && pass egress-dns-forced "query to 8.8.8.8 for a non-allowlisted name refused by the proxy DNS" || fail egress-dns-forced "$r"
r=$(ex 'ip -6 route 2>/dev/null | grep -c . ; wget -Y off -q -T 4 -O- "http://[2606:4700:4700::1111]/" >/dev/null 2>&1 && echo reached || echo blocked')
echo "$r" | grep -q blocked && pass egress-ipv6 "no IPv6 egress" || fail egress-ipv6 "$r"
# The token: not at its node path in the guest, not in env, the CA template, secrets or any response.
seen=$(ex "test -e '$TOKFILE' && echo PRESENT; env; cat /local/* /secrets/* 2>/dev/null; ls -la /alloc /local /secrets 2>&1")
seen="$seen$(tls tp.test)"
if echo "$seen" | grep -q PRESENT; then fail egress-token "token file path visible in the guest"
elif sudo grep -qF -f "$TOKFILE" <<<"$seen"; then fail egress-token "token value visible in the guest (output withheld)"
else pass egress-token "token file absent in the guest; value not in env, /local, /secrets or responses (checked on the node)"; fi
record egress-audit tail -n 20 "$EH/audit.jsonl"

if [ "${KEEP_NOMAD:-0}" != 1 ]; then
  sudo systemctl stop nomad-kit && info agent-stopped "nomad-kit stopped (KEEP_NOMAD=1 keeps it)"
fi
finish
