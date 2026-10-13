#!/usr/bin/env bash
# Functional test of the egress proxy policy on loopback (no root needed). The real proxy
# (mitmproxy + addon) runs with a test upstream; curl plays the sandbox. Network-level
# enforcement (no bypass, DNS/UDP/IPv6/metadata routing, spoofing) is in netns-test.sh.
#   EGRESS_VENV=/path/to/venv bash tests/proxy-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venv="${EGRESS_VENV:-/opt/sandbox-egress/venv}"
work=$(mktemp -d)
fails=0; passes=0
pass() { passes=$((passes + 1)); echo "PASS $1: $2"; }
fail() { fails=$((fails + 1)); echo "FAIL $1: $2"; }
check() { if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "expected '$3', got '$2'"; fi; }
free_port() { "$venv/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
KEY=aaaaaaaaaaaaaaaaaaaa
PP=$(free_port); DP=$(free_port)
"$venv/bin/python" "$here/harness.py" serve --dir "$work" --listen "127.0.0.1:$PP" --dns "127.0.0.1:$DP" \
  --source "127.0.0.1=$KEY" --venv "$venv" >"$work/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; pkill -f "egress_config=$work/" 2>/dev/null; rm -rf "$work"' EXIT
for _ in $(seq 1 150); do [ -s "$work/state.json" ] && break; sleep 0.2; done
[ -s "$work/state.json" ] || { cat "$work/serve.log"; echo "harness did not start"; exit 1; }
st() { jq -r ".$1" "$work/state.json"; }
U=$(st https_port); T=$(st tcp_port); CA=$(st mitm_ca); TOKSHA=$(st token_sha256)
c() { curl -sS --max-time 10 --proxy "http://127.0.0.1:$PP" --cacert "$CA" "$@" 2>&1 || true; }
# The status the client saw: the HTTP status, or the proxy's answer to CONNECT when the tunnel was refused.
code() {
  local r; r=$(curl -s -o /dev/null -w '%{http_code} %{http_connect}' --max-time 10 --proxy "http://127.0.0.1:$PP" --cacert "$CA" "$@" 2>/dev/null || true)
  case "$r" in "000 000"|"") echo 000 ;; "000 "*) echo "${r#000 }" ;; *) echo "${r%% *}" ;; esac
}

