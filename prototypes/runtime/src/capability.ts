import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./store.ts";

export function issueCapability(key: string, owner: string, id: string): string {
  const body = Buffer.from(JSON.stringify({ owner, id })).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
export function verifyCapability(key: string, token: string) {
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new ApiError(401, "Invalid sandbox capability");
  const expected = createHmac("sha256", key).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new ApiError(401, "Invalid sandbox capability");
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  if (
    typeof parsed.owner !== "string" ||
    typeof parsed.id !== "string" ||
    !parsed.owner ||
    !parsed.id
  )
    throw new ApiError(401, "Invalid sandbox capability");
  return { owner: parsed.owner, id: parsed.id };
}
