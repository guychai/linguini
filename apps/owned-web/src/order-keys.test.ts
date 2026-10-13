// Pin and Active order keys are stored separately and projected into the T3 shell, so a
// T3 thread.pin.reorder / thread.active.reorder actually moves the thread in T3's sort.
// Runs the real T3 adapter against an in-process owned backend (SQLite, fake harness).
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "../../../packages/client-runtime/src/state/threadSort.ts";

// The runtime is a separate package typechecked by its own tsconfig; load it at run time so
// this app's stricter compiler options are not applied to it.
const runtime = (file: string): Promise<any> =>
  import(new URL(`../../../prototypes/runtime/src/${file}`, import.meta.url).href);

test("pin and active reorder change the projected T3 order independently", async () => {
  const [{ SqliteStore }, { Engine }, { api }] = await Promise.all([
    runtime("store.ts"),
    runtime("engine.ts"),
    runtime("api.ts"),
  ]);
  const dir = await mkdtemp(join(tmpdir(), "order-keys-")),
    store = new SqliteStore(join(dir, "s.sqlite"));
  const engine = new Engine(
    store,
    async () =>
      ({
        async run() {},
        async steer() {},
        async close() {},
      }) as never,
    { heartbeatMs: 0 },
  );
  const token = "test-only-order-token-00000000000000000";
  const { server, closeStreams } = api(engine, { [token]: "alice" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch,
    priorStorage = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    realFetch(
      typeof input === "string" && input.startsWith("/")
        ? `http://127.0.0.1:${address.port}${input}`
        : input,
      init,
    )) as typeof fetch;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => (key === "owned-prototype-token" ? token : null),
    setItem() {},
    removeItem() {},
  };
  try {
    const { invoke } = await import("./t3-adapter.ts");
    const { shell, serverConfig } = await import("./projection.ts");
    const { OwnedAdapter } = await import("./adapter.ts");
    const capabilities = serverConfig().environment.capabilities as Record<string, unknown>;
    assert.equal(capabilities.threadPinReorder, true);
    assert.equal(capabilities.threadActiveReorder, true);
    const owned = new OwnedAdapter(token, globalThis.fetch);
    let n = 0;
    const dispatch = (input: Record<string, unknown>) =>
      invoke("orchestration.dispatchCommand", { commandId: `cmd-${++n}`, ...input });
    for (const id of ["t-a", "t-b", "t-c"]) await owned.create(id, id);
    const view = async () => {
      const rows = await Promise.all(["t-a", "t-b", "t-c"].map((id) => owned.snapshot(id)));
      return shell(rows).threads.map((t) => ({
        id: String(t.id),
        createdAt: String(t.createdAt),
        pinnedAt: t.pinnedAt,
        pinOrderKey: t.pinOrderKey ?? null,
        activeOrderKey: t.activeOrderKey ?? null,
        updatedAt: String(t.updatedAt),
      }));
    };
    const pinned = async () =>
      sortPinnedThreadsByOrderKey((await view()).filter((t) => t.pinnedAt != null)).map(
        (t) => t.id,
      );
    const active = async () => sortActiveThreadsByOrderKey(await view()).map((t) => t.id);

    // Pin a and b with slots, then arrange the Active list.
    await dispatch({ type: "thread.pin", threadId: "t-a", orderKey: "g" });
    await dispatch({ type: "thread.pin", threadId: "t-b", orderKey: "t" });
    assert.deepEqual(await pinned(), ["t-a", "t-b"]);
    for (const [id, key] of [
      ["t-a", "f"],
      ["t-b", "m"],
      ["t-c", "t"],
    ])
      await dispatch({ type: "thread.active.reorder", threadId: id, orderKey: key });
    assert.deepEqual(await active(), ["t-a", "t-b", "t-c"]);

    // A pin reorder moves b above a in the pinned block and leaves Active untouched.
    const beforePin = await view();
    await dispatch({ type: "thread.pin.reorder", threadId: "t-b", orderKey: "c" });
    assert.deepEqual(await pinned(), ["t-b", "t-a"]);
    assert.deepEqual(await active(), ["t-a", "t-b", "t-c"]);
    const afterPin = await view();
    assert.equal(afterPin.find((t) => t.id === "t-b")!.activeOrderKey, "m");

    // An Active reorder moves c to the top of Active and leaves the pinned slots untouched,
    // and arranging is not thread activity (updatedAt unchanged).
    const cBefore = afterPin.find((t) => t.id === "t-c")!.updatedAt;
    await dispatch({ type: "thread.active.reorder", threadId: "t-c", orderKey: "a" });
    assert.deepEqual(await active(), ["t-c", "t-a", "t-b"]);
    assert.deepEqual(await pinned(), ["t-b", "t-a"]);
    const afterActive = await view();
    assert.equal(afterActive.find((t) => t.id === "t-c")!.updatedAt, cBefore);
    assert.deepEqual(
      afterActive.map((t) => [t.id, t.pinOrderKey]),
      [
        ["t-a", "g"],
        ["t-b", "c"],
        ["t-c", null],
      ],
    );
    assert.notDeepEqual(beforePin, afterActive);

    // Re-pinning keeps the arranged slot; unpin clears it (upstream semantics).
    await dispatch({ type: "thread.pin", threadId: "t-b", orderKey: "z" });
    assert.equal((await view()).find((t) => t.id === "t-b")!.pinOrderKey, "c");
    await dispatch({ type: "thread.unpin", threadId: "t-b" });
    const unpinned = (await view()).find((t) => t.id === "t-b")!;
    assert.equal(unpinned.pinnedAt, null);
    assert.equal(unpinned.pinOrderKey, null);
    assert.equal(unpinned.activeOrderKey, "m");
    assert.deepEqual(await pinned(), ["t-a"]);
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = priorStorage;
    closeStreams();
    await engine.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
