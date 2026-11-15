#!/usr/bin/env bash
# The open-web tier (node config open_web_read, on by default): an unlisted host takes
# GET/HEAD only, no body, tight URL/query caps, no websocket, within a per-conversation budget.
# Loopback, no root.   EGRESS_VENV=/path/to/venv bash tests/open-web-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venv="${EGRESS_VENV:-/opt/sandbox-egress/venv}"
work=$(mktemp -d)
fails=0; passes=0
pass() { passes=$((passes + 1)); echo "PASS $1: $2"; }
fail() { fails=$((fails + 1)); echo "FAIL $1: $2"; }
check() { if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "expected '$3', got '$2'"; fi; }
free_port() { "$venv/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
KEY=cccccccccccccccccccc
PP=$(free_port); DP=$(free_port)
"$venv/bin/python" "$here/harness.py" serve --dir "$work" --listen "127.0.0.1:$PP" --dns "127.0.0.1:$DP" \
  --source "127.0.0.1=$KEY" --venv "$venv" --open-web >"$work/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; pkill -f "egress_config=$work/" 2>/dev/null; rm -rf "$work"' EXIT
for _ in $(seq 1 150); do [ -s "$work/state.json" ] && break; sleep 0.2; done
[ -s "$work/state.json" ] || { cat "$work/serve.log"; echo "harness did not start"; exit 1; }
st() { jq -r ".$1" "$work/state.json"; }
U=$(st https_port); CA=$(st mitm_ca)
code() {
  local r; r=$(curl -s -o /dev/null -w '%{http_code} %{http_connect}' --max-time 10 --proxy "http://127.0.0.1:$PP" --cacert "$CA" "$@" 2>/dev/null || true)
  case "$r" in "000 000"|"") echo 000 ;; "000 "*) echo "${r#000 }" ;; *) echo "${r%% *}" ;; esac
}
check open-web-get "$(code "https://open.test:$U/echo")" "200"
# the warehouse is never an open-web host
check open-web-warehouse-denied "$(code "https://trino.test:$U/echo")" "403"
# HEAD reaches the upstream (the test server answers 501 to HEAD), so the proxy allowed it
check open-web-head "$(code -I "https://open.test:$U/echo")" "501"
check open-web-post "$(code -X POST --data x "https://open.test:$U/echo")" "403"
check open-web-get-with-body "$(code -X GET --data x "https://open.test:$U/echo")" "403"
check open-web-query-cap "$(code "https://open.test:$U/echo?q=$(head -c 600 /dev/zero | tr '\0' a)")" "403"
check open-web-url-cap "$(code "https://open.test:$U/$(head -c 2100 /dev/zero | tr '\0' a)")" "403"
check open-web-small-query "$(code "https://open.test:$U/echo?q=$(head -c 400 /dev/zero | tr '\0' a)")" "200"
check open-web-websocket "$(code --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "https://open.test:$U/ws")" "403"
check open-web-secret "$(code "https://open.test:$U/echo?t=ghp_$(head -c 36 /dev/zero | tr '\0' B)")" "403"
check open-web-raw-ip "$(code "https://127.0.0.1:$U/echo")" "403"
check open-web-dns "$("$venv/bin/python" "$here/harness.py" dns-query 127.0.0.1 "$DP" open.test)" "rcode=0 answers=127.0.0.1"
# listed rules still apply as before (cdn.test allows GET/HEAD only)
check listed-rule-still-wins "$(code -X POST --data x "https://cdn.test:$U/echo")" "403"
# per-conversation budget (40 requests in this harness): the tier stops, listed hosts keep working
for i in $(seq 1 45); do last=$(code "https://open.test:$U/echo?i=$i"); done
check open-web-budget "$last" "403"
check listed-after-budget "$(code "https://cdn.test:$U/echo")" "200"
check open-web-reasons "$(jq -r 'select(.host=="open.test" and .decision=="deny") | .reason' "$work/audit.jsonl" | sort -u | tr '\n' ' ')" "budget-requests open-web-body open-web-method query-too-long secret-detected url-too-long websocket-not-allowed "
echo "=== open-web-test: $passes passed, $fails failed"
if [ "$fails" = 0 ]; then echo "RESULT PASS"; else echo "RESULT FAIL"; exit 1; fi
