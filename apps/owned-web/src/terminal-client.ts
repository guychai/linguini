import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";

/**
 * T3's terminal RPCs mapped onto the owned backend. Commands are POSTs to
 * /api/conversations/:id/terminal/:op; attach/observe and the metadata/event streams are
 * WebSockets at /api/terminal-stream. The shell runs inside the conversation's sandbox, always
 * at /workspace: client cwd, worktree, env and provider options are not forwarded (the backend
 * accepts none of them). Terminal I/O never goes to Pi.
 */
export const TERMINAL_COMMANDS = [
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.clear",
  "terminal.restart",
  "terminal.close",
] as const;
export const TERMINAL_STREAMS = [
  "terminal.attach",
  "terminal.observe",
  "subscribeTerminalMetadata",
  "subscribeTerminalEvents",
] as const;
export interface TerminalDeps {
  fetch: typeof fetch;
  token: () => string;
  WebSocket: typeof WebSocket;
  location: { protocol: string; host: string };
}
const pick = (input: Record<string, any>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
function checkLocation(input: Record<string, any>) {
  if (input.worktreePath)
    throw new Error("Worktree terminals are unavailable; the shell runs in the sandbox /workspace");
}
export async function terminalCommand(
  tag: string,
  input: Record<string, any>,
  deps: TerminalDeps,
): Promise<unknown> {
  const op = tag.slice("terminal.".length);
  let payload: Record<string, unknown>;
  switch (tag) {
    case "terminal.open":
    case "terminal.restart":
      checkLocation(input);
      payload = pick(input, ["terminalId", "cols", "rows"]);
      break;
    case "terminal.write":
      payload = pick(input, ["terminalId", "data"]);
      break;
    case "terminal.resize":
      payload = pick(input, ["terminalId", "cols", "rows"]);
      break;
    case "terminal.clear":
    case "terminal.close":
      payload = pick(input, ["terminalId"]);
      break;
    default:
      throw new Error(`Unsupported terminal command: ${tag}`);
  }
  const token = deps.token();
  const response = await deps.fetch(
    `/api/conversations/${encodeURIComponent(String(input.threadId))}/terminal/${op}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    },
  );
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(String(value.error ?? `Terminal request failed (${response.status})`));
  return tag === "terminal.open" || tag === "terminal.restart" ? value : undefined;
}
export function terminalStreamUrl(
  tag: string,
  input: Record<string, any>,
  location: TerminalDeps["location"],
) {
  const params = new URLSearchParams();
  if (tag === "terminal.attach" || tag === "terminal.observe") {
    checkLocation(input);
    params.set("kind", tag === "terminal.attach" ? "attach" : "observe");
    params.set("threadId", String(input.threadId));
    params.set("terminalId", String(input.terminalId));
    for (const k of ["cols", "rows"])
      if (typeof input[k] === "number") params.set(k, String(input[k]));
  } else if (tag === "subscribeTerminalMetadata") params.set("kind", "metadata");
  else if (tag === "subscribeTerminalEvents") params.set("kind", "events");
  else throw new Error(`Unsupported terminal stream: ${tag}`);
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal-stream?${params}`;
}
/** A WebSocket-backed stream; the socket closes when the stream is released. */
export function terminalStream(
  tag: string,
  input: Record<string, any>,
  deps: TerminalDeps,
): Stream.Stream<unknown, Error> {
  let url: string;
  try {
    url = terminalStreamUrl(tag, input, deps.location);
  } catch (error) {
    return Stream.fail(error as Error);
  }
  return Stream.callback<unknown, Error>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const token = deps.token();
        const ws = new deps.WebSocket(url, token ? [`t3.bearer.${token}`] : []);
        let failed = false;
        ws.onmessage = (event) => {
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (value.type === "stream-error") {
            failed = true;
            Queue.failCauseUnsafe(queue, Cause.fail(new Error(String(value.message))));
            return;
          }
          Queue.offerUnsafe(queue, value);
        };
        ws.onclose = () => {
          if (!failed)
            Queue.failCauseUnsafe(queue, Cause.fail(new Error("Terminal stream closed")));
        };
        return ws;
      }),
      (ws) => Effect.sync(() => ws.close()),
    ).pipe(Effect.asVoid),
  );
}
