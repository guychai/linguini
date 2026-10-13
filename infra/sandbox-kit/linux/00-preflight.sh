#!/usr/bin/env bash
# shellcheck disable=SC2015  # pass/fail/warn/info always return 0, so "test && pass || fail" is a safe if/else
# Preflight for a Linux sandbox node (a dev VM with nested virtualization, or bare metal).
# READ-ONLY: it installs, starts, writes and changes nothing, and needs no root. If passwordless
# sudo is already available it uses `sudo -n` only to read (docker info, the KVM probe).
#   bash linux/00-preflight.sh
# FAIL (exit 1) when steps 10-50 cannot work on this machine: unsupported arch or distro, no
# hardware virtualization exposed to this VM, no /dev/kvm, a KVM probe that cannot create a
# vCPU, cgroup v1, or less CPU/RAM/disk than one sandbox needs. WARN never fails it.
# Test hooks (tests/linux-preflight-stub-test.sh): KIT_SYSROOT prefixes /proc, /sys, /etc and
# /dev reads; $KIT_SYSROOT/kvm-probe stands in for the ioctl probe.
set -u
KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../versions.env
. "$KIT_DIR/versions.env"
R="${KIT_SYSROOT:-}"
FAILS=0 WARNS=0
pass() { echo "PASS $1: $2"; }
fail() { FAILS=$((FAILS + 1)); echo "FAIL $1: $2"; }
warn() { WARNS=$((WARNS + 1)); echo "WARN $1: $2"; }
info() { echo "INFO $1: $2"; }
have() { command -v "$1" >/dev/null 2>&1 || [ -x "/usr/sbin/$1" ] || [ -x "/sbin/$1" ]; }
SUDO=""; if [ -z "$R" ] && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi
gib() { awk -v k="$1" 'BEGIN {printf "%.1f", k / 1048576}'; }

# ---- platform ----
m=$(uname -m)
case "$m" in
  x86_64) arch=amd64; pass arch "x86_64 (amd64 pins: Kata ${KIT_KATA_SHA256_amd64:0:12}..., Nomad ${KIT_NOMAD_SHA256_amd64:0:12}...)" ;;
  aarch64) arch=arm64; pass arch "aarch64 (arm64 pins: Kata ${KIT_KATA_SHA256_arm64:0:12}..., Nomad ${KIT_NOMAD_SHA256_arm64:0:12}...)" ;;
  *) arch=""; fail arch "$m; the kit supports x86_64 and aarch64" ;;
esac
if [ -r "$R/etc/os-release" ]; then
  # shellcheck disable=SC1091
  . "$R/etc/os-release"
  code=""; for p in $KIT_UBUNTU; do [ "${p%%:*}" = "${VERSION_ID:-}" ] && code=${p#*:}; done
  if [ "${ID:-}" = ubuntu ] && [ -n "$code" ]; then
    pass distro "$PRETTY_NAME (Docker repo '$code')"
    s="~ubuntu.$VERSION_ID~$code"; KIT_DOCKER_VERSION="$KIT_DOCKER_VERSION$s" KIT_CONTAINERD_VERSION="$KIT_CONTAINERD_VERSION$s"
  else fail distro "${PRETTY_NAME:-unknown}; steps 20-50 support Ubuntu $KIT_UBUNTU (VERSION_ID:codename)"; fi
else fail distro "no /etc/os-release"; fi
info kernel "$(uname -r)"
kmaj=$(uname -r | cut -d. -f1); kmin=$(uname -r | cut -d. -f2)
[ "${kmaj:-0}" -gt 5 ] || { [ "${kmaj:-0}" -eq 5 ] && [ "${kmin:-0}" -ge 15 ]; } && pass kernel-version "$(uname -r) >= 5.15" || warn kernel-version "$(uname -r) is older than 5.15 (Ubuntu 24.04 ships 6.8, 26.04 ships 7.0)"
virt=$( (systemd-detect-virt 2>/dev/null || true) | head -1)
info virt "systemd-detect-virt=${virt:-unknown} (a VM is expected for the dev node; 'none' = bare metal)"
case "$virt" in docker|podman|lxc|lxc-libvirt|container-other|systemd-nspawn|wsl|openvz)
  warn container "this looks like a container ($virt), not the VM: run the preflight on the sandbox node itself" ;; esac

# ---- hardware virtualization and KVM ----
flags=$(grep -m1 -E '^(flags|Features)' "$R/proc/cpuinfo" 2>/dev/null || true)
if [ "$arch" = amd64 ]; then
  if echo "$flags" | grep -qw vmx; then pass cpu-virt "vmx (Intel VT-x) exposed to this machine"; vendor=intel
  elif echo "$flags" | grep -qw svm; then pass cpu-virt "svm (AMD-V) exposed to this machine"; vendor=amd
  else fail cpu-virt "no vmx/svm flag: the hypervisor does not expose nested virtualization to this VM (enable it on the host/cloud side)"; vendor=""; fi
  if [ -n "$vendor" ]; then
    n=$(cat "$R/sys/module/kvm_$vendor/parameters/nested" 2>/dev/null || echo "module kvm_$vendor not loaded")
    info kvm-nested "kvm_$vendor nested=$n. This VM is L1 and Kata guests are L2: what they need is vmx/svm above plus a usable /dev/kvm here. nested=Y/1 would only let a Kata guest run its own VMs (L3), which the kit does not need"
  fi
