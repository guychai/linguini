#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016  # pass/fail/info always return 0 (safe "&& ||"); single-quoted $ expands in the guest
# Egress boundary on the sandbox node (DESIGN-egress.md): the mitmproxy-based egress proxy as a
# dedicated system user under systemd, the node nftables rules (egress/node/sandbox-net.sh),
# then proof on this kernel:
#   1. egress/tests/proxy-test.sh   proxy policy, injection, redirects, websockets, DNS, audit
#   2. egress/tests/netns-test.sh   forced routing with real namespaces (no bypass, spoofing, v6)
#   3. a Kata guest on its own sbx* Docker network with no proxy settings: transparent MITM with
#      the node CA in its trust store, allowlisted package install, denied host, no direct route,
#      no metadata, the old explicit proxy port closed, DNS forced to the proxy
# Idempotent. Needs 20 (Docker + Kata). Network access: PyPI (hash-locked wheels) and, in part 3,
# dl-cdn.alpinelinux.org through the proxy (the one allowlisted host of the test policy).
#   EGRESS_BACKEND_USER  user that runs the backend and writes policies (default: $SUDO_USER or $USER)
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root_tools
export DEBIAN_FRONTEND=noninteractive
EG="$KIT_DIR/egress"
OPT=/opt/sandbox-egress
VENV=$OPT/venv
ETC=/etc/sandbox-egress
RUN=/run/sandbox-egress
CA_DIR=/var/lib/sandbox-egress/ca
GUEST_CA=/var/lib/sandbox-egress/guest-ca.pem
BACKEND_USER="${EGRESS_BACKEND_USER:-${SUDO_USER:-$(id -un)}}"
TPORT=3130 DNSP=5353 OLDPORT=3128

# ---- packages ----
missing=""
for p in nftables python3-venv python3-pip iproute2 util-linux jq curl; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then sudo apt-get update -q; # shellcheck disable=SC2086
  sudo apt-get install -y -q $missing; fi
pyv=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python3 -c 'import sys; sys.exit(not ((3, 12) <= sys.version_info[:2] <= (3, 14)))' && pass python "python3 $pyv (3.12-3.14: binary wheels for every locked package, mitmproxy $KIT_MITMPROXY_VERSION)" || die python "python3 $pyv is outside 3.12-3.14 (requirements.lock was checked for those)"

# ---- venv from the hash lock (every wheel/sdist checked against requirements.lock) ----
sudo install -d -m 0755 "$OPT"
if [ "$("$VENV/bin/mitmdump" --version 2>/dev/null | awk '/^Mitmproxy:/ {print $2}')" != "$KIT_MITMPROXY_VERSION" ] || ! sudo cmp -s "$EG/requirements.lock" "$OPT/requirements.lock"; then
  sudo rm -rf "$VENV"
  sudo python3 -m venv "$VENV"
  sudo "$VENV/bin/pip" install -q --no-deps --require-hashes --only-binary :all: -r "$EG/requirements.lock" || die venv "pip install --require-hashes failed"
  sudo install -m 0644 "$EG/requirements.lock" "$OPT/requirements.lock"
fi
mv_=$("$VENV/bin/mitmdump" --version 2>/dev/null | awk '/^Mitmproxy:/ {print $2}')
[ "$mv_" = "$KIT_MITMPROXY_VERSION" ] && pass mitmproxy "mitmproxy $mv_ in $VENV (hash-locked)" || die mitmproxy "got '$mv_'"
# Code the service runs: copied (root-owned), so the kit checkout can't change it underneath.
sudo install -d -m 0755 "$OPT/addon" "$OPT/node"
sudo install -m 0644 "$EG/addon/sandbox_egress.py" "$OPT/addon/sandbox_egress.py"
sudo install -m 0755 "$EG/run-proxy.sh" "$OPT/run-proxy.sh"
sudo install -m 0755 "$EG/node/sandbox-net.sh" "$OPT/node/sandbox-net.sh"
sudo install -m 0755 "$EG/node/sandbox-netctl" "$OPT/node/sandbox-netctl"
pass code "addon, run-proxy.sh, sandbox-net.sh, sandbox-netctl installed under $OPT (root-owned)"

