#!/bin/bash
# Mac path only (RUNBOOK appendix A): host preflight for the Kata + DinD kit. Run on the Mac, not in Lima.
# Read-only: it installs, starts, writes and changes nothing (no brew, no limactl start).
# Written for macOS's /bin/bash 3.2.
#
# Fails (exit 1) when the Mac cannot run Lima's VZ nested virtualization:
#   - macOS older than 15 (Lima pkg/driver/vz/vm_darwin.go refuses below 15.0.0)
#   - not Apple silicon, or an Apple chip older than M3 (Apple's nested virtualization needs M3+)
# Warnings do not fail it: missing Homebrew/Lima, an older Lima, low free disk or RAM headroom.
set -u

KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=versions.env  # path relative to the kit root (tests/validate-static.sh runs there)
. "$KIT_DIR/versions.env"
VM_MEMORY_GIB=16
VM_DISK_GIB=100
FAILS=0
WARNS=0
pass() { echo "PASS $1: $2"; }
fail() { FAILS=$((FAILS + 1)); echo "FAIL $1: $2"; }
warn() { WARNS=$((WARNS + 1)); echo "WARN $1: $2"; }
info() { echo "INFO $1: $2"; }
# "15.4.1" -> 15; "26.0" -> 26
major() { echo "${1%%.*}"; }
# version_ge A B: true when dotted version A >= B (numeric fields, missing fields = 0)
version_ge() {
  local a b i x y
  a="$1"; b="$2"
  for i in 1 2 3; do
    x=$(echo "$a" | cut -d. -f"$i"); y=$(echo "$b" | cut -d. -f"$i")
    x=${x:-0}; y=${y:-0}
    x=${x%%[!0-9]*}; y=${y%%[!0-9]*}
    x=${x:-0}; y=${y:-0}
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 0
}
# Apple chip generation from the brand string: "Apple M5 Max" -> 5; anything else -> empty.
chip_generation() {
  echo "$1" | sed -n 's/^Apple M\([0-9][0-9]*\).*/\1/p'
}

echo "=== sandbox-kit preflight $(date '+%Y-%m-%d %H:%M:%S %Z')"
os=$(uname -s)
if [ "$os" != "Darwin" ]; then
  fail os "this is $os; run host/mac-preflight.sh on the Mac host"
  echo "RESULT FAIL"; exit 1
fi

product=$(sw_vers -productName 2>/dev/null || echo unknown)
version=$(sw_vers -productVersion 2>/dev/null || echo 0)
build=$(sw_vers -buildVersion 2>/dev/null || echo unknown)
info macos "$product $version ($build)"
if [ "$(major "$version")" -ge 15 ] 2>/dev/null; then
  pass macos-version "$version >= 15 (Lima VZ nested virtualization minimum)"
else
  fail macos-version "$version is below 15; Lima refuses nestedVirtualization before macOS 15"
fi

arch=$(uname -m)
if [ "$arch" = "arm64" ]; then
  pass arch "arm64 (Apple silicon)"
else
  fail arch "$arch; VZ cannot run an aarch64 guest on Intel and nested virt needs Apple M3+"
fi
# Rosetta reports x86_64 for a translated shell; the hardware flag tells the truth.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  warn rosetta "this shell runs under Rosetta; rerun from a native arm64 terminal"
fi

chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)
gen=$(chip_generation "$chip")
model=$(sysctl -n hw.model 2>/dev/null || echo unknown)
info chip "$chip (model $model)"
if [ -n "$gen" ] && [ "$gen" -ge 3 ]; then
  pass chip "Apple M$gen >= M3"
else
  fail chip "'$chip' is not Apple M3 or newer; Apple exposes nested virtualization only on M3+"
fi
hv=$(sysctl -n kern.hv_support 2>/dev/null || echo 0)
if [ "$hv" = "1" ]; then pass hypervisor "kern.hv_support=1"; else fail hypervisor "kern.hv_support=$hv"; fi
info nested-note "macOS gives no read-only nested-virt probe here; Lima checks VZ IsNestedVirtualizationSupported() at start and 10-kvm-check.sh proves /dev/kvm inside the guest"

