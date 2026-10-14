/**
 * The render worker process (infra/hosting/linguini-render.service): headless Chromium as the
 * dedicated non-root user `linguini-render`, Chrome's sandbox on, one fresh profile per job, CDP
 * over a pipe. Env: RENDER_SOCKET (default /run/linguini-render/render.sock), CHROMIUM_PATH
 * (default /opt/chrome-headless-shell/current/chrome-headless-shell), RENDER_CONCURRENCY (2), RENDER_TIMEOUT_MS (20000).
 */
import { chmod, rm } from "node:fs/promises";
import { createRenderWorker, LocalRenderer } from "./render-worker.ts";

if (process.getuid?.() === 0) {
  console.error("render worker refuses to run as root (Chrome's sandbox must stay on)");
  process.exit(1);
}
const socket = process.env.RENDER_SOCKET ?? "/run/linguini-render/render.sock";
const renderer = new LocalRenderer(
  {
    executable:
      process.env.CHROMIUM_PATH ?? "/opt/chrome-headless-shell/current/chrome-headless-shell",
    timeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 20_000),
  },
  Number(process.env.RENDER_CONCURRENCY ?? 2),
);
await rm(socket, { force: true });
const server = createRenderWorker(renderer);
server.listen(socket, async () => {
  // Owner (linguini-render) and group (the backend is in it): no one else.
  await chmod(socket, 0o660);
  console.log(`render worker listening on ${socket}`);
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
