# Sandbox egress: a forced proxy with per-conversation allowlists and token injection

Settled policy (2026-10-11):

- Every built-in Pi tool runs in the conversation's Kata sandbox.
- All sandbox network traffic goes through one egress proxy on the node.
- The proxy allows only hosts approved for that conversation, and injects credentials itself
  when a host needs them.

Sandbox `bash` is therefore sandbox work (no production data or credentials inside the
guest), and the proxy is the egress boundary. This document covers the design, the prototype
in `egress/`, what has been proven where, and what is left.

## Threat model

Assume the code in the guest is hostile: prompt-injected, or deliberately exfiltrating. It is
root inside its Kata VM and can rewrite the guest's routes, DNS, trust store and proxy env. So
nothing in the guest is enforcement. Everything below lives on the node, outside the VM:

| Goal                             | Mechanism (node side)                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No path around the proxy         | nftables: packets from `sbx*` interfaces may reach only the proxy and DNS ports on the node; `forward` drops everything from and to `sbx*` (no route to the internet, LAN, other sandboxes or metadata) |
| No DNS channel                   | any udp/tcp 53 from `sbx*` is redirected to the proxy's DNS listener, which answers only allowlisted names and forwards nothing                                                                         |
| No metadata                      | `169.254.0.0/16`, `100.100.100.200`, `fe80::/10`, `fd00:ec2::/32` never reachable: dropped by routing, and always refused by the proxy even for an allowlisted name that resolves there                 |
| IPv6                             | dropped from `sbx*` (the prototype is IPv4-only inside sandboxes); the proxy still filters v6 answers, and maps `::ffff:a.b.c.d` to IPv4 before checking                                                |
| Sandbox identity can't be forged | source IP to conversation key, bound to the sandbox's own interface (`ifname . ipv4_addr` set); spoofed sources are dropped before routing                                                              |
| Allowlist not guest-settable     | the backend writes `policies/<key>.json` on the node (`FileEgressPolicyWriter`); the guest has no path to it                                                                                            |
| Secrets never in the guest       | values live in `/etc/sandbox-egress/secrets/` (root:sandbox-egress 0640); the proxy adds the header on the way out; the guest's own value for that header is dropped                                    |
| Audit without leaks              | JSONL per decision: source, conversation, host, port, method, path without query, status, sizes, redirect target without query, injected secret _name_; never headers, bodies, queries or values        |

## Candidates

| Candidate              | Maturity                                                                                                              | Fit                                                                                                                                                                                 | Verdict                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **mitmproxy 12 addon** | 10+ years; active; native explicit and transparent proxy, CONNECT, on-the-fly cert minting, HTTP/1-2, websockets, DNS mode, TCP hooks | Policy is about 350 lines of Python hooks; `connection_strategy=lazy` lets policy run before any upstream connect; easy to test                                                     | **Chosen** for the prototype and a single dev node |
| Envoy                  | Very mature, fast, xDS                                                                                                | No on-the-fly leaf minting for arbitrary SNI without an external SDS/cert service; per-conversation allowlists need RBAC filters or a control plane; injection via Lua or ext_authz | Strong for production scale, heavy for this stage  |
| Squid ssl-bump         | Mature                                                                                                                | ssl-bump + `request_header_add` work, but per-source dynamic allowlists and per-host secrets mean external ACL helpers and reconfigures; websockets after bump are awkward          | Workable, clunky                                   |
| Small Go/TS proxy      | n/a                                                                                                                   | Full control, but we would own TLS interception correctness (cert minting, ALPN, HTTP/2, websockets)                                                                                | Not worth it yet                                   |

mitmproxy runs at a pinned 12.2.3, from a fully hash-locked `requirements.lock`
(`uv pip compile --universal --generate-hashes`), installed with `--require-hashes`. Upstream
TLS is verified against the node's system CAs (mitmproxy's default). If the node later
outgrows Python, the policy model (`EgressPolicy` JSON, the source map, the secrets file)
moves unchanged to Envoy with an ext_authz service.

## Architecture

```
Kata guest (conversation K, IP 10.89.x.2)          node (outside every guest)
  no proxy settings ─────────────── sbx<key12> ──► nftables inet sandbox_egress
  node CA in system trust store                       early:  drop IPv6, drop spoofed src
  any :53 ─────────────────────────────────────────► dns:    redirect to :5353
  any TCP 80/443 ──────────────────────────────────► dns:    redirect to :3130 (transparent)
  anything else ───────────────────────────────────► input/forward: reject (TCP reset / ICMP)
                                                     mitmproxy (user sandbox-egress)
                                                       :3130 transparent proxy, :5353 DNS
                                                       sources/<ip> -> K (sandbox-net.sh add)
                                                       policies/K.json (written by the backend)
                                                       secrets.json + value files
                                                       audit.jsonl
```

