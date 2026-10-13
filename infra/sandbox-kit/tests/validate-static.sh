#!/usr/bin/env bash
# shellcheck disable=SC2015  # ok/no/skip always return 0, so "A && ok || no" is safe
# Static checks that run anywhere (no KVM, Docker or VM needed). They prove syntax, schema and
# policy shape only; the runtime behaviour is proven by linux/NN-*.sh on the sandbox node.
#   LIMACTL=/path/to/limactl NOMAD=/path/to/nomad bash tests/validate-static.sh
# Without LIMACTL/NOMAD on PATH, those checks are skipped (reported as SKIP, not PASS).
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$KIT"
LIMACTL="${LIMACTL:-$(command -v limactl || true)}"; NOMAD="${NOMAD:-$(command -v nomad || true)}"
fails=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; fails=$((fails + 1)); }
skip() { echo "SKIP $1"; }
if command -v shellcheck >/dev/null; then
  shellcheck -x host/mac-preflight.sh host/kit.sh tests/*.sh && shellcheck -x -P linux linux/*.sh && shellcheck -s sh inner/dind-entry.sh \
    && shellcheck -x egress/run-proxy.sh egress/node/*.sh egress/tests/*.sh && ok shellcheck || no shellcheck
else skip shellcheck; fi
for f in host/*.sh linux/*.sh tests/*.sh egress/*.sh egress/node/*.sh egress/tests/*.sh; do bash -n "$f" || no "bash -n $f"; done
bash tests/preflight-stub-test.sh >/dev/null && ok "preflight-stub-test (Mac appendix)" || no preflight-stub-test
bash tests/linux-preflight-stub-test.sh >/dev/null && ok linux-preflight-stub-test || no linux-preflight-stub-test
# Files the node scripts read must be in the kit archive (git archive of the committed tree), not
# just in this working copy: the repo's root .gitignore once hid inner/build/ (step 40, dev VM).
if git -C . rev-parse --git-dir >/dev/null 2>&1; then
  for f in inner/build/Dockerfile inner/build/compose.yaml inner/dind-entry.sh egress/node/sandbox-netctl egress/requirements.lock nomad/hands.nomad.hcl; do
    [ -n "$(git ls-files -- "$f")" ] && ok "tracked: $f" || no "$f is not tracked by git, so it is missing from the kit archive"
  done
  untracked=$(git ls-files --others --ignored --exclude-standard -- . | grep -vE '(^|/)__pycache__/|\.pyc$' || true)
  [ -z "$untracked" ] && ok "no ignored files inside the kit" || no "ignored (not archived) files in the kit: $(echo "$untracked" | tr '\n' ' ')"
fi
python3 -c 'import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' egress/addon/sandbox_egress.py egress/tests/harness.py && ok "python syntax (egress)" || no "python syntax (egress)"
for f in egress/*.json; do jq -e . "$f" >/dev/null && ok "json $f" || no "json $f"; done
# Every pin the scripts need exists for both arches.
( . ./versions.env; for a in amd64 arm64; do v="KIT_KATA_SHA256_$a"; w="KIT_NOMAD_SHA256_$a"; [[ "${!v}" =~ ^[0-9a-f]{64}$ && "${!w}" =~ ^[0-9a-f]{64}$ ]] || exit 1; done ) && ok "per-arch sha256 pins (amd64, arm64)" || no "per-arch sha256 pins"
grep -q -- '--hash=sha256:' egress/requirements.lock && ! grep -Eq '^[a-z].*==[^ ]+$' egress/requirements.lock && ok "requirements.lock is fully hash-pinned" || no "requirements.lock hashes"
if [ -n "$LIMACTL" ]; then "$LIMACTL" validate lima/kata-dind.yaml >/dev/null 2>&1 && ok "limactl validate ($("$LIMACTL" --version))" || no "limactl validate"; else skip limactl; fi
if [ -n "$NOMAD" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  printf 'data_dir = "%s"\nserver {\n  enabled = true\n  bootstrap_expect = 1\n}\nclient {\n  enabled = true\n}\n' "$tmp/data" > "$tmp/modes.hcl"
  "$NOMAD" config validate nomad/agent.hcl "$tmp/modes.hcl" >/dev/null 2>&1 && ok "nomad config validate agent.hcl" || no "nomad config validate agent.hcl"
  # job run -output parses HCL2 locally (no agent needed); job validate would need one.
  # Sample inputs: the CA is a placeholder; the runtime replaces every per-sandbox field.
  PEM=$'-----BEGIN CERTIFICATE-----\nU0FNUExFLW5vdC1hLWNlcnQ=\n-----END CERTIFICATE-----\n'
  r() { # key gen [network ipv4 gateway pem]
    "$NOMAD" job run -output -var conversation_key="$1" -var generation="$2" \
      -var sandbox_network="${3:-sbx0123456789ab}" -var sandbox_ipv4="${4:-10.90.0.2}" \
      -var sandbox_gateway="${5:-10.90.0.1}" -var egress_ca_pem="${6:-$PEM}" \
      nomad/hands.nomad.hcl >"$tmp/out.json" 2>&1
  }
  r 0123456789abcdef 1 && ok "hands.nomad.hcl renders" || no "hands.nomad.hcl renders"
  for bad in "../etc 1" "ABCDEF012345 1" "short 1" "0123456789abcdef 0" "0123456789abcdef 1.5"; do
    # shellcheck disable=SC2086
    if r $bad; then no "hands.nomad.hcl accepted bad input ($bad)"; else ok "hands.nomad.hcl rejects ($bad)"; fi
  done
  for badnet in "bridge" "host" "container:abc" "sbx" "sbxTOOLONGNAME0000" "default"; do
    if r 0123456789abcdef 1 "$badnet"; then no "accepted network '$badnet'"; else ok "hands.nomad.hcl rejects network '$badnet'"; fi
  done
  for badip in "169.254.169.254" "10.0.0.1/8" "1.2.3.4" "10.90.0"; do
    if r 0123456789abcdef 1 sbx0123456789ab "$badip"; then no "accepted ipv4 '$badip'"; else ok "hands.nomad.hcl rejects ipv4 '$badip'"; fi
  done
  if r 0123456789abcdef 1 sbx0123456789ab 10.90.0.2 10.90.0.1 'not a cert {{ env "X" }}'; then no "accepted a non-PEM CA"; else ok "hands.nomad.hcl rejects a non-PEM CA"; fi
  if r 0123456789abcdef 1 sbx0123456789ab 10.90.0.2 10.90.0.1 "$PEM$PEM"; then no "accepted two PEM blocks"; else ok "hands.nomad.hcl rejects two PEM blocks"; fi
  r 0123456789abcdef 1
  jq -e '.Job.TaskGroups[0].Networks == null and (.Job.TaskGroups[0].Tasks[0].Config | .network_mode == "sbx0123456789ab" and .ipv4_address == "10.90.0.2" and .dns_servers == ["10.90.0.1"] and .runtime == "kata")' "$tmp/out.json" >/dev/null \
    && ok "rendered job: no group network (no pause container), task on its sandbox network" || no "rendered job network fields"
  jq -S . "$tmp/out.json" > "$tmp/fresh.json"
  if jq -S . nomad/hands.job.json | cmp -s - "$tmp/fresh.json"; then ok "nomad/hands.job.json matches the template"; else no "nomad/hands.job.json is stale: regenerate with the sample inputs above (tests/validate-static.sh r())"; fi
  for f in nomad/negative/*.hcl; do "$NOMAD" job run -output "$f" >/dev/null 2>&1 && ok "parses $f" || no "parses $f"; done
else skip nomad; fi
echo "validate-static: $fails failure(s)"; [ "$fails" = 0 ]
