#!/usr/bin/env bash
# Network enforcement test (needs root via sudo, network namespaces and nftables).
# Builds an isolated topology so the machine's own network is untouched:
#   netns egress-node   plays the sandbox node: real proxy (mitmproxy + addon), test upstreams,
#                       node/sandbox-net.sh nftables
#   netns egress-ga/gb  two sandboxes ("guests"), each on its own sbx* veth, commands as nobody
# On the Linux VM, 45-egress.sh repeats the key checks with a real Kata container instead.
#   EGRESS_VENV=/path/to/venv bash tests/netns-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
kit="$(dirname "$here")"
venv="${EGRESS_VENV:-/opt/sandbox-egress/venv}"
sudo -n true 2>/dev/null || { echo "BLOCKED: needs passwordless sudo (root for netns/nftables)"; exit 3; }
sudo sh -c "command -v nft" >/dev/null || { echo "BLOCKED: nft not installed"; exit 3; }
N=egress-node A=egress-ga B=egress-gb
KA=aaaaaaaaaaaaaaaaaaaa KB=bbbbbbbbbbbbbbbbbbbb
PP=13128 DP=15353 TP=13130 CANARY=18081
work=$(mktemp -d); chmod 755 "$work"
fails=0; passes=0
pass() { passes=$((passes + 1)); echo "PASS $1: $2"; }
fail() { fails=$((fails + 1)); echo "FAIL $1: $2"; }
check() { if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "expected '$3', got '$2'"; fi; }
cleanup() {
  sudo ip netns pids "$N" 2>/dev/null | xargs -r sudo kill 2>/dev/null || true
  for ns in "$N" "$A" "$B"; do sudo ip netns del "$ns" 2>/dev/null || true; done
  sudo rm -rf "$work"
}
trap cleanup EXIT
cleanup; work=$(mktemp -d); chmod 755 "$work"

# topology: node <-> guest A (10.88.1.0/30), node <-> guest B (10.88.2.0/30)
for ns in "$N" "$A" "$B"; do sudo ip netns add "$ns"; sudo ip -n "$ns" link set lo up; done
link() { # guest-ns host-if subnet-prefix
  sudo ip link add "$2" netns "$N" type veth peer name eth0 netns "$1"
  sudo ip -n "$N" addr add "$3.1/30" dev "$2"; sudo ip -n "$N" link set "$2" up
  sudo ip -n "$1" addr add "$3.2/30" dev eth0; sudo ip -n "$1" link set eth0 up
  sudo ip -n "$1" route add default via "$3.1"
}
link "$A" sbxa 10.88.1; link "$B" sbxb 10.88.2
sudo ip netns exec "$N" sysctl -qw net.ipv4.ip_forward=1   # forwarding on: the nft drop must hold anyway
# A default route on the node (to a dummy uplink) so traffic to the internet reaches the forward
# hook, as on a real host; without it the kernel drops it at routing and the rules go untested.
sudo ip -n "$N" link add up0 type dummy; sudo ip -n "$N" addr add 192.0.2.1/24 dev up0; sudo ip -n "$N" link set up0 up
sudo ip -n "$N" route add default via 192.0.2.254
sleep 2  # IPv6 link-local addresses (DAD)

# node: enforcement, then proxy + upstreams (as the invoking user, not root)
nodex() { sudo ip netns exec "$N" "$@"; }
nodex env DNS_PORT=$DP TPROXY_PORT=$TP STATE_DIR="$work/run" bash "$kit/node/sandbox-net.sh" init
nodex env STATE_DIR="$work/run" bash "$kit/node/sandbox-net.sh" add sbxa 10.88.1.2 "$KA"
nodex env STATE_DIR="$work/run" bash "$kit/node/sandbox-net.sh" add sbxb 10.88.2.2 "$KB"
sudo chown -R "$(id -u):$(id -g)" "$work"
mkdir -p "$work/h"
# shellcheck disable=SC2024  # the log is written by the invoking user on purpose
sudo ip netns exec "$N" setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups \
  "$venv/bin/python" "$here/harness.py" serve --dir "$work/h" --listen "0.0.0.0:$PP" --dns "0.0.0.0:$DP" --transparent "0.0.0.0:$TP" --venv "$venv" \
  >"$work/serve.log" 2>&1 &
for _ in $(seq 1 150); do [ -s "$work/h/state.json" ] && break; sleep 0.2; done
[ -s "$work/h/state.json" ] || { cat "$work/serve.log"; echo "harness did not start"; exit 1; }
# the proxy's identity map comes from sandbox-net.sh (trusted host), policies from the backend
rmdir "$work/h/sources" && ln -s "$work/run/sources" "$work/h/sources"
"$venv/bin/python" "$here/harness.py" policy --dir "$work/h" --key "$KA"
"$venv/bin/python" "$here/harness.py" policy --dir "$work/h" --key "$KB" --only cdn.test
U=$(jq -r .https_port "$work/h/state.json")
cp "$(jq -r .mitm_ca "$work/h/state.json")" "$work/guest-ca.pem"; chmod 644 "$work/guest-ca.pem"  # = guest trust store
TOKSHA=$(jq -r .token_sha256 "$work/h/state.json"); TOKFILE=$(jq -r .token_file "$work/h/state.json")
# canaries on the node: a host service, and the same on IPv6
nodex python3 -m http.server "$CANARY" --bind :: >/dev/null 2>&1 &

