import { createServer, type IncomingMessage } from "node:http";
import { verifyCapability } from "./capability.ts";
import { ApiError, initial, read } from "./store.ts";
import { SandboxBroker, assertPublicationAllowed, type ToolCall } from "./sandbox.ts";
import { assertNotBlocked } from "./ledger.ts";

export async function body(
  request: IncomingMessage,
  maxChars = 1_000_000,
): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > maxChars) throw new ApiError(413, "Request too large");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Invalid JSON object");
  }
}
export function gateway(broker: SandboxBroker, key: string) {
  if (key.length < 32) throw new Error("Sandbox capability key must be at least 32 characters");
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    try {
      if (request.method === "GET" && request.url === "/health") {
        response.end(JSON.stringify({ ok: true, provider: broker.provider.kind }));
        return;
      }
      const { owner, id } = verifyCapability(
        key,
        request.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      // A scoped capability can create only its own durable sandbox metadata.
      await broker.store.create(initial(id, owner));
      if (request.method === "GET" && request.url === "/status") {
        const c = await read(broker.store, owner, id);
        response.setHeader("cache-control", "no-store");
        response.end(
          JSON.stringify({
            tainted: c.tainted,
            sandboxAllocated: !!c.sandbox,
            sequence: c.events.at(-1)?.seq ?? 0,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/tools") {
        const call = (await body(request)) as unknown as ToolCall;
        const controller = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded) controller.abort();
        });
        response.end(JSON.stringify(await broker.execute(owner, id, call, controller.signal)));
        return;
      }
      if (
        request.method === "POST" &&
        ["/actions/create-pr", "/actions/publish"].includes(request.url ?? "")
      ) {
        // Keyed off the declared publication destination, not a route or tool name.
        await broker.store.mutate(owner, id, (c) => {
          assertNotBlocked(c);
          assertPublicationAllowed(c);
        });
        throw new ApiError(501, "PR and publication integrations are disabled in this prototype");
      }
      throw new ApiError(404, "Unsupported route");
    } catch (error) {
      response.statusCode = error instanceof ApiError ? error.status : 500;
      response.end(
        JSON.stringify({ error: error instanceof ApiError ? error.message : "Internal error" }),
      );
    }
  });
}
