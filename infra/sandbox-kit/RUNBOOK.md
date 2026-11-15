# Sandbox kit runbook: Kata + Docker-in-Docker + Nomad + egress proxy on a Linux sandbox node

This kit validates handoff section 11 from the inside out, directly on one Linux machine: a dev
VM with nested virtualization (or bare metal), x86_64 or aarch64. The owned runtime will run on
that same machine and talk to Docker, Kata and Nomad there. It is a prototype rig, not
production.

```
Linux sandbox node (Ubuntu 24.04 or 26.04, x86_64 or aarch64, /dev/kvm usable)
├─ owned runtime (backend)  ── writes /run/sandbox-egress/policies/<key>.json
├─ Docker 29.8.2 + containerd 2.3.6; default runtime = kata (QEMU); runc only by name
├─ Nomad 2.0.7 dev agent: docker driver, allow_runtimes = ["kata"], privileged off, volumes off
├─ sandbox-egress (systemd, user sandbox-egress): mitmproxy 12.2.3 + addon, transparent :3130 (sandbox TCP 80/443 redirected) and DNS :5353
├─ nftables inet sandbox_egress: sbx* interfaces reach only the proxy; no forward; v6 dropped
└─ Kata microVM per conversation ("hands"), on its own sbx* network
   └─ inner dockerd (docker:29.8.2-dind); no proxy settings; egress transparent, node CA in the system store
```

The settled policy behind it:

- Every built-in Pi tool (bash, read, write, edit, grep, find, ls) runs in the sandbox.
- All sandbox egress goes through the proxy, which allowlists per conversation and injects
  tokens outside the guest.
- Allocation happens only after the policy check.
- Only Kata runs. Docker's default runtime is `kata`, and the backend refuses any job that does
  not name it.

The design is in `DESIGN-hands.md` and `DESIGN-egress.md`.

Every script prints `PASS <check>: <evidence>` / `FAIL ...` / `WARN ...` / `INFO ...` lines and
ends with `RESULT PASS` or `RESULT FAIL`. Steps 10-50 also save everything under
`~/sandbox-kit-evidence/`. Every step can be rerun; they are idempotent. Downloads:

- Kata: ~1.0 GB on amd64, ~650 MB on arm64;
- Docker packages: ~120 MB;
- dind image: ~120 MB;
- mitmproxy wheels: ~30 MB.

## 0. The VM

- **Nested virtualization on**, at the hypervisor or cloud level. On x86 the VM must show the
  `vmx` (Intel) or `svm` (AMD) CPU flag. On arm64 the kernel must start at EL2 (FEAT_NV2
  hosts).
- **Ubuntu 24.04** (noble) **or 26.04** (resolute). Other releases fail the preflight. Step 20
  installs the same pinned Docker versions from Docker's repo for that codename, and 45's proxy
  venv uses the system Python (3.12 or 3.14).
- **Size:** at least 6 vCPU and 12 GiB RAM (MemTotal), 8 vCPU and 16 GiB is comfortable. One
  sandbox is 4 vCPU / 8 GiB, and its Kata VM adds 2 GiB of base memory; the node keeps 2 GiB.
  A 16 GiB VM reports about 15.6 GiB MemTotal, which passes. At least 40 GiB free disk.
- **Your user** needs passwordless sudo while running steps 10-50 (`sudo -v` first is enough if
  your sudo caches credentials). The scripts never add anyone to the `docker` group (that is
  root-equivalent).
- **If a self-hosted Cursor cloud agent runs on this VM:**
  - its user must not be root;
  - it must not be in the `docker` or `sandbox-egress` groups;
  - it must not have passwordless sudo.

  Otherwise it is outside the sandbox boundary: it could edit allowlists, read tokens, or
  start runc containers.

## 1. Get the kit onto the VM

The branch `forge/sandbox-kit` is local (not pushed). Use the kit archive from the report
(`sandbox-kit-<commit>.tgz`, sha256 next to it):

```sh
sha256sum -c sandbox-kit-<commit>.tgz.sha256
mkdir -p ~/sandbox-kit && tar -C ~/sandbox-kit -xzf sandbox-kit-<commit>.tgz && cd ~/sandbox-kit
```

