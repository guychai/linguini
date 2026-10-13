#!/usr/bin/env bash
# shellcheck disable=SC2015  # pass/fail/info always return 0, so "test && pass || fail" is a safe if/else
# Step 2 of the handoff's inside-out plan: start one Kata guest directly through Docker and prove
# it runs its own kernel under the intended hypervisor with KVM acceleration; record the runtime
# configuration and the devices the container can actually see. Idempotent (removes its own
# container first and last).
#   KATA_RUNTIME=kata     QEMU via runtime-rs (default; the documented Docker path)
#   KATA_RUNTIME=kata-db  runtime-rs built-in Dragonball VMM, diagnostic only, if QEMU hangs
#                         under nested virtualization (reported by others on M3+ with Kata 3.x)
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root_tools
RT="${KATA_RUNTIME:-kata}"
BOOT_TIMEOUT="${KATA_BOOT_TIMEOUT:-300}"
NAME=kit-smoke
cfg="$KIT_KATA_CONFIG"; [ "$RT" = "kata-db" ] && cfg="$KIT_KATA_CONFIG_DB"

dk info --format '{{json .Runtimes}}' | jq -e --arg rt "$RT" '.[$rt]' >/dev/null || die runtime "Docker has no '$RT' runtime; run 20-install-docker-kata.sh"
dk rm -f "$NAME" >/dev/null 2>&1 || true
vmm_pids() { pgrep -f "^$KIT_QEMU" || true; }
before=$(vmm_pids | sort)
dk pull -q "$KIT_BUSYBOX_IMAGE" >/dev/null && pass image "$KIT_BUSYBOX_IMAGE"

node_kernel=$(uname -r)
runc_kernel=$(dk run --rm --runtime runc "$KIT_BUSYBOX_IMAGE" uname -r)
[ "$runc_kernel" = "$node_kernel" ] && pass runc-baseline "runc container shares the node kernel ($runc_kernel)" || info runc-baseline "runc saw $runc_kernel vs node $node_kernel"

t0=$(date +%s%N)
if ! kata_kernel=$(timeout "$BOOT_TIMEOUT" sudo docker run --rm --runtime "$RT" "$KIT_BUSYBOX_IMAGE" uname -r 2>"$KIT_EVIDENCE/$KIT_SCRIPT.first-run.stderr"); then
  record docker-journal sudo journalctl -u docker -u containerd --since "-10 min" --no-pager
  record vmm-processes sh -c "ps -eo pid,user,etime,args | grep -E 'qemu|kata|dragonball|virtiofsd' | grep -v grep"
  sudo pkill -f "^$KIT_QEMU" 2>/dev/null || true
  die first-boot "no Kata guest within ${BOOT_TIMEOUT}s (runtime $RT). stderr: $(tr '\n' ' ' < "$KIT_EVIDENCE/$KIT_SCRIPT.first-run.stderr" | cut -c1-400). If this is a QEMU hang under nested virt, rerun with KATA_RUNTIME=kata-db and send both logs."
fi
info first-boot-ms "$(( ($(date +%s%N) - t0) / 1000000 )) ms including image unpack"
[ -n "$kata_kernel" ] && [ "$kata_kernel" != "$node_kernel" ] && pass guest-kernel "Kata guest kernel $kata_kernel differs from node kernel $node_kernel" || fail guest-kernel "Kata '$kata_kernel' vs node '$node_kernel'"
case "$kata_kernel" in 6.18.35*) pass kata-kernel-version "matches the kernel shipped in Kata $KIT_KATA_VERSION (6.18.35)";; *) info kata-kernel-version "$kata_kernel (Kata $KIT_KATA_VERSION ships 6.18.35)";; esac

# A long-lived guest to inspect from both sides. Limits follow the handoff's per-sandbox shape
# scaled down (2 CPUs / 2 GiB) so the smoke test fits beside anything else running.
dk run -d --name "$NAME" --runtime "$RT" --cpus 2 --memory 2g --pids-limit 512 "$KIT_BUSYBOX_IMAGE" sleep 900 >/dev/null
sleep 2
inspect=$(dk inspect "$NAME" --format '{{json .HostConfig}}')
echo "$inspect" | jq '{Runtime, Privileged, CapAdd, CapDrop, SecurityOpt, Devices, NanoCpus, Memory, PidsLimit, Binds, Mounts}' > "$KIT_EVIDENCE/$KIT_SCRIPT.hostconfig.json"
[ "$(echo "$inspect" | jq -r .Runtime)" = "$RT" ] && pass runtime "HostConfig.Runtime=$RT" || fail runtime "$(echo "$inspect" | jq -r .Runtime)"
[ "$(echo "$inspect" | jq -r .Privileged)" = "false" ] && pass not-privileged "Privileged=false" || fail not-privileged "container is privileged"

