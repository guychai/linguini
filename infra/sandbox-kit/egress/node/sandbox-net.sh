#!/usr/bin/env bash
# Node-side egress enforcement for sandboxes (runs on the host, outside every guest; root).
#
# Every sandbox has its own interface whose name starts with "sbx" (a routed veth, or a
# per-sandbox Docker bridge). nftables then guarantees, independent of anything in the guest:
#   - packets from a sandbox interface may only reach the egress proxy and its DNS port on the
#     host; nothing is forwarded (no route to the internet, the metadata service, the LAN or
#     other sandboxes);
#   - TCP 80/443 to any destination is redirected to the proxy's transparent listener, so the
#     guest needs no proxy settings (only trust in the node CA);
#   - anything else a sandbox sends out (other TCP ports, UDP incl. QUIC on 443) is rejected
#     at once (TCP reset / ICMP admin-prohibited) instead of silently dropped, so tools fail fast;
#   - any DNS (udp/tcp 53, any destination) is redirected to the proxy's DNS listener;
#   - IPv6 from sandbox interfaces is dropped;
#   - a sandbox can only use the source IP bound to its interface, so it cannot claim another
#     sandbox's identity (the proxy maps source IP -> conversation).
#
# Usage (root):
#   sandbox-net.sh init                       TPROXY_PORT=3130 DNS_PORT=5353 by default
#   sandbox-net.sh add IFACE IP KEY           bind IP to IFACE and map IP -> conversation KEY
#   sandbox-net.sh del IFACE IP
#   sandbox-net.sh status                     ruleset with counters
#   sandbox-net.sh down                       remove the table and mappings
# STATE_DIR (default /run/sandbox-egress) holds sources/<ip> for the proxy.
set -euo pipefail
TABLE=sandbox_egress
DNS_PORT="${DNS_PORT:-5353}"
TPROXY_PORT="${TPROXY_PORT:-3130}"
STATE_DIR="${STATE_DIR:-/run/sandbox-egress}"
valid_if() { [[ "$1" =~ ^sbx[a-z0-9]{1,12}$ ]] || { echo "interface must match sbx[a-z0-9]{1,12}: $1" >&2; exit 2; }; }
valid_ip() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "IPv4 address expected: $1" >&2; exit 2; }; }
valid_key() { [[ "$1" =~ ^[a-z0-9]{12,40}$ ]] || { echo "conversation key must match ^[a-z0-9]{12,40}$" >&2; exit 2; }; }

case "${1:-}" in
  init)
    [[ "$DNS_PORT" =~ ^[0-9]+$ && "$TPROXY_PORT" =~ ^[0-9]+$ ]] || { echo "ports must be numeric" >&2; exit 2; }
    install -d -m 0755 "$STATE_DIR/sources"
    nft delete table inet "$TABLE" 2>/dev/null || true
    nft -f - <<NFT
table inet $TABLE {
  # (sandbox interface, its one allowed source IP)
  set bind {
    type ifname . ipv4_addr
  }
  chain early {
    # Before conntrack/NAT: identity and protocol checks on everything a sandbox sends.
    type filter hook prerouting priority -300; policy accept;
    iifname "sbx*" meta nfproto ipv6 counter drop comment "no IPv6 from sandboxes"
    iifname "sbx*" meta protocol ip iifname . ip saddr != @bind counter drop comment "anti-spoofing"
  }
  chain dns {
    type nat hook prerouting priority -100; policy accept;
    iifname "sbx*" udp dport 53 counter redirect to :$DNS_PORT comment "all DNS goes to the proxy"
    iifname "sbx*" tcp dport 53 counter redirect to :$DNS_PORT
    iifname "sbx*" tcp dport { 80, 443 } counter redirect to :$TPROXY_PORT comment "web traffic goes to the transparent proxy"
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "sbx*" ct state established,related accept
    iifname "sbx*" tcp dport $TPROXY_PORT accept comment "egress proxy (transparent)"
    iifname "sbx*" meta l4proto { udp, tcp } th dport $DNS_PORT accept comment "proxy DNS"
    iifname "sbx*" meta l4proto tcp counter reject with tcp reset comment "nothing else on the host"
    iifname "sbx*" counter reject with icmpx admin-prohibited
    iifname != { "lo", "sbx*" } tcp dport $TPROXY_PORT counter drop comment "proxy only for sandboxes"
    iifname != { "lo", "sbx*" } meta l4proto { udp, tcp } th dport $DNS_PORT counter drop
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "sbx*" meta l4proto tcp counter reject with tcp reset comment "no route out: internet, metadata, LAN, other sandboxes"
    iifname "sbx*" counter reject with icmpx admin-prohibited comment "UDP (incl. QUIC) and the rest: fail fast"
    oifname "sbx*" counter drop comment "nothing routed into a sandbox"
  }
}
NFT
    echo "sandbox egress table installed (transparent proxy :$TPROXY_PORT, dns :$DNS_PORT)"
    ;;
  add)
    valid_if "$2"; valid_ip "$3"; valid_key "$4"
    nft add element inet "$TABLE" bind "{ \"$2\" . $3 }"
    install -d -m 0755 "$STATE_DIR/sources"
    printf '%s' "$4" > "$STATE_DIR/sources/$3.tmp" && chmod 0644 "$STATE_DIR/sources/$3.tmp" && mv "$STATE_DIR/sources/$3.tmp" "$STATE_DIR/sources/$3"
    ;;
  del)
    valid_if "$2"; valid_ip "$3"
    nft delete element inet "$TABLE" bind "{ \"$2\" . $3 }" 2>/dev/null || true
    rm -f "$STATE_DIR/sources/$3"
    ;;
  status) nft list table inet "$TABLE" ;;
  down)
    nft delete table inet "$TABLE" 2>/dev/null || true
    rm -rf "$STATE_DIR/sources"
    ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
