# Hands: binding a conversation to a Kata sandbox (handoff section 10)

Status: **design + stub**. `prototypes/runtime/src/hands.ts` implements `HandsProvider` /
`NomadKataHands`. It is unit-tested against a deterministic fake of Nomad's HTTP API, whose
status codes and error strings were taken from a real Nomad 2.0.7 dev agent. It has **not**
run against a real Nomad with Kata; that is step 50 of the RUNBOOK on the Linux sandbox node. The
deterministic fixture stays the default provider. This one is opt-in with
`SANDBOX_PROVIDER=nomad-kata` (and `NOMAD_ADDR`).

## Inputs and identity

The broker, never the agent, supplies everything (handoff section 10):

| Input                              | Where it comes from                                          | Used for                                                                                             |
| ---------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| principal, conversation            | authenticated owner + conversation row                       | `conversation_key = sha256(owner \0 conversation)[:20]`: opaque, so user text never reaches a job ID |
| generation                         | `hands.generation` in the row                                | job ID `hands-<key>-g<generation>`; replacing compute increments it                                  |
| execution ID                       | the tool ledger (`executionId(owner, conversation, callId)`) | passed with every exec; the hands side must not apply one ID twice                                   |
| epoch                              | the lease epoch on the ledger intent                         | passed with every exec; a mismatch with the caller's fence is refused                                |
| capability, deadline, output limit | broker policy                                                | exec deadline (default 120 s) and output cap (256 KiB)                                               |

Image, runtime, capabilities, limits and mounts are **not inputs**. They come from the
reviewed template `nomad/hands.nomad.hcl`, rendered to `nomad/hands.job.json` by
`nomad job run -output`. `tests/validate-static.sh` fails if the two drift. The runtime loads
the JSON once and refuses it unless:

- the runtime is `kata`;
- privileged is unset;
- there are no volumes, host network, PID or IPC namespaces;
- every mount is tmpfs;
- the image is pinned by digest;
- CPU and memory limits are set.

Per conversation it replaces only `ID`, `Name` and identity `Meta`.

## State machine (persisted in the conversation row, `Conversation.hands`)

```
           ensure (row lock)          register create-only           running alloc
(none) ──────────────────▶ requested ─────────────────▶ allocating ─────────────▶ ready
                              │  4xx                       │ placement failed /       │
                              ▼                            │ task failed / timeout    │ job vanished
                            failed ◀───────────────────────┴──────────────────────────┘ (reconcile)
 stop: any ──▶ stopping ──purge──▶ stopped ──ensure──▶ requested (generation + 1, same workspaceId)
```

Every transition is a `store.mutate` under the row lock. Each one:

- is fenced with the caller's lease;
- moves only its own generation forward from an expected state;
- is a no-op if nothing changes, so racers that observe the same running allocation write one
  `ready`;
- appends a `hands.state` journal event.

## Idempotency and races

- **Lazy.** No Nomad traffic until the first tool call that needs hands. The broker calls
  `allocate` only when `conversation.sandbox` is null.
- **One binding.** The first caller writes `requested`; any concurrent caller, in this process
  or another worker on the same database, sees an active binding and joins it.
- **One job.** Registration is `POST /v1/jobs` with `EnforceIndex: true, JobModifyIndex: 0`.
  Nomad creates the job only if it does not exist. The duplicate answer, HTTP 500
  `Enforcing job modify index 0: job already exists`, counts as success. Verified against a
  real Nomad 2.0.7 agent on the box.
- **Restart.** A worker that dies mid-allocation leaves `requested` or `allocating`. Then
  `reconcile` (or the next `ensure`) observes the job:
  - a running allocation makes the binding `ready` with that alloc ID;
  - no job while still `requested` triggers a create-only registration;
  - no job after `allocating`/`ready` is `failed`. A job vanishing is an incident, never a
    silent re-create;
  - an allocation Nomad replaced (node lost) is followed to the new alloc ID.