elif [ "$arch" = arm64 ]; then
  info cpu-features "$(echo "$flags" | cut -c1-200)"
  mode=$(grep -o 'kvm-arm.mode=[a-z]*' "$R/proc/cmdline" 2>/dev/null || true)
  n=$(cat "$R/sys/module/kvm/parameters/mode" 2>/dev/null || true)
  info kvm-nested "kernel cmdline ${mode:-has no kvm-arm.mode}; ${n:+kvm mode=$n}. On arm64 the guest kernel must boot at EL2 (FEAT_NV2 from the host) for /dev/kvm to exist; the probe below is the proof"
fi
if [ -e "$R/dev/kvm" ]; then
  pass dev-kvm "$(stat -c '%A %U:%G' "$R/dev/kvm" 2>/dev/null)"
  if [ -r "$R/dev/kvm" ] && [ -w "$R/dev/kvm" ]; then pass kvm-access "$(id -un) can open /dev/kvm read-write"
  else info kvm-access "$(id -un) cannot open /dev/kvm (fine: Docker/Kata run as root; the probe uses sudo -n if available)"; fi
else fail dev-kvm "/dev/kvm missing: KVM is not available (no nested virtualization, or kvm modules not loaded)"; fi

# KVM_GET_API_VERSION, KVM_CREATE_VM, KVM_CREATE_VCPU (include/uapi/linux/kvm.h). The fds are
# closed at exit; nothing persists.
probe_py='import fcntl, os
fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
print("api=%d" % fcntl.ioctl(fd, 0xAE00, 0), flush=True)
vm = fcntl.ioctl(fd, 0xAE01, 0); print("create_vm=ok", flush=True)
fcntl.ioctl(vm, 0xAE41, 0); print("create_vcpu=ok", flush=True)'
probe=""
if [ -n "$R" ]; then probe=$(cat "$R/kvm-probe" 2>/dev/null || true)
elif [ -e /dev/kvm ] && have python3; then
  # Output is flushed per step and the exit status kept: a probe that dies on a signal (seen on
  # sandboxed hosts: KVM_CREATE_VCPU -> SIGSEGV) still shows how far it got.
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then probe=$(python3 -c "$probe_py" 2>&1; echo "exit=$?")
  elif [ -n "$SUDO" ]; then probe=$($SUDO python3 -c "$probe_py" 2>&1; echo "exit=$?"); fi
fi
if [ -z "$probe" ]; then
  [ -e "$R/dev/kvm" ] && warn kvm-probe "not run (no access and no passwordless sudo); 10-kvm-check.sh runs it with sudo"
elif echo "$probe" | grep -qx 'create_vcpu=ok'; then pass kvm-probe "$(echo "$probe" | tr '\n' ' ')- KVM acceleration is usable"
else fail kvm-probe "$(echo "$probe" | grep -v '^Traceback\|^  ' | tr '\n' ' ')- cannot create a vCPU, so no Kata guest can boot here"; fi
for d in vhost-vsock vhost-net; do
  [ -e "$R/dev/$d" ] && pass "dev-$d" present || info "dev-$d" "missing now; 20-install-docker-kata.sh loads ${d/-/_} (modprobe)"
done

# ---- cgroups ----
if grep -qE '^[^ ]+ /sys/fs/cgroup cgroup2 ' "$R/proc/mounts" 2>/dev/null; then pass cgroup2 "unified cgroup v2 at /sys/fs/cgroup"
else fail cgroup2 "/sys/fs/cgroup is not cgroup2 (hybrid/v1); Kata runtime-rs, Docker and Nomad are set up for cgroup v2"; fi