Flow for one HTTPS request:

1. `CONNECT host:port` is decided: source to key, key to policy, host to rule.
   - Rules are exact host or `*.domain` (subdomains only), ports (default 443) and schemes
     (default https), plus `methods`, `websocket` and `allowWhenTainted`.
   - A raw IP never matches a rule.
   - Denied means 403, audited.
2. TLS from the guest is terminated with a leaf for `host`, signed by the node CA. The
   ClientHello SNI must equal the CONNECT host.
3. Each request inside the tunnel is checked again:
   - the Host header must equal the CONNECT host (no domain fronting);
   - the method must be allowed;
   - a websocket upgrade needs `websocket: true`.
4. Injection only happens when the rule names a secret, the secret's own `hosts` list
   includes the host (a policy cannot send a token elsewhere), and the scheme is https. The
   value is read from its file at use and never stored on the flow audit.
5. Upstream connect: the name is resolved and every address is checked against the
   always-blocked ranges and the private ranges (blocked unless the node allows them). The
   first allowed address is pinned. If none is allowed, the connection errors (502) and the
   attempt is audited (`blocked-address`). This also stops DNS rebinding to metadata or the
   LAN. Upstream SNI is forced to the allowed name.
6. Redirects are passed back to the client, never followed by the proxy. The next hop is a
   new request through the same policy. The audit records the redirect target without its
   query.
7. Non-HTTP inside a tunnel (raw TCP, SSH over 443, etc.) is detected (`tcp_start`) and
   killed before any upstream connect. Plain `http://` is allowed only for rules that list
   the `http` scheme, and is never injected.

**Taint.** The backend writes `tainted: true` into the policy once the conversation has seen
production data. From then on the proxy allows only `allowWhenTainted` rules. The broker relaxes
`egress: "proxied"` tools after taint only when the provider has this boundary
(`egressBoundary: "proxy"`, i.e. `HandsSandbox` built with an `EgressPolicyWriter`).

**CA.** There is one CA per node, in the proxy's confdir (0700, owned by the proxy user). Guests
get only the certificate (`/var/lib/sandbox-egress/guest-ca.pem`), installed into their trust
store at sandbox start. A per-sandbox CA would limit what a leaked node CA key could do. It
needs one proxy instance (confdir) per sandbox, or Envoy with SDS; that is deferred, see gaps.

## Prototype (`egress/`)

