/**
 * Visual replies: the `html_preview` and `html_render` tools (upstream T3's names and result
 * shapes, so upstream's HtmlRenderFrame card shows Linguini's renders unchanged).
 *
 * - Pages are self-contained. Neither the render browser nor the viewing card loads anything
 *   but the page itself plus data:/blob: URLs (see RENDER_CSP and render-browser.ts).
 * - Images: absolute `/workspace/...` paths in the page are read from the conversation's own
 *   sandbox through the files API (realpath-confined to /workspace) and inlined as data URIs.
 *   Nothing is ever read from the host.
 * - The theme bootstrap is upstream's, vendored in html-render-vendor.ts.
 */
import {
  HTML_RENDER_BOOTSTRAP_STYLE_AND_SCRIPT,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
} from "./html-render-vendor.ts";
import { ApiError } from "./store.ts";

export {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
} from "./html-render-vendor.ts";

const MIB = 1024 * 1024;
/** The agent's HTML (characters), as upstream. */
export const MAX_HTML_CHARS = 512_000;
/** One inlined image. */
export const MAX_IMAGE_BYTES = 5 * MIB;
/** The stored page with its images inlined. */
export const MAX_PAGE_BYTES = 8 * MIB;
export const MAX_IMAGES_PER_PAGE = 32;
export const MIN_PREVIEW_WIDTH = 240;
export const MAX_PREVIEW_WIDTH = 1_600;

/**
 * The served page's policy (and the card's): scripts and styles only inline or from data:/blob:,
 * images only data:/blob:, fonts only data:, no fetch/XHR/WebSocket/EventSource, no frames, no
 * form posts, no base URL. `sandbox` gives the page an opaque origin (never Linguini's).
 */
export const RENDER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; " +
  "img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; " +
  "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; " +
  "sandbox allow-scripts allow-forms";

export const clampHtmlRenderHeight = (height: number) =>
  Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));

const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script> (or data: URIs). The page has no network: http(s) URLs, CDNs, web fonts, fetch, XHR and WebSockets all fail, so inline any library you need. Sandbox images written as absolute paths under /workspace (src="/workspace/out/chart.png", CSS url(/workspace/bg.webp), or a JS string) are inlined automatically; other paths are not read.';

export const HTML_TOOL_DESCRIPTIONS = {
  html_preview: `Render an HTML page in Linguini's headless browser (no network) and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. ${PAGE_RULES} The page gets the theme variables and layout described in html_render.`,
  html_render: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this conversation, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with html_preview first. The frame fits the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE.replace("T3 injects", "Linguini injects")}`,
} as const;
export const HTML_PARAM_DESCRIPTIONS = {
  html: "A complete, self-contained HTML document.",
  width: `Viewport width in CSS pixels, ${MIN_PREVIEW_WIDTH}-${MAX_PREVIEW_WIDTH}. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use about 390 to check phones.`,
  appearance: "Theme to preview: dark or light. Defaults to dark.",
  title: "Short name for the page.",
  height: `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.`,
} as const;

export const RENDER_RESULT_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

export function validHtml(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new ApiError(400, "html is required");
  if (value.length > MAX_HTML_CHARS)
    throw new ApiError(413, `html is ${value.length} characters; the limit is ${MAX_HTML_CHARS}`);
  return value;
}
export function validTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, "title is required");
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML"
  );
}
export function validWidth(value: unknown): number {
  if (value === undefined || value === null) return HTML_RENDER_COLUMN_WIDTH;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ApiError(400, "width must be a number");
  return Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, Math.round(value)));
}
export function validFrameHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ApiError(400, "height must be a number");
  return clampHtmlRenderHeight(value);
}

// ---- Theme bootstrap (same logic as upstream's injectHtmlRenderBootstrap; drift-tested) ----

function bootstrapMarkup(markup: string): string {
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    HTML_RENDER_BOOTSTRAP_STYLE_AND_SCRIPT,
  ].join("");
}
// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};
/** Inserts the theme bootstrap at the start of the document head. */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

// ---- Sandbox images ----

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// Upstream's pattern (a whole quoted string or an unquoted CSS url(...)), POSIX paths only.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(/(?!/)(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(/(?!/)[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);
export interface ImageReference {
  start: number;
  end: number;
  path: string;
}
export function findLocalImages(html: string): ImageReference[] {
  return Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });
}
/** `/workspace/a/b.png` -> `a/b.png`; anything else (host paths) -> null, never read. */
export function workspaceRelative(path: string): string | null {
  if (!path.startsWith("/workspace/")) return null;
  const rel = path.slice("/workspace/".length);
  if (!rel || /[\u0000-\u001f\u007f\\]/.test(rel)) return null;
  if (rel.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  return rel;
}
const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));
/** Whether bytes are an image whatever the file is named (a renamed secret is not inlined). */
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  )
    return true;
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
}
const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};
const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};
const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

/** Reads one image from the conversation's sandbox (files API), or null if missing. */
export type SandboxImageReader = (relativePath: string, maxBytes: number) => Promise<Buffer | null>;

/**
 * The page as stored and rendered: bootstrap first (so its head scan never runs over image data),
 * then each `/workspace/...` image inlined. Paths that are missing, not images, or outside
 * /workspace stay as written (and so fail to load: the page has no network) and are reported.
 */
export async function preparePage(
  html: string,
  readImage: SandboxImageReader,
): Promise<{ html: string; missing: string[] }> {
  const page = injectHtmlRenderBootstrap(html);
  const references = findLocalImages(page);
  const paths = [...new Set(references.map((r) => r.path))];
  if (paths.length > MAX_IMAGES_PER_PAGE)
    throw new ApiError(
      413,
      `The page references ${paths.length} images; the limit is ${MAX_IMAGES_PER_PAGE}.`,
    );
  const uris = new Map<string, string>();
  let total = Buffer.byteLength(page);
  for (const path of paths) {
    const rel = workspaceRelative(path);
    if (rel === null) continue;
    const bytes = await readImage(rel, MAX_IMAGE_BYTES);
    if (!bytes || !isImageBytes(bytes)) continue;
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const uri = `data:${IMAGE_MIME_TYPES[ext] ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
    total += uri.length * references.filter((r) => r.path === path).length;
    if (total > MAX_PAGE_BYTES)
      throw new ApiError(
        413,
        `With its images inlined the page is over ${MAX_PAGE_BYTES / MIB} MiB. Use smaller images.`,
      );
    uris.set(path, uri);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const r of references) {
    const uri = uris.get(r.path);
    if (uri === undefined) continue;
    parts.push(page.slice(cursor, r.start), uri);
    cursor = r.end;
  }
  parts.push(page.slice(cursor));
  const out = parts.join("");
  if (Buffer.byteLength(out) > MAX_PAGE_BYTES)
    throw new ApiError(413, `The page is over ${MAX_PAGE_BYTES / MIB} MiB. Use smaller images.`);
  return { html: out, missing: paths.filter((p) => !uris.has(p)) };
}
