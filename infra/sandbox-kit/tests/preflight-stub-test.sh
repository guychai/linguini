#!/usr/bin/env bash
# Exercises host/mac-preflight.sh's decisions off-Mac with stubbed macOS commands (sw_vers, sysctl,
# uname, vm_stat, df, brew, limactl). This proves the parsing and thresholds, not the real Mac:
# the real values only come from running host/mac-preflight.sh on it (RUNBOOK step 1).
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
fails=0

# scenario name expected-exit expected-regexps... ; settings come from env vars below
scenario() {
  local name="$1" want="$2"; shift 2
  local bin="$work/$name/bin"; mkdir -p "$bin" "$work/$name/home"
  cat > "$bin/uname" <<S
#!/bin/sh
case "\$1" in -s) echo "${OS:-Darwin}";; -m) echo "${ARCH:-arm64}";; *) echo "${OS:-Darwin}";; esac
S
  cat > "$bin/sw_vers" <<S
#!/bin/sh
case "\$1" in -productName) echo macOS;; -productVersion) echo "${MACOS:-26.0.1}";; -buildVersion) echo 25A362;; esac
S
  cat > "$bin/sysctl" <<S
#!/bin/sh
case "\$2" in
  machdep.cpu.brand_string) echo "${CHIP:-Apple M5 Max}";;
  hw.model) echo Mac17,7;;
  kern.hv_support) echo "${HV:-1}";;
  hw.ncpu) echo 18;;
  hw.perflevel0.physicalcpu) echo 12;;
  hw.perflevel1.physicalcpu) echo 6;;
  hw.memsize) echo \$(( ${MEM_GIB:-36} * 1073741824 ));;
  sysctl.proc_translated) echo "${ROSETTA:-0}";;
  *) exit 1;;
esac
S
  cat > "$bin/vm_stat" <<'S'
#!/bin/sh
cat <<V
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              900000.
Pages active:                            700000.
Pages inactive:                          600000.
Pages speculative:                        50000.
V
S
  cat > "$bin/df" <<S
#!/bin/sh
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/disk3s5 971350180 400000000 \$(( ${DISK_GIB:-300} * 1048576 )) 50% /System/Volumes/Data"
S
  if [ "${BREW:-1}" = 1 ]; then printf '#!/bin/sh\necho "Homebrew 5.1.0"\n' > "$bin/brew"; fi
  if [ -n "${LIMA-2.2.1}" ]; then
    # shellcheck disable=SC2016  # $1 belongs to the generated stub, not this shell
    printf '#!/bin/sh\ncase "$1" in --version) echo "limactl version %s";; list) exit 0;; esac\n' "${LIMA-2.2.1}" > "$bin/limactl"
  fi
  chmod +x "$bin"/*
  local out code=0
  out=$(HOME="$work/$name/home" PATH="$bin:/usr/bin:/bin" bash "$KIT/host/mac-preflight.sh" 2>&1) || code=$?
  local ok=1 re
  [ "$code" = "$want" ] || ok=0
  for re in "$@"; do echo "$out" | grep -Eq "$re" || { ok=0; echo "  missing /$re/"; }; done
  if [ "$ok" = 1 ]; then echo "ok   $name (exit $code)"; else fails=$((fails + 1)); echo "FAIL $name (exit $code, want $want)"; printf "     | %s\n" "$out"; fi
}

scenario m5max-macos26 0 '^PASS chip: Apple M5 >= M3' '^PASS macos-version' '^PASS memory-headroom: 36 GiB - 16 GiB VM leaves 20 GiB' '^PASS lima: limactl 2.2.1' '^RESULT PASS'
MACOS=14.7 scenario macos14 1 '^FAIL macos-version: 14.7 is below 15' '^RESULT FAIL'
MACOS=15.0 scenario macos15 0 '^PASS macos-version: 15.0' '^RESULT PASS'
CHIP="Apple M2 Pro" scenario m2 1 "^FAIL chip: 'Apple M2 Pro'" '^RESULT FAIL'
CHIP="Apple M3" scenario m3 0 '^PASS chip: Apple M3 >= M3'
CHIP="Apple M10 Ultra" scenario m10 0 '^PASS chip: Apple M10 >= M3'
ARCH=x86_64 CHIP="Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz" scenario intel 1 '^FAIL arch: x86_64' '^FAIL chip' '^RESULT FAIL'
ROSETTA=1 ARCH=x86_64 scenario rosetta 1 '^WARN rosetta' '^FAIL arch'
OS=Linux scenario linux 1 '^FAIL os: this is Linux'
MEM_GIB=24 scenario ram24 0 '^WARN memory-headroom: only 8 GiB'
MEM_GIB=16 scenario ram16 1 '^FAIL memory-headroom'
DISK_GIB=50 scenario disk50 0 '^WARN disk: 50 GiB'
DISK_GIB=20 scenario disk20 1 '^FAIL disk: 20 GiB'
BREW=0 LIMA="" scenario fresh-mac 0 '^WARN homebrew' '^WARN lima: limactl not installed' '^RESULT PASS'
LIMA=1.2.1 scenario lima-old 1 '^FAIL lima: limactl 1.2.1 is older than 2.2.1'
LIMA=2.3.0 scenario lima-new 0 '^PASS lima: limactl 2.3.0'
HV=0 scenario no-hv 1 '^FAIL hypervisor'

if [ "$fails" -gt 0 ]; then echo "preflight-stub-test: $fails scenario(s) failed"; exit 1; fi
echo "preflight-stub-test: all scenarios passed"