# ---- user, directories, config (secrets readable by the proxy user only, never by guests) ----
getent group sandbox-egress >/dev/null || sudo groupadd --system sandbox-egress
id sandbox-egress >/dev/null 2>&1 || sudo useradd --system --gid sandbox-egress --home-dir /var/lib/sandbox-egress --shell /usr/sbin/nologin sandbox-egress
# The backend user writes policies; the proxy reads them through the group.
id -nG "$BACKEND_USER" | grep -qw sandbox-egress || sudo usermod -aG sandbox-egress "$BACKEND_USER"
sudo install -d -m 0750 -o root -g sandbox-egress "$ETC" "$ETC/secrets"
sudo install -d -m 0750 -o sandbox-egress -g sandbox-egress /var/lib/sandbox-egress /var/log/sandbox-egress
sudo install -d -m 0700 -o sandbox-egress -g sandbox-egress "$CA_DIR"
printf 'd %s 0755 root root -\nd %s/sources 0755 root root -\nd %s/policies 2750 %s sandbox-egress -\n' "$RUN" "$RUN" "$RUN" "$BACKEND_USER" | sudo tee /etc/tmpfiles.d/sandbox-egress.conf >/dev/null
sudo systemd-tmpfiles --create /etc/tmpfiles.d/sandbox-egress.conf
[ -e "$ETC/config.json" ] || jq '.audit_log = "/var/log/sandbox-egress/audit.jsonl"' "$EG/config.example.json" | KIT_DEST="$ETC/config.json" sudo_install_stdin -m 0640 -o root -g sandbox-egress
[ -e "$ETC/secrets.json" ] || echo '{}' | KIT_DEST="$ETC/secrets.json" sudo_install_stdin -m 0640 -o root -g sandbox-egress
info config "$ETC/config.json (kept if present), secrets $ETC/secrets.json + $ETC/secrets/ (0640/0750 root:sandbox-egress; add tokens there, never in a guest)"
record perms sudo stat -c '%A %U:%G %n' "$ETC" "$ETC/config.json" "$ETC/secrets.json" "$ETC/secrets" "$CA_DIR" "$RUN/policies"

# The backend gets exactly one root capability: create/bind/release a per-conversation sandbox
# network through sandbox-netctl (which validates the key itself). Not the docker group, not nft.
NETCTL="$OPT/node/sandbox-netctl"
sudoers=$(mktemp)
printf '# sandbox-kit 45-egress.sh: the backend may only manage per-conversation sandbox networks.\n%s ALL=(root) NOPASSWD: %s ensure *, %s release *, %s show *\n' \
  "$BACKEND_USER" "$NETCTL" "$NETCTL" "$NETCTL" > "$sudoers"
if sudo visudo -cqf "$sudoers"; then
  sudo install -m 0440 -o root -g root "$sudoers" /etc/sudoers.d/sandbox-egress && pass sudoers "/etc/sudoers.d/sandbox-egress: $BACKEND_USER may run only sandbox-netctl ensure|release|show (visudo -c ok)"
else fail sudoers "generated rule failed visudo -c; not installed"; fi
rm -f "$sudoers"
sudo -u "$BACKEND_USER" sudo -n -l "$NETCTL" ensure kitprobe000000 >/dev/null 2>&1 && pass sudoers-effective "sudo -n -l confirms $BACKEND_USER can run '$NETCTL ensure' without a password" || fail sudoers-effective "sudo -n -l refused $NETCTL for $BACKEND_USER"

