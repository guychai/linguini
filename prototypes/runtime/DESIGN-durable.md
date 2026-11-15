# Pi Durable harness

[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2 is
the only model harness. The Pi coding-agent harness, its session entries (`piEntries`), the
gateway and the capability tokens are gone; there is no cutover and no migration (the dev
database is wiped). `HARNESS_MODE=fixture` runs the deterministic `FixtureHarness` for tests and
the browser e2e suite only; any other `HARNESS_MODE` value refuses startup. Code:
`src/durable-harness.ts`, `src/durable-pg.ts`. Tests: `src/durable-harness.test.ts`,
`src/durable-codemode.test.ts`, `src/durable-pg.test.ts` (all need `TEST_DATABASE_URL`; CI runs a
Postgres service).

## What the engine keeps

The engine owns leases, the job queue, Stop and steer, and the tool ledger. Durable sits behind
the `Harness` interface, one instance per turn. Every tool body is `SandboxBroker.execute`, so
intent → effect → observation and unknown outcomes work exactly as for any other call.

## Security rules

| Rule | How |
| --- | --- |
| Every tool task is gated | A `beforeTool` hook calls `SandboxBroker.preflight`: known tool, ledger not blocked, host-tool destinations, and the owner's entitlement for the tool. Durable runs `beforeTool` for model calls, code mode's nested calls and `executeTool()` alike. A refused call never reaches its body; the model sees the refusal; a `tool.blocked` event is recorded. The broker checks again at execute time. |
| Only Linguini's tools | Tools are generated from the broker's policies (sandbox tools plus host tools that declare `description` and `parameters`). Durable's built-in coding tools are never installed and no `env` is passed, so nothing can run outside the Kata sandbox. Any other tool name fails preflight. |
| No taint | There is no sensitive-thread flag. Data stays in because egress is constrained (R1) and every tool call is gated, not because a thread is marked. |
| Replay | Only safe reads (`read`, `grep`, `find`, `ls`, `html_preview`) are `replay: "safe"`. The broker call ID is `durable:<Durable call ID>`, stable across restarts, so a re-delivered call finds its ledger entry instead of running again. |
| Cut-off calls | A non-idempotent or idempotent-write call that Durable reports as `interrupted`, `restart_limit` or `abandoned`, or `aborted` without its body having run in this process, is marked unknown in the ledger if it has an open intent. That blocks the thread (409 `tool_outcome_unknown`) until an operator resolves it. |
| Code mode | **On.** `PI_DURABLE_CODEMODE=0` is the off switch. Scripts run in QuickJS on a worker thread with no Node globals, env, file system, network, timers or `models.*`. Every `tools.<name>()` call is its own tool task and passes `beforeTool` (entitlements included) and the broker. Code mode's own `codemode` tool is the only tool exempt from preflight, because it only orchestrates. |
| No telemetry | No telemetry option is passed. |

## Storage: an append-only log in Postgres

Durable's `Storage` is implemented as an append-only commit log replayed into pi-durable's
`MemoryStorage` (`PostgresLogStorage`, the design proven on `spike/durable-pg-log`; it passes
pi-durable's storage conformance suite):

- Table `prototype_durable_log(log_key text, seq bigint, writes text, PRIMARY KEY (log_key, seq))`,
  created on first use. `log_key` is the conversation's hands key. `writes` is JSON **text**, not
  jsonb: jsonb refuses `\u0000` and re-orders keys, text keeps Durable's strings lossless.
- `open` replays the rows in `seq` order into memory. Each commit is validated in memory first,
  then appended in **one** Postgres transaction; reads wait while an append is in flight.
- **Fence:** inside that transaction, before the insert, the conversation row is read
  `FOR SHARE` and its lease worker and epoch must match the turn's. Otherwise nothing is stored
  and the append fails with `StaleOwnerError`, so a worker that lost the lease cannot write.
- **Poison and reload:** any failure after a batch was applied in memory (including a COMMIT
  whose reply was lost) poisons the storage. The harness turns that into a failed turn ("Saving
  the conversation transcript failed; it reloads from the database on the next turn") and drops
  the instance. Every turn opens fresh storage, so the next turn replays what Postgres actually
  holds.
- Conversation deletion removes the log (deletion `local` step). The log is part of the database
  backup; nothing lives on the host file system.

## Turn semantics

- `run`: submit with `requestId = jobId`, stream assistant text from the live partial and the
  committed entries, wait for the submission. A failed run surfaces as `assistant.error` plus a
  "⚠️ Model request failed" line.
- `steer`: `submit({ whenBusy: "steer" })`. `abort`/Stop: `root.abort()`.
- On open, any run left over from a lost worker is aborted, not resumed: the engine already marked
  that turn interrupted, and the ledger decides what happened to its tools.

## Dependencies

`pi-durable`, `pi-ai`, `chord`, `pi-codemode`, `pi-schema`, `pi-telemetry` are pinned to exactly
1.5.2; `pi-coding-agent` is no longer a dependency. Chord's optional `ws` peer pins 8.21.0; the
override keeps the backend's `ws` (8.22.0). Node >= 22.19 is required (checked at startup).

Credentials: `durableModels()` uses pi-ai's built-in providers with `$PI_HOST_DIR/pi-config/auth.json`
through a small file credential store (atomic writes, 0600).