# ---- headroom: one sandbox (KIT_SANDBOX_CPUS vCPU / KIT_SANDBOX_MEMORY_MB) plus the node's own services ----
cpus=$(nproc 2>/dev/null || echo 0)
if [ "$cpus" -lt 2 ]; then fail cpus "$cpus CPU(s)"
elif [ "$cpus" -lt $((KIT_SANDBOX_CPUS + 2)) ]; then warn cpus "$cpus CPUs; a sandbox asks for $KIT_SANDBOX_CPUS vCPUs and the node needs ~2 more (vCPUs are shared, so it runs, but slowly)"
else pass cpus "$cpus CPUs (sandbox $KIT_SANDBOX_CPUS + node services)"; fi
memt=$(awk '/^MemTotal:/ {print $2}' "$R/proc/meminfo" 2>/dev/null || echo 0)
mema=$(awk '/^MemAvailable:/ {print $2}' "$R/proc/meminfo" 2>/dev/null || echo 0)
# One full sandbox: the container limit plus the Kata VM's base memory, plus the node's services.
need_kb=$(( (KIT_SANDBOX_MEMORY_MB + KIT_KATA_VM_BASE_MB + KIT_NODE_RESERVE_MB) * 1024 ))
if [ "${memt:-0}" -lt "$need_kb" ]; then fail memory "$(gib "$memt") GiB total < $(gib "$need_kb") GiB (one ${KIT_SANDBOX_MEMORY_MB} MiB sandbox + ${KIT_KATA_VM_BASE_MB} MiB Kata VM base + ${KIT_NODE_RESERVE_MB} MiB for the node)"
elif [ "${mema:-0}" -lt "$need_kb" ]; then warn memory "$(gib "$memt") GiB total but only $(gib "$mema") GiB available now; free memory before step 30"
else pass memory "$(gib "$memt") GiB total, $(gib "$mema") GiB available (>= $(gib "$need_kb") GiB: ${KIT_SANDBOX_MEMORY_MB} MiB sandbox + ${KIT_KATA_VM_BASE_MB} MiB Kata VM base + ${KIT_NODE_RESERVE_MB} MiB node)"; fi
for d in / /var/lib /opt; do
  free=$(df -Pk "$R$d" 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$free" ] || continue
  if [ "$free" -lt $((15 * 1048576)) ]; then fail "disk$d" "$(gib "$free") GiB free under $d; Kata (~1 GB amd64 / 0.65 GB arm64 compressed), Docker images and sandboxes need >= 15 GiB"
  elif [ "$free" -lt $((40 * 1048576)) ]; then warn "disk$d" "$(gib "$free") GiB free under $d (>= 40 GiB recommended)"
  else pass "disk$d" "$(gib "$free") GiB free under $d"; fi
done

# ---- installed components (none required yet: 20/45/50 install the pinned versions) ----
ver() { # name pinned actual
  if [ -z "$3" ]; then info "$1" "not installed (pinned $2; installed by a later step)"
  elif [ "$3" = "$2" ]; then pass "$1" "$3 (pinned)"
  else warn "$1" "$3 installed; the kit pins $2 (the install step will change it)"; fi
}
dver=""; have docker && dver=$(docker version --format '{{.Client.Version}}' 2>/dev/null || true)
ver docker "${KIT_DOCKER_VERSION#5:}" "${dver:+$( (dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || echo "$dver") | sed 's/^5://')}"
cver=""; have containerd && cver=$(containerd --version 2>/dev/null | awk '{print $3}' | sed 's/^v//')
ver containerd "${KIT_CONTAINERD_VERSION%%-*}" "$cver"
kver=$(cat "$R/opt/kata/.kit-version" 2>/dev/null || true)
[ -z "$kver" ] && [ -x /opt/kata/bin/kata-runtime ] && kver="(unpinned) $(/opt/kata/bin/kata-runtime --version 2>/dev/null | head -1)"
ver kata "$KIT_KATA_VERSION" "$kver"
nver=""; have nomad && nver=$(nomad version 2>/dev/null | awk 'NR==1 {print $2}' | sed 's/^v//')
ver nomad "$KIT_NOMAD_VERSION" "$nver"
if [ -n "$dver" ]; then
  dinfo=$( (docker info --format '{{json .}}' 2>/dev/null || $SUDO docker info --format '{{json .}}' 2>/dev/null) || true)
  if [ -n "$dinfo" ] && have jq; then
    drt=$(echo "$dinfo" | jq -r '.DefaultRuntime // ""'); rts=$(echo "$dinfo" | jq -r '(.Runtimes // {}) | keys | join(",")')
    [ "$drt" = kata ] && pass docker-default-runtime "kata (runtimes: $rts)" || info docker-default-runtime "${drt:-?} (runtimes: $rts); 20-install-docker-kata.sh makes kata the default"
  else info docker-daemon "not readable without root (sudo -n unavailable) or not running"; fi
fi
for t in curl jq python3 unzip zstd nft ip sha256sum; do have "$t" || info "tool-$t" "missing; installed by 20/45 (apt)"; done
py=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)
info python "${py:-none} (the egress proxy venv needs 3.12-3.14; Ubuntu 24.04 has 3.12, 26.04 has 3.14)"
[ -e "$R/proc/net/if_inet6" ] && info ipv6 "enabled on the node (sandbox interfaces get IPv6 dropped by egress/node/sandbox-net.sh)"

echo "=== linux preflight: $FAILS failure(s), $WARNS warning(s)"
if [ "$FAILS" -gt 0 ]; then echo "RESULT FAIL"; exit 1; fi
echo "RESULT PASS"
