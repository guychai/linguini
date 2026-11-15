// The click-through page for external links in generated content (`/out?u=<url>`). It shows the
// full URL, with its host called out, and leaves the app only when the user clicks Continue. It
// is not a redirect: nothing navigates on its own, so a link in a reply cannot send the browser
// (or data in its query string) anywhere without the user seeing the address first. The web UI
// rewrites external links to it (apps/web/src/lib/externalLinks.ts).
import type { ServerResponse } from "node:http";

export const CLICK_THROUGH_PATH = "/out";
const MAX_URL = 8192;
/** No script, no external anything; the inline style is the only resource. */
export const CLICK_THROUGH_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The target URL when it is an http(s) URL Linguini will offer, else null. */
export function clickThroughTarget(raw: string | null): URL | null {
  if (!raw || raw.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url;
}

export function clickThroughPage(raw: string | null): { status: number; html: string } {
  const url = clickThroughTarget(raw);
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1rem;color:#111}code{display:block;word-break:break-all;white-space:pre-wrap;background:#f4f4f5;border:1px solid #d4d4d8;border-radius:6px;padding:.75rem;font-size:14px}.host{font-weight:600}.row{display:flex;gap:1rem;margin-top:1.5rem}a.btn{padding:.5rem 1rem;border-radius:6px;border:1px solid #a1a1aa;color:inherit;text-decoration:none}a.go{background:#111;color:#fff;border-color:#111}@media(prefers-color-scheme:dark){body{background:#09090b;color:#e4e4e7}code{background:#18181b;border-color:#3f3f46}a.go{background:#e4e4e7;color:#09090b;border-color:#e4e4e7}}</style></head><body>${body}</body></html>`;
  if (!url)
    return {
      status: 400,
      html: page(
        "Link not allowed",
        `<h1>This link can't be opened</h1><p>Only plain http and https addresses (without a username or password) can be opened from a conversation.</p><div class="row"><a class="btn" href="/">Back to Linguini</a></div>`,
      ),
    };
  const href = url.href;
  return {
    status: 200,
    html: page(
      `Leaving Linguini: ${escape(url.host)}`,
      `<h1>You're leaving Linguini</h1><p>This link from a conversation goes to <span class="host">${escape(url.host)}</span>. Check the full address before you continue; anything in it is sent to that site.</p><code>${escape(href)}</code><div class="row"><a class="btn go" href="${escape(href)}" rel="noopener noreferrer" referrerpolicy="no-referrer">Continue to ${escape(url.host)}</a><a class="btn" href="/">Back to Linguini</a></div>`,
    ),
  };
}

export function serveClickThrough(response: ServerResponse, raw: string | null) {
  const { status, html } = clickThroughPage(raw);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": CLICK_THROUGH_CSP,
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  });
  response.end(html);
}