- **Failure is real.** These all persist `failed` and purge the job:
  - a placement failure (evaluation with `FailedTGAllocs`, i.e. blocked);
  - a failed or lost allocation (with Nomad's task event, e.g. `Driver Failure: ...`);
  - no running allocation within the deadline (300 s).

  They surface as `503 hands_allocation_failed`. A failed generation is not retried
  automatically, and **there is no host fallback**: no code path runs a tool locally.
  Recovery is explicit: `stop` and then `ensure` again starts generation + 1.

## Workspace lifetime vs compute lifetime

`workspaceId = ws-<key>` is fixed for the (principal, conversation) pair and carried in the job
meta. Compute (the Kata VM + inner dockerd) is per generation. Restarts, crash recovery and
`stop`/`ensure` change compute, never the workspace identity.

**Gap: durable workspace storage is not built.** The kit's Nomad agent disables volumes
(`volumes.enabled = false`), which stops jobs from binding host paths such as the Docker
socket. So today `/workspace` and inner Docker state live inside the allocation, in the VM's
rootfs or tmpfs. They survive `nomad alloc restart` only as far as step 50 shows (it records
the outcome as INFO) and are lost on `stop`. The options to evaluate next are below. All are
unverified, and each must keep the Docker socket and host paths unreachable:

1. Nomad dynamic host volumes, one per workspace ID, created by the broker.
2. A CSI volume per workspace.
3. Snapshot or sync to object storage at stop, and restore at ensure.

## Exec transport

`NomadKataHands.exec` checks that:

- the fence and epoch are current;
- the binding is `ready` and has an alloc;
- the caller's generation is current.

It then calls an injected `HandsTransport`. **No transport is implemented**. Without one, exec
returns `501 hands_exec_unavailable`; it never falls back. The intended transport is Nomad's
alloc exec (`/v1/client/allocation/:id/exec`, a websocket), as exercised by
`nomad alloc exec` in step 50. A thin agent inside the sandbox that enforces execution-ID
dedupe, deadline and output limit is the alternative.

## Broker integration and sandbox policy (settled 2026-10-11)

`HandsSandbox` adapts `HandsProvider` to the broker's `SandboxProvider`. The broker passes
`execId`, `epoch`, `owner`, `conversationId` and `tainted` to `execute`. These are optional
extras; `RemoteSandbox`'s wire format is unchanged.

**Every built-in Pi tool runs in the sandbox.** `bash`, `read`, `write`, `edit`, `grep`, `find`
and `ls` are all bridged as argv over the exec transport (`sandboxArgv` in `src/hands.ts`);
none is emulated on the host. `edit` is a read, then a sha256-guarded write: if the file changed
in between, the write is not applied (exit 75 in the sandbox, 409 to the caller). Every result
carries `productionData: false`.

**Classification.** The sandbox is sandbox work, not production. `HandsSandbox` declares
`provenanceSource: "declared"`, so the broker trusts the per-tool policy instead of tainting
an unclassifiable remote provider. In `DEFAULT_TOOL_POLICIES`, `bash` is `egress: "proxied"`:
its network access goes only through the egress proxy (DESIGN-egress.md). The broker lets
"proxied" egress run in a tainted conversation only when the provider declares
`egressBoundary: "proxy"`. `HandsSandbox` declares that only when it is built with an
`EgressPolicyWriter`. Before each exec it writes the conversation's policy (allowlist,
injection rules, `tainted`) to the trusted directory the proxy reads. A tainted conversation
then reaches only rules marked `allowWhenTainted`. That enforcement happens at the proxy,
outside the guest. Without a writer the boundary is `"none"`, and tainted bash is refused as
before.

**Policy before allocation.** `executeLocked` now runs `assertNotBlocked`, the egress check, and
the declared-provenance check _before_ `HandsProvider.ensure`. A refused call never starts a VM.
Unit tests cover this: taint, a blocked ledger, and a production tool each make zero Nomad
requests. The finding recorded here before (remote without classify meant tainted, plus
allocate-before-check) is resolved.

**Kata only, twice.** The backend refuses to submit any job whose tasks are not
`driver = "docker"` with `runtime = "kata"` and not privileged. `assertKataJob` raises
`400 hands_job_refused` in `NomadHttpApi.registerNew`, and `converge` checks it again before
both create calls. A tampered template becomes `hands_allocation_failed` with zero register
calls. On the node, 20-install-docker-kata.sh makes `kata` Docker's **default runtime**, so even
a job that names no runtime gets a VM. 50-nomad.sh proves it with `no-runtime-gets-kata`. runc
stays registered, and is only used when named; Nomad's `allow_runtimes = ["kata"]` refuses it.

## Known gaps before multi-tenant use

- **Empty runtime (closed on kit nodes).** Nomad 2.0.7 checks `allow_runtimes` only when a job
  sets `runtime`. On kit nodes the Docker default is `kata`, and the backend refuses non-kata
  jobs. Other Nomad users could still submit jobs directly; production also needs ACLs that
  limit who can submit to the hands namespace (or Sentinel).
- **Per-sandbox network (closed).** Each hands job runs on its conversation's `sbx<key12>`
  network, created and bound to the egress proxy by `sandbox-netctl` before the job is
  submitted, after the allowlist is registered. The backend refuses any job whose network is
  not that one (DESIGN-egress.md, "Nomad-launched sandboxes"). 50-nomad.sh proves it on the
  node. Inner Docker pulls through the proxy remain open (DESIGN-egress.md, gap 3).
- **No exec transport yet** (see above). The tests use an in-memory transport.
- **No Nomad ACLs / mTLS** in the dev setup. Production needs an ACL token scoped to the hands
  namespace (submit, read, alloc-exec on those jobs only) and TLS.
- **Dev agent state is in memory.** Agent-restart reconciliation is covered by the fake-API
  tests only.
- **QEMU under nested virt** may hang on some hosts (a third-party report on Apple M3+ with
  Kata 3.x). Step 30 measures it; Dragonball is a diagnostic fallback, not allowed in Nomad.
