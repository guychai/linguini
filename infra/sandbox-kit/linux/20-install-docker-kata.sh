#!/usr/bin/env bash
# shellcheck disable=SC2015  # pass/fail/info always return 0, so "test && pass || fail" is a safe if/else
# Step 2 prerequisites: Docker Engine (pinned, >= 26) and Kata Containers (pinned) with QEMU,
# configured the way Kata's installation docs describe for Docker (docs/installation.md at tag
# 4.2.0, "Use Kata Containers with Docker"): the kata-static tarball under /opt/kata, and a
# Docker runtime whose runtimeType is the runtime-rs shim and whose ConfigPath selects the
# QEMU runtime-rs configuration. No Kubernetes or CRI-only settings. Kata is made Docker's
# DEFAULT runtime on the node ("default-runtime": "kata"), so a container that names no runtime
# still gets a VM; runc stays available only by explicit name (--runtime runc), which the
# baseline in 30 uses and Nomad's allow_runtimes = ["kata"] refuses.
# Runs directly on the Linux sandbox node (Ubuntu 24.04 or 26.04, x86_64 or aarch64), with sudo.
# Idempotent: every step checks the current state first; rerunning changes nothing.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root_tools
export DEBIAN_FRONTEND=noninteractive
# shellcheck disable=SC1091
. /etc/os-release
code=$(kit_ubuntu_codename "${VERSION_ID:-}" || true)
[ "${ID:-}" = ubuntu ] && [ -n "$code" ] && [ "${VERSION_CODENAME:-}" = "$code" ] || die platform "expected Ubuntu ($KIT_UBUNTU), got ${PRETTY_NAME:-?} ($(uname -m)); see linux/00-preflight.sh"
kit_docker_pins "$VERSION_ID" "$code"
pass platform "${PRETTY_NAME} $(uname -m) -> $KIT_ARCH artifacts, Docker repo '$code' ($KIT_DOCKER_VERSION)"

# --- base tools ---
missing=""
for p in ca-certificates curl gnupg jq zstd unzip python3; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then
  sudo apt-get update -q
  # shellcheck disable=SC2086
  sudo apt-get install -y -q $missing
fi
pass base-tools "ca-certificates curl gnupg jq zstd unzip python3 present"

# --- Docker apt repository (Docker's documented Ubuntu install), key fingerprint checked ---
key=/etc/apt/keyrings/docker.asc
if [ ! -s "$key" ]; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key"
  sudo chmod a+r "$key"
fi
fpr=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')
[ "$fpr" = "$KIT_DOCKER_GPG_FPR" ] && pass docker-key "fingerprint $fpr" || die docker-key "fingerprint '$fpr' != pinned $KIT_DOCKER_GPG_FPR"
src=/etc/apt/sources.list.d/docker.list
line="deb [arch=$KIT_ARCH signed-by=$key] https://download.docker.com/linux/ubuntu $code stable"
if [ "$(cat "$src" 2>/dev/null)" != "$line" ]; then
  echo "$line" | sudo tee "$src" >/dev/null
  sudo apt-get update -q
fi

# --- Docker Engine, pinned exact versions, held against unattended upgrades ---
want="docker-ce=$KIT_DOCKER_VERSION docker-ce-cli=$KIT_DOCKER_VERSION containerd.io=$KIT_CONTAINERD_VERSION docker-buildx-plugin=$KIT_BUILDX_VERSION docker-compose-plugin=$KIT_COMPOSE_VERSION"
need=""
for pv in $want; do
  [ "$(dpkg-query -W -f='${Version}' "${pv%%=*}" 2>/dev/null || true)" = "${pv#*=}" ] || need="$need $pv"
done
if [ -n "$need" ]; then
  sudo apt-mark unhold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  sudo apt-get install -y -q --allow-downgrades $need
fi
sudo apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
sudo systemctl enable --now docker >/dev/null 2>&1
server=$(dk version --format '{{.Server.Version}}' 2>/dev/null || echo 0)
[ "${server%%.*}" -ge 26 ] 2>/dev/null && pass docker-version "Engine $server (>= 26, Kata's documented minimum for the Docker path)" || die docker-version "Engine '$server'"
info docker-packages "$(dpkg-query -W -f='${Package}=${Version} ' docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)"

# --- Kata static release, checksum-verified ---
if [ "$(cat /opt/kata/.kit-version 2>/dev/null)" != "$KIT_KATA_VERSION-$KIT_ARCH" ]; then
  tmp=$(mktemp -d)
  url="https://github.com/kata-containers/kata-containers/releases/download/$KIT_KATA_VERSION/kata-static-$KIT_KATA_VERSION-$KIT_ARCH.tar.zst"
  info kata-download "$url (amd64 ~1.0 GB, arm64 ~650 MB)"
  curl -fL --retry 3 -o "$tmp/kata.tar.zst" "$url"
  echo "$KIT_KATA_SHA256  $tmp/kata.tar.zst" | sha256sum -c - || die kata-sha256 "checksum mismatch for $url"
  sudo rm -rf /opt/kata
  # The archive uses an /opt/kata/ prefix (Kata docs); extract as root to /.
  sudo tar --use-compress-program=unzstd -xf "$tmp/kata.tar.zst" -C /
  echo "$KIT_KATA_VERSION-$KIT_ARCH" | sudo tee /opt/kata/.kit-version >/dev/null
  rm -rf "$tmp"
fi
pass kata-installed "/opt/kata from kata-static-$KIT_KATA_VERSION-$KIT_ARCH.tar.zst, sha256-verified at install ($KIT_KATA_SHA256)"
for f in "$KIT_KATA_SHIM" "$KIT_KATA_CONFIG" "$KIT_QEMU" /opt/kata/libexec/virtiofsd; do
  [ -e "$f" ] && pass kata-file "$f" || fail kata-file "$f missing"
done
info kata-shim-version "$("$KIT_KATA_SHIM" --version 2>&1 | head -3 | tr '\n' ' ')"
info kata-qemu-version "$("$KIT_QEMU" --version | head -1)"

# --- Kata host prerequisites (installation.md "Host kernel modules") ---
for m in vhost_vsock vhost_net; do
  sudo modprobe "$m" && [ -d "/sys/module/$m" ] && pass "module-$m" loaded || fail "module-$m" "cannot load"
done
mods=$'vhost_vsock\nvhost_net'
[ "$(cat /etc/modules-load.d/kata-containers.conf 2>/dev/null)" = "$mods" ] || echo "$mods" | sudo tee /etc/modules-load.d/kata-containers.conf >/dev/null
[ -r /etc/modules-load.d/kata-containers.conf ] && pass modules-boot "/etc/modules-load.d/kata-containers.conf loads vhost_vsock, vhost_net at boot" || fail modules-boot "cannot write /etc/modules-load.d/kata-containers.conf"
[ -c /dev/kvm ] && pass dev-kvm "$(ls -l /dev/kvm)" || fail dev-kvm "missing; rerun 10-kvm-check.sh"

# --- Register the runtimes with Docker (merge into daemon.json, keep anything else) ---
daemon=/etc/docker/daemon.json
current=$(sudo cat "$daemon" 2>/dev/null || echo '{}')
merged=$(echo "$current" | jq -S \
  --arg shim "$KIT_KATA_SHIM" --arg cfg "$KIT_KATA_CONFIG" --arg db "$KIT_KATA_CONFIG_DB" '
  .runtimes.kata = {runtimeType: $shim, options: {ConfigPath: $cfg}}
  | .["default-runtime"] = "kata"
  | .runtimes["kata-db"] = {runtimeType: $shim, options: {ConfigPath: $db}}')
if [ "$(echo "$current" | jq -S .)" != "$merged" ]; then
  echo "$merged" | sudo tee "$daemon" >/dev/null
  sudo systemctl restart docker
  info daemon-json "updated and docker restarted"
fi
record daemon-json sudo cat "$daemon"
runtimes=$(dk info --format '{{json .Runtimes}}')
echo "$runtimes" | jq -e '.kata' >/dev/null && pass docker-runtime-kata "$(echo "$runtimes" | jq -c '.kata')" || fail docker-runtime-kata "$runtimes"
drt=$(dk info --format '{{.DefaultRuntime}}')
[ "$drt" = kata ] && pass docker-default-runtime "DefaultRuntime=kata: a container that names no runtime still gets a Kata VM" || fail docker-default-runtime "DefaultRuntime=$drt"
echo "$runtimes" | jq -e '.runc' >/dev/null && info docker-runtime-runc "still registered, used only when named (--runtime runc); Nomad's allow_runtimes refuses it" || true
# Proof, not just config: a container started with no --runtime boots its own kernel.
if dk pull -q "$KIT_BUSYBOX_IMAGE" >/dev/null 2>&1; then
  dflt=$(timeout 300 sudo docker run --rm "$KIT_BUSYBOX_IMAGE" uname -r 2>&1 || true)
  [ -n "$dflt" ] && [ "$dflt" != "$(uname -r)" ] && pass default-is-vm "docker run without --runtime: guest kernel $dflt != node kernel $(uname -r)" || fail default-is-vm "docker run without --runtime gave '$dflt' (node kernel $(uname -r)); see 30-kata-smoke.sh"
else fail default-is-vm "cannot pull $KIT_BUSYBOX_IMAGE"; fi
info docker-storage "$(dk info --format 'Driver={{.Driver}} DriverStatus={{json .DriverStatus}} Root={{.DockerRootDir}}')"
record docker-info sudo docker info
record kata-config-sha256 sha256sum "$KIT_KATA_CONFIG" "$KIT_KATA_CONFIG_DB"
finish
