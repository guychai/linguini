#!/usr/bin/env bash
# Tests node/sandbox-netctl (the backend's one privileged step) with a fake docker CLI and the
# real nftables table in a throwaway network namespace (root via sudo). Proves: subnet allocation
# from the pool, idempotent ensure, nft binding + source map, refusal to share a name with another
# key, input validation, release + reuse. The real Docker side runs on the VM (linux/50-nomad.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
kit="$(dirname "$here")"
sudo -n true 2>/dev/null || { echo "BLOCKED: needs passwordless sudo"; exit 3; }
NS=egress-netctl
work=$(mktemp -d); chmod 755 "$work"
cleanup() { sudo ip netns del "$NS" 2>/dev/null || true; sudo rm -rf "$work"; }
trap cleanup EXIT
sudo ip netns del "$NS" 2>/dev/null || true
sudo ip netns add "$NS"
passes=0 fails=0
check() { if [ "$2" = "$3" ]; then passes=$((passes + 1)); echo "PASS $1: $2"; else fails=$((fails + 1)); echo "FAIL $1: expected '$3', got '$2'"; fi; }

# fake docker: networks are files $work/nets/<name> holding "label subnet gateway"
mkdir -p "$work/nets"
cat > "$work/docker" <<F
#!/usr/bin/env bash
set -eu
D="$work/nets"
[ "\$1" = network ] || exit 2; shift
case "\$1" in
  create)
    shift; label="" subnet="" gw="" name=""
    while [ \$# -gt 0 ]; do case "\$1" in
      --subnet) subnet=\$2; shift 2;; --gateway) gw=\$2; shift 2;; --label) label=\${2#*=}; shift 2;;
      --driver|-o) shift 2;; *) name=\$1; shift;; esac; done
    [ -e "\$D/\$name" ] && { echo "network with name \$name already exists" >&2; exit 1; }
    echo "\$label \$subnet \$gw" > "\$D/\$name"; echo "id-\$name" ;;
  inspect)
    shift; fmt=""; names=()
    while [ \$# -gt 0 ]; do case "\$1" in --format) fmt=\$2; shift 2;; *) names+=("\$1"); shift;; esac; done
    for n in "\${names[@]}"; do
      n=\${n#id-}; [ -e "\$D/\$n" ] || { echo "network \$n not found" >&2; exit 1; }
      read -r l s g < "\$D/\$n"
      case "\$fmt" in *Labels*) echo "\$l \$s \$g";; *) echo "\$s";; esac
    done ;;
  ls) for f in "\$D"/*; do [ -e "\$f" ] && echo "id-\$(basename "\$f")"; done; true ;;
  rm) rm "\$D/\$2" ;;
esac
F
printf '#!/bin/sh\nexec env STATE_DIR=%s/run bash %s/node/sandbox-net.sh "$@"\n' "$work" "$kit" > "$work/sandbox-net"
sed -e "s|^DOCKER=.*|DOCKER=$work/docker|" -e "s|^SANDBOX_NET=.*|SANDBOX_NET=$work/sandbox-net|" \
    -e "s|^STATE_DIR=.*|STATE_DIR=$work/run|" "$kit/node/sandbox-netctl" > "$work/netctl"
chmod +x "$work/docker" "$work/sandbox-net" "$work/netctl"
nsx() { sudo ip netns exec "$NS" "$@"; }
nsx "$work/sandbox-net" init >/dev/null
K1=aaaaaaaaaaaa11111111 K2=bbbbbbbbbbbb22222222 K1B=aaaaaaaaaaaa99999999 K3=cccccccccccc33333333
ctl() { nsx "$work/netctl" "$@" 2>&1; }
elem() { nsx nft list set inet sandbox_egress bind | tr -d ' \n' | grep -o "\"$1\"\\.$2" || echo none; }

out=$(ctl ensure $K1)
check ensure-json "$out" '{"name":"sbxaaaaaaaaaaaa","subnet":"10.90.0.0/29","gateway":"10.90.0.1","ipv4":"10.90.0.2"}'
check nft-bound "$(elem sbxaaaaaaaaaaaa 10.90.0.2)" '"sbxaaaaaaaaaaaa".10.90.0.2'
check source-map "$(sudo cat "$work/run/sources/10.90.0.2")" "$K1"
check ensure-idempotent "$(ctl ensure $K1)" "$out"
check one-network "$(find "$work/nets" -type f | wc -l | tr -d ' ')" "1"
check second-subnet "$(ctl ensure $K2 | jq -r .subnet)" "10.90.0.8/29"
r=$(ctl ensure $K1B; echo "exit=$?") || true
check foreign-name-refused "$(echo "$r" | grep -c 'refusing to share')" "1"
check foreign-unchanged "$(sudo cat "$work/run/sources/10.90.0.2")" "$K1"
r=$(ctl ensure '../etc' || true); check bad-key "$(echo "$r" | grep -c 'must match')" "1"
r=$(ctl ensure 'ABCDEF0123456789' || true); check upper-key "$(echo "$r" | grep -c 'must match')" "1"
check release "$(ctl release $K1)" '{"name":"sbxaaaaaaaaaaaa","released":true}'
check release-unbinds "$(elem sbxaaaaaaaaaaaa 10.90.0.2)" "none"
check release-unmaps "$(sudo test -e "$work/run/sources/10.90.0.2" && echo present || echo gone)" "gone"
check release-idempotent "$(ctl release $K1)" '{"name":"sbxaaaaaaaaaaaa","released":true}'
check subnet-reused "$(ctl ensure $K3 | jq -r .subnet)" "10.90.0.0/29"
r=$(ctl show $K1 || true); check show-missing "$(echo "$r" | grep -c 'no network')" "1"
check show "$(ctl show $K2 | jq -r .ipv4)" "10.90.0.10"
echo "=== netctl-test: $passes passed, $fails failed"
if [ "$fails" = 0 ]; then echo "RESULT PASS"; else echo "RESULT FAIL"; exit 1; fi
