#!/usr/bin/env bash
# shellcheck disable=SC2015  # pass/fail/info always return 0, so "test && pass || fail" is a safe if/else
# Step 1 of the handoff's inside-out plan: node facts and KVM usability on the Linux sandbox
# node (x86_64 or aarch64; a VM with nested virtualization, or bare metal; or the Lima VM on the
# Mac path).
# Read-only and idempotent. Proves that /dev/kvm is not just present but usable: it creates a
# KVM VM and a vCPU through the ioctl interface, which only succeeds with accelerated nested
# virtualization. Fails visibly otherwise.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

pass arch "$(uname -m) ($KIT_ARCH pins)"
# shellcheck disable=SC1091
. /etc/os-release
info os "$PRETTY_NAME"
kit_ubuntu_codename "${VERSION_ID:-}" >/dev/null && [ "${ID:-}" = ubuntu ] && pass os "Ubuntu ${VERSION_ID} (supported: $KIT_UBUNTU)" || fail os "${PRETTY_NAME}; the kit supports Ubuntu $KIT_UBUNTU"
info kernel "$(uname -a)"
virt=$(systemd-detect-virt 2>/dev/null || true)
info virt "systemd-detect-virt=${virt:-none} (kvm/microsoft/amazon/google/apple for a VM node; none = bare metal)"
case "$virt" in docker|podman|lxc|lxc-libvirt|container-other|systemd-nspawn|wsl|openvz) die not-a-container "this is a container ($virt); run the kit on the sandbox node (VM or bare metal)";; esac
info cpus "$(nproc) CPUs, $(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo) RAM"
[ "$(nproc)" -ge "$KIT_SANDBOX_CPUS" ] && pass node-cpus "$(nproc) CPUs >= one sandbox ($KIT_SANDBOX_CPUS)" || fail node-cpus "$(nproc) CPUs < $KIT_SANDBOX_CPUS"

kvm_init=$(sudo dmesg 2>/dev/null | grep -Ei 'kvm \[[0-9]+\]:|kvm:|kvm_intel|kvm_amd' | head -5 | tr '\n' ' ' || true)
info kvm-dmesg "${kvm_init:-no kvm lines in dmesg}"
record dmesg-kvm sh -c "sudo dmesg | grep -Ei 'kvm|EL2|hyp|gic|vgic|nested|vmx|svm'"
if [ "$KIT_ARCH" = arm64 ]; then
  # The kernel boots at EL2 only when the hypervisor offers virtualization to the guest.
  el=$(sudo dmesg 2>/dev/null | grep -Eo 'CPU: All CPU\(s\) started at EL[0-9]' | tail -1 || true)
  info boot-el "${el:-not found in dmesg}"
  [ "$el" = "CPU: All CPU(s) started at EL2" ] && pass el2 "kernel started at EL2" || fail el2 "${el:-no EL line}; without EL2 this machine cannot host KVM"
else
  # x86: the hypervisor must expose VT-x/AMD-V to this VM (the vmx/svm CPU flag).
  if grep -qw vmx /proc/cpuinfo; then vendor=intel; elif grep -qw svm /proc/cpuinfo; then vendor=amd; else vendor=""; fi
  [ -n "$vendor" ] && pass cpu-virt "$( [ "$vendor" = intel ] && echo vmx || echo svm) flag present" || fail cpu-virt "no vmx/svm flag: nested virtualization is not exposed to this VM"
  [ -n "$vendor" ] && info kvm-nested "kvm_$vendor nested=$(cat "/sys/module/kvm_$vendor/parameters/nested" 2>/dev/null || echo n/a) (only matters for VMs inside a Kata guest; not required)"
fi

if [ -c /dev/kvm ]; then
  pass dev-kvm "$(ls -l /dev/kvm)"
else
  die dev-kvm "/dev/kvm missing: no nested virtualization for this VM, or kvm modules not loaded (Mac path: vmType vz, M3+, macOS 15+)"
fi
grep -q '^kvm:' /etc/group && info kvm-group "$(getent group kvm)"

# KVM_GET_API_VERSION, KVM_CREATE_VM, KVM_CREATE_VCPU and KVM_CHECK_EXTENSION(KVM_CAP_ARM_EL2; 0 on x86),
# values from include/uapi/linux/kvm.h. Run as root so group membership does not matter here.
probe=$(sudo python3 - 2>&1 <<'PY'
import fcntl, os, sys
KVM_GET_API_VERSION, KVM_CREATE_VM, KVM_CHECK_EXTENSION, KVM_CREATE_VCPU = 0xAE00, 0xAE01, 0xAE03, 0xAE41
KVM_CAP_ARM_EL2 = 240
def say(k, v):
    print(f"{k}={v}", flush=True)  # flushed per step, so a crash still shows how far it got
fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
say("api", fcntl.ioctl(fd, KVM_GET_API_VERSION, 0))
say("cap_arm_el2", fcntl.ioctl(fd, KVM_CHECK_EXTENSION, KVM_CAP_ARM_EL2))
try:
    vm = fcntl.ioctl(fd, KVM_CREATE_VM, 0)
    say("create_vm", "ok")
    vcpu = fcntl.ioctl(vm, KVM_CREATE_VCPU, 0)
    say("create_vcpu", "ok")
except OSError as e:
    say("error", f"{e.errno}:{e.strerror}")
PY
echo "exit=$?") || true
info kvm-probe "$(echo "$probe" | tr '\n' ' ')"
echo "$probe" > "$KIT_EVIDENCE/$KIT_SCRIPT.kvm-probe.txt"
echo "$probe" | grep -qx 'api=12' && pass kvm-api "KVM API version 12" || fail kvm-api "$(echo "$probe" | tr '\n' ' ')"
echo "$probe" | grep -qx 'create_vm=ok' && pass kvm-create-vm "KVM_CREATE_VM succeeded" || fail kvm-create-vm "$(echo "$probe" | tr '\n' ' ')"
echo "$probe" | grep -qx 'create_vcpu=ok' && pass kvm-create-vcpu "KVM_CREATE_VCPU succeeded: KVM acceleration is usable here" || fail kvm-create-vcpu "$(echo "$probe" | tr '\n' ' ')"
# Informational (arm64): whether this L1 could itself offer EL2 to its guests (a third level).
# Kata does not need it.
[ "$KIT_ARCH" = arm64 ] && info kvm-cap-arm-el2 "$(echo "$probe" | sed -n 's/^cap_arm_el2=//p') (0 = Kata guests cannot nest further; not required)"

for m in vhost_vsock vhost_net; do
  if [ -d "/sys/module/$m" ]; then pass "module-$m" "loaded"; else info "module-$m" "not loaded yet (20-install-docker-kata.sh loads it and persists it)"; fi
done
for d in vhost-vsock vhost-net; do [ -c "/dev/$d" ] && pass "dev-$d" "$(stat -c '%A %U:%G' "/dev/$d")" || info "dev-$d" "missing until the module is loaded (step 20)"; done
mount | grep -q ' /sys/fs/cgroup type cgroup2 ' && pass cgroup2 "unified cgroup v2" || fail cgroup2 "not cgroup v2"
record lscpu lscpu
record cpuinfo-features sh -c "grep -m1 -i features /proc/cpuinfo"
record mounts sh -c "findmnt -D; echo; mount | grep -Ei 'virtiofs|9p|sshfs' || echo 'no host mounts (expected: mounts: [])'"
mount | grep -Eqi 'virtiofs|fuse.sshfs| 9p ' && info host-mounts "host-shared directories are mounted on this node; sandboxes never get them (Nomad volumes are disabled)" || pass host-mounts "no host-shared directories mounted"
finish
