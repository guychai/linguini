#!/usr/bin/env bash
# Exercises linux/00-preflight.sh's decisions with a fake sysroot (KIT_SYSROOT) and stubbed
# commands (uname, nproc, df, systemd-detect-virt, docker, dpkg-query). This proves parsing and
# thresholds for x86_64 and aarch64, not the real VM: the real values come from running
# linux/00-preflight.sh on it (RUNBOOK step 1).
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
fails=0

# scenario name expected-exit expected-regexps... ; knobs are env vars (see defaults below)
scenario() {
  local name="$1" want="$2"; shift 2
  local root="$work/$name/root" bin="$work/$name/bin" code=0 out
  mkdir -p "$bin" "$root/etc" "$root/proc" "$root/dev" "$root/sys/module/kvm_intel/parameters" "$root/sys/module/kvm/parameters"
  printf 'ID=%s\nVERSION_ID="%s"\nPRETTY_NAME="%s"\nVERSION_CODENAME=%s\n' "${DISTRO:-ubuntu}" "${DVER:-24.04}" "${DISTRO:-ubuntu} ${DVER:-24.04}" "${CODENAME:-noble}" > "$root/etc/os-release"
  if [ "${ARCH:-x86_64}" = x86_64 ]; then echo "flags		: fpu vme ${VIRTFLAG-vmx} sse2" > "$root/proc/cpuinfo"
  else echo "Features	: fp asimd evtstrm aes" > "$root/proc/cpuinfo"; fi
  echo "BOOT_IMAGE=/vmlinuz root=/dev/vda1 ${CMDLINE:-}" > "$root/proc/cmdline"
  echo "${CGROUP:-cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid 0 0}" > "$root/proc/mounts"
  printf 'MemTotal:       %s kB\nMemAvailable:   %s kB\n' "${MEMT:-32000000}" "${MEMA:-28000000}" > "$root/proc/meminfo"
  echo "${NESTED:-Y}" > "$root/sys/module/kvm_intel/parameters/nested"
  [ "${KVM:-1}" = 1 ] && : > "$root/dev/kvm"
  printf '%s\n' "${PROBE-api=12
create_vm=ok
create_vcpu=ok
exit=0}" > "$root/kvm-probe"
  cat > "$bin/uname" <<S
#!/bin/sh
case "\$1" in -m) echo "${ARCH:-x86_64}";; -r) echo "${KREL:-6.8.0-85-generic}";; *) echo Linux;; esac
S
  printf '#!/bin/sh\necho %s\n' "${CPUS:-8}" > "$bin/nproc"
  printf '#!/bin/sh\necho %s\n' "${VIRT:-kvm}" > "$bin/systemd-detect-virt"
  printf '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/vda1 200000000 1 %s 1%% /"\n' "${DISKKB:-100000000}" > "$bin/df"
  if [ -n "${DOCKER_DEFAULT:-}" ]; then
    cat > "$bin/docker" <<S
#!/bin/sh
case "\$1" in
  version) echo 29.8.2;;
  info) echo '{"DefaultRuntime":"$DOCKER_DEFAULT","Runtimes":{"kata":{},"runc":{}}}';;