| File                                          | What                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addon/sandbox_egress.py`                     | the policy addon (hooks above)                                                                                                                    |
| `run-proxy.sh`                                | `mitmdump` with the addon, transparent proxy plus DNS mode (explicit mode for tests only), lazy connect, no flow bodies on disk                                                     |
| `node/sandbox-net.sh`                         | `init` / `add IFACE IP KEY` / `del` / `status` / `down` for the nftables table and the source map                                                 |
| `config.example.json`, `secrets.example.json` | node config and the secret format `{name: {header, format, value_file, hosts}}`                                                                   |
| `addon/github_app.py`, `GITHUB.md`, `github-app-manifest.json`, `github-app-create.py` | GitHub: repo-scoped App tokens minted by the proxy, push refused; App manifest and setup |
| `requirements.in`, `requirements.lock`        | mitmproxy 12.2.3, hash-locked                                                                                                                     |
| `tests/harness.py`                            | test CA plus upstream (HTTPS echo returning `sha256(Authorization)`, never the value; redirect; websocket; raw TCP), policies, DNS and TCP probes |
| `tests/proxy-test.sh`                         | 35 checks over loopback, no root                                                                                                                  |
| `tests/netns-test.sh`                         | 23 checks with real network namespaces and nftables (root)                                                                                        |
| `tests/netctl-test.sh`                        | 17 checks of `node/sandbox-netctl` with a fake Docker CLI and real nftables in a namespace (root)                                                 |
| `../linux/45-egress.sh`                       | VM install (systemd, dedicated user) plus both suites plus a real Kata guest end to end                                                           |

Backend side (`prototypes/runtime/src/hands.ts`): `EgressRule`, `EgressPolicy`,
`EgressPolicyWriter`, `FileEgressPolicyWriter` (atomic, 0640). `own-main.ts` wires it with
`EGRESS_POLICY_DIR` and `EGRESS_RULES_FILE` (per-owner rules from a trusted file).

### Evidence (box, 2026-10-11 ET)

**`proxy-test.sh`: 35/35 PASS.** Covered:

- injection;
- guest header replaced;
- no injection without a rule;
- a secret stays bound to its own hosts;
- denied host;
- raw IPs (loopback and public);
- metadata: raw, by name, over plain http;
- an allowlisted name that resolves to a private address;
- plain http, wrong port, Host-header fronting, `--connect-to` fronting (SNI mismatch);
- method not allowed;
- redirect to a denied host blocked, no credential carried over a redirect;
- websocket with opt-in works, without opt-in refused;
- raw TCP in a tunnel killed;
- DNS: allowed name answered, denied name refused, metadata answer filtered;
- taint narrowing;
- unknown source;
- v4-mapped metadata;
- the audit contains no token, bearer, query or body.

**`netns-test.sh`: 23/23 PASS**, with a node namespace running the real proxy plus nftables and
two guest namespaces running as `nobody`. Covered:

- per-conversation allowlists: A gets api.test with injection; B is denied api.test but
  allowed cdn.test;
- denied host and metadata through the proxy;
- direct internet, metadata, the other sandbox and a node service unreachable, with the
  forward drop counters going up;
- DNS to any server address answered only for allowlisted names, and per conversation;
- other UDP dropped;
- the node's IPv6 link-local unreachable (v6 drop counter);
- B's source IP spoofed from A dropped (anti-spoofing counter);
- token file unreadable;
- token absent from env, responses and audit.

**Not provable on the box** (BLOCKED, needs the VM): a real Kata guest behind the boundary.
The box is a container whose `KVM_CREATE_VCPU` segfaults. `linux/45-egress.sh` part 3
covers it:

- the node CA as issuer in the guest;
- `apk add curl` from the allowlisted CDN through the MITM;
- example.com 403;
- no direct route, no metadata;
- DNS forced to the proxy;
- no secrets in the guest env.

It also reruns both suites on the VM kernel, and runs the proxy under systemd as a dedicated
user.

## Nomad-launched sandboxes

Every hands job runs on its conversation's own network, which goes through the same nftables
boundary as 45's container.

**Options considered (Nomad 2.0.7 docker driver, read at the v2.0.7 source):**

| Option                                          | Mechanism                                                                                                                                                                                                                                                                                                             | Verdict                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Group `network { mode = "bridge" }`             | Nomad's shared `nomad` bridge plus CNI plugins and Nomad-managed iptables. The task joins `container:<pause>`, and the pause container (`nomad_init_<alloc>`, infra_image) is created without a runtime, so the network namespace belongs to a runc container while the task is Kata. All sandboxes share one bridge. | Rejected: shared L2, a runc pause container, extra CNI plugins and iptables, and per-sandbox interface binding is impossible.            |
| Group `network { mode = "cni/<name>" }`         | Custom CNI config per network, still via the pause container.                                                                                                                                                                                                                                                         | Rejected: the same pause-container issue, plus a CNI config per conversation and Nomad agent reloads.                                    |
| **Task `network_mode = "sbx<key12>"`** (chosen) | A user-defined Docker bridge created before the job. Docker attaches the Kata container directly (`ipv4_address`, `dns_servers` supported). No pause container, no CNI, no Nomad iptables.                                                                                                                            | Chosen: one interface per sandbox (which the source-IP binding needs), the mechanism 45 proves with Kata, and no extra Nomad privileges. |

The docker driver has no allowlist for `network_mode`, so the backend enforces it.

**Sequence (`NomadKataHands`, before every submit):**

1. `sandbox-netctl ensure <key>`, run as `sudo -n` through a sudoers rule that allows only
   `ensure|release|show`. The backend is not in the docker group and cannot touch nft.
   netctl validates the key, then under a lock:
   - creates `sbx<key12>`: a /29 from 10.90.0.0/16, masquerade off, ICC off, labelled with
     the key;
   - binds it (`sandbox-net.sh add`);
   - prints `{name, subnet, gateway, ipv4}`.

   It is idempotent and refuses a network labelled for another key.

2. The broker validates the answer: the name must be `sbx` + the key's first 12 characters, a
   10.x address and gateway in the same /24, and not equal to each other.
3. The conversation's allowlist is written for the proxy (`FileEgressPolicyWriter`), with
   `tainted` taken from the conversation.
4. The job is rendered:
   - `network_mode` and `ipv4_address` set as above, `dns_servers = [gateway]`;
   - no proxy env (egress is transparent; the runtime rejects templates that set any);
   - the node CA as a Nomad `template` into `local/egress-ca.pem`, since host volumes stay
     disabled; the entry script installs it into the system trust store at start;
   - CA trust env only, the set Vercel Sandbox documents
     (https://vercel.com/docs/sandbox/concepts#proxy-ca-certificates), all pointing at the
     system bundle `/etc/ssl/certs/ca-certificates.crt`, plus `NODE_USE_SYSTEM_CA=1`.
5. `assertKataJob(job, network)` refuses the job unless:
   - no group network is set;
   - `network_mode` is that exact network;
   - `ipv4_address` and `dns_servers` match it.

   `NomadHttpApi.registerNew` refuses (without a network argument) anything not on an `sbx*`
   network with a 10.x address.

If step 1 or 3 fails, nothing is submitted: the error is 503 `hands_egress_unavailable` and the
generation stays `requested`, so it can be retried. A job that fails the check is
`hands_job_refused`. Without a configured network and proxy, NomadKataHands refuses every job.
`stop` purges the job, then releases the network (best effort).

**Template validation:** `hands.nomad.hcl` validates its variables in Nomad itself:

- `sandbox_network` must match `^sbx[a-z0-9]{1,12}$`;
- the address and gateway must be 10.x;
- the CA must be exactly one PEM certificate, so it cannot smuggle in template directives.

**Proof on the node:** 50-nomad.sh's last section runs the hands job through this exact path
against the test proxy and checks:

- an allowed host works, TLS-verified against the template CA, with the upstream seeing the
  injected header (sha256 only);
- a denied host is refused with 403;
- an allowlisted name resolving to the metadata address is refused;
- metadata is refused through the proxy (403) and directly (no route);
- there is no direct route, and DNS to 8.8.8.8 is forced;
- there is no IPv6;
- the token file is absent in the guest, and its value is not in the env, `/local`, `/secrets`
  or any response.

## GitHub

GitHub is special-cased in the addon (`egress/addon/github_app.py`, details and setup in
`egress/GITHUB.md`):

- the guest's `Authorization`/`Cookie` headers never reach a GitHub host;
- git push (`git-receive-pack`, including its `info/refs` discovery) is always refused with
  403 `git-push-not-enabled`;
- for owners the backend enables (policy field `github: {app: true}`, from
  `GITHUB_APP_OWNERS`), reads of one repository (smart-HTTP upload-pack,
  `api.github.com/repos/<o>/<r>/…` GET, raw.githubusercontent.com) get an installation token the
  proxy mints for exactly that repository (`repositories: [repo]`, contents/metadata read) with
  the node's GitHub App key, cached per repository until shortly before it expires;
- download tokens GitHub embeds in API responses (`?token=`) are redacted; archive endpoints are
  never credentialed;
- anything else stays anonymous, so public repositories work without the App, and a private
  repository the App cannot read fails with a `text/plain` explanation git prints as `remote:`.

`tests/github-test.sh` proves it end to end against a mock GitHub (real git, real proxy).

## Gaps and next steps

1. **Nomad template integration: closed.** See "Nomad-launched sandboxes" above.
   Open sub-items:
   - Docker's embedded DNS (127.0.0.11) probably does not answer inside a Kata guest on a
     user-defined network. The job sets `dns_servers = [gateway]`, and nftables DNATs any port
     53 query to the proxy DNS. Traffic through the proxy needs no guest DNS. Needs-VM.
   - Two conversation keys sharing their first 12 characters would map to the same network
     name. `sandbox-netctl` refuses to share (the second conversation fails closed). Keys are
     20 hex characters of a sha256, so this is rare.
   - Release on stop is best effort: Docker refuses to remove a network while the purged
     container is still stopping. A leftover stays bound to its own conversation only and is
     reused by the next generation. A periodic sweep of networks without allocations is a
     follow-up.
2. **Transparent interception** is the only path: TCP 80/443 is redirected into mitmproxy's
   transparent mode and decided by SNI (and Host for :80); the destination address must be one
   the proxy's DNS gave that sandbox for the name. The explicit proxy (:3128) was removed.
3. **Inner Docker pulls.** The inner dockerd needs the proxy env and the node CA (system trust
   or `/etc/docker/certs.d`), plus allowlist rules for `registry-1.docker.io`,
   `auth.docker.io` and `production.cloudflare.docker.com`. This is not tested yet.
4. **Upstreams that echo credentials.** An allowlisted API that reflects the `Authorization`
   header back would hand the token to the guest. Inject only for trusted APIs. A response
   scrubber for the injected value is a possible addition.
5. **Wildcard rules and DNS.** For `*.domain` rules the proxy resolves any subdomain, so the
   query labels reach that zone's authoritative servers: a low-bandwidth exfil channel to that
   zone. Prefer exact hosts. HTTP to an allowed host is, of course, also a channel to that
   host.
6. **Per-node CA.** A compromise of the node CA key allows MITM of every sandbox on that node.
   That node already sees all the plaintext, so it is not a new trust boundary, but rotate the
   CA and keep it off backups. A per-sandbox CA, or name constraints, is the hardening step.
7. **`init` resets bindings.** Re-running `sandbox-net.sh init` (e.g. at boot) recreates the
   table empty, so existing sandboxes fail closed until the backend re-adds them.
   Reconciliation should re-add the bindings of live allocations.
8. **Scale.** The prototype has one mitmproxy process per node, and the policy is re-read per
   decision (small JSON files, kept simple on purpose). Measure on the VM before relying on it
   for heavy traffic.
