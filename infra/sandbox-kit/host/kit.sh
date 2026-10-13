#!/bin/bash
# Mac path only (RUNBOOK appendix A): host-side driver that runs the linux/ scripts inside a
# Lima VM (macOS /bin/bash 3.2). On a Linux sandbox node, run linux/NN-*.sh directly instead.
#   host/kit.sh create            create + start the Lima VM from lima/kata-dind.yaml
#   host/kit.sh push              copy this kit into the VM (fresh ~/sandbox-kit each time)
#   host/kit.sh run 10|20|...     run one linux/ script in the VM (output is also saved there)
#   host/kit.sh all               push, then 10 20 30 40 45 50 in order, stopping at the first failure
#   host/kit.sh fetch             copy the evidence archive back to ./sandbox-kit-evidence-<time>.tgz
#   host/kit.sh delete            stop and delete the VM (everything inside it is gone)
set -eu
KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=versions.env  # path relative to the kit root (tests/validate-static.sh runs there)
. "$KIT_DIR/versions.env"
VM="$KIT_LIMA_INSTANCE"
in_vm() { limactl shell --workdir / "$VM" -- bash -c "$1"; }
step_file() {
  case "$1" in
    10) echo 10-kvm-check.sh ;; 20) echo 20-install-docker-kata.sh ;; 30) echo 30-kata-smoke.sh ;;
    40) echo 40-inner-docker.sh ;; 45) echo 45-egress.sh ;; 50) echo 50-nomad.sh ;;
    *) echo "unknown step $1 (10 20 30 40 45 50)" >&2; exit 2 ;;
  esac
}
case "${1:-}" in
  create)
    limactl create --tty=false --name="$VM" "$KIT_DIR/lima/kata-dind.yaml"
    limactl start "$VM"
    ;;
  push)
    tmp=$(mktemp -d)
    # COPYFILE_DISABLE: keep macOS's ._ metadata files out of the archive.
    COPYFILE_DISABLE=1 tar -C "$KIT_DIR" -czf "$tmp/kit.tgz" .
    limactl copy "$tmp/kit.tgz" "$VM:/tmp/sandbox-kit.tgz"
    rm -rf "$tmp"
    # shellcheck disable=SC2016  # ~ and $HOME expand inside the VM, not here
    in_vm 'rm -rf ~/sandbox-kit && mkdir ~/sandbox-kit && tar -C ~/sandbox-kit -xzf /tmp/sandbox-kit.tgz && rm /tmp/sandbox-kit.tgz && echo "kit in $HOME/sandbox-kit"'
    ;;
  run)
    f=$(step_file "${2:?step}")
    # Pass through the documented knobs only (KATA_RUNTIME, INNER_STORAGE, KEEP, KEEP_NOMAD).
    in_vm "KATA_RUNTIME='${KATA_RUNTIME:-kata}' INNER_STORAGE='${INNER_STORAGE:-auto}' KEEP='${KEEP:-0}' KEEP_NOMAD='${KEEP_NOMAD:-0}' bash ~/sandbox-kit/linux/$f"
    ;;
  all)
    "$0" push
    for s in 10 20 30 40 45 50; do
      echo; echo "######## step $s ($(date '+%H:%M:%S'))"
      "$0" run "$s" || { echo "step $s failed; fix or report, then: host/kit.sh run $s"; exit 1; }
    done
    ;;
  fetch)
    out="sandbox-kit-evidence-$(date '+%Y%m%d-%H%M%S').tgz"
    in_vm 'tar -C ~ -czf /tmp/evidence.tgz sandbox-kit-evidence'
    limactl copy "$VM:/tmp/evidence.tgz" "./$out"
    echo "evidence: $PWD/$out"
    ;;
  delete)
    limactl stop "$VM" 2>/dev/null || true
    limactl delete "$VM"
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