# guest commands run as nobody inside the guest namespace
g() { local ns=$1; shift; sudo ip netns exec "$ns" setpriv --reuid=65534 --regid=65534 --clear-groups "$@"; }
gcurl() { local ns=$1; shift; g "$ns" curl -sS --max-time 4 --cacert "$work/guest-ca.pem" "$@" 2>&1 || true; }
code() { local ns=$1 gw=$2; shift 2
  local r; r=$(g "$ns" curl -s -o /dev/null -w '%{http_code} %{http_connect}' --max-time 4 --cacert "$work/guest-ca.pem" --proxy "http://$gw:$PP" "$@" 2>/dev/null || true)
  case "$r" in "000 000"|"") echo blocked ;; "000 "*) echo "${r#000 }" ;; *) echo "${r%% *}" ;; esac; }
counter() { nodex nft list table inet sandbox_egress | grep -F "$1" | grep -o 'packets [0-9]*' | awk '{s+=$2} END {print s+0}'; }

# transparent mode: no proxy settings in the guest, only trust in the node CA
# (tp.test -> 198.51.100.7 in static_hosts; on the node that address is the local upstream)
nodex ip addr add 198.51.100.7/32 dev lo
nodex nft -f - <<NFT
table ip egress_test_upstream {
  chain out { type nat hook output priority -100; policy accept;
    ip daddr 198.51.100.7 tcp dport 443 dnat to 127.0.0.1:$U
  }
}
NFT
R=(--resolve tp.test:443:198.51.100.7 --resolve tp.test:80:198.51.100.7)
tcode() { local ns=$1; shift; local r
  r=$(g "$ns" curl -s -o /dev/null -w '%{http_code}' --max-time 4 --cacert "$work/guest-ca.pem" "$@" 2>/dev/null || true)
  [ "$r" = 000 ] || [ -z "$r" ] && echo blocked || echo "$r"; }
