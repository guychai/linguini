import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLocalImages,
  injectHtmlRenderBootstrap,
  isImageBytes,
  MAX_PAGE_BYTES,
  preparePage,
  RENDER_CSP,
  workspaceRelative,
} from "./html-render.ts";
import * as vendor from "./html-render-vendor.ts";
import { MemoryRenderStore, VisualReplies } from "./visual.ts";
import { Gate, LocalRenderer } from "./render-worker.ts";
import type { Renderer } from "./render-worker.ts";
import type { RenderJob } from "./render-browser.ts";
import { DEFAULT_TOOL_POLICIES } from "./ledger.ts";
import { TOOL_DESCRIPTIONS, sandboxTools } from "./pi-tools.ts";
import { persisted } from "./sandbox.ts";
import { sandboxSystemPrompt } from "./sandbox-prompt.ts";
import { ApiError, SqliteStore } from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import { createAuth } from "./auth.ts";
import { MemorySettings, settingsPolicyFromEnv } from "./users.ts";
import type { Harness } from "./harness.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("vendored theme bootstrap matches upstream (packages/shared/src/htmlRender.ts)", async (t) => {
  const path = new URL("../../../packages/shared/src/htmlRender.ts", import.meta.url);
  if (!existsSync(path)) return t.skip("upstream sources not in this checkout");
  const upstream = (await import(path.href)) as {
    injectHtmlRenderBootstrap(html: string): string;
    HTML_RENDER_THEME_GUIDE: string;
    HTML_RENDER_LAYOUT_GUIDE: string;
    HTML_RENDER_MEASURE_WIDTHS: readonly number[];
    HTML_RENDER_COLUMN_WIDTH: number;
    HTML_RENDER_MIN_HEIGHT: number;
    HTML_RENDER_MAX_HEIGHT: number;
  };
  for (const html of [
    "<p>x</p>",
    "<!doctype html><p>x</p>",
    "<html lang=en><body>x</body></html>",
    '<html><head><meta charset="utf-8"><title>t</title></head><body></body></html>',
    '<head><meta name="viewport" content="width=500"></head>',
    "<!-- <head> --><script>'<head>'</script><template><head></template><HEAD data-x>",
    "<plaintext><head>",
  ])
    assert.equal(injectHtmlRenderBootstrap(html), upstream.injectHtmlRenderBootstrap(html), html);
  assert.equal(vendor.HTML_RENDER_THEME_GUIDE, upstream.HTML_RENDER_THEME_GUIDE);
  assert.equal(vendor.HTML_RENDER_LAYOUT_GUIDE, upstream.HTML_RENDER_LAYOUT_GUIDE);
  assert.deepEqual(
    [...vendor.HTML_RENDER_MEASURE_WIDTHS],
    [...upstream.HTML_RENDER_MEASURE_WIDTHS],
  );
  assert.equal(vendor.HTML_RENDER_COLUMN_WIDTH, upstream.HTML_RENDER_COLUMN_WIDTH);
  assert.equal(vendor.HTML_RENDER_MIN_HEIGHT, upstream.HTML_RENDER_MIN_HEIGHT);
  assert.equal(vendor.HTML_RENDER_MAX_HEIGHT, upstream.HTML_RENDER_MAX_HEIGHT);
});

test("tools: declared, described, ledgered; screenshots reach the model but are never persisted", async () => {
  for (const name of ["html_preview", "html_render"] as const) {
    assert.ok(DEFAULT_TOOL_POLICIES[name], name);
    assert.equal(DEFAULT_TOOL_POLICIES[name]!.egress, false);
    assert.match(TOOL_DESCRIPTIONS[name], /no network/);
  }
  assert.equal(DEFAULT_TOOL_POLICIES.html_preview!.replay, "safe-read");
  const tools = sandboxTools(async () => ({
    text: "{}",
    images: [{ mimeType: "image/png", data: "AAAA" }],
  }));
  const preview = tools.find((t) => t.name === "html_preview")!;
  const out = await preview.execute(
    "c1",
    { html: "<p>x</p>" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(out.content, [
    { type: "text", text: "{}" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.deepEqual(persisted({ text: "t", images: [{ mimeType: "image/png", data: "x" }] }), {
    text: "t",
  });
  const prompt = sandboxSystemPrompt([]);
  assert.match(prompt, /html_preview/);
  assert.match(prompt, /self-contained/);
  assert.match(prompt, /no network/);
});

test("images: only /workspace paths, read through the sandbox reader, real image bytes only", async () => {
  const html = `<img src="/workspace/a.png"><img src='/etc/shadow.png'><div style="background:url(/workspace/b.png)"></div><img src="/workspace/fake.png"><img src="/workspace/../x.png"><img src="https://cdn.example/x.png"><img src="/workspace/missing.png">`;
  assert.deepEqual(
    findLocalImages(html).map((r) => r.path),
    [
      "/workspace/a.png",
      "/etc/shadow.png",
      "/workspace/b.png",
      "/workspace/fake.png",
      "/workspace/../x.png",
      "/workspace/missing.png",
    ],
  );
  assert.equal(workspaceRelative("/etc/shadow.png"), null);
  assert.equal(workspaceRelative("/workspace/../x.png"), null);
  assert.equal(workspaceRelative("/workspace/d/a.png"), "d/a.png");
  const reads: string[] = [];
  const files: Record<string, Buffer> = {
    "a.png": PNG,
    "b.png": PNG,
    "fake.png": Buffer.from("SECRET=hunter2"),
  };
  const out = await preparePage(html, async (rel) => (reads.push(rel), files[rel] ?? null));
  assert.deepEqual(reads.sort(), ["a.png", "b.png", "fake.png", "missing.png"]);
  assert.equal(out.html.match(/data:image\/png;base64,/g)?.length, 2);
  assert.doesNotMatch(out.html, /hunter2|SECRET/);
  assert.deepEqual(out.missing.sort(), [
    "/etc/shadow.png",
    "/workspace/../x.png",
    "/workspace/fake.png",
    "/workspace/missing.png",
  ]);
  assert.match(out.html, /<style id="t3-theme">/);
  assert.ok(isImageBytes(Buffer.from('<?xml version="1.0"?><svg xmlns="x"/>')));
  assert.ok(!isImageBytes(Buffer.from("<html><svg></svg></html>")));
  // Page size limit counts inlined images.
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
  await assert.rejects(
    preparePage(
      '<img src="/workspace/1.png"><img src="/workspace/2.png"><img src="/workspace/3.png">',
      async () => big,
    ),
    (e) => (e as ApiError).status === 413,
  );
  assert.ok(MAX_PAGE_BYTES >= 8 * 1024 * 1024);
});

test("gate: per-user and global concurrency, bounded queue, slots handed over", async () => {
  const g = new Gate(1, 1);
  let running = 0,
    peak = 0;
  const job = () =>
    g.run(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    });
  const a = job(),
    b = job();
  await assert.rejects(job(), /queue is full/);
  await Promise.all([a, b]);
  assert.equal(peak, 1);
  assert.equal(g.busy, 0);
});

const fakeRenderer = (jobs: RenderJob[]): Renderer => ({
  async render(job) {
    jobs.push(job);
    return {
      consoleMessages: [{ level: "log", text: "hi" }],
      ...(job.captureWidth
        ? {
            capture: {
              png: "UE5H",
              contentHeight: 321,
              capturedHeight: 321,
              width: job.captureWidth,
            },
          }
        : {}),
      ...(job.measureWidths
        ? { heights: job.measureWidths.map((w) => [w, 5000 - w] as [number, number]) }
        : {}),
    };
  },
});

function visualRig(now = () => Date.now()) {
  const owners = new Map([
    ["c1", "alice"],
    ["c2", "bob"],
  ]);
  const live = new Set(["c1", "c2"]);
  const store = new MemoryRenderStore(async (id) => owners.get(id) ?? null);
  const jobs: RenderJob[] = [];
  const visual = new VisualReplies({
    renderer: fakeRenderer(jobs),
    store,
    readImage: () => async () => PNG,
    conversationExists: async (o, i) => {
      if (owners.get(i) !== o || !live.has(i)) throw new ApiError(404, "Conversation not found");
    },
    signingKey: Buffer.alloc(32, 7),
    quotaBytes: 64 * 1024,
    now,
  });
  return { visual, store, jobs, live };
}

test("html_render: upstream result shape, stored per conversation, idempotent per call, quota", async () => {
  const { visual, store, jobs } = visualRig();
  const call = {
    id: "job1:call1",
    tool: "html_render",
    args: { html: "<p>chart</p>", title: " Sales\n", height: 99999 },
  };
  const r = await visual.execute("alice", "c1", call);
  const out = JSON.parse(r.text);
  assert.match(out.htmlRender.attachmentId, /^[a-f0-9]{32}-html$/);
  assert.equal(out.htmlRender.title, "Sales");
  assert.equal(out.htmlRender.height, 2000);
  assert.equal(out.htmlRender.heights.length, vendor.HTML_RENDER_MEASURE_WIDTHS.length);
  assert.ok(out.htmlRender.heights.every(([, h]: [number, number]) => h <= 2000));
  assert.match(out.message, /Shown to the reader/);
  assert.equal(jobs[0]!.fragment, vendor.HTML_RENDER_MEASURE_FRAGMENT_DARK);
  // A replayed call finds its page; it is not stored twice.
  const again = JSON.parse((await visual.execute("alice", "c1", call)).text);
  assert.equal(again.htmlRender.attachmentId, out.htmlRender.attachmentId);
  assert.equal(store.rows.size, 1);
  // Another user's conversation id is refused.
  await assert.rejects(
    visual.execute("alice", "c2", { ...call, id: "x" }),
    (e) => (e as ApiError).status === 404,
  );
  // Quota (64 KiB here).
  await assert.rejects(
    visual.execute("alice", "c1", {
      ...call,
      id: "big",
      args: { ...call.args, html: "x".repeat(70_000) },
    }),
    (e) => (e as ApiError).code === "render_quota",
  );
  assert.ok((await store.usage("alice")) > 0);
  assert.equal(await store.usage("bob"), 0);
  store.forget("c1");
  assert.equal(await store.usage("alice"), 0);
});

test("html_preview: screenshot as an image block, upstream fields in text", async () => {
  const { visual, jobs } = visualRig();
  const r = await visual.execute("alice", "c1", {
    id: "p1",
    tool: "html_preview",
    args: { html: '<img src="/workspace/a.png">', width: 99, appearance: "light" },
  });
  const out = JSON.parse(r.text);
  assert.equal(out.width, 240);
  assert.equal(out.contentHeight, 321);
  assert.deepEqual(out.screenshot, { mimeType: "image/png", width: 240, height: 321 });
  assert.deepEqual(r.images, [{ mimeType: "image/png", data: "UE5H" }]);
  assert.equal(jobs[0]!.fragment, vendor.HTML_RENDER_MEASURE_FRAGMENT_LIGHT);
  assert.match(jobs[0]!.html, /data:image\/png;base64,/);
  await assert.rejects(
    visual.execute("alice", "c1", {
      id: "p2",
      tool: "html_preview",
      args: { html: "x".repeat(600_000) },
    }),
    (e) => (e as ApiError).status === 413,
  );
});

const SECRET = "s".repeat(40);
async function apiRig(
  t: { after: (f: () => unknown) => void },
  visual: (store: SqliteStore) => VisualReplies,
  webDist?: string,
) {
  const dir = await mkdtemp(join(tmpdir(), "vr-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  const auth = await createAuth({ secret: SECRET, baseURL: "http://localhost" });
  const engine = new Engine(
    store,
    async (): Promise<Harness> => ({
      async run() {},
      async steer() {},
      async abort() {},
      dispose() {},
    }),
    { heartbeatMs: 0, worker: "W" },
  );
  const v = visual(store);
  const { server, closeStreams } = api(engine, { ["t".repeat(40)]: "svc" }, webDist, {
    auth: { auth, settings: new MemorySettings(), policy: settingsPolicyFromEnv({}) },
    renders: v,
  } as never);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    closeStreams();
    server.close();
    await engine.stop();
  });
  const base = `http://127.0.0.1:${port}`;
  const as = (who: string | null, path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(base + path, {
      ...init,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        "content-type": "application/json",
        ...(who ? { cookie: who } : {}),
        "sec-fetch-site": "same-origin",
        "x-linguini-client": "1",
        ...(path.startsWith("/api/auth/") ? { origin: "http://localhost" } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const signUp = async (email: string) => {
    const r = await as(null, "/api/auth/sign-up/email", {
      method: "POST",
      json: { email, password: "correct horse battery", name: "x" },
    });
    assert.equal(r.status, 200, await r.clone().text());
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("linguini.session_token="))!;
    const id = ((await (await as(cookie, "/api/session")).json()) as { owner: string }).owner;
    return { cookie, id };
  };
  return { as, signUp, base, port, store, v };
}

/** Conversation owners for the in-memory render store (conversations are created via the API). */
const owners = new Map<string, string>();
const visualFor =
  (renderer: Renderer, opts: { now?: () => number } = {}) =>
  (store: SqliteStore) =>
    new VisualReplies({
      renderer,
      store: new MemoryRenderStore(async (id) => owners.get(id) ?? null),
      readImage: () => async () => null,
      conversationExists: async (o, i) => void (await store.snapshot(o, i, { events: false })),
      signingKey: Buffer.alloc(32, 3),
      ...(opts.now ? { now: opts.now } : {}),
    });

test("render URLs: minted for the owner only; served only with a valid signature to the owner", async (t) => {
  let now = Date.now();
  let storeRef: SqliteStore | undefined;
  const r = await apiRig(t, (store) => {
    storeRef = store;
    return visualFor(fakeRenderer([]), { now: () => now })(store);
  });
  const a = await r.signUp("a@x.example");
  const b = await r.signUp("b@x.example");
  assert.equal(
    (
      await r.as(a.cookie, "/api/conversations", {
        method: "POST",
        json: { id: "conv-a", title: "A" },
      })
    ).status,
    201,
  );
  owners.set("conv-a", a.id);
  const out = JSON.parse(
    (
      await r.v.execute(a.id, "conv-a", {
        id: "k1",
        tool: "html_render",
        args: { html: "<p id=x>hello</p>", title: "T", height: 200 },
      })
    ).text,
  );
  const attachmentId = out.htmlRender.attachmentId as string;
  const mint = await r.as(a.cookie, "/api/renders/url", { method: "POST", json: { attachmentId } });
  assert.equal(mint.status, 200);
  const { relativeUrl, expiresAt } = (await mint.json()) as {
    relativeUrl: string;
    expiresAt: number;
  };
  assert.match(relativeUrl, /^\/render\/[a-f0-9]{32}-html\.html\?c=conv-a&e=\d+&s=/);
  assert.ok(expiresAt > now);
  assert.equal(
    (await r.as(b.cookie, "/api/renders/url", { method: "POST", json: { attachmentId } })).status,
    404,
  );
  assert.equal(
    (
      await r.as(a.cookie, "/api/renders/url", {
        method: "POST",
        json: { attachmentId: "../../etc" },
      })
    ).status,
    404,
  );
  // Without the client header the mint is a cross-site request.
  assert.equal(
    (
      await fetch(r.base + "/api/renders/url", {
        method: "POST",
        headers: { cookie: a.cookie },
        body: JSON.stringify({ attachmentId }),
      })
    ).status,
    403,
  );
  const page = await fetch(r.base + relativeUrl, { headers: { cookie: a.cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), RENDER_CSP);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("service-worker-allowed"), null);
  assert.equal(page.headers.get("clear-site-data"), null);
  assert.match(page.headers.get("content-type")!, /^text\/html/);
  assert.match(await page.text(), /<p id=x>hello<\/p>/);
  assert.match(RENDER_CSP, /default-src 'none'/);
  assert.match(RENDER_CSP, /connect-src 'none'/);
  assert.match(RENDER_CSP, /sandbox allow-scripts allow-forms$/);
  assert.doesNotMatch(RENDER_CSP, /allow-popups|allow-same-origin/);
  // Another signed-in user, no session at all, a forged signature, another conversation, expiry.
  assert.equal((await fetch(r.base + relativeUrl, { headers: { cookie: b.cookie } })).status, 403);
  assert.equal((await fetch(r.base + relativeUrl)).status, 403);
  assert.equal(
    (
      await fetch(r.base + relativeUrl.replace(/s=[^&]+/, "s=AAAA"), {
        headers: { cookie: a.cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(r.base + relativeUrl.replace("c=conv-a", "c=conv-b"), {
        headers: { cookie: a.cookie },
      })
    ).status,
    404,
  );
  now = expiresAt + 1;
  assert.equal((await fetch(r.base + relativeUrl, { headers: { cookie: a.cookie } })).status, 403);
  now = Date.now();
  // Deleted conversation: the page is gone with it.
  await storeRef!.mutate(a.id, "conv-a", (c) => void (c.deletedAt = new Date().toISOString()));
  assert.equal((await fetch(r.base + relativeUrl, { headers: { cookie: a.cookie } })).status, 404);
  assert.equal(
    (await r.as(a.cookie, "/api/renders/url", { method: "POST", json: { attachmentId } })).status,
    404,
  );
});

// Real browser, required in CI: the render browser blocks the network (with and without the
// page CSP), and the card (a sandboxed same-origin iframe, as upstream's HtmlRenderDocument)
// shows the page while every network attempt from it fails.
const chromiumPath = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));
const asRoot = process.getuid?.() === 0;
test(
  "browser: render browser and card render the page; network attempts fail",
  { skip: chromiumPath || process.env.CI ? false : "no Chromium found", timeout: 120_000 },
  async (t) => {
    assert.ok(chromiumPath, "Chromium is required in CI (set CHROMIUM_PATH)");
    let hits = 0;
    const canary = createServer((_q, res) => {
      hits++;
      res.end("canary");
    });
    canary.listen(0, "127.0.0.1");
    await once(canary, "listening");
    t.after(() => canary.close());
    const cport = (canary.address() as { port: number }).port;
    const leak = `http://127.0.0.1:${cport}`;
    const hostile = `<!doctype html><html><head><link rel="stylesheet" href="${leak}/css"><link rel="prefetch" href="${leak}/prefetch"></head><body>
<h1 id="title" style="height:420px">Quarterly chart</h1>
<img src="${leak}/img"><iframe src="${leak}/frame"></iframe><video src="${leak}/video"></video>
<form action="${leak}/form" method="post"><button id="b">go</button></form>
<script src="${leak}/script.js"></script>
<script>
const results = {};
const done = (k, v) => { results[k] = v; console.log(k + ":" + v); };
fetch("${leak}/fetch").then(() => done("fetch", "ok"), () => done("fetch", "blocked"));
fetch("/api/conversations", { credentials: "include" }).then(() => done("api", "ok"), () => done("api", "blocked"));
try { const w = new WebSocket("${leak.replace("http", "ws")}/ws"); w.onopen = () => done("ws", "ok"); w.onerror = () => done("ws", "blocked"); } catch { done("ws", "blocked"); }
try { new EventSource("${leak}/sse").onerror = () => done("sse", "blocked"); } catch { done("sse", "blocked"); }
navigator.sendBeacon && (() => { try { navigator.sendBeacon("${leak}/beacon", "x"); } catch {} })();
try { done("parent", String(window.parent.document.cookie)); } catch { done("parent", "blocked"); }
try { done("cookie", document.cookie || "empty"); } catch { done("cookie", "blocked"); }
try { localStorage.setItem("x", "1"); done("storage", "ok"); } catch { done("storage", "blocked"); }
done("rtc", typeof RTCPeerConnection);
window.results = results;
</script></body></html>`;
    const browserOptions = { executable: chromiumPath!, timeoutMs: 30_000, noSandbox: asRoot };
    // 1. The render browser itself, with the page CSP and (tests only) without it.
    for (const pageCsp of [undefined, ""]) {
      const renderer = new LocalRenderer({
        ...browserOptions,
        ...(pageCsp === undefined ? {} : { pageCsp }),
      });
      const prepared = injectHtmlRenderBootstrap(hostile);
      const out = await renderer.render({
        html: prepared,
        fragment: vendor.HTML_RENDER_MEASURE_FRAGMENT_DARK,
        captureWidth: 728,
        measureWidths: [320, 728],
      });
      assert.ok(out.capture!.png.length > 1000, "screenshot");
      assert.ok(out.capture!.contentHeight >= 420, `contentHeight ${out.capture!.contentHeight}`);
      assert.equal(out.heights!.length, 2);
      const logs = out.consoleMessages.map((m) => m.text).join("\n");
      assert.doesNotMatch(logs, /fetch:ok|ws:ok|api:ok/);
      assert.match(logs, /fetch:blocked/);
      assert.match(logs, /rtc:undefined/);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hits, 0, "the render browser made no network request");

    // 2. The card: the stored page in a sandboxed iframe on the app's own origin.
    const dir = await mkdtemp(join(tmpdir(), "vr-web-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "web"), { recursive: true });
    await writeFile(
      join(dir, "web/index.html"),
      "<!doctype html><html><body><div id=host></div></body></html>",
    );
    const real = new LocalRenderer(browserOptions);
    const r = await apiRig(t, visualFor(real), join(dir, "web"));
    const a = await r.signUp("card@x.example");
    assert.equal(
      (
        await r.as(a.cookie, "/api/conversations", {
          method: "POST",
          json: { id: "conv-card", title: "C" },
        })
      ).status,
      201,
    );
    owners.set("conv-card", a.id);
    const published = JSON.parse(
      (
        await r.v.execute(a.id, "conv-card", {
          id: "k",
          tool: "html_render",
          args: { html: hostile, title: "Chart", height: 600 },
        })
      ).text,
    );
    assert.ok(published.htmlRender.heights?.length, "measured at publish");
    assert.equal(hits, 0);
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const ctx = await browser.newContext();
    const [name, ...value] = a.cookie.split("=");
    await ctx.addCookies([
      { name: name!, value: value.join("="), domain: "127.0.0.1", path: "/", sameSite: "Lax" },
    ]);
    const page = await ctx.newPage();
    const app = await page.goto(r.base + "/");
    assert.match(
      app!.headers()["content-security-policy"]!,
      new RegExp(`frame-src 127\\.0\\.0\\.1:${r.port}/render/;`),
    );
    // What the client does: mint (with the client header), then frame it like HtmlRenderDocument.
    const state = (await page.evaluate(`(async () => {
      const minted = await (await fetch("/api/renders/url", {
        method: "POST",
        headers: { "content-type": "application/json", "x-linguini-client": "1" },
        body: JSON.stringify({ attachmentId: ${JSON.stringify(published.htmlRender.attachmentId)} }),
      })).json();
      const heights = [];
      window.addEventListener("message", (e) => {
        if (e.data && e.data.method === "ui/notifications/size-changed") heights.push(e.data.params.height);
      });
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      frame.style.width = "728px";
      frame.style.height = "600px";
      frame.src = minted.relativeUrl + ${JSON.stringify(vendor.HTML_RENDER_MEASURE_FRAGMENT_DARK)};
      document.getElementById("host").append(frame);
      await new Promise((res) => frame.addEventListener("load", res, { once: true }));
      await new Promise((res) => setTimeout(res, 1500));
      return { heights, url: minted.relativeUrl };
    })()`)) as { heights: number[]; url: string };
    const frame = page.frameLocator("iframe");
    assert.equal(await frame.locator("#title").textContent(), "Quarterly chart");
    const results = (await page.frames()[1]!.evaluate("window.results")) as Record<string, string>;
    assert.equal(results.fetch, "blocked");
    assert.equal(results.api, "blocked");
    assert.equal(results.ws, "blocked");
    assert.equal(results.parent, "blocked", "opaque origin: no access to the app");
    assert.notEqual(results.storage, "ok");
    assert.ok(
      state.heights.some((h) => h >= 420),
      `size-changed from the bootstrap: ${state.heights}`,
    );
    await frame
      .locator("#b")
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(300);
    assert.equal(hits, 0, "the card made no network request");
    // The page URL opened top-level is still sandboxed (opaque origin), never the app's origin.
    const top = await ctx.newPage();
    const resp = await top.goto(r.base + state.url);
    assert.equal(resp!.headers()["content-security-policy"], RENDER_CSP);
    assert.equal(
      await top.evaluate(
        "(() => { try { return String(localStorage.length); } catch { return 'blocked'; } })()",
      ),
      "blocked",
    );
    assert.equal(hits, 0);
  },
);

test(
  "postgres render store: owner-checked insert, idempotent id, quota, cascade with the conversation",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { PostgresStore, initial } = await import("./store.ts");
    const { PostgresRenderStore } = await import("./visual.ts");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const store = await PostgresStore.open(process.env.TEST_DATABASE_URL!);
    const renders = await PostgresRenderStore.open(process.env.TEST_DATABASE_URL!);
    try {
      const owner = `vr-${randomUUID()}`;
      const id = `vr-${randomUUID()}`;
      await store.create(initial(id, owner));
      const rid = () => `${randomBytes(16).toString("hex")}-html`;
      const row = {
        id: rid(),
        owner,
        conversationId: id,
        title: "T",
        height: 300,
        heights: [[320, 400]] as Array<[number, number]>,
        html: "<p>x</p>",
      };
      const saved = await renders.put(row, 1000);
      assert.equal(saved.bytes, 8);
      assert.deepEqual(saved.heights, [[320, 400]]);
      assert.equal((await renders.put(row, 1000)).id, row.id, "same id: the existing page");
      await assert.rejects(
        renders.put({ ...row, id: rid(), owner: "someone-else" }, 1000),
        (e) => (e as ApiError).status === 404,
      );
      await assert.rejects(
        renders.put({ ...row, id: rid(), html: "y".repeat(1000) }, 1000),
        (e) => (e as ApiError).code === "render_quota",
      );
      assert.equal(await renders.usage(owner), 8);
      await store.mutate(owner, id, (c) => void (c.deletedAt = new Date().toISOString()));
      await store.purge(owner, id);
      assert.equal(await renders.get(row.id), null);
      assert.equal(await renders.usage(owner), 0);
    } finally {
      await renders.close();
      await store.close();
    }
  },
);

test("render worker socket: jobs over a unix socket, validated, errors reported", async (t) => {
  const { createRenderWorker, SocketRenderer } = await import("./render-worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "vr-sock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jobs: RenderJob[] = [];
  const server = createRenderWorker(fakeRenderer(jobs));
  const socket = join(dir, "r.sock");
  server.listen(socket);
  await once(server, "listening");
  t.after(() => server.close());
  const client = new SocketRenderer(socket);
  const out = await client.render({ html: "<p>x</p>", fragment: "#t", measureWidths: [320] });
  assert.deepEqual(out.heights, [[320, 4680]]);
  await assert.rejects(
    client.render({ html: "<p>x</p>", fragment: "no-hash" }),
    /invalid fragment/,
  );
  await assert.rejects(
    client.render({ html: "x", fragment: "#", captureWidth: 99_999 }),
    /invalid width/,
  );
  await assert.rejects(
    new SocketRenderer(join(dir, "none.sock")).render({ html: "x", fragment: "#" }),
    /unavailable/,
  );
  assert.equal(jobs.length, 1);
});