after=$(vmm_pids | sort)
new_pid=$(comm -13 <(echo "$before") <(echo "$after") | tail -1)
if [ "$RT" = "kata" ]; then
  if [ -n "$new_pid" ]; then
    cmdline=$(sudo cat "/proc/$new_pid/cmdline" | tr '\0' ' ')
    echo "$cmdline" > "$KIT_EVIDENCE/$KIT_SCRIPT.qemu-cmdline.txt"
    pass hypervisor "QEMU pid $new_pid: $(sudo readlink "/proc/$new_pid/exe")"
    echo "$cmdline" | grep -Eq 'accel=kvm|-accel kvm|-enable-kvm' && pass accel "QEMU uses KVM ($(echo "$cmdline" | grep -Eo 'accel=kvm|-accel kvm|-enable-kvm' | head -1))" || fail accel "no KVM accelerator on the QEMU command line (TCG emulation would be a different design)"
    echo "$cmdline" | grep -Eq -- '-cpu host' && pass cpu-host "-cpu host (required for nested VMs)" || fail cpu-host "QEMU not started with -cpu host"
    sudo ls -l "/proc/$new_pid/fd" 2>/dev/null | grep -q '/dev/kvm' && pass kvm-fd "QEMU holds /dev/kvm open" || fail kvm-fd "QEMU has no /dev/kvm descriptor"
    info vmm-rss "$(ps -o rss= -p "$new_pid" | awk '{printf "%.0f MiB", $1/1024}') resident for a 2 GiB-limit guest"
  else
    fail hypervisor "no new $KIT_QEMU process for $NAME"
  fi
else
  shim=$(pgrep -f containerd-shim-kata-v2 | tail -1)
  sudo ls -l "/proc/$shim/fd" 2>/dev/null | grep -q '/dev/kvm' && pass kvm-fd "Dragonball (in shim pid $shim) holds /dev/kvm" || fail kvm-fd "shim $shim has no /dev/kvm descriptor"
fi
record kata-processes sh -c "ps -eo pid,user,rss,etime,args | grep -E 'qemu-system|containerd-shim-kata|virtiofsd' | grep -v grep"

gx() { dk exec "$NAME" sh -c "$1"; }
record guest-identity dk exec "$NAME" sh -c 'uname -a; echo; cat /proc/cmdline; echo; tr "\0" "\n" < /sys/firmware/devicetree/base/compatible 2>/dev/null; echo; nproc; grep -E "MemTotal|MemFree" /proc/meminfo'
compat=$(gx 'tr "\0" " " < /sys/firmware/devicetree/base/compatible 2>/dev/null' || true)
info guest-machine "${compat:-no devicetree (x86 guests have none)}$( [ "$KIT_ARCH" = arm64 ] && echo " (QEMU's arm64 virt machine is 'linux,dummy-virt')")"
info guest-resources "nproc=$(gx nproc) MemTotal=$(gx "awk '/MemTotal/ {print \$2\" kB\"}' /proc/meminfo") for --cpus 2 --memory 2g (static_sandbox_resource_mgmt sizes the VM at boot)"

# Effective device exposure inside the guest container.
devs=$(gx 'ls -1 /dev' | tr '\n' ' ')
echo "$devs" > "$KIT_EVIDENCE/$KIT_SCRIPT.dev-default.txt"
info devices "$devs"
bad=$(gx 'ls -1 /dev' | grep -E '^(kvm|vhost-|vd[a-z]|sd[a-z]|nvme|loop|dm-|mapper|fuse|net)$' || true)
[ -z "$bad" ] && pass device-exposure "no kvm, vhost, block, loop, fuse or tun devices in the container" || fail device-exposure "unexpected devices: $(echo "$bad" | tr '\n' ' ')"
info capabilities "$(gx 'grep -E "Cap(Eff|Bnd)" /proc/self/status' | tr '\n' ' ')"
record guest-mounts dk exec "$NAME" cat /proc/mounts

# The capability set the inner dockerd will get (40-inner-docker.sh) must not add devices:
# capabilities act inside the guest kernel; they do not hot-plug node devices into the VM.
capargs=(); IFS=, read -ra caps <<< "$KIT_INNER_CAPS"; for c in "${caps[@]}"; do capargs+=(--cap-add "$c"); done
devs_caps=$(timeout "$BOOT_TIMEOUT" sudo docker run --rm --runtime "$RT" "${capargs[@]}" "$KIT_BUSYBOX_IMAGE" ls -1 /dev | tr '\n' ' ')
echo "$devs_caps" > "$KIT_EVIDENCE/$KIT_SCRIPT.dev-with-caps.txt"
[ "$devs_caps" = "$devs" ] && pass caps-no-devices "--cap-add $KIT_INNER_CAPS exposes the same /dev" || fail caps-no-devices "device list changed with caps: $devs_caps"

# Runtime configuration actually in force.
record runtime-config sh -c "sha256sum '$cfg'; echo; grep -nE '^\[|^(path|kernel|image|initrd|firmware|machine_type|machine_accelerators|cpu_features|default_vcpus|default_maxvcpus|default_memory|shared_fs|virtio_fs_daemon|block_device_driver|enable_debug|disable_guest_seccomp|sandbox_cgroup_only|static_sandbox_resource_mgmt|internetworking_model|disable_new_netns|seccomp_sandbox) ?=' '$cfg'"
info config "$cfg sha256 $(sha256sum "$cfg" | cut -c1-16)…"

# Startup latency, warm image: three sequential throwaway guests.
for i in 1 2 3; do
  t0=$(date +%s%N)
  timeout "$BOOT_TIMEOUT" sudo docker run --rm --runtime "$RT" "$KIT_BUSYBOX_IMAGE" true
  info "start-latency-$i" "$(( ($(date +%s%N) - t0) / 1000000 )) ms (docker run --rm ... true)"
done

dk rm -f "$NAME" >/dev/null
sleep 3
left=$(comm -13 <(echo "$before") <(vmm_pids | sort) | tr '\n' ' ')
[ -z "${left// /}" ] && pass cleanup "no Kata VMM processes left behind" || fail cleanup "leftover QEMU pids: $left"
finish
