/**
 * /api/projects* routes (V1.4a; spec §8.2), mounted by api.ts only when PROJECTS=1.
 * Cookie- or token-authenticated like every /api route; `owner` is the caller.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { body } from "./gateway.ts";
import { ApiError } from "./store.ts";
import type { ProjectService } from "./projects.ts";

const ID = "([A-Za-z0-9_-]{1,100})";
export async function projectHttp(
  projects: ProjectService,
  owner: string,
  request: IncomingMessage,
  url: URL,
  json: (status: number, value: unknown) => void,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/api/projects" && !path.startsWith("/api/projects/")) return false;
  const m = request.method;
  // An empty body counts as {} (join links and joins take no required fields).
  const input = async () =>
    request.headers["content-length"] === "0" ||
    (!request.headers["content-length"] && !request.headers["transfer-encoding"])
      ? {}
      : await body(request);
  let r: RegExpExecArray | null;
  if (path === "/api/projects") {
    if (m === "GET") return (json(200, { projects: await projects.list(owner) }), true);
    if (m === "POST") return (json(201, await projects.create(owner, await input())), true);
    throw new ApiError(405, "Method not allowed");
  }
  if ((r = new RegExp(`^/api/projects/join/([A-Za-z0-9_-]{1,100})$`).exec(path))) {
    if (m !== "POST") throw new ApiError(405, "Method not allowed");
    return (json(200, await projects.join(owner, r[1]!)), true);
  }
  if ((r = new RegExp(`^/api/projects/${ID}$`).exec(path))) {
    if (m === "GET") return (json(200, await projects.get(owner, r[1]!)), true);
    if (m === "POST") return (json(200, await projects.update(owner, r[1]!, await input())), true);
    throw new ApiError(405, "Method not allowed");
  }
  if ((r = new RegExp(`^/api/projects/${ID}/members$`).exec(path))) {
    if (m === "GET") return (json(200, { members: await projects.members(owner, r[1]!) }), true);
    if (m === "POST") return (json(201, await projects.invite(owner, r[1]!, await input())), true);
    throw new ApiError(405, "Method not allowed");
  }
  if ((r = new RegExp(`^/api/projects/${ID}/members/([^/]{1,200})$`).exec(path))) {
    if (m !== "DELETE") throw new ApiError(405, "Method not allowed");
    return (json(200, await projects.remove(owner, r[1]!, decodeURIComponent(r[2]!))), true);
  }
  if ((r = new RegExp(`^/api/projects/${ID}/join-link$`).exec(path))) {
    if (m !== "POST") throw new ApiError(405, "Method not allowed");
    return (json(200, await projects.rotateJoinLink(owner, r[1]!, await input())), true);
  }
  if ((r = new RegExp(`^/api/projects/${ID}/threads$`).exec(path))) {
    if (m !== "GET") throw new ApiError(405, "Method not allowed");
    return (json(200, { threads: await projects.threads(owner, r[1]!) }), true);
  }
  throw new ApiError(404, "Not found");
}