# allowed host: request passes, credential injected outside the client
out=$(c "https://api.test:$U/echo?q=secret-query-value")
check allowed-injected "$(echo "$out" | jq -r .auth_sha256)" "$TOKSHA"
check allowed-no-token-in-response "$(grep -c "$(cat "$work/secrets/testsvc.token")" <<<"$out" || true)" "0"
# the client's own credential for that header is replaced, not forwarded
out=$(c -H "Authorization: Bearer guest-supplied" "https://api.test:$U/echo")
check guest-header-replaced "$(echo "$out" | jq -r .auth_sha256)" "$TOKSHA"
# allowed host without an injection rule gets no credential
check allowed-no-inject "$(c "https://cdn.test:$U/echo" | jq -r .auth_sha256)" "null"
# per-rule methods: cdn.test allows GET/HEAD only
check method-not-allowed "$(code -X POST --data x "https://cdn.test:$U/echo")" "403"
# per-rule paths: POST allowed only on */*/git-upload-pack (upstream answers 501 to any POST)
check path-allowed-upload-pack "$(code -X POST --data x "https://cdn.test:$U/octo/repo.git/git-upload-pack")" "501"
check path-allowed-upload-pack-nogit "$(code -X POST --data x "https://cdn.test:$U/octo/repo/git-upload-pack")" "501"
check path-denied-receive-pack "$(code -X POST --data x "https://cdn.test:$U/octo/repo.git/git-receive-pack")" "403"
check path-denied-other-post "$(code -X POST --data x "https://cdn.test:$U/octo/repo.git/info/lfs/objects/batch")" "403"
check path-denied-deeper "$(code -X POST --data x "https://cdn.test:$U/a/b/c/git-upload-pack")" "403"
check path-denied-dotdot "$(code --path-as-is -X POST --data x "https://cdn.test:$U/octo/x/../git-upload-pack")" "403"
check path-denied-encoded "$(code -X POST --data x "https://cdn.test:$U/octo%2Frepo/x/git-upload-pack")" "403"
check path-get-still-allowed "$(code "https://cdn.test:$U/echo")" "200"
# the policy names the secret for a host the secret does not list: not injected
check secret-host-bound "$(c "https://denied-for-secret.test:$U/echo" | jq -r .auth_sha256)" "null"
# denied host, raw IPs, metadata
check denied-host "$(code "https://denied.test:$U/echo")" "403"
check raw-ip-loopback "$(code "https://127.0.0.1:$U/echo")" "403"
check raw-ip-public "$(code "https://93.184.215.14/")" "403"
check metadata-raw-ip "$(code "http://169.254.169.254/latest/meta-data/")" "403"
# IPv4-mapped IPv6 forms of metadata are treated as the IPv4 address (always blocked)
check metadata-v4-mapped "$("$venv/bin/python" -c 'import sys; sys.path.insert(0, sys.argv[1]); import sandbox_egress as s; print(any(s._ip("::ffff:169.254.169.254") in n for n in s.ALWAYS_BLOCKED))' "$here/../addon")" "True"
check metadata-via-allowed-name "$(code "https://metadata.test:$U/echo")" "502"
check metadata-plain-http-name "$(code "http://metadata.test/latest/meta-data/")" "502"
check private-rebind "$(code "https://rebind.test:$U/echo")" "502"
# plain HTTP to an https-only rule; port not in the rule
check plain-http "$(code "http://api.test:$U/echo")" "403"
check wrong-port "$(code "https://api.test:8443/echo")" "403"
# fronting: Host header and SNI must name the CONNECT host
check host-header-fronting "$(code -H "Host: denied.test" "https://api.test:$U/echo")" "403"
out=$(curl -sS --max-time 10 --proxy "http://127.0.0.1:$PP" --cacert "$CA" --connect-to "denied.test:$U:api.test:$U" "https://denied.test:$U/echo" -o /dev/null -w '%{http_code}' 2>&1 || true)
check connect-to-fronting "$out" "403"
# redirects: followed hops are checked again; the credential stays with its host
check redirect-to-denied "$(code -L "https://api.test:$U/redirect?to=https://denied.test:$U/echo")" "403"
out=$(c -L "https://api.test:$U/redirect?to=https://cdn.test:$U/echo")
check redirect-no-credential-carryover "$(echo "$out" | jq -r .auth_sha256)" "null"
# websockets: allowed with opt-in (api.test), refused without (cdn.test)
out=$(curl -sS --max-time 5 --proxy "http://127.0.0.1:$PP" --cacert "$CA" "wss://api.test:$U/ws" 2>&1 || true)
check websocket-allowed "$(grep -o hello-ws <<<"$out" | head -1)" "hello-ws"
check websocket-not-opted-in "$(code "wss://cdn.test:$U/ws")" "403"
# non-HTTP inside an allowed CONNECT: killed before the upstream answers
out=$("$venv/bin/python" "$here/harness.py" tcp-probe 127.0.0.1 "$PP" api.test "$T")
case "$out" in *"200"*"<closed>"*|*"200"*"Error>"*) pass non-http-killed "$out";; *) fail non-http-killed "$out";; esac
# DNS: allowlisted names resolve (metadata answers dropped), others refused, nothing forwarded
check dns-allowed "$("$venv/bin/python" "$here/harness.py" dns-query 127.0.0.1 "$DP" api.test)" "rcode=0 answers=127.0.0.1"
check dns-denied "$("$venv/bin/python" "$here/harness.py" dns-query 127.0.0.1 "$DP" exfil-data.evil.example)" "rcode=5 answers=-"
check dns-metadata-filtered "$("$venv/bin/python" "$here/harness.py" dns-query 127.0.0.1 "$DP" metadata.test)" "rcode=0 answers=-"
check dns-aaaa-nodata "$("$venv/bin/python" "$here/harness.py" dns-query 127.0.0.1 "$DP" api.test 28)" "rcode=0 answers=-"
check dns-aaaa-denied "$("$venv/bin/python" "$here/harness.py" dns-query 127.0.0.1 "$DP" exfil-data.evil.example 28)" "rcode=5 answers=-"
# taint narrows egress to allowWhenTainted hosts; the trusted side rewrites the policy
"$venv/bin/python" "$here/harness.py" policy --dir "$work" --key "$KEY" --tainted
check tainted-blocks-api "$(code "https://api.test:$U/echo")" "403"
check tainted-keeps-cdn "$(code "https://cdn.test:$U/echo")" "200"
# a source with no mapping gets nothing (the policy belongs to the sandbox's interface/IP)
rm -f "$work/sources/127.0.0.1"
check unknown-source "$(code "https://cdn.test:$U/echo")" "403"
# audit: decisions recorded; no credential, query string, or body content
A="$work/audit.jsonl"
check audit-has-denies "$( [ "$(jq -r 'select(.decision=="deny") | .reason' "$A" | sort -u | wc -l)" -ge 8 ] && echo yes || echo no)" "yes"
check audit-no-token "$(grep -c "$(cat "$work/secrets/testsvc.token")" "$A" || true)" "0"
check audit-no-bearer "$(grep -ci 'bearer' "$A" || true)" "0"
check audit-no-query "$(grep -c 'secret-query-value' "$A" || true)" "0"
check audit-no-body "$(grep -c 'hello-ws\|auth_sha256\|RAW-TCP-BANNER' "$A" || true)" "0"
check audit-injection-named "$(jq -r 'select(.injected=="testsvc") | .host' "$A" | sort -u | tr '\n' ' ')" "api.test "
echo "reasons seen: $(jq -r 'select(.decision=="deny") | .reason' "$A" | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
echo "=== proxy-test: $passes passed, $fails failed"
if [ "$fails" = 0 ]; then echo "RESULT PASS"; else echo "RESULT FAIL"; exit 1; fi
