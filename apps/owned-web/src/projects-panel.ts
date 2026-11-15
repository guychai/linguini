// Owned "Projects" settings block (V1.4b), mounted on the settings page through
// uiFlags.settingsExtensions like account-admin.ts. Shown only when the server serves
// /api/projects (PROJECTS=1, off by default until Nick OKs it), so with the flag off the UI is
// unchanged. Threads stay private: the board lists only your own threads in each project.
// Plain DOM, same-origin cookie fetches. Reuses the lg-admin-* styles.
export interface ProjectView {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  archivedAt: string | null;
}
export interface MemberView {
  userId: string;
  role: string;
  joinedAt: string;
}
export interface ThreadView {
  id: string;
  title: string;
  tainted: boolean;
}
type Fetch = typeof fetch;

export class ProjectsClient {
  private readonly fetchFn: Fetch;
  constructor(fetchFn: Fetch = (...a) => fetch(...a)) {
    this.fetchFn = fetchFn;
  }
  private async call(path: string, method = "GET", body?: unknown) {
    const r = await this.fetchFn(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok)
      throw Object.assign(
        new Error(String(data.message ?? data.error ?? `Request failed (${r.status})`)),
        {
          status: r.status,
        },
      );
    return data;
  }
  /** Whether the server has projects (PROJECTS=1). Off: a 404. */
  async enabled() {
    try {
      await this.call("/api/projects");
      return true;
    } catch {
      return false;
    }
  }
  async list() {
    return (await this.call("/api/projects")).projects as ProjectView[];
  }
  async create(name: string) {
    return (await this.call("/api/projects", "POST", { name })) as unknown as ProjectView;
  }
  async members(id: string) {
    return (await this.call(`/api/projects/${enc(id)}/members`)).members as MemberView[];
  }
  async threads(id: string) {
    return (await this.call(`/api/projects/${enc(id)}/threads`)).threads as ThreadView[];
  }
  async invite(id: string, email: string, role: "editor" | "viewer") {
    return this.call(`/api/projects/${enc(id)}/members`, "POST", { email, role });
  }
  async remove(id: string, userId: string) {
    return this.call(`/api/projects/${enc(id)}/members/${enc(userId)}`, "DELETE");
  }
  async joinLink(id: string, role: "editor" | "viewer") {
    const r = await this.call(`/api/projects/${enc(id)}/join-link`, "POST", { role });
    return String(r.path);
  }
  async join(token: string) {
    return (await this.call(
      `/api/projects/join/${enc(token)}`,
      "POST",
      {},
    )) as unknown as ProjectView;
  }
  async archive(id: string) {
    return this.call(`/api/projects/${enc(id)}`, "POST", { archived: true });
  }
  async newThread(projectId: string, title: string) {
    const id = `thread-${crypto.randomUUID()}`;
    await this.call("/api/conversations", "POST", { id, title, projectId });
    return id;
  }
}
const enc = encodeURIComponent;

/** `/join/<token>` opened in the browser: the token, or null. */
export function joinToken(pathname: string) {
  const m = /^\/join\/([A-Za-z0-9_-]{20,100})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

type Props = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...kids: Array<Node | string>
) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}
const btn = (text: string, onclick: () => void, danger = false) =>
  el("button", {
    type: "button",
    className: `lg-admin-btn${danger ? " lg-admin-danger" : ""}`,
    textContent: text,
    onclick,
  });

export function mountProjects(
  root: HTMLElement,
  opts: { client?: ProjectsClient; me: { id: string }; openThread: (id: string) => void },
) {
  const client = opts.client ?? new ProjectsClient();
  let alive = true;
  const status = el("p", { className: "lg-admin-status" });
  const list = el("div", { className: "lg-admin-scroll" });
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("lg-admin-error", error);
  };
  const act = async (f: () => Promise<unknown>, done?: string) => {
    try {
      await f();
      if (done) say(done);
      await load();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  };
  const nameInput = el("input", { placeholder: "Project name", maxLength: 100 });
  const create = el(
    "form",
    { className: "lg-admin-form" },
    el("label", { className: "lg-admin-field" }, "New project", nameInput),
    el("button", { type: "submit", className: "lg-admin-btn", textContent: "Create" }),
  );
  create.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    void act(async () => {
      await client.create(name);
      nameInput.value = "";
    }, `Created ${name}.`);
  });
  const projectBlock = async (p: ProjectView) => {
    const [members, threads] = await Promise.all([client.members(p.id), client.threads(p.id)]);
    const owner = p.role === "owner";
    const block = el("section", { className: "lg-project" });
    block.append(
      el("h4", { textContent: `${p.name} · ${p.role}` }),
      el(
        "p",
        { className: "lg-admin-status" },
        `Members: ${members.map((m) => `${m.userId === opts.me.id ? "you" : m.userId} (${m.role})`).join(", ")}`,
      ),
    );
    const threadList = el("ul");
    for (const t of threads)
      threadList.append(
        el(
          "li",
          {},
          btn(t.tainted ? `${t.title} · Sensitive` : t.title, () => opts.openThread(t.id)),
        ),
      );
    block.append(
      el("p", {
        className: "lg-admin-status",
        textContent: "Your threads in this project (only you see them):",
      }),
      threads.length
        ? threadList
        : el("p", { className: "lg-admin-status", textContent: "None yet." }),
    );
    const actions = el("div", { className: "lg-admin-form" });
    if (p.role !== "viewer")
      actions.append(
        btn(
          "New thread in this project",
          () =>
            void act(async () =>
              opts.openThread(await client.newThread(p.id, `New thread in ${p.name}`)),
            ),
        ),
      );
    if (owner) {
      const email = el("input", { placeholder: "Email of an existing user", type: "email" });
      const role = el(
        "select",
        {},
        el("option", { value: "viewer", textContent: "viewer" }),
        el("option", { value: "editor", textContent: "editor" }),
      );
      actions.append(
        el("label", { className: "lg-admin-field" }, "Invite", email),
        role,
        btn(
          "Invite",
          () =>
            void act(
              () => client.invite(p.id, email.value.trim(), role.value as "editor" | "viewer"),
              "Invited.",
            ),
        ),
        btn(
          "Reset join link",
          () =>
            void act(async () => {
              const path = await client.joinLink(p.id, role.value as "editor" | "viewer");
              say(`Join link (earlier links stop working): ${location.origin}${path}`);
            }),
        ),
        btn("Archive", () => void act(() => client.archive(p.id), `Archived ${p.name}.`), true),
      );
      for (const m of members.filter((x) => x.userId !== opts.me.id))
        actions.append(
          btn(
            `Remove ${m.userId}`,
            () => void act(() => client.remove(p.id, m.userId), "Removed."),
            true,
          ),
        );
    } else
      actions.append(
        btn(
          "Leave",
          () => void act(() => client.remove(p.id, opts.me.id), `Left ${p.name}.`),
          true,
        ),
      );
    block.append(actions);
    return block;
  };
  async function load() {
    const projects = await client.list();
    const blocks = await Promise.all(projects.map(projectBlock));
    if (!alive) return;
    list.replaceChildren(
      ...(blocks.length
        ? blocks
        : [el("p", { className: "lg-admin-status", textContent: "No projects yet." })]),
    );
  }
  root.append(create, list, status);
  void load().catch((e) => say(String(e), true));
  return () => {
    alive = false;
    root.replaceChildren();
  };
}