ncpu=$(sysctl -n hw.ncpu 2>/dev/null || echo 0)
perf=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || echo "?")
eff=$(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null || echo "?")
info cpus "$ncpu logical ($perf performance + $eff efficiency); the VM takes 6 vCPUs"

mem_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
mem_gib=$((mem_bytes / 1073741824))
page=$(vm_stat 2>/dev/null | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')
page=${page:-16384}
pages() { vm_stat 2>/dev/null | awk -v k="$1" -F: '$1==k {gsub(/[^0-9]/,"",$2); print $2}'; }
free_p=$(pages "Pages free"); inactive_p=$(pages "Pages inactive"); spec_p=$(pages "Pages speculative")
avail_gib=$(( (${free_p:-0} + ${inactive_p:-0} + ${spec_p:-0}) * page / 1073741824 ))
info memory "total ${mem_gib} GiB; free+inactive+speculative now ~${avail_gib} GiB"
headroom=$((mem_gib - VM_MEMORY_GIB))
if [ "$headroom" -ge 16 ]; then
  pass memory-headroom "${mem_gib} GiB - ${VM_MEMORY_GIB} GiB VM leaves ${headroom} GiB for macOS and apps"
elif [ "$headroom" -ge 8 ]; then
  warn memory-headroom "only ${headroom} GiB left for macOS after the ${VM_MEMORY_GIB} GiB VM"
else
  fail memory-headroom "${mem_gib} GiB total cannot host a ${VM_MEMORY_GIB} GiB VM with headroom"
fi
if [ "$avail_gib" -lt "$VM_MEMORY_GIB" ]; then
  warn memory-now "only ~${avail_gib} GiB is reclaimable right now; close large apps before limactl start"
fi
if command -v memory_pressure >/dev/null 2>&1; then
  info memory-pressure "$(memory_pressure -Q 2>/dev/null | tail -1)"
fi

lima_home="${LIMA_HOME:-$HOME/.lima}"
probe_dir="$lima_home"; [ -d "$probe_dir" ] || probe_dir="$HOME"
free_kb=$(df -k "$probe_dir" | awk 'NR==2 {print $4}')
free_gib=$((free_kb / 1048576))
info disk "${free_gib} GiB free on the volume holding $probe_dir"
if [ "$free_gib" -ge 60 ]; then
  pass disk "${free_gib} GiB free (VM disk is sparse, up to ${VM_DISK_GIB} GiB; ~25-40 GiB used by this kit)"
elif [ "$free_gib" -ge 40 ]; then
  warn disk "${free_gib} GiB free; enough to start, tight for repeated builds"
else
  fail disk "${free_gib} GiB free; need at least 40 GiB"
fi

if command -v brew >/dev/null 2>&1; then
  pass homebrew "$(brew --version 2>/dev/null | head -1) at $(command -v brew)"
else
  warn homebrew "not installed; RUNBOOK step 2 installs Lima from the release tarball instead"
fi
if command -v limactl >/dev/null 2>&1; then
  lv=$(limactl --version 2>/dev/null | awk '{print $NF}')
  if version_ge "$lv" "$KIT_LIMA_VERSION"; then
    pass lima "limactl $lv (kit validated against $KIT_LIMA_VERSION)"
  else
    fail lima "limactl $lv is older than $KIT_LIMA_VERSION, the template's minimumLimaVersion; upgrade first (RUNBOOK step 2)"
  fi
  if limactl list -q 2>/dev/null | grep -qx "$KIT_LIMA_INSTANCE"; then
    warn lima-instance "an instance named $KIT_LIMA_INSTANCE already exists: $(limactl list "$KIT_LIMA_INSTANCE" 2>/dev/null | tail -1)"
  fi
else
  warn lima "limactl not installed; RUNBOOK step 2 installs Lima $KIT_LIMA_VERSION"
fi
for tool in qemu-img socket_vmnet; do
  if command -v "$tool" >/dev/null 2>&1; then info "$tool" "present (not needed for vmType vz)"; fi
done

echo "=== preflight: $FAILS failed, $WARNS warnings"
if [ "$FAILS" -gt 0 ]; then echo "RESULT FAIL"; exit 1; fi
echo "RESULT PASS"
