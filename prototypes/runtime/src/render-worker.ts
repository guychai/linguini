/**
 * The render worker and its clients.
 *
 * Production: `render-worker-main.ts` runs as its own non-root system user (linguini-render, no
 * login, no access to the backend's config or data) in an empty network namespace, and listens
 * on a unix socket that only the backend's group can open. The backend sends a prepared page and
 * gets heights / a screenshot back; it never runs Chromium itself.
 *
 * Limits here (the backend adds per-user ones): request size, a global concurrency cap with a
 * short queue, and a per-job timeout.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { MAX_PAGE_BYTES, MAX_PREVIEW_WIDTH, MIN_PREVIEW_WIDTH } from "./html-render.ts";
import {
  runRenderJob,
  type BrowserOptions,
  type RenderJob,
  type RenderOutput,
} from "./render-browser.ts";

export interface Renderer {
  render(job: RenderJob): Promise<RenderOutput>;
}

/** A counting semaphore with a bounded queue. */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly limit: number,
    private readonly maxQueue = Infinity,
  ) {}
  get busy() {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueue) throw new Error("render queue is full");
      // The slot is handed over by the job that finishes (active is not decremented then).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const MAX_WIDTHS = 24;
/** Checks a job from the wire (the backend is trusted, but the worker keeps its own limits). */
export function validJob(value: unknown): RenderJob {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") throw new Error("invalid job");
  if (typeof v.html !== "string" || Buffer.byteLength(v.html) > MAX_PAGE_BYTES)
    throw new Error("invalid html");
  if (typeof v.fragment !== "string" || v.fragment.length > 16_384 || !v.fragment.startsWith("#"))
    throw new Error("invalid fragment");
  const width = (w: unknown) =>
    typeof w === "number" &&
    Number.isInteger(w) &&
    w >= MIN_PREVIEW_WIDTH - 80 &&
    w <= MAX_PREVIEW_WIDTH;
  if (v.captureWidth !== undefined && !width(v.captureWidth)) throw new Error("invalid width");
  if (
    v.measureWidths !== undefined &&
    (!Array.isArray(v.measureWidths) ||
      v.measureWidths.length > MAX_WIDTHS ||
      !v.measureWidths.every(width))
  )
    throw new Error("invalid widths");
  return {
    html: v.html,
    fragment: v.fragment,
    ...(v.captureWidth === undefined ? {} : { captureWidth: v.captureWidth as number }),
    ...(v.measureWidths === undefined ? {} : { measureWidths: v.measureWidths as number[] }),
  };
}

/** Runs Chromium in this process (the worker itself; tests). */
export class LocalRenderer implements Renderer {
  private readonly gate: Gate;
  constructor(
    private readonly browser: BrowserOptions,
    concurrency = 2,
    maxQueue = 8,
  ) {
    this.gate = new Gate(concurrency, maxQueue);
  }
  render(job: RenderJob) {
    return this.gate.run(() => runRenderJob(validJob(job), this.browser));
  }
}

/** The worker's HTTP-over-unix-socket server: POST /render {job} -> RenderOutput. */
export function createRenderWorker(renderer: Renderer): Server {
  const limit = MAX_PAGE_BYTES * 2 + 65_536;
  return createServer((req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || req.url !== "/render") return reply(404, { error: "not found" });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reply(413, { error: "job too large" });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", async () => {
      if (size > limit) return;
      try {
        const job = validJob(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        reply(200, await renderer.render(job));
      } catch (e) {
        reply(422, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}

/** The backend's client for the worker socket. */
export class SocketRenderer implements Renderer {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 60_000,
  ) {}
  render(job: RenderJob): Promise<RenderOutput> {
    const payload = JSON.stringify(job);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path: "/render",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode === 200) resolve(value as RenderOutput);
              else
                reject(
                  new Error(String(value.error ?? `render worker answered ${res.statusCode}`)),
                );
            } catch {
              reject(new Error("render worker sent an invalid reply"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("render worker timed out")));
      req.on("error", (e) => reject(new Error(`render worker unavailable: ${e.message}`)));
      req.end(payload);
    });
  }
}
