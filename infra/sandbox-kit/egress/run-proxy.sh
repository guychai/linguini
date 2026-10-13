#!/usr/bin/env bash
# Start the egress proxy (mitmproxy + addon/sandbox_egress.py) in the foreground.
#   EGRESS_VENV      venv with requirements.lock installed (default: /opt/sandbox-egress/venv)
#   EGRESS_CONFIG    node config JSON (see config.example.json)
#   EGRESS_TRANSPARENT  transparent listener (default 127.0.0.1:3130); nftables redirects sandbox
#                    TCP 80/443 here, so guests need no proxy settings
#   EGRESS_EXPLICIT  TESTS ONLY: also run an explicit (CONNECT) proxy on this address, for the
#                    loopback policy suite (tests/proxy-test.sh). Never set on a node.
#   EGRESS_DNS       DNS listener (default 127.0.0.1:5353); node nftables DNATs port 53 here
#   EGRESS_CONFDIR   mitmproxy confdir holding the node CA (key never leaves the node)
#   EGRESS_UPSTREAM_CA  extra CA bundle for upstream verification (tests only)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venv="${EGRESS_VENV:-/opt/sandbox-egress/venv}"
: "${EGRESS_CONFIG:?set EGRESS_CONFIG}"
dnsl="${EGRESS_DNS:-127.0.0.1:5353}"
tlisten="${EGRESS_TRANSPARENT:-127.0.0.1:3130}"
confdir="${EGRESS_CONFDIR:-/var/lib/sandbox-egress/ca}"
mkdir -p "$confdir" && chmod 700 "$confdir"
args=(
  -q -s "$here/addon/sandbox_egress.py"
  --set "egress_config=$EGRESS_CONFIG"
  --mode "transparent@${tlisten}" --mode "dns@${dnsl}"
  --set "confdir=$confdir"
  # Lazy: nothing connects upstream until policy has seen the request (and refused non-HTTP).
  --set connection_strategy=lazy
  # Bodies stay in memory for size accounting only; nothing is written to disk.
  --set flow_detail=0 --set termlog_verbosity=warn
)
if [ -n "${EGRESS_EXPLICIT:-}" ]; then args+=(--mode "regular@${EGRESS_EXPLICIT}"); fi
if [ -n "${EGRESS_UPSTREAM_CA:-}" ]; then args+=(--set "ssl_verify_upstream_trusted_ca=$EGRESS_UPSTREAM_CA"); fi
exec "$venv/bin/mitmdump" "${args[@]}"