# 1. per-conversation allowlists, injection outside the guest (transparent: no proxy settings)
check a-allowed-injected "$(g "$A" curl -sS --max-time 4 --cacert "$work/guest-ca.pem" "${R[@]}" https://tp.test/echo 2>&1 | jq -r .auth_sha256)" "$TOKSHA"
# the explicit proxy port is not reachable from a sandbox (only the transparent listener is)
t0=$(date +%s%N); r=$(code "$A" 10.88.1.1 "${R[@]}" https://tp.test/echo); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
check explicit-proxy-port-closed "$r $([ "$ms" -lt 1500 ] && echo fast || echo "slow ${ms}ms")" "blocked fast"
# 2. no bypass: direct connections never leave the guest's link
fwd0=$(counter 'no route out')
# (80/443 now land on the transparent proxy, which refuses IP literals with a 403: raw-ip)
check direct-internet "$(code "$A" '' --noproxy '*' "https://1.1.1.1/")" "403"
check direct-metadata "$(code "$A" '' --noproxy '*' "http://169.254.169.254/latest/meta-data/")" "403"
check direct-other-sandbox "$(code "$A" '' --noproxy '*' "http://10.88.2.2:8080/")" "blocked"
fwd1=$(counter 'no route out')
check forward-drops-counted "$([ "$fwd1" -gt "$fwd0" ] && echo yes || echo "no ($fwd0 -> $fwd1)")" "yes"
check direct-host-service "$(code "$A" '' --noproxy '*' "http://10.88.1.1:$CANARY/")" "blocked"
check node-canary-is-up "$(nodex curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CANARY/")" "200"
# (guest probes run as nobody with the system python3 and only the stdlib part of harness.py,
# copied into the world-readable work dir because the kit may live under a private $HOME)
install -m 0644 "$here/harness.py" "$work/probe.py"
# 3. DNS: any resolver address lands on the proxy's DNS; only allowlisted names answer
check dns-any-server-allowed "$(g "$A" python3 "$work/probe.py" dns-query 8.8.8.8 53 api.test)" "rcode=0 answers=127.0.0.1"
check dns-any-server-denied "$(g "$A" python3 "$work/probe.py" dns-query 1.1.1.1 53 exfil.evil.example)" "rcode=5 answers=-"
check dns-other-sandbox-name "$(g "$B" python3 "$work/probe.py" dns-query 10.88.2.1 53 api.test)" "rcode=5 answers=-"
check udp-other-port "$(g "$A" python3 "$work/probe.py" dns-query 8.8.8.8 123 api.test)" "error TimeoutError"
# 4. IPv6: the node's link-local address is unreachable from the guest
ll=$(nodex ip -6 -o addr show dev sbxa scope link | awk '{print $4}' | cut -d/ -f1)
r6=$(g "$A" curl -s -o /dev/null -w '%{http_code}' --max-time 3 -g "http://[$ll%eth0]:$CANARY/" 2>/dev/null || true)
check ipv6-link-local "$([ "$r6" = 000 ] || [ -z "$r6" ] && echo blocked || echo "reached ($r6)")" "blocked"
check ipv6-drops-counted "$([ "$(counter 'no IPv6')" -gt 0 ] && echo yes || echo no)" "yes"
# 5. spoofing: guest A claims guest B's address
sudo ip -n "$A" addr add 10.88.2.2/32 dev eth0
spoof0=$(counter 'anti-spoofing')
check spoofed-source "$(tcode "$A" --interface 10.88.2.2 "${R[@]}" https://tp.test/echo)" "blocked"
check spoof-drops-counted "$([ "$(counter 'anti-spoofing')" -gt "$spoof0" ] && echo yes || echo no)" "yes"
sudo ip -n "$A" addr del 10.88.2.2/32 dev eth0
check tp-dns "$(g "$A" python3 "$work/probe.py" dns-query 8.8.8.8 53 tp.test)" "rcode=0 answers=198.51.100.7"
check tp-allowed-no-proxy-env "$(tcode "$A" "${R[@]}" https://tp.test/echo)" "200"
check tp-http2 "$(tcode "$A" --http2 "${R[@]}" https://tp.test/echo)" "200"
check tp-other-sandbox "$(tcode "$B" "${R[@]}" https://tp.test/echo)" "403"
check tp-post-get-only "$(tcode "$A" -X POST -d x "${R[@]}" https://tp.test/echo)" "403"
check tp-host-header-mismatch "$(tcode "$A" -H 'Host: cdn.test' "${R[@]}" https://tp.test/echo)" "403"
check tp-plain-http "$(tcode "$A" "${R[@]}" http://tp.test/echo)" "403"
check tp-fronting-wrong-ip "$(tcode "$A" --resolve tp.test:443:203.0.113.9 https://tp.test/echo)" "403"
check tp-sni-not-allowed "$(tcode "$A" --resolve denied.test:443:198.51.100.7 https://denied.test/echo)" "403"
check tp-no-sni "$(tcode "$A" -k https://198.51.100.7/echo)" "403"
check tp-websocket "$(tcode "$A" --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${R[@]}" https://tp.test/ws)" "101"
# fail fast: other TCP ports get a reset at once (not a silent drop), UDP 443 (QUIC) never leaves
t0=$(date +%s%N); r=$(tcode "$A" https://1.1.1.1:8443/); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
check other-port-rejected-fast "$r $([ "$ms" -lt 1500 ] && echo fast || echo "slow ${ms}ms")" "blocked fast"
t0=$(date +%s%N); r=$(g "$A" bash -c 'exec 3<>/dev/tcp/10.88.1.1/22' 2>&1 || true); r=$(echo "$r" | grep -qi refused && echo refused || echo "other: $r"); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
check host-ssh-rejected-fast "$r $([ "$ms" -lt 1500 ] && echo fast || echo "slow ${ms}ms")" "refused fast"
rej0=$(counter 'fail fast')
check udp-443-quic "$(g "$A" python3 "$work/probe.py" dns-query 1.1.1.1 443 tp.test)" "error TimeoutError"
check udp-rejects-counted "$([ "$(counter 'fail fast')" -gt "$rej0" ] && echo yes || echo no)" "yes"
# denied transparent connections: refused by the proxy (403 + reason), never connected upstream
for rs in host-not-allowed destination-not-resolved no-sni; do
  check "tp-audit-$rs" "$(grep '"mode": "transparent"' "$work/h/audit.jsonl" | grep -c "\"reason\": \"$rs\"" | awk '{print ($1>0)?"yes":"no"}')" "yes"
done
check tp-audit-transparent "$(grep -c '"mode": "transparent"' "$work/h/audit.jsonl" | awk '{print ($1>0)?"yes":"no"}')" "yes"
# 6. the credential is not readable from the guest, nor in its environment or responses
check guest-cannot-read-token "$(g "$A" cat "$TOKFILE" >/dev/null 2>&1 && echo readable || echo denied)" "denied"
check guest-env-clean "$(g "$A" env | grep -c "$(sudo cat "$TOKFILE")" || true)" "0"
check token-not-in-response "$(gcurl "$A" "${R[@]}" https://tp.test/echo | grep -c "$(sudo cat "$TOKFILE")" || true)" "0"
check audit-no-token "$(grep -c "$(sudo cat "$TOKFILE")" "$work/h/audit.jsonl" || true)" "0"
nodex nft list table inet sandbox_egress > "$work/ruleset.txt"
echo "--- ruleset with counters (evidence) ---"; grep -E 'counter|comment' "$work/ruleset.txt" | sed 's/^\s*/  /'
echo "=== netns-test: $passes passed, $fails failed"
if [ "$fails" = 0 ]; then echo "RESULT PASS"; else echo "RESULT FAIL"; exit 1; fi
