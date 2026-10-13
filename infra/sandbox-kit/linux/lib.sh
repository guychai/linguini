#!/usr/bin/env bash
# Shared helpers for the node scripts (linux/NN-*.sh). Sourced, never run directly. They run
# directly on the Linux sandbox node (Ubuntu 24.04 or 26.04, x86_64 or aarch64), or inside the Lima VM
# on the Mac path (RUNBOOK appendix).
# Every check prints one line: "PASS <id>: <evidence>" or "FAIL <id>: <evidence>", and all output
# is copied to $KIT_EVIDENCE/<script>.log so it can be sent back as one archive.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../versions.env
. "$KIT_DIR/versions.env"
KIT_EVIDENCE="${KIT_EVIDENCE:-$HOME/sandbox-kit-evidence}"
mkdir -p "$KIT_EVIDENCE"
KIT_SCRIPT="$(basename "$0" .sh)"
KIT_LOG="$KIT_EVIDENCE/$KIT_SCRIPT.log"
# shellcheck disable=SC2034  # used by the scripts that source this file
case "$(uname -m)" in
  x86_64) KIT_ARCH=amd64; KIT_QEMU=/opt/kata/bin/qemu-system-x86_64 ;;
  aarch64) KIT_ARCH=arm64; KIT_QEMU=/opt/kata/bin/qemu-system-aarch64 ;;
  *) echo "FAIL arch: $(uname -m) is not supported (x86_64 or aarch64)"; exit 1 ;;
esac
# Per-arch pins from versions.env (KIT_KATA_SHA256_amd64 / _arm64, KIT_NOMAD_SHA256_*).
KIT_KATA_SHA256_VAR="KIT_KATA_SHA256_$KIT_ARCH"
KIT_NOMAD_SHA256_VAR="KIT_NOMAD_SHA256_$KIT_ARCH"
# shellcheck disable=SC2034  # used by the scripts that source this file
KIT_KATA_SHA256="${!KIT_KATA_SHA256_VAR}"
# shellcheck disable=SC2034
KIT_NOMAD_SHA256="${!KIT_NOMAD_SHA256_VAR}"
# Ubuntu release -> codename from KIT_UBUNTU, and the full Docker apt pins for it.
kit_ubuntu_codename() { # VERSION_ID -> codename, or nothing if unsupported
  local p; for p in $KIT_UBUNTU; do [ "${p%%:*}" = "$1" ] && { echo "${p#*:}"; return 0; }; done; return 1
}
kit_docker_pins() { # VERSION_ID codename: sets KIT_*_VERSION to the full apt version strings
  local s="~ubuntu.$1~$2"
  KIT_DOCKER_VERSION="${KIT_DOCKER_VERSION%%~*}$s" KIT_CONTAINERD_VERSION="${KIT_CONTAINERD_VERSION%%~*}$s"
  KIT_BUILDX_VERSION="${KIT_BUILDX_VERSION%%~*}$s" KIT_COMPOSE_VERSION="${KIT_COMPOSE_VERSION%%~*}$s"
}
KIT_FAILS=0
KIT_PASSES=0
exec > >(tee -a "$KIT_LOG") 2>&1
echo "=== $KIT_SCRIPT $(date -Is) host=$(hostname) kernel=$(uname -r) arch=$(uname -m)"

pass() { KIT_PASSES=$((KIT_PASSES + 1)); echo "PASS $1: $2"; }
fail() { KIT_FAILS=$((KIT_FAILS + 1)); echo "FAIL $1: $2"; }
info() { echo "INFO $1: $2"; }
# Record a command's output as evidence without failing the script.
record() {
  local name="$1"; shift
  { echo "\$ $*"; "$@" 2>&1 || echo "(exit $?)"; } > "$KIT_EVIDENCE/$KIT_SCRIPT.$name.txt"
  info evidence "$KIT_EVIDENCE/$KIT_SCRIPT.$name.txt"
}
# Stop immediately: later checks depend on this one.
die() { fail "$1" "$2"; finish; }
finish() {
  echo "=== $KIT_SCRIPT done: $KIT_PASSES passed, $KIT_FAILS failed"
  if [ "$KIT_FAILS" -gt 0 ]; then
    echo "RESULT FAIL"
    exit 1
  fi
  echo "RESULT PASS"
  exit 0
}
need_root_tools() {
  sudo -n true 2>/dev/null || die sudo "passwordless sudo is required for this step (run 'sudo -v' first, or use a sudoers entry)"
}
# Docker as root; the scripts never add the user to the docker group (that is root-equivalent).
dk() { sudo docker "$@"; }
# sudo install <args> <dest> with the content from stdin. Not `install /dev/stdin`: uutils
# install (Ubuntu 26.04's coreutils) fails with "No such file or directory" when the
# destination already exists, so stage in a private temp file first.
sudo_install_stdin() {
  local tmp rc; tmp=$(mktemp) || return 1
  cat > "$tmp" && sudo install "$@" "$tmp" "${KIT_DEST:?}"; rc=$?
  rm -f "$tmp"; return $rc
}
# Remove containers and wait until they are gone. A Kata VM can take longer than Docker's 10 s
# kill deadline to stop, so the first `rm -f` may fail ("is zombie and can not be killed") and
# a retry seconds later succeeds (seen on the dev VM, step 40).
dk_rm() {
  local c left; for _ in $(seq 1 30); do
    left=0; for c in "$@"; do dk inspect "$c" >/dev/null 2>&1 && { dk rm -f -v "$c" >/dev/null 2>&1 || true; left=1; }; done
    [ "$left" = 0 ] && return 0
    sleep 2
  done
  for c in "$@"; do dk inspect "$c" >/dev/null 2>&1 && return 1; done; return 0
}
