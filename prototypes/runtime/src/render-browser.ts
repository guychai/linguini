/**
 * The render browser: one headless Chromium per job, spoken to over CDP on
 * `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-delimited JSON; no debugging port), with a
 * fresh temporary profile that is removed afterwards. Chrome's sandbox stays on: the worker that
 * calls this runs as its own non-root user (render-worker-main.ts) and never passes --no-sandbox.
 *
 * No network: every request the page makes is paused by Fetch interception and failed, except
 * the page itself (served from PAGE_URL with RENDER_CSP). data:/blob: never reach the network.
 * Belt and braces for what Fetch cannot see (WebSocket, WebRTC, DNS prefetch): a proxy that does
 * not exist, a host resolver that resolves nothing, and RTCPeerConnection removed. In production
 * the worker additionally runs in its own empty network namespace (PrivateNetwork=yes).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { RENDER_CSP } from "./html-render.ts";

export const PAGE_ORIGIN = "http://linguini-page.invalid";
export const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
const PAGE_NAME = "page.html";
const VIEWPORT_HEIGHT = 800;
export const MAX_CAPTURE_HEIGHT = 4_000;
const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const MEASURE_CONCURRENCY = 3;
// Resolves after web fonts load and two frames paint, so late layout lands in the capture.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";

export interface ConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}
export interface RenderJob {
  /** The prepared page (bootstrap injected, images inlined). */
  html: string;
  /** Theme fragment appended to PAGE_URL. */
  fragment: string;
  /** Screenshot at this width (html_preview). */
  captureWidth?: number;
  /** Content height at each width (html_render). */
  measureWidths?: readonly number[];
}
export interface RenderOutput {
  consoleMessages: ConsoleMessage[];
  capture?: { png: string; contentHeight: number; capturedHeight: number; width: number };
  heights?: Array<[number, number]>;
}
export interface BrowserOptions {
  executable: string;
  timeoutMs: number;
  /** Tests only (CI containers without user namespaces). Production never sets it. */
  noSandbox?: boolean;
  /** Tests only: the page's CSP (default RENDER_CSP), to check the browser's own blocking. */
  pageCsp?: string;
}

const CONSOLE_LEVELS: Record<string, ConsoleMessage["level"]> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
};
interface RemoteObject {
  type?: string;
  value?: unknown;
  description?: string;
}
const remoteText = (v: RemoteObject) =>
  typeof v.value === "string"
    ? v.value
    : (v.description ?? (v.value === undefined ? String(v.type) : String(v.value)));

export function browserArgs(profile: string, noSandbox = false): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    "--block-new-web-contents",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--no-pings",
    "--dns-prefetch-disable",
    // Nothing listens there: anything Fetch interception does not pause still cannot leave.
    "--proxy-server=socks5://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ...(noSandbox ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`,
    "about:blank",
  ];
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };
interface PageState {
  mainFrameId: string;
  loaded?: () => void;
  console: ConsoleMessage[];
  omitted: number;
}