# ---- systemd: nftables first, then the proxy ----
sudo tee /etc/systemd/system/sandbox-egress-net.service >/dev/null <<UNIT
[Unit]
Description=Sandbox egress nftables (no route out of sbx* except the proxy)
Before=docker.service sandbox-egress.service
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
Environment=TPROXY_PORT=$TPORT DNS_PORT=$DNSP STATE_DIR=$RUN
ExecStart=$OPT/node/sandbox-net.sh init
ExecStop=$OPT/node/sandbox-net.sh down
[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/systemd/system/sandbox-egress.service >/dev/null <<UNIT
[Unit]
Description=Sandbox egress proxy (allowlist, TLS MITM, token injection)
Requires=sandbox-egress-net.service
After=sandbox-egress-net.service network-online.target
[Service]
User=sandbox-egress
Group=sandbox-egress
Environment=EGRESS_VENV=$VENV EGRESS_CONFIG=$ETC/config.json EGRESS_TRANSPARENT=0.0.0.0:$TPORT EGRESS_DNS=0.0.0.0:$DNSP EGRESS_CONFDIR=$CA_DIR
ExecStart=$OPT/run-proxy.sh
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$CA_DIR /var/log/sandbox-egress
ReadOnlyPaths=$ETC $RUN
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable -q sandbox-egress-net.service sandbox-egress.service
sudo systemctl restart sandbox-egress-net.service sandbox-egress.service
for _ in $(seq 1 30); do sudo ss -ltn "sport = :$TPORT" | grep -q LISTEN && break; sleep 1; done
systemctl is-active -q sandbox-egress && sudo ss -ltn "sport = :$TPORT" | grep -q LISTEN && pass proxy-service "sandbox-egress active as user sandbox-egress, transparent listener :$TPORT (+ DNS :$DNSP/udp)" || { record journal sudo journalctl -u sandbox-egress --no-pager -n 80; die proxy-service "not listening; see evidence"; }
sudo nft list table inet sandbox_egress >/dev/null && pass nft-table "inet sandbox_egress installed" || fail nft-table "missing"
for _ in $(seq 1 20); do sudo test -s "$CA_DIR/mitmproxy-ca-cert.pem" && break; sleep 1; done
sudo install -m 0644 "$CA_DIR/mitmproxy-ca-cert.pem" "$GUEST_CA"
sudo test "$(sudo stat -c %a "$CA_DIR/mitmproxy-ca.pem")" = 600 && pass node-ca "CA key $CA_DIR/mitmproxy-ca.pem is 0600 sandbox-egress; guests get only $GUEST_CA ($(openssl x509 -in "$GUEST_CA" -noout -fingerprint -sha256 | cut -c1-40)...)" || fail node-ca "$(sudo stat -c '%a %U' "$CA_DIR/mitmproxy-ca.pem" 2>&1)"

# ---- 1 + 2: the box-validated suites, again on this kernel ----
if EGRESS_VENV="$VENV" bash "$EG/tests/proxy-test.sh" > "$KIT_EVIDENCE/$KIT_SCRIPT.proxy-test.txt" 2>&1; then pass proxy-test "$(grep -E '^=== ' "$KIT_EVIDENCE/$KIT_SCRIPT.proxy-test.txt" | tail -1)"
else fail proxy-test "$(grep -E '^FAIL' "$KIT_EVIDENCE/$KIT_SCRIPT.proxy-test.txt" | head -3 | tr '\n' ' ')"; fi
if EGRESS_VENV="$VENV" bash "$EG/tests/netns-test.sh" > "$KIT_EVIDENCE/$KIT_SCRIPT.netns-test.txt" 2>&1; then pass netns-test "$(grep -E '^=== ' "$KIT_EVIDENCE/$KIT_SCRIPT.netns-test.txt" | tail -1)"
else fail netns-test "$(grep -E '^FAIL|BLOCKED' "$KIT_EVIDENCE/$KIT_SCRIPT.netns-test.txt" | head -3 | tr '\n' ' ')"; fi

# ---- 3: a Kata guest behind the boundary ----
NET=sbxkit0 SUBNET=10.89.0.0/29 GW=10.89.0.1 IP=10.89.0.2 KEY=kite2e000000000000 NAME=kit-egress
dk info --format '{{json .Runtimes}}' | jq -e '.kata' >/dev/null || die runtime "Docker has no 'kata' runtime; run 20-install-docker-kata.sh"
dk_rm "$NAME" || die cleanup "container $NAME could not be removed within 60 s"
dk network rm "$NET" >/dev/null 2>&1 || true
# One bridge per sandbox (the source-IP binding needs one interface per sandbox), no NAT, no ICC.
dk network create --driver bridge --subnet "$SUBNET" --gateway "$GW" \
  -o com.docker.network.bridge.name="$NET" \
  -o com.docker.network.bridge.enable_ip_masquerade=false \
  -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null && pass sandbox-network "$NET $SUBNET (bridge $NET, masquerade off, icc off)"
sudo env STATE_DIR="$RUN" "$OPT/node/sandbox-net.sh" add "$NET" "$IP" "$KEY"
# The policy the backend would write (FileEgressPolicyWriter): one allowlisted host, untainted.
jq -n --arg k "$KEY" '{version: 1, conversationKey: $k, workspaceId: "kit", tainted: false,
  rules: [{host: "dl-cdn.alpinelinux.org", ports: [443], methods: ["GET", "HEAD"]}]}' \
  | KIT_DEST="$RUN/policies/$KEY.json" sudo_install_stdin -m 0640 -o "$BACKEND_USER" -g sandbox-egress
dk pull -q "$KIT_ALPINE_IMAGE" >/dev/null
dk run -d --name "$NAME" --runtime kata --network "$NET" --ip "$IP" --dns "$GW" \
  --mount "type=bind,src=$GUEST_CA,dst=/kit/node-ca.pem,readonly" \
  "$KIT_ALPINE_IMAGE" sleep 900 >/dev/null
