import type { IncomingMessage } from "node:http";
import { ApiError } from "./store.ts";

/** A request's JSON object body (max `maxChars`); 413 when too large, 400 when not an object. */
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