## 2. Preflight (read-only, ~5 s)

```sh
bash linux/00-preflight.sh
```

It installs, starts and writes nothing, and needs no root. With passwordless sudo it reads
`docker info` and runs the KVM probe through `sudo -n`. Expected on a good VM:

```
PASS arch: x86_64 (amd64 pins: Kata b828904fa3f1..., Nomad 4c9b8a0850d6...)
PASS distro: Ubuntu 24.04.x LTS (or 26.04.x)
PASS cpu-virt: vmx (Intel VT-x) exposed to this machine
INFO kvm-nested: kvm_intel nested=N ...   (fine: only matters for VMs inside a Kata guest)
PASS dev-kvm: crw-rw---- root:kvm
PASS kvm-probe: api=12 create_vm=ok create_vcpu=ok exit=0 - KVM acceleration is usable
PASS cgroup2 / cpus / memory / disk...
INFO docker / containerd / kata / nomad: not installed (pinned ...; installed by a later step)
RESULT PASS
```

**Stop on `RESULT FAIL`** and send the output. These end the attempt on this VM:

- `FAIL cpu-virt` or `FAIL dev-kvm`: nested virtualization is not exposed;
- `FAIL kvm-probe`: `/dev/kvm` exists but no vCPU can be created;
- `FAIL cgroup2`;
- too little RAM or disk.

## 3. Node steps, in order

```sh
sudo -v
for s in 10-kvm-check 20-install-docker-kata 30-kata-smoke 40-inner-docker 45-egress 50-nomad; do
  echo "######## $s ($(date '+%H:%M:%S'))"
  bash "linux/$s.sh" || { echo "step $s failed: send the evidence (section 4)"; break; }
done
```

Or run them one at a time (`bash linux/30-kata-smoke.sh`), which is easier to report on.
**Stop at the first `RESULT FAIL`**: every later step depends on the earlier ones.

| Step | Time     | What it proves                                                                                                                                                                                                                             | Key expected lines                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10   | ~10 s    | KVM usable on this node: vmx/svm (x86) or EL2 (arm64), KVM_CREATE_VM + VCPU                                                                                                                                                                | `PASS cpu-virt` or `PASS el2`, `PASS kvm-create-vcpu`, `PASS cgroup2`                                                                                                                                                                                                                                                                                                                                  |
| 20   | 3-10 min | Docker 29.8.2 + Kata 4.2.0 (per-arch, sha256-checked); `kata` is Docker's default runtime                                                                                                                                                  | `PASS kata-installed`, `PASS docker-runtime-kata`, `PASS docker-default-runtime`, `PASS default-is-vm` (no `--runtime` still boots a guest kernel)                                                                                                                                                                                                                                                     |
| 30   | 1-3 min  | A Kata container boots its own kernel under QEMU+KVM; no host devices leak                                                                                                                                                                 | `PASS guest-kernel` (6.18.35), `PASS hypervisor`, `PASS accel`, `PASS kvm-fd`, `PASS device-exposure`                                                                                                                                                                                                                                                                                                  |
| 40   | 4-10 min | Inner dockerd in Kata without the host socket: pull, build, volume, port, Compose, limits                                                                                                                                                  | `PASS no-host-socket`, `PASS separate-engine`, `PASS build`, `PASS compose`                                                                                                                                                                                                                                                                                                                            |
| 45   | 2-5 min  | Egress boundary: proxy as a systemd service, nftables, both egress suites on this kernel, a real Kata guest behind it; sandbox-netctl + its sudoers rule                                                                                   | `PASS proxy-service`, `PASS sudoers`, `PASS sudoers-effective`, `PASS node-ca`, `PASS proxy-test`, `PASS netns-test`, `PASS allowlisted-install`, `PASS mitm`, `PASS denied-host`, `PASS no-direct-route`, `PASS no-metadata-*`, `PASS dns-forced-*`, `PASS netctl-ensure`, `PASS netctl-release`                                                                                                      |
| 50   | 5-10 min | Nomad schedules the reviewed job (kata) on its own sandbox network; exec, restart, crash recovery; refuses runc, privileged, host socket; a no-runtime job still gets kata; a Nomad-launched sandbox is behind the egress proxy (needs 45) | `PASS sandbox-network`, `PASS template-network`, `PASS allocate`, `PASS create-only`, `PASS container-network`, `PASS exec-kata-kernel`, `PASS refuse-*`, `PASS no-runtime-gets-kata`, `PASS egress-registered`, `PASS egress-allowed-injected`, `PASS egress-denied-host`, `PASS egress-metadata-*`, `PASS egress-no-direct-route`, `PASS egress-dns-forced`, `PASS egress-ipv6`, `PASS egress-token` |

