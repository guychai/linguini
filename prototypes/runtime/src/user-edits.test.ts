// Files-panel saves are told to Pi as context on its next prompt only: the note reaches the
// harness, is consumed once, and never appears in the visible transcript (message.user).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresStore, SqliteStore, initial, read, type Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { recordUserEdit } from "./files.ts";
import type { Harness, Sink } from "./harness.ts";

const database = process.env.TEST_DATABASE_URL;

for (const kind of ["sqlite", "postgres"] as const) {
  test(
    `${kind}: user edits are prepended to the next prompt once, out of the transcript`,
    { skip: kind === "postgres" && !database, timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "edits-"));
      const store: Store =
        kind === "sqlite"
          ? new SqliteStore(join(dir, "s.sqlite"))
          : await PostgresStore.open(database!);
      const prompts: string[] = [];
      const engine = new Engine(
        store,
        async (): Promise<Harness> => ({
          async run(text: string, _h: string, emit: Sink) {
            prompts.push(text);
            await emit("assistant.delta", { text: "ok" });
          },
          async steer() {},
          async abort() {},
          dispose() {},
        }),
        { heartbeatMs: 0, worker: "W" },
      );
      const owner = `edits-${randomUUID()}`,
        id = randomUUID();
      try {
        await store.create(initial(id, owner));
        for (const p of ["src/a.ts", "README.md", "src/a.ts"])
          await store.mutate(owner, id, (c) => {
            c.userEdits = recordUserEdit(c.userEdits, p);
          });
        await engine.command(owner, id, { commandId: "r1", kind: "prompt", text: "hello" });
        await engine.idle(owner, id);
        await engine.command(owner, id, { commandId: "r2", kind: "prompt", text: "again" });
        await engine.idle(owner, id);
        assert.equal(prompts.length, 2);
        assert.match(
          prompts[0]!,
          /^\[Linguini note: .*\/workspace\/README\.md, \/workspace\/src\/a\.ts\..*\]\n\nhello$/s,
        );
        assert.equal(prompts[1], "again", "consumed once");
        const c = await read(store, owner, id);
        assert.equal(c.userEdits, undefined);
        const users = c.events.filter((e) => e.type === "message.user").map((e) => e.data.text);
        assert.deepEqual(users, ["hello", "again"]);
        assert.ok(!JSON.stringify(c.events).includes("Linguini note"), "note never journaled");
      } finally {
        await engine.stop();
        await store.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