# No proxy settings in the guest: nftables redirects its TCP 80/443 to the transparent proxy.
gx() { dk exec "$NAME" sh -c "$1" 2>&1; }
[ "$(dk inspect -f '{{.HostConfig.Runtime}}' "$NAME")" = kata ] && pass guest-runtime "kata" || fail guest-runtime "not kata"
# Like the platform (PR #15): point resolv.conf at the gateway, not Docker's embedded 127.0.0.11,
# so names resolve through the proxy's DNS (no proxy env, so the guest resolves for itself).
gx "echo nameserver $GW > /etc/resolv.conf" >/dev/null || true
gx 'cat /kit/node-ca.pem >> /etc/ssl/certs/ca-certificates.crt' >/dev/null || true
out=$(gx 'apk add -q --no-cache curl && curl --version | head -1' || true)
echo "$out" | grep -q '^curl ' && pass allowlisted-install "apk add curl from dl-cdn.alpinelinux.org through the transparent MITM proxy, no proxy env: $(echo "$out" | tail -1 | cut -c1-40)" || fail allowlisted-install "$(echo "$out" | tail -3 | tr '\n' ' ')"
issuer=$(gx 'curl -sS -o /dev/null -w "%{certs}" https://dl-cdn.alpinelinux.org/alpine/ | grep -m1 "^Issuer:"' || true)
echo "$issuer" | grep -qi mitmproxy && pass mitm "guest sees the node CA as issuer ($issuer)" || fail mitm "issuer: $issuer"
c() { gx "curl -s -o /dev/null -w '%{http_code}' --max-time 6 $1 || true"; }
# (example.com does not resolve for the guest; pin it to its address to reach the proxy's TLS check)
r=$(c "--resolve example.com:443:93.184.215.14 https://example.com/"); [ "$r" = 403 ] && pass denied-host "example.com: 403 from the transparent proxy" || fail denied-host "$r"
t0=$(date +%s%N); r=$(c https://1.1.1.1:8443/); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[ "$r" = 000 ] && [ "$ms" -lt 2000 ] && pass no-direct-route "1.1.1.1:8443 rejected in ${ms}ms (no route around the proxy)" || fail no-direct-route "$r ${ms}ms"
r=$(c http://169.254.169.254/latest/meta-data/); [ "$r" = 403 ] && pass no-metadata "metadata (port 80) refused by the transparent proxy" || fail no-metadata "$r"
t0=$(date +%s%N); r=$(c "--proxy http://$GW:$OLDPORT https://dl-cdn.alpinelinux.org/alpine/"); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[ "$r" = 000 ] && [ "$ms" -lt 2000 ] && pass old-proxy-port-closed "explicit proxy $GW:$OLDPORT refused in ${ms}ms" || fail old-proxy-port-closed "$r ${ms}ms"
r=$(gx 'nslookup -timeout=3 dl-cdn.alpinelinux.org 8.8.8.8 | grep -c "^Address" || true'); [ "${r:-0}" -ge 2 ] && pass dns-forced-allowed "query to 8.8.8.8 answered by the proxy DNS" || fail dns-forced-allowed "$r"
r=$(gx 'nslookup -timeout=3 exfil.example.com 8.8.8.8 >/dev/null 2>&1 && echo answered || echo refused'); [ "$r" = refused ] && pass dns-forced-denied "non-allowlisted name refused" || fail dns-forced-denied "$r"
r=$(gx 'env | grep -ciE "token|secret|authorization" || true'); [ "$r" = 0 ] && pass guest-env "no token/secret variables in the guest" || fail guest-env "$r matching variables"
# The broker's path: sandbox-netctl (as the backend user, via the sudoers rule) creates the
# per-conversation network and binds it to the proxy; release undoes both.
NKEY=kitnetctl00000000000
if j=$(sudo -u "$BACKEND_USER" sudo -n "$NETCTL" ensure "$NKEY" 2>&1); then
  nn=$(echo "$j" | jq -r .name) nip=$(echo "$j" | jq -r .ipv4)
  bound=$(sudo nft list set inet sandbox_egress bind | tr -d ' \n' | grep -c "\"$nn\"\.$nip" || true)
  src=$(cat "$RUN/sources/$nip" 2>/dev/null || true)
  [ "$(dk network inspect -f '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}' "$nn")" = false ] && [ "${bound:-0}" -ge 1 ] && [ "$src" = "$NKEY" ] \
    && pass netctl-ensure "backend user: $(echo "$j" | jq -c .) (masquerade off, nft-bound, source mapped)" || fail netctl-ensure "$j bound=$bound src=$src"
  sudo -u "$BACKEND_USER" sudo -n "$NETCTL" release "$NKEY" >/dev/null && ! dk network inspect "$nn" >/dev/null 2>&1 && [ ! -e "$RUN/sources/$nip" ] \
    && pass netctl-release "network, nft binding and source mapping removed" || fail netctl-release "leftovers for $nn"
else fail netctl-ensure "$j"; fi
record audit sudo tail -n 20 /var/log/sandbox-egress/audit.jsonl
record counters sudo nft list table inet sandbox_egress
if [ "${KEEP:-0}" != 1 ]; then
  dk_rm "$NAME"; dk network rm "$NET" >/dev/null
  sudo env STATE_DIR="$RUN" "$OPT/node/sandbox-net.sh" del "$NET" "$IP"; sudo rm -f "$RUN/policies/$KEY.json"
fi
finish