Knobs:

- `KATA_RUNTIME=kata-db bash linux/30-kata-smoke.sh`: **only if 30's first boot hangs** with
  QEMU under nested virt. It retries with Dragonball. That would be a finding, not a fix:
  Nomad stays `kata` (QEMU) only.
- `INNER_STORAGE=tmpfs` (40) forces tmpfs-backed inner Docker storage.
- `KEEP=1` (40 and 45) keeps the test sandbox running for inspection.
- `KEEP_NOMAD=1` (50) leaves Nomad running on `127.0.0.1:4646`.
- `EGRESS_BACKEND_USER=<user>` (45): the user that will run the backend and write policies
  (default: you). It is added to the `sandbox-egress` group; log in again for that to apply.

Failure modes worth reporting as-is:

- 10 `FAIL kvm-create-vcpu`;
- 30 first-boot timeout (the QEMU nested hang; try `kata-db`);
- 40 `FAIL dind-start` (cgroup remount refused);
- 45 `FAIL allowlisted-install` or `FAIL mitm` (the guest did not trust the node CA, or apk
  ignored the proxy env: send the evidence);
- 50 `refuse-*`;
- 50 `FAIL container-network` or `FAIL egress-*` (the Kata guest is not on its sandbox network,
  or the network does not force traffic through the proxy). `egress-allowed-injected` failing
  alone may mean the guest's openssl or `/local/egress-ca.pem`: send the evidence, including
  `50-nomad.harness.log`.

50 stops the production `sandbox-egress` service for its last section: the test proxy takes its
ports. The service is restarted on exit.

45 network use:

- PyPI, for the hash-locked mitmproxy wheels;
- `dl-cdn.alpinelinux.org`, reached by the test guest through the proxy. It is the test
  policy's only allowlisted host.

## 4. Send back

```sh
tar -C ~ -czf ~/sandbox-kit-evidence.tgz sandbox-kit-evidence
```

Send that archive and the terminal output of `linux/00-preflight.sh` (it saves nothing). The
archive holds logs, recorded configs, `docker info`, nft counters, the proxy audit tail, and
Nomad node/alloc JSON. It contains no credentials: the kit uses none, and the test token in
the egress suites is random, generated per run, and only its sha256 is ever printed.

## 5. Wiring the backend to it (after 45 and 50 pass)

```sh
SANDBOX_PROVIDER=nomad-kata NOMAD_ADDR=http://127.0.0.1:4646 \
EGRESS_POLICY_DIR=/run/sandbox-egress/policies EGRESS_RULES_FILE=/etc/sandbox-egress/rules.json \
EGRESS_CA_FILE=/var/lib/sandbox-egress/guest-ca.pem \
  <start the owned runtime as EGRESS_BACKEND_USER>
```

- **Hands jobs need both `EGRESS_POLICY_DIR` and `EGRESS_CA_FILE`.** Without them,
  NomadKataHands refuses every job ("no sandbox network / egress proxy configured").
- **Sandbox networks.** Each conversation's network is created through
  `sudo -n /opt/sandbox-egress/node/sandbox-netctl` (override the argv with
  `SANDBOX_NETCTL='["..."]'`, a JSON array). 45 installs `sandbox-netctl` and a sudoers
  rule `/etc/sudoers.d/sandbox-egress` that lets `EGRESS_BACKEND_USER` run only
  `sandbox-netctl ensure|release|show`. The backend needs no docker group and no root otherwise.
- **`rules.json`** maps owner to `EgressRule[]`:
  `{host, ports?, schemes?, methods?, inject?, websocket?, allowWhenTainted?}`.
- **Tokens** go only in `/etc/sandbox-egress/secrets/<name>.token` (root:sandbox-egress 0640)
  plus an entry in `/etc/sandbox-egress/secrets.json` (see `egress/secrets.example.json`).
  Then `sudo systemctl restart sandbox-egress`. They never go in a policy, the backend's env,
  or a guest. GitHub is not configured this way: the proxy mints per-repository tokens from the
  Linguini GitHub App (`egress/GITHUB.md`), and drops any GitHub credentials a guest sends.
- **Inside the guest**, the proxy env and the CA (`/local/egress-ca.pem`, with
  `SSL_CERT_FILE` and similar variables) are set for the task. The inner dockerd does not yet
  pull through the proxy (DESIGN-egress.md, gap 3).

## 6. Cleanup and rollback

- Egress:
  first `for n in $(sudo docker network ls -q --filter label=sandbox.egress.key); do sudo docker network rm "$n"; done`,
  then `sudo systemctl disable --now sandbox-egress sandbox-egress-net`, then
  `sudo rm -f /etc/sudoers.d/sandbox-egress; sudo rm -rf /opt/sandbox-egress /etc/sandbox-egress /var/lib/sandbox-egress /var/log/sandbox-egress /etc/systemd/system/sandbox-egress*.service /etc/tmpfiles.d/sandbox-egress.conf`,
  then `sudo userdel sandbox-egress`.
- Nomad: `sudo systemctl stop nomad-kit; sudo rm -f /usr/local/bin/nomad /etc/nomad.d/kit.hcl`.
- Kata as default runtime: remove `"default-runtime"` and the `kata*` runtimes from
  `/etc/docker/daemon.json`, then `sudo systemctl restart docker`. Then `sudo rm -rf /opt/kata`.
- Docker: `sudo apt-mark unhold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`,
  then `sudo apt-get purge` the same packages.
- Or simply discard the VM.

## What each piece is

