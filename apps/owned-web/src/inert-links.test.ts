// V1.0b (P0.3): links in a sensitive thread render as inert text with the URL visible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  inertLinkLabel,
  isExternalGeneratedHref,
  isGeneratedContentTainted,
  subscribeGeneratedContentTaint,
} from "../../web/src/lib/generatedContentTaint.ts";
import { projection } from "./projection.ts";
import {
  inertGeneratedLink,
  INERT_LINK_TITLE,
} from "../../web/src/components/chat/linguiniGeneratedLinks.tsx";

const conv = (id: string, tainted: boolean) =>
  ({
    id,
    title: "t",
    tainted,
    jobs: [],
    events: [],
    metadata: {},
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    sandboxAllocated: false,
    toolOutcomesUnknown: [],
  }) as never;

test("projection feeds the sensitive-thread store; it only ever turns on", () => {
  let notified = 0;
  const off = subscribeGeneratedContentTaint(() => notified++);
  projection(conv("clean-1", false));
  assert.equal(isGeneratedContentTainted("clean-1"), false);
  projection(conv("sens-1", true));
  assert.equal(isGeneratedContentTainted("sens-1"), true);
  assert.equal(notified, 1);
  projection(conv("sens-1", true));
  projection(conv("sens-1", false)); // a stale snapshot never clears it
  assert.equal(isGeneratedContentTainted("sens-1"), true);
  assert.equal(notified, 1, "no repeat notifications");
  assert.equal(isGeneratedContentTainted(undefined), false);
  off();
});

test("only links that leave the app are inerted", () => {
  for (const h of ["https://x.example/a?b=1", "http://x", "mailto:a@b", "//x.example/p", " HTTPS://X "])
    assert.equal(isExternalGeneratedHref(h), true, h);
  for (const h of ["", undefined, "/workspace/a.ts", "a.ts", "#frag", "?q"])
    assert.equal(isExternalGeneratedHref(h), false, String(h));
  assert.deepEqual(inertLinkLabel("docs", "https://x/y"), { text: "docs", url: "https://x/y" });
  assert.deepEqual(inertLinkLabel("https://x/y", "https://x/y"), { text: "https://x/y", url: null });
  assert.deepEqual(inertLinkLabel("", "https://x/y"), { text: "https://x/y", url: null });
});

test("inert rendering: no <a>, no href, full URL visible; clean threads render the link normally", () => {
  const el = inertGeneratedLink(true, "https://evil.example/leak?d=4711", "click me");
  assert.ok(el);
  const html = renderToStaticMarkup(createElement("div", null, el));
  assert.doesNotMatch(html, /<a[\s>]/);
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /click me/);
  assert.match(html, /https:\/\/evil\.example\/leak\?d=4711/);
  assert.match(html, new RegExp(INERT_LINK_TITLE));
  assert.equal(inertGeneratedLink(false, "https://x", "x"), null, "clean thread");
  assert.equal(inertGeneratedLink(true, "/workspace/a.ts", "a.ts"), null, "in-app link");
  assert.equal(inertGeneratedLink(true, undefined, "x"), null);
});
