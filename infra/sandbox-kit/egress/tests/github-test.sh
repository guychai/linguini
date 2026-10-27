#!/usr/bin/env bash
# GitHub through the egress proxy, end to end on loopback (no root, no network, no real GitHub):
# real `git` clients behind the real proxy (mitmproxy + addon) against a mock GitHub (harness.py:
# git http-backend over bare repos, REST paths, and the App API that mints repo-scoped tokens).
#   EGRESS_VENV=/path/to/venv bash tests/github-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venv="${EGRESS_VENV:-/opt/sandbox-egress/venv}"
work=$(mktemp -d)
fails=0; passes=0
pass() { passes=$((passes + 1)); echo "PASS $1: $2"; }
fail() { fails=$((fails + 1)); echo "FAIL $1: $2"; }
check() { if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$3" <<<"$2"; then pass "$1" "found '$3'"; else fail "$1" "no '$3' in: $(tr '\n' ' ' <<<"$2" | cut -c1-300)"; fi; }
free_port() { "$venv/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
KEY=bbbbbbbbbbbbbbbbbbbb
PP=$(free_port); DP=$(free_port)
"$venv/bin/python" "$here/harness.py" serve --dir "$work" --listen "127.0.0.1:$PP" --dns "127.0.0.1:$DP" \
  --source "127.0.0.1=$KEY" --venv "$venv" >"$work/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; pkill -f "egress_config=$work/" 2>/dev/null; rm -rf "$work"' EXIT
for _ in $(seq 1 150); do [ -s "$work/state.json" ] && break; sleep 0.2; done
[ -s "$work/state.json" ] || { cat "$work/serve.log"; echo "harness did not start"; exit 1; }
st() { jq -r ".$1" "$work/state.json"; }
U=$(st https_port); CA=$(st mitm_ca); UCA=$(st upstream_ca); A=$(st audit)
GH="https://github.com:$U"
# The sandbox's git: only the proxy and its CA, no credentials, no prompts.
g() {
  env -i PATH="$PATH" HOME="$work/home" GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 \
    git -c http.proxy="http://127.0.0.1:$PP" -c http.sslCAInfo="$CA" -c credential.helper= \
    -c init.defaultBranch=main "$@" 2>&1
}
c() { curl -sS --max-time 10 --proxy "http://127.0.0.1:$PP" --cacert "$CA" "$@" 2>&1 || true; }
mints() { curl -sS --cacert "$UCA" "https://localhost:$U/_stats" | jq -r '.mints | join(",")'; }
mkdir -p "$work/home" "$work/c"

# public repository without the App: anonymous clone works
out=$(g clone -q "$GH/octo/open.git" "$work/c/open" || true)
check public-clone-anonymous "$(cat "$work/c/open/README.md" 2>/dev/null)" "repo octo/open"
check public-clone-audit "$(jq -r 'select(.repo=="octo/open" and .method=="POST") | "\(.github)/\(.github_reason)"' "$A" | sort -u)" "anonymous/not-installed"
# public repository with the App installed: cloned with its token (better rate limits)
out=$(g clone -q "$GH/octo/public.git" "$work/c/public" || true)
check public-clone "$(cat "$work/c/public/README.md" 2>/dev/null)" "repo octo/public"
# private repository the App is installed on: clone works with a token minted for it alone
out=$(g clone -q "$GH/octo/private.git" "$work/c/private" || true)
check private-clone "$(cat "$work/c/private/README.md" 2>/dev/null)" "repo octo/private"
check private-clone-no-dotgit "$(g ls-remote "$GH/octo/private" HEAD | awk '{print $2}')" "HEAD"
# minted once per repository, then cached (public got its own token; a token never spans repos)
before=$(mints)
out=$(g -C "$work/c/private" fetch -q origin && echo fetched)
check private-fetch "$out" "fetched"
check token-cached "$(mints)" "$before"
case ",$before," in *",private,"*) pass mint-per-repo "$before";; *) fail mint-per-repo "$before";; esac
# protocol v0 too (info/refs + upload-pack without Git-Protocol)
out=$(g -c protocol.version=0 ls-remote "$GH/octo/private.git" main | awk '{print $2}')
check private-protocol-v0 "$out" "refs/heads/main"
# private repository the App cannot see: a readable error, no password prompt
out=$(g clone -q "$GH/octo/hidden.git" "$work/c/hidden" || true)
echo "  (git's output for the hidden repo: $(tr '\n' ' ' <<<"$out"))"
has hidden-clear-error "$out" "Linguini GitHub App has no access"
has hidden-names-repo "$out" "github.com/octo/hidden"
check hidden-no-prompt "$(grep -c 'Username\|terminal prompts' <<<"$out" || true)" "0"
# credentials from the guest are dropped: they neither unlock a repo nor reach GitHub
out=$(g clone -q "https://x-access-token:guest-pat@github.com:$U/octo/hidden.git" "$work/c/hidden2" || true)
has guest-credentials-ignored "$out" "Linguini GitHub App has no access"
out=$(c -H "Authorization: Bearer guest-supplied" "https://api.github.com:$U/repos/octo/hidden/auth-echo")
check api-guest-auth-stripped "$(jq -r .auth <<<"$out")" "none"
# push: refused by the proxy with a clear message, both discovery and data
( cd "$work/c/private" && echo change >> README.md && g -c user.name=t -c user.email=t@t commit -qam change >/dev/null )
out=$(g -C "$work/c/private" push -q origin HEAD:refs/heads/linguini/test || true)
echo "  (git's output for the push: $(tr '\n' ' ' <<<"$out"))"
has push-refused "$out" "git-push-not-enabled"
check push-data-refused "$(c -o /dev/null -w '%{http_code}' -X POST --data x "$GH/octo/private.git/git-receive-pack")" "403"
check push-not-in-mock "$(g ls-remote "$GH/octo/private.git" | grep -c linguini/ || true)" "0"
# REST API: repo-scoped Bearer token for the installed repo; anonymous elsewhere
check api-app-token "$(c "https://api.github.com:$U/repos/octo/private/auth-echo" | jq -r .auth)" "app:octo/private"
check api-public-installed "$(c "https://api.github.com:$U/repos/octo/public/auth-echo" | jq -r .auth)" "app:octo/public"
check api-public-anonymous "$(c "https://api.github.com:$U/repos/octo/open/auth-echo" | jq -r .auth)" "none"
check api-not-installed "$(c "https://api.github.com:$U/repos/octo/hidden/auth-echo" | jq -r .auth)" "none"
check api-archive-uncredentialed "$(c "https://api.github.com:$U/repos/octo/private/tarball/main" | jq -r .auth)" "none"
out=$(c "https://api.github.com:$U/repos/octo/private/contents/README.md")
check api-download-token-scrubbed "$(jq -r .download_url <<<"$out")" "https://raw.githubusercontent.com/octo/private/main/README.md?token=REDACTED-by-egress"
check api-post-denied "$(c -o /dev/null -w '%{http_code}' -X POST --data '{}' "https://api.github.com:$U/repos/octo/private/issues")" "403"
# raw.githubusercontent.com: token form, private file readable
check raw-private "$(c "https://raw.githubusercontent.com:$U/octo/private/main/README.md")" "raw octo/private auth=app:octo/private"
# a conversation naming endless repositories cannot use up the App's API rate limit (budget 20 here)
for i in $(seq 1 25); do out=$(g ls-remote "$GH/octo/nope$i.git" 2>&1 || true); done
has app-lookup-budget "$out" "too many different GitHub repositories"
check app-budget-cached-still-works "$(g ls-remote "$GH/octo/private.git" main | awk '{print $2}')" "refs/heads/main"
# conversation not enabled for the App (owner not in GITHUB_APP_OWNERS): public still works, private explains
"$venv/bin/python" "$here/harness.py" policy --dir "$work" --key "$KEY" --no-github-app
out=$(g clone -q "$GH/octo/private.git" "$work/c/private-off" || true)
has app-disabled-message "$out" "not enabled for this account"
check app-disabled-public "$(g ls-remote "$GH/octo/public.git" main | awk '{print $2}')" "refs/heads/main"
check app-disabled-api "$(c "https://api.github.com:$U/repos/octo/private/auth-echo" | jq -r .auth)" "none"
# tainted conversation: no GitHub at all
"$venv/bin/python" "$here/harness.py" policy --dir "$work" --key "$KEY" --tainted
out=$(g ls-remote "$GH/octo/public.git" || true)
has tainted-no-github "$out" "403\|denied\|tainted\|Forbidden"
# the App's JWTs were all valid
check app-jwt-valid "$(curl -sS --cacert "$UCA" "https://localhost:$U/_stats" | jq -r .bad_jwt)" "0"
# audit: per-conversation repository access recorded; no token, JWT or Basic credential anywhere
check audit-repo-access "$(jq -r "select(.sandbox==\"$KEY\" and .repo==\"octo/private\" and .github==\"app\") | .repo" "$A" | sort -u)" "octo/private"
check audit-push-denied "$(jq -r 'select(.reason=="git-push-not-enabled") | .repo' "$A" | sort -u)" "octo/private"
check audit-no-ghs "$(grep -c 'ghs_' "$A" || true)" "0"
check audit-no-basic "$(grep -ci 'basic \|x-access-token\|bearer\|eyJ' "$A" || true)" "0"
check audit-no-guest-secret "$(grep -c 'guest-pat\|guest-supplied' "$A" || true)" "0"
check audit-no-download-token "$(grep -c 'GHSAT0' "$A" || true)" "0"
echo "=== github-test: $passes passed, $fails failed"
if [ "$fails" = 0 ]; then echo "RESULT PASS"; else echo "RESULT FAIL"; exit 1; fi