| Path                                  | Role                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linux/00-preflight.sh`               | Linux node checks, read-only (arch, distro, vmx/svm/EL2, /dev/kvm + probe, nested flag, cgroup v2, CPU/RAM/disk, installed versions)                 |
| `linux/10..50-*.sh`                   | inside-out validation and install steps; `linux/lib.sh` is shared (arch detection, per-arch pins)                                                    |
| `linux/45-egress.sh`                  | egress proxy + nftables install, sandbox-netctl + sudoers, end-to-end test                                                                           |
| `versions.env`                        | every pin with its checksum or digest, per arch                                                                                                      |
| `egress/`                             | proxy addon, node nftables script, `node/sandbox-netctl` (per-conversation sandbox networks), hash-locked requirements, tests (see DESIGN-egress.md) |
| `inner/dind-entry.sh`, `inner/build/` | the sandbox's inner dockerd entrypoint and step 40's workload                                                                                        |
| `nomad/agent.hcl`                     | Nomad client policy (kata only, caps, no privileged, no volumes)                                                                                     |
| `nomad/hands.nomad.hcl`               | the reviewed hands job template; `hands.job.json` is its rendered JSON, which the runtime loads                                                      |
| `nomad/negative/`                     | jobs the agent must refuse or contain (step 50)                                                                                                      |
| `tests/`                              | off-node checks: `validate-static.sh` (shellcheck, both preflight stub tests, pins, Nomad validation)                                                |
| `host/`, `lima/`                      | the Mac path (appendix A)                                                                                                                            |
| `DESIGN-hands.md`, `DESIGN-egress.md` | how the runtime binds a conversation to a sandbox, and the egress boundary                                                                           |

## Appendix A: the Mac path (Lima, nested virtualization on M3+)

Kept for reference; the Linux VM above is the primary path. On a Mac, the same `linux/`
scripts run inside a Lima VM (Ubuntu 24.04 arm64, vz, `nestedVirtualization: true`), driven by
`host/kit.sh` (`host/kit.sh all` runs 10, 20, 30, 40, 45 and 50). Not re-validated on a Mac
after the Linux retarget.

### A0. Get the kit onto the Mac

From the repo, on the `forge/sandbox-kit` branch: `cd infra/sandbox-kit`. All commands below
run from that directory in a **native arm64** Terminal (not under Rosetta).

### A1. Preflight (read-only, ~5 s)

```sh
bash host/mac-preflight.sh
```

Expected on an M5 Max with 36 GB:

```
PASS macos-version: 26.x >= 15 (Lima VZ nested virtualization minimum)
PASS arch: arm64 (Apple silicon)
PASS chip: Apple M5 >= M3
PASS hypervisor: kern.hv_support=1
PASS memory-headroom: 36 GiB - 16 GiB VM leaves 20 GiB for macOS and apps
PASS disk: NNN GiB free ...
PASS homebrew / WARN homebrew      (either is fine)
PASS lima: limactl 2.2.1 / WARN lima: limactl not installed
RESULT PASS
```

It installs nothing. **Stop on `RESULT FAIL`** and send the output. The failures that end the
attempt on this Mac are macOS below 15, a chip older than M3, or no hypervisor support.

**Memory headroom (36 GB).** The VM takes a fixed 16 GiB while it runs, which leaves about
20 GiB for macOS and apps: comfortable, not lavish. Inside it, one Kata sandbox gets 8 GiB
(QEMU guest RAM is allocated lazily), and the inner tmpfs for Docker storage (4 GiB max)
counts against that sandbox's 8 GiB. Do not run two sandboxes at the default size. Close
large apps (other VMs, Docker Desktop, big IDE indexes) before step 3. `limactl stop`
releases the 16 GiB.

### A2. Install Lima 2.2.1 (~1 min; skip if preflight said `PASS lima`)

Either use Homebrew (any version >= 2.2.1 is accepted; the kit was validated against 2.2.1):

```sh
brew install lima && limactl --version
```

Or use the pinned release, no Homebrew and no sudo:

```sh
cd /tmp
curl -fLO https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz
echo "9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e  lima-2.2.1-Darwin-arm64.tar.gz" | shasum -a 256 -c
mkdir -p ~/.local/lima && tar -C ~/.local/lima -xzf lima-2.2.1-Darwin-arm64.tar.gz
export PATH="$HOME/.local/lima/bin:$PATH"     # add to ~/.zshrc to keep it
cd - && limactl --version                      # limactl version 2.2.1
```

Rerun `bash host/mac-preflight.sh`; it should now say `PASS lima`.

### A3. Create and start the VM (~3-8 min, mostly the image download)

```sh
host/kit.sh create
```

Lima downloads the pinned Ubuntu 24.04 image (it verifies the digest) and boots it with
`nestedVirtualization: true`. A readiness probe waits for `/dev/kvm`. Expect Lima to finish
with a READY message. `limactl list` then shows `kata-dind  Running ... vz  aarch64  6  16GiB  100GiB`.

If it fails with a nested-virtualization error, Lima/macOS refused nested virt. Send
`~/.lima/kata-dind/ha.stderr.log`.

### A4. Copy the kit into the VM (~5 s)

```sh
host/kit.sh push        # -> kit in /home/<you>.linux/sandbox-kit
```

Rerun it after any change to the kit; it replaces `~/sandbox-kit` in the VM completely.

### A5. Steps inside the VM, in order

`host/kit.sh all` runs 10 through 50 (including 45) and stops at the first failure. Running them one at a
time (`host/kit.sh run NN`) is easier to report on. **Stop at the first `RESULT FAIL`**, fetch
the evidence (step 6) and send it: every later step depends on the earlier ones.

| Step | Command              | Time     | What it proves                                                                                                         | Key expected lines                                                                                                                                                    |
| ---- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10   | `host/kit.sh run 10` | ~10 s    | Nested KVM is usable inside Lima                                                                                       | `PASS kvm-create-vm`, `PASS kvm-create-vcpu`, `PASS el2` (dmesg: CPUs started at EL2), `PASS dev-vhost-vsock`                                                         |
| 20   | `host/kit.sh run 20` | 3-8 min  | Docker 29.8.2 + Kata 4.2.0 installed and checksummed; `kata` registered and made the default runtime                   | `PASS docker-version: 29.8.2`, `PASS kata-installed` (a checksum mismatch stops with `FAIL kata-sha256`), `PASS docker-runtime-kata`                                  |
| 30   | `host/kit.sh run 30` | 1-3 min  | A Kata container boots a separate kernel under QEMU+KVM, no host devices leak                                          | `PASS guest-kernel` (6.18.35, not Lima's), `PASS hypervisor`, `PASS accel` (accel=kvm), `PASS kvm-fd`, `PASS device-exposure`, `PASS not-privileged`, start latencies |
| 40   | `host/kit.sh run 40` | 4-10 min | Inner dockerd in Kata without the host socket: pull, build, volume, port, Compose, limits, cleanup                     | `PASS no-host-socket`, `PASS separate-engine`, `PASS build`, `PASS compose`, `PASS inner-memory-limit: true 137`                                                      |
| 45   | `host/kit.sh run 45` | 2-5 min  | Egress proxy + nftables; a Kata guest can only reach allowlisted hosts through the MITM proxy                          | `PASS proxy-test`, `PASS netns-test`, `PASS mitm`, `PASS denied-host`, `PASS no-direct-route`                                                                         |
| 50   | `host/kit.sh run 50` | 4-8 min  | Nomad schedules the reviewed job with runtime kata; exec/restart/crash recovery; refuses runc, privileged, host socket | `PASS allocate`, `PASS create-only`, `PASS exec-kata-kernel`, `PASS restart`, `PASS reconcile-crash`, `PASS refuse-*`                                                 |

Knobs (environment variables on the Mac; `host/kit.sh` passes them into the VM):

- `KATA_RUNTIME=kata-db host/kit.sh run 30`: **only if step 30's first boot hangs or fails**
  with the default QEMU runtime. It retries with Kata's built-in Dragonball VMM. Field reports
  show QEMU hanging under nested virt on M3+ with Kata 3.x. The kit's QEMU result on Kata
  4.2.0 is unknown until this runs. A Dragonball pass is a finding, not a fix: Nomad stays
  `kata` (QEMU) only.
- `INNER_STORAGE=tmpfs host/kit.sh run 40` forces tmpfs-backed inner Docker storage. The
  default, `auto`, probes the image's own `/var/lib/docker` first.
- `KEEP=1` (40) keeps the inner sandbox running for poking at.
- `KEEP_NOMAD=1` (50) leaves Nomad running. Its UI is then at http://127.0.0.1:4646 on the Mac.

Expected failure modes worth reporting as-is (do not work around them):

- 10: `FAIL kvm-create-vcpu`. Nested virt is not actually working in the guest.
- 30: first boot times out (`KATA_BOOT_TIMEOUT`, default 300 s). This is the QEMU nested hang;
  try `KATA_RUNTIME=kata-db`.
- 40: `FAIL dind-start` with `kit: /sys/fs/cgroup is not writable`. The cgroup remount inside the Kata guest was refused.
- 50: `refuse-*` fails. The Nomad agent policy did not reject a job it should have.

### A6. Send back

```sh
host/kit.sh fetch      # -> ./sandbox-kit-evidence-YYYYMMDD-HHMMSS.tgz
```

Send that archive plus:

- the terminal output of `host/mac-preflight.sh` (it is not in the archive, because it runs on the
  Mac);
- the output of `sw_vers; sysctl -n machdep.cpu.brand_string; limactl --version`;
- for any failure, which step and whether you used a knob.

The archive holds logs, the recorded Docker/Kata/Nomad configs, `docker info`, and Nomad
node/alloc JSON. It contains no credentials: the kit uses none, and the Nomad dev agent runs
without ACLs on loopback.

### A7. Cleanup and rollback

- `limactl stop kata-dind` (~10 s) frees the 16 GiB of RAM and keeps the VM for later.
- `host/kit.sh delete` (or `limactl delete kata-dind`) removes the VM and everything in it:
  Docker, Kata, Nomad, images, evidence. Fetch the evidence first.
- Lima itself: `brew uninstall lima`, or `rm -rf ~/.local/lima` for the tarball install.
  `rm -rf ~/.lima` removes Lima's download cache and any other instances. Check
  `limactl list` first.
- Nothing else on the Mac was changed: no launch agents, no sudo, no network settings.
