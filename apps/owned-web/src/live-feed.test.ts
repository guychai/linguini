// Live feed supervision: bounded retries, finite failure on outage, immediate failure on
// 401/403, idle detection and resync on reconnect. Fake fetch, injected sleep: no timing.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { LiveFeed } from "./live-feed.ts";

const encoder = new TextEncoder();
/** A response whose body is driven by the test. */
function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    frame: (data = '{"id":null}') => controller.enqueue(encoder.encode(`data: ${data}\n\n`)),
    end: () => controller.close(),
  };
}
const noSleep = async () => {};
const tick = () => new Promise((r) => setImmediate(r));

test("401 fails the feed at once with an auth failure and no retries", async () => {
  let calls = 0;
  const feed = new LiveFeed({
    url: "/api/changes",
    headers: () => ({}),
    sleep: noSleep,
    fetch: async () => {
      calls++;
      return new Response('{"error":"Authentication required"}', { status: 401 });
    },
  }).start();
  const failure = await feed.failed;
  assert.equal(failure.kind, "auth");
  assert.equal(calls, 1);
});

test("an outage is retried a bounded number of times, then fails once (finite, observable)", async () => {
  let calls = 0;
  const delays: number[] = [];
  const feed = new LiveFeed({
    url: "/x",
    headers: () => ({}),
    retryDelaysMs: [10, 20, 30],
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetch: async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
  }).start();
  const failure = await feed.failed;
  assert.equal(failure.kind, "outage");
  assert.equal(calls, 4, "initial attempt + 3 bounded retries");
  assert.deepEqual(delays, [10, 20, 30]);
  assert.match(failure.kind === "outage" ? failure.detail : "", /after 4 attempts: fetch failed/);
  await tick();
  assert.equal(calls, 4, "no attempts after failing");
});

test("a dropped stream reconnects within the session and resyncs listeners", async () => {
  const responses = [streamResponse(), streamResponse()];
  let calls = 0,
    refreshes = 0;
  const feed = new LiveFeed({
    url: "/x",
    headers: () => ({}),
    sleep: noSleep,
    fetch: async () => responses[calls++]!.response,
  });
  feed.subscribe(() => {
    refreshes++;
  });
  feed.start();
  await tick();
  responses[0]!.frame();
  await tick();
  assert.equal(refreshes, 1);
  responses[0]!.end();
  await tick();
  await tick();
  assert.equal(calls, 2, "reconnected after the drop");
  responses[1]!.frame();
  await tick();
  assert.equal(refreshes, 2, "the server's connect frame triggers a resync");
  feed.close();
  let settled = false;
  void feed.failed.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "closing the session is not a failure");
});

test("a server that accepts then drops every connection cannot cause an endless loop", async () => {
  let calls = 0;
  const feed = new LiveFeed({
    url: "/x",
    headers: () => ({}),
    retryDelaysMs: [1, 1],
    sleep: noSleep,
    now: () => 0,
    fetch: async () => {
      calls++;
      const r = streamResponse();
      queueMicrotask(() => {
        r.frame();
        r.end();
      });
      return r.response;
    },
  }).start();
  const failure = await feed.failed;
  assert.equal(failure.kind, "outage");
  assert.equal(calls, 3);
});

test("a silent half-open connection is detected by the idle timeout", async () => {
  let calls = 0;
  const feed = new LiveFeed({
    url: "/x",
    headers: () => ({}),
    retryDelaysMs: [],
    idleTimeoutMs: 20,
    sleep: noSleep,
    fetch: async (_u, init) => {
      calls++;
      const r = streamResponse();
      init?.signal?.addEventListener("abort", () => r.end());
      return r.response;
    },
  }).start();
  const failure = await feed.failed;
  assert.equal(failure.kind, "outage");
  assert.match(failure.kind === "outage" ? failure.detail : "", /idle timeout|closed/);
  assert.equal(calls, 1);
});

test("a listener hitting 401 while refreshing fails the feed as an auth failure", async () => {
  const r = streamResponse();
  const feed = new LiveFeed({
    url: "/x",
    headers: () => ({}),
    sleep: noSleep,
    fetch: async () => r.response,
  });
  feed.subscribe(async () => {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  });
  feed.start();
  await tick();
  r.frame();
  assert.equal((await feed.failed).kind, "auth");
});

test("T3 session: closed fails with ConnectionBlockedError(authentication) on 401 and Transient on outage", async () => {
  (globalThis as any).sessionStorage = { getItem: () => "tok", setItem() {} };
  let changes: "401" | "down" = "401";
  (globalThis as any).fetch = async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/api/session")) return new Response(JSON.stringify({ owner: "o" }));
    if (u.endsWith("/health")) return new Response(JSON.stringify({ harness: "fixture" }));
    if (u.endsWith("/api/changes")) {
      if (changes === "401") return new Response('{"error":"no"}', { status: 401 });
      throw new TypeError("fetch failed");
    }
    return new Response("{}");
  };
  const { layer } = await import("./t3-adapter.ts");
  const { RpcSessionFactory } = await import("../../../packages/client-runtime/src/rpc/session.ts");
  const run = () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* RpcSessionFactory;
          const session = yield* factory.connect({} as never);
          return yield* Effect.flip(session.closed);
        }),
      ).pipe(Effect.provide(layer()), Effect.orDie),
    );
  const auth = await run();
  assert.equal(auth._tag, "ConnectionBlockedError");
  assert.equal(auth.reason, "authentication");
  changes = "down";
  const outage = await run();
  assert.equal(outage._tag, "ConnectionTransientError");
  assert.equal(outage.reason, "remote-unavailable");
});
