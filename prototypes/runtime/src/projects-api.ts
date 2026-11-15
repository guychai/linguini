/**
 * /api/projects* routes, mounted by api.ts whenever projects are configured (Postgres auth).
 * Cookie- or token-authenticated like every /api route; `owner` is the caller.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { body } from "./http-body.ts";
import { ApiError } from "./store.ts";
import type { ProjectService } from "./projects.ts";
import type { ProjectArtifacts } from "./project-store.ts";
import type { SharedThreads } from "./shared-threads.ts";

const ID = "([A-Za-z0-9_-]{1,100})";
export async function projectHttp(
  projects: ProjectService,
  owner: string,
  request: IncomingMessage,
  url: URL,
  json: (status: number, value: unknown) => void,
  artifacts?: ProjectArtifacts,
  shared?: SharedThreads,
): Promise<boolean> {
  const path = url.pathname;
  const m = request.method;
  const grant = new RegExp(`^/api/conversations/${ID}/grants$`).exec(path);
  if (grant && artifacts) {
    if (m !== "POST") throw new ApiError(405, "Method not allowed");
    json(200, await artifacts.grant(owner, grant[1]!, await body(request)));
    return true;
  }
  if (path !== "/api/projects" && !path.startsWith("/api/projects/")) return false;
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
  const storeRoute = new RegExp(`^/api/projects/${ID}/store(?:/${ID})?$`).exec(path);
  if (storeRoute) {
    if (!artifacts) throw new ApiError(404, "Not found");
    const [, id, artifactId] = storeRoute;
    if (!artifactId && m === "GET")
      return (json(200, { artifacts: await artifacts.list(owner, id!) }), true);
    if (!artifactId && m === "POST")
      return (json(201, await artifacts.write(owner, id!, await body(request, 4_000_000))), true);
    if (artifactId && m === "DELETE")
      return (json(200, await artifacts.remove(owner, id!, artifactId)), true);
    throw new ApiError(405, "Method not allowed");
  }
  // A member's read-only view of a project thread (shared-threads.ts); 404 unless allowed.
  if ((r = new RegExp(`^/api/projects/${ID}/threads/([^/]{1,200})/${ID}$`).exec(path))) {
    if (m !== "GET") throw new ApiError(405, "Method not allowed");
    if (!shared) throw new ApiError(404, "Not found");
    await projects.get(owner, r[1]!);
    const view = await shared.view(owner, decodeURIComponent(r[2]!), r[3]!);
    if (view.projectId !== r[1]) throw new ApiError(404, "Conversation not found");
    return (json(200, view), true);
  }
  if ((r = new RegExp(`^/api/projects/${ID}/threads$`).exec(path))) {
    if (m !== "GET") throw new ApiError(405, "Method not allowed");
    return (json(200, { threads: await projects.threads(owner, r[1]!) }), true);
  }
  throw new ApiError(404, "Not found");
}
