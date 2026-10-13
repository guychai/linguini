import WebSocket from "ws";
import type { ExecChannel, ExecConnector, ExecHandlers } from "./terminal.ts";

/**
 * Nomad's allocation exec WebSocket with a TTY (`/v1/client/allocation/:id/exec`). The process
 * runs inside the sandbox task with the task's own environment; nothing from the backend's
 * environment is sent. Nomad is reached on loopback only.
 */
export class NomadExecConnector implements ExecConnector {
  constructor(
    private readonly addr = "http://127.0.0.1:4646",
    private readonly task = "hands",
  ) {}
  open(
    allocId: string,
    command: string[],
    size: { cols: number; rows: number },
    handlers: ExecHandlers,
  ): Promise<ExecChannel> {
    if (!/^[0-9a-f-]{36}$/.test(allocId)) return Promise.reject(new Error("invalid allocation id"));
    const url = new URL(`/v1/client/allocation/${allocId}/exec`, this.addr);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("task", this.task);
    url.searchParams.set("tty", "true");
    url.searchParams.set("command", JSON.stringify(command));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let opened = false;
      let done = false;
      const finish = (code: number | null, error?: string) => {
        if (done) return;
        done = true;
        handlers.onExit(code, error);
      };
      const send = (m: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      };
      ws.on("open", () => {
        opened = true;
        send({ tty_size: { height: size.rows, width: size.cols } });
        resolve({
          write: (data) => send({ stdin: { data: Buffer.from(data, "utf8").toString("base64") } }),
          resize: (cols, rows) => send({ tty_size: { height: rows, width: cols } }),
          close: () => {
            done = true;
            send({ stdin: { close: true } });
            ws.close();
          },
        });
      });
      const decoder = new TextDecoder("utf-8");
      ws.on("message", (raw) => {
        let m: {
          stdout?: { data?: string };
          stderr?: { data?: string };
          exited?: boolean;
          result?: { exit_code?: number };
        };
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        for (const part of [m.stdout?.data, m.stderr?.data])
          if (part) {
            const text = decoder.decode(Buffer.from(part, "base64"), { stream: true });
            if (text && !done) handlers.onData(text);
          }
        if (m.exited) finish(m.result?.exit_code ?? null);
      });
      ws.on("error", (error) => {
        if (!opened) reject(new Error(`sandbox exec unavailable: ${error.message}`));
        else finish(null, "connection to sandbox lost");
      });
      ws.on("close", () => finish(null));
    });
  }
}