esac
S
    printf '#!/bin/sh\necho "5:29.8.2-1~ubuntu.%s~%s"\n' "${DVER:-24.04}" "${CODENAME:-noble}" > "$bin/dpkg-query"
  fi
  chmod +x "$bin"/*
  out=$(KIT_SYSROOT="$root" PATH="$bin:/usr/bin:/bin" bash "$KIT/linux/00-preflight.sh" 2>&1) || code=$?
  local ok=1 re
  [ "$code" = "$want" ] || ok=0
  for re in "$@"; do echo "$out" | grep -Eq "$re" || { ok=0; echo "   missing: $re"; }; done
  # shellcheck disable=SC2001
  if [ "$ok" = 1 ]; then echo "ok   $name (exit $code)"; else fails=$((fails + 1)); echo "FAIL $name (exit $code, want $want)"; echo "$out" | sed 's/^/   | /'; fi
}

scenario x86-good 0 '^PASS arch: x86_64' '^PASS cpu-virt: vmx' '^INFO kvm-nested: kvm_intel nested=Y' '^PASS kvm-probe' '^PASS cgroup2' '^PASS memory' '^RESULT PASS'
ARCH=aarch64 CMDLINE=kvm-arm.mode=nested scenario arm64-good 0 '^PASS arch: aarch64 \(arm64 pins: Kata 5dd4e9f2d5ea' '^INFO kvm-nested: kernel cmdline kvm-arm.mode=nested' '^RESULT PASS'
VIRTFLAG='' scenario x86-no-vmx 1 '^FAIL cpu-virt: no vmx/svm' '^RESULT FAIL'
VIRTFLAG=svm scenario x86-amd 0 '^PASS cpu-virt: svm'
KVM=0 PROBE='' scenario no-dev-kvm 1 '^FAIL dev-kvm: /dev/kvm missing' '^RESULT FAIL'
PROBE=$'api=12\ncreate_vm=ok\nexit=139' scenario vcpu-segv 1 '^FAIL kvm-probe: api=12 create_vm=ok exit=139' '^RESULT FAIL'
CGROUP='cgroup /sys/fs/cgroup tmpfs ro 0 0' scenario cgroup-v1 1 '^FAIL cgroup2' '^RESULT FAIL'
MEMT=8000000 MEMA=7000000 scenario low-ram 1 '^FAIL memory: 7\.6 GiB total < 12\.0 GiB' '^RESULT FAIL'
# The dev VM: MemTotal 16363288 kB (15.6 GiB) for a 16 GiB VM fits one 8 GiB sandbox.
DVER=26.04 CODENAME=resolute MEMT=16363288 MEMA=15200000 KREL=7.0.0-38-generic VIRTFLAG=svm scenario ubuntu-2604-16g 0 '^PASS distro: ubuntu 26\.04 \(Docker repo .resolute.\)' '^PASS memory: 15\.6 GiB total' '^RESULT PASS'
MEMT=12000000 MEMA=11000000 scenario just-under-12g 1 '^FAIL memory: 11\.4 GiB total < 12\.0 GiB' '^RESULT FAIL'
MEMA=4000000 scenario busy-ram 0 '^WARN memory: .* only 3\.8 GiB available' '^RESULT PASS'
CPUS=4 scenario few-cpus 0 '^WARN cpus: 4 CPUs' '^RESULT PASS'
DISKKB=10000000 scenario low-disk 1 '^FAIL disk/: 9\.5 GiB free' '^RESULT FAIL'
DISTRO=debian DVER=13 scenario wrong-distro 1 '^FAIL distro: debian 13' '^RESULT FAIL'
DVER=25.10 CODENAME=questing scenario ubuntu-unsupported 1 '^FAIL distro: ubuntu 25\.10; steps 20-50 support Ubuntu 24\.04:noble 26\.04:resolute' '^RESULT FAIL'
ARCH=riscv64 scenario bad-arch 1 '^FAIL arch: riscv64'
VIRT=docker scenario in-container 0 '^WARN container: this looks like a container \(docker\)'
DVER=26.04 CODENAME=resolute DOCKER_DEFAULT=kata scenario docker-kata-default-2604 0 '^PASS docker: 29\.8\.2-1~ubuntu\.26\.04~resolute \(pinned\)'
DOCKER_DEFAULT=kata scenario docker-kata-default 0 '^PASS docker: 29\.8\.2-1~ubuntu\.24\.04~noble \(pinned\)' '^PASS docker-default-runtime: kata \(runtimes: kata,runc\)'
DOCKER_DEFAULT=runc scenario docker-runc-default 0 '^INFO docker-default-runtime: runc .*makes kata the default'
echo "linux-preflight-stub-test: $([ "$fails" = 0 ] && echo "all scenarios passed" || echo "$fails scenario(s) failed")"
[ "$fails" = 0 ]
