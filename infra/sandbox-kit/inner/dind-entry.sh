# Entrypoint for the inner Docker daemon inside a Kata guest. Passed as `sh -c` to the pinned
# docker:dind image by 40-inner-docker.sh and by the Nomad job template; the owned runtime's
# NomadKataHands embeds the same text (a unit test keeps them identical).
#
# Why not --privileged: with Docker as the outer engine there is no
# privileged_without_host_devices switch (that is containerd-CRI / CRI-O only, per Kata's
# privileged.md), so a privileged Kata container asks the runtime to pass the Lima VM's host
# devices into the guest. The container instead gets a few capabilities; they act on the Kata
# guest kernel, whose boundary is the VM, not on the Lima kernel.
#
# Kata mounts cgroup2 read-only for a non-privileged container (as runc does). The dind script
# must create /sys/fs/cgroup/init and enable controllers, so remount it read-write
# (CAP_SYS_ADMIN, guest kernel only). Fail fast instead of letting dind's loop spin forever.
set -eu
mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
# /proc/sys is read-only too; dockerd writes per-interface sysctls (IPv6 on each container veth,
# IPv4 forwarding) and fails "docker run" without them. Guest kernel only, like the cgroup remount.
mount -o remount,rw /proc/sys 2>/dev/null || true
if ! mkdir -p /sys/fs/cgroup/init 2>/dev/null; then
  echo "kit: /sys/fs/cgroup is not writable; inner dockerd cannot manage cgroups" >&2
  exit 70
fi
# Docker gives containers on a user-defined network its embedded resolver (127.0.0.11), which
# lives in the host's network namespace and is unreachable from inside a Kata guest, so every
# plain lookup failed. Point the guest at the gateway instead; nftables sends any DNS there to the
# egress proxy, which answers only allowlisted names. Inner containers inherit this file.
# (No brace expansions here: Nomad interpolates them in task config.)
dns=$(printenv SANDBOX_DNS || true)
if [ -n "$dns" ] && grep -q '^nameserver 127\.0\.0\.11' /etc/resolv.conf 2>/dev/null; then
  printf 'nameserver %s\noptions ndots:0\n' "$dns" > /etc/resolv.conf ||
    echo "kit: could not rewrite /etc/resolv.conf" >&2
fi
# Trust the node's egress CA system-wide. The egress proxy is transparent (nftables redirects
# TCP 80/443 to it), so the guest has no proxy settings, only this trust. The job's CA env vars
# point at the system bundle; dockerd (Go) reads it at start, so install before exec.
if [ -s /local/egress-ca.pem ]; then
  mkdir -p /usr/local/share/ca-certificates
  cp /local/egress-ca.pem /usr/local/share/ca-certificates/linguini-egress-ca.crt
  update-ca-certificates >/dev/null 2>&1 || cat /local/egress-ca.pem >> /etc/ssl/certs/ca-certificates.crt
fi
# The workspace is the only persistent path. /var/lib/docker is whatever the caller mounted.
mkdir -p /workspace
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock
