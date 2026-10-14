#!/usr/bin/env bash
# Visual replies (html_preview / html_render): the render worker on the dev VM. Idempotent.
# - Chrome for Testing's headless shell, pinned by version and sha256 (Ubuntu's chromium is a
#   snap, which does not suit a hardened system service), under /opt/chrome-headless-shell, plus
#   its shared libraries and the Liberation fonts (the measure fonts) from the distro.
# - System user linguini-render (no login, no home), the unit linguini-render.service.
# - agentplat joins group linguini-render (to open the socket) via the backend unit's
#   SupplementaryGroups (infra/hosting/agent-platform.service), and the backend gets
#   RENDER_SOCKET in /etc/agent-platform/agent-platform.env (appended once; nothing else touched).
# Chrome's sandbox needs unprivileged user namespaces; this checks, it does not change sysctls.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
version=${CHROME_HEADLESS_SHELL_VERSION:-155.0.8059.79}
sha256=${CHROME_HEADLESS_SHELL_SHA256:-4cea4c32b501aa43cc2b81eb45734af991a6a82feded48380d6dfaf96642a1c1}
dir=/opt/chrome-headless-shell/$version
if [ ! -x "$dir/chrome-headless-shell" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/chs.zip" "https://storage.googleapis.com/chrome-for-testing-public/$version/linux64/chrome-headless-shell-linux64.zip"
  echo "$sha256  $tmp/chs.zip" | sha256sum -c -
  command -v unzip >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q unzip >/dev/null
  unzip -q "$tmp/chs.zip" -d "$tmp"
  sudo install -d -m 0755 /opt/chrome-headless-shell
  sudo rm -rf "$dir" && sudo cp -r "$tmp/chrome-headless-shell-linux64" "$dir"
  sudo chown -R root:root "$dir" && sudo chmod -R go-w "$dir"
fi
sudo ln -sfn "$dir" /opt/chrome-headless-shell/current
# Shared libraries (newer Ubuntu releases renamed some with a t64 suffix).
for pkg in fonts-liberation libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
  libcups2 libdbus-1-3 libexpat1 libgbm1 libglib2.0-0 libpango-1.0-0 libcairo2 libasound2 \
  libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2; do
  dpkg -s "$pkg" >/dev/null 2>&1 || dpkg -s "${pkg}t64" >/dev/null 2>&1 ||
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$pkg" >/dev/null 2>&1 ||
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${pkg}t64" >/dev/null
done
missing=$(ldd /opt/chrome-headless-shell/current/chrome-headless-shell | grep 'not found' || true)
[ -z "$missing" ] || { echo "missing libraries: $missing" >&2; exit 1; }
/opt/chrome-headless-shell/current/chrome-headless-shell --version
if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != 1 ] ||
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" = 0 ] ||
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  echo "unprivileged user namespaces are restricted: Chrome's sandbox cannot start" >&2
  exit 1
fi
getent group linguini-render >/dev/null || sudo groupadd --system linguini-render
id linguini-render >/dev/null 2>&1 || sudo useradd --system --gid linguini-render --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin linguini-render
sudo cp "$here/linguini-render.service" /etc/systemd/system/linguini-render.service
env=/etc/agent-platform/agent-platform.env
sudo grep -q '^RENDER_SOCKET=' "$env" ||
  echo 'RENDER_SOCKET=/run/linguini-render/render.sock' | sudo tee -a "$env" >/dev/null
grep -q 'linguini-render' /etc/systemd/system/agent-platform.service ||
  echo "note: install infra/hosting/agent-platform.service (SupplementaryGroups adds linguini-render)" >&2
sudo systemctl daemon-reload
sudo systemctl enable --now linguini-render.service
for _ in $(seq 1 30); do [ -S /run/linguini-render/render.sock ] && break; sleep 1; done
sudo ls -l /run/linguini-render/render.sock
