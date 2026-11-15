import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { api } from "./api.ts";
import { Engine } from "./engine.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "./store.ts";
import { clickThroughPage, clickThroughTarget } from "./out.ts";

test("click-through accepts only plain http(s) URLs", () => {
  assert.equal(clickThroughTarget("https://example.com/a?b=1")?.host, "example.com");
  assert.equal(clickThroughTarget("http://127.0.0.1:8080/x")?.port, "8080");
  for (const bad of [
    null,
    "",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "/relative",
    "https://user:pw@example.com/",
    `https://example.com/${"a".repeat(9000)}`,
  ])
    assert.equal(clickThroughTarget(bad), null, String(bad).slice(0, 40));
});

test("click-through page shows the full escaped URL and never navigates on its own", () => {
  const { status, html } = clickThroughPage(
    'https://evil.example/leak?d=4711&q="><script>x</script>',
  );
  assert.equal(status, 200);
  assert.ok(html.includes("evil.example/leak?d=4711&amp;q=%22%3E%3Cscript%3Ex%3C/script%3E"));
  assert.ok(!/<script/i.test(html), "no script");
  assert.ok(!/http-equiv="refresh"/i.test(html), "no meta refresh");
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /<span class="host">evil\.example<\/span>/);
  assert.equal(clickThroughPage("javascript:alert(1)").status, 400);
});

test("GET /out is served without a session, with a no-script CSP and no referrer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "out-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true });
  });
  const { server } = api(
    new Engine(store, async () => {
      throw new Error("no harness");
    }),
    { ["t".repeat(40)]: "o" },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/out?u=${encodeURIComponent("https://example.com/x")}`, {
      redirect: "manual",
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("location"), null);
    assert.ok((await r.text()).includes("https://example.com/x"));
    assert.equal((await fetch(`${base}/out?u=javascript%3Aalert(1)`)).status, 400);
  } finally {
    server.close();
  }
});