/** Runs one job in its own browser; the process group and profile are gone when it returns. */
export async function runRenderJob(job: RenderJob, options: BrowserOptions): Promise<RenderOutput> {
  const profile = await mkdtemp(join(tmpdir(), "linguini-render-"));
  const child = spawn(options.executable, browserArgs(join(profile, "p"), options.noSandbox), {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    detached: true,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile, TMPDIR: profile },
  });
  // The first lines say why a launch failed (e.g. no usable sandbox); a crash dump follows.
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => {
    if (stderr.length < 1024) stderr = (stderr + d.toString()).slice(0, 1024);
  });
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  const pending = new Map<number, Pending & { method: string }>();
  const pages = new Map<string, PageState>();
  const body = Buffer.from(job.html, "utf8").toString("base64");
  let nextId = 0;
  let dead: Error | undefined;
  const fail = (error: Error) => {
    if (dead) return;
    dead = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  child.on("error", (e) => fail(new Error(`the browser could not be started: ${e.message}`)));
  child.on("exit", () =>
    fail(new Error(`the browser exited unexpectedly${stderr ? `: ${stderr.slice(0, 600)}` : ""}`)),
  );
  toChrome.on("error", () => undefined);
  const write = (msg: Record<string, unknown>) => {
    if (!dead) toChrome.write(`${JSON.stringify(msg)}\0`);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (dead) return reject(dead);
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      write({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  const post = (method: string, params: Record<string, unknown>, sessionId: string) =>
    write({ id: ++nextId, method, params, sessionId });
  const onMessage = (raw: string) => {
    let m: {
      id?: number;
      method?: string;
      sessionId?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.error) p.reject(new Error(`${p.method} failed: ${m.error.message}`));
      else p.resolve(m.result ?? {});
      return;
    }
    const page = m.sessionId ? pages.get(m.sessionId) : undefined;
    if (!page || !m.method || !m.sessionId) return;
    const params = m.params ?? {};
    if (m.method === "Page.loadEventFired") return page.loaded?.();
    if (m.method === "Fetch.requestPaused") {
      const request = params.request as { url?: string } | undefined;
      const url = String(request?.url ?? "").split("#", 1)[0];
      if (url === PAGE_URL && params.frameId === page.mainFrameId) {
        post(
          "Fetch.fulfillRequest",
          {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "text/html; charset=utf-8" },
              ...(options.pageCsp === ""
                ? []
                : [{ name: "Content-Security-Policy", value: options.pageCsp ?? RENDER_CSP }]),
            ],
            body,
          },
          m.sessionId,
        );
      } else
        post(
          "Fetch.failRequest",
          { requestId: params.requestId, errorReason: "BlockedByClient" },
          m.sessionId,
        );
      return;
    }
    let message: ConsoleMessage | undefined;
    if (m.method === "Runtime.consoleAPICalled") {
      const level = CONSOLE_LEVELS[String(params.type)];
      const args = (params.args as RemoteObject[] | undefined) ?? [];
      if (level) message = { level, text: args.map(remoteText).join(" ") };
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined;
      if (d) message = { level: "error", text: d.exception?.description ?? String(d.text) };
    } else if (m.method === "Log.entryAdded") {
      const e = params.entry as { level?: string; text?: string; url?: string } | undefined;
      if (e && (e.level === "error" || e.level === "warning"))
        message = { level: e.level, text: e.url ? `${e.text} ${e.url}` : String(e.text) };
    }
    if (!message) return;
    if (page.console.length >= MAX_CONSOLE_MESSAGES) {
      page.omitted += 1;
      return;
    }
    const text = message.text.replaceAll(PAGE_URL, PAGE_NAME);
    page.console.push({
      level: message.level,
      text:
        text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text,
    });
  };
  let partial: Buffer[] = [];
  fromChrome.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      partial.push(chunk.subarray(start, end));
      const raw = Buffer.concat(partial).toString("utf8");
      partial = [];
      start = end + 1;
      onMessage(raw);
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  });
  fromChrome.on("error", () => undefined);

  const exited = new Promise<never>((_, reject) =>
    child.once("exit", () => reject(dead ?? new Error("the browser exited"))),
  );
  exited.catch(() => undefined);
  const openPage = async (width: number) => {
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const state: PageState = { mainFrameId: targetId, console: [], omitted: 0 };
    pages.set(sessionId, state);
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);
    await send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;",
        runImmediately: true,
      },
      sessionId,
    );
    // Every request pauses here: the page is served, everything else fails.
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const load = async () => {
      const loaded = new Promise<void>((resolve) => (state.loaded = resolve));
      const nav = await send("Page.navigate", { url: `${PAGE_URL}${job.fragment}` }, sessionId);
      if (nav.errorText) throw new Error("the page could not be opened");
      await Promise.race([loaded, exited]);
      await send(
        "Runtime.evaluate",
        { expression: SETTLE_EXPRESSION, awaitPromise: true },
        sessionId,
      );
      const measured = (await send(
        "Runtime.evaluate",
        { expression: MEASURE_EXPRESSION, returnByValue: true },
        sessionId,
      )) as { result?: { value?: unknown } };
      const v = Number(measured.result?.value);
      return Number.isFinite(v) ? Math.max(0, Math.ceil(v)) : 0;
    };
    const screenshot = async (height: number) =>
      String(
        (
          await send(
            "Page.captureScreenshot",
            {
              format: "png",
              captureBeyondViewport: true,
              clip: { x: 0, y: 0, width, height, scale: 1 },
            },
            sessionId,
          )
        ).data,
      );
    const consoleMessages = (): ConsoleMessage[] =>
      state.omitted === 0
        ? [...state.console]
        : [
            ...state.console,
            { level: "warning", text: `${state.omitted} more console messages were omitted.` },
          ];
    const close = () => send("Target.closeTarget", { targetId }).catch(() => undefined);
    return { load, screenshot, consoleMessages, close };
  };

  let timer: NodeJS.Timeout | undefined;
  const work = async (): Promise<RenderOutput> => {
    const out: RenderOutput = { consoleMessages: [] };
    if (job.captureWidth !== undefined) {
      const page = await openPage(job.captureWidth);
      const contentHeight = await page.load();
      const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
      out.capture = {
        png: await page.screenshot(capturedHeight),
        contentHeight,
        capturedHeight,
        width: job.captureWidth,
      };
      out.consoleMessages = page.consoleMessages();
      await page.close();
    }
    if (job.measureWidths?.length) {
      const widths = [...job.measureWidths];
      const heights: Array<[number, number]> = [];
      const worker = async () => {
        for (let w = widths.shift(); w !== undefined; w = widths.shift()) {
          const page = await openPage(w);
          try {
            heights.push([w, await page.load()]);
          } finally {
            await page.close();
          }
        }
      };
      await Promise.all(Array.from({ length: MEASURE_CONCURRENCY }, worker));
      out.heights = heights.sort((a, b) => a[0] - b[0]);
    }
    return out;
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`the page did not finish loading within ${options.timeoutMs / 1000}s`),
            ),
          options.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    dead ??= new Error("closed");
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(resolve, 2000);
    });
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
