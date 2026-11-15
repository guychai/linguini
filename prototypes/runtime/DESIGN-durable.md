# Pi Durable harness (V1.1.5, spec D16)

`HARNESS_MODE=durable` runs new threads on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)
1.5.2 instead of the Pi coding-agent SDK. Code: `src/durable-harness.ts`; tests:
`src/durable-harness.test.ts`.

## What stays the same

The engine still owns leases, the job queue, Stop and steer, and the tool ledger. Durable sits
behind the same `Harness` interface as `PiHarness` and `FixtureHarness`: one instance per turn.
Every tool body is `SandboxBroker.execute`, so intent → effect → observation, unknown outcomes,
taint and egress rules are exactly the ones the Pi harness gets.

## Security rules

| Rule | How |
| --- | --- |
| Every tool task is gated | A `beforeTool` hook calls `SandboxBroker.preflight` (ledger not blocked, egress after taint, host-tool destinations and the sensitive boundary). Durable runs `beforeTool` for model calls, code mode's nested calls and `executeTool()` alike. A refused call never reaches its body; the model sees the refusal; a `tool.blocked` event is recorded. The broker checks again at execute time. |
| Only Linguini's tools | Tools are generated from the broker's policies (sandbox tools plus host tools that declare `description` and `parameters`). Durable's built-in coding tools are never installed and no `env` is passed, so nothing can run outside the Kata sandbox. Any other tool name fails preflight. |
| Sensitive flag | Only the broker sets it, while a call runs and before its result is returned. A nested call that reads a sensitive source flags the thread even if the script never outputs the data. Nothing in Durable (including code mode `store`/`load`) can clear it. |
| Replay | Only safe reads (`read`, `grep`, `find`, `ls`, `html_preview`) are `replay: "safe"`. The broker call ID is `durable:<Durable call ID>`, which is stable across restarts, so a re-delivered call finds its ledger entry instead of running again. |
| Cut-off calls | A non-idempotent or idempotent-write call that Durable reports as `interrupted`, `restart_limit` or `abandoned`, or `aborted` without its body having run in this process (a run left over from a lost worker), is marked unknown in the ledger if it has an open intent. That blocks the thread (409 `tool_outcome_unknown`) until an operator resolves it, the same as a lost worker. |
| Code mode | Off. V1.1.5b adds the gating tests; it ships off even then. |
| No telemetry | No telemetry option is passed (pi-telemetry is a no-op without one). |

## Storage

Durable has no Postgres adapter; writing one means implementing its whole `Storage` commit
protocol and passing its conformance suite, which is not reasonable for v1. Each conversation
gets one SQLite file, `$PI_DURABLE_DIR/<hands key>.sqlite` (default `$PI_HOST_DIR/durable`),
opened with `PRAGMA synchronous = FULL` (Durable's opener defaults to `NORMAL`, which can lose the
last commits on power loss); the harness refuses to start if SQLite does not accept it.

Durable allows one writer per file. That matches the engine: one worker per database (advisory
lock) and one active turn per conversation. Running more than one worker host needs a shared
directory or a Postgres adapter first.

Conversation deletion removes the file (deletion `local` step). The directory must be backed up
together with the database.

## Existing threads: cutover, not migration

`Conversation.harness` is set to `"durable"` on a thread's first Durable turn and never changes.
With `HARNESS_MODE=durable`, a thread with no earlier turn starts on Durable; a thread that already
has turns or `piEntries` keeps `PiHarness`, so old transcripts are never converted or dropped.
There is no official importer, and a hand-written one would have to synthesize Durable's task
records; cutover avoids that risk. Switching back to `HARNESS_MODE=pi` keeps Durable threads on
Durable.

## Turn semantics

- `run`: submit with `requestId = jobId`, stream assistant text from the live partial and the
  committed entries, wait for the submission. An unanswered run surfaces its failure as
  `assistant.error` plus a "⚠️ Model request failed" line, like `PiHarness`.
- `steer`: `submit({ whenBusy: "steer" })`. `abort`/Stop: `root.abort()`.
- On open, any run left over from a lost worker is aborted, not resumed: the engine already marked
  that turn interrupted, and the ledger decides what happened to its tools. Resuming interrupted
  turns is a later step.

## Dependencies

`pi-durable`, `pi-ai`, `chord`, `pi-codemode`, `pi-schema`, `pi-telemetry` are pinned to exactly
1.5.2. `pi-coding-agent` stays on 1.1.0 with its own 1.1.0 dependencies through npm `overrides`, so
the existing `PiHarness` path is unchanged. Chord's optional `ws` peer pins 8.21.0; the override
keeps the backend's `ws` (8.22.0). Node >= 22.19 is required (checked at startup in durable mode).

Credentials: `durableModels()` uses pi-ai's built-in providers with `$PI_HOST_DIR/pi-config/auth.json`
(the file the Pi harness uses) through a small file credential store (atomic writes, 0600).
