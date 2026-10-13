// Owned settings blocks for AUTH_MODE=better-auth, mounted into upstream's Appearance page via
// uiFlags.settingsExtensions: "Password" (change your own, Better Auth change-password) for
// everyone, "Users" (the /api/admin/* API) for admins only. Plain DOM, same-origin cookie fetches.
// (Avoid the bare Tailwind token for display:none in this folder; see styles.css.)
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  lastActiveAt: string | null;
  conversations: number;
  runningSandboxes: number;
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
async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(data.message ?? data.error ?? `Request failed (${r.status})`));
  return data;
}
export function formatWhen(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The Users page's two status lines: the list state (loading / count / load error), which every
 * reload rewrites, and the last action's result, which stays until the next action starts or the
 * admin dismisses it (a reload never overwrites it).
 */
export class UsersStatus {
  list: { text: string; error: boolean } = { text: "Loading users…", error: false };
  result: { text: string; error: boolean } | null = null;
  constructor(private readonly render: (s: UsersStatus) => void = () => {}) {}
  setList(text: string, error = false) {
    this.list = { text, error };
    this.render(this);
  }
  setResult(text: string, error = false) {
    this.result = { text, error };
    this.render(this);
  }
  /** A new action starts (or the admin dismissed the result). */
  clearResult() {
    this.result = null;
    this.render(this);
  }
}

export function mountChangePassword(root: HTMLElement) {
  const current = el("input", {
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const next = el("input", {
    type: "password",
    autocomplete: "new-password",
    required: true,
    minLength: 8,
  });
  const status = el("p", { className: "lg-admin-status" });
  status.setAttribute("role", "status");
  const submit = el("button", {
    type: "submit",
    className: "lg-admin-btn",
    textContent: "Change password",
  });
  const label = (text: string, input: HTMLInputElement) =>
    el("label", { className: "lg-admin-field" }, text, input);
  current.setAttribute("aria-label", "Current password");
  next.setAttribute("aria-label", "New password");
  const form = el(
    "form",
    { className: "lg-admin-form" },
    label("Current password", current),
    label("New password", next),
    submit,
    status,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    status.className = "lg-admin-status";
    status.textContent = "Saving…";
    try {
      await call("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: current.value,
          newPassword: next.value,
          revokeOtherSessions: true,
        }),
      });
      current.value = next.value = "";
      status.textContent = "Password changed. Other devices were signed out.";
    } catch (error) {
      status.className = "lg-admin-status lg-admin-error";
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      submit.disabled = false;
    }
  });
  root.replaceChildren(form);
  return () => root.replaceChildren();
}

export function mountUsers(root: HTMLElement, me: { email: string }) {
  let alive = true;
  const status = el("p", { className: "lg-admin-status" });
  status.setAttribute("role", "status");
  const resultText = el("span");
  const dismiss = el("button", { type: "button", className: "lg-admin-dismiss", textContent: "×" });
  dismiss.setAttribute("aria-label", "Dismiss");
  const result = el("p", { className: "lg-admin-result" }, resultText, dismiss);
  result.setAttribute("role", "status");
  const state = new UsersStatus((s) => {
    status.className = s.list.error ? "lg-admin-status lg-admin-error" : "lg-admin-status";
    status.textContent = s.list.text;
    result.style.display = s.result ? "" : "none";
    result.className = s.result?.error ? "lg-admin-result lg-admin-error" : "lg-admin-result";
    resultText.textContent = s.result?.text ?? "";
  });
  dismiss.onclick = () => state.clearResult();
  const body = el("tbody");
  const head = el(
    "thead",
    {},
    el(
      "tr",
      {},
      ...["User", "Created", "Last active", "Conversations", "Running sandboxes", ""].map((h) =>
        el("th", { textContent: h }),
      ),
    ),
  );
  const table = el("table", { className: "lg-admin-users" }, head, body);
  root.replaceChildren(result, el("div", { className: "lg-admin-scroll" }, table), status);
  state.setList("Loading users…");
  const say = (text: string, error = false) => state.setList(text, error);
  const report = (text: string, error = false) => state.setResult(text, error);
  const load = async () => {
    try {
      const { users } = (await call("/api/admin/users")) as unknown as { users: AdminUser[] };
      if (alive) render(users);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  };
  const render = (users: AdminUser[]) => {
    const admins = users.filter((u) => u.role === "admin").length;
    say(`${users.length} user${users.length === 1 ? "" : "s"}`);
    body.replaceChildren(
      ...users.map((u) => {
        const self = u.email === me.email;
        const actions = el("div", { className: "lg-admin-actions" });
        const who = el(
          "td",
          {},
          el("div", { className: "lg-admin-name", textContent: u.name || u.email }),
          el("div", { className: "lg-admin-sub", textContent: u.email }),
          ...(u.role === "admin"
            ? [el("span", { className: "lg-admin-badge", textContent: "admin" })]
            : []),
          ...(self ? [el("span", { className: "lg-admin-badge", textContent: "you" })] : []),
        );
        const row = el(
          "tr",
          {},
          who,
          el("td", { textContent: new Date(u.createdAt).toLocaleDateString() }),
          el("td", { textContent: formatWhen(u.lastActiveAt) }),
          el("td", { textContent: String(u.conversations) }),
          el("td", { textContent: String(u.runningSandboxes) }),
          el("td", {}, actions),
        );
        row.dataset.userEmail = u.email;
        const idle = () => {
          actions.replaceChildren();
          if (self) return;
          const reset = el("button", {
            type: "button",
            className: "lg-admin-btn",
            textContent: "Reset password",
          });
          const del = el("button", {
            type: "button",
            className: "lg-admin-btn lg-admin-danger",
            textContent: "Delete",
          });
          if (u.role === "admin" && admins <= 1) del.disabled = true;
          reset.onclick = () =>
            confirmStep(
              `Reset ${u.email}'s password and sign them out everywhere?`,
              "Reset",
              async () => {
                const r = (await call(`/api/admin/users/${encodeURIComponent(u.id)}/password`, {
                  method: "POST",
                  body: "{}",
                })) as { password?: string };
                report(
                  `Password reset for ${u.email}. Their sessions were signed out; give them the temporary password below.`,
                );
                const code = el("code", {
                  className: "lg-admin-secret",
                  textContent: r.password ?? "",
                });
                const copy = el("button", {
                  type: "button",
                  className: "lg-admin-btn",
                  textContent: "Copy",
                });
                copy.onclick = () =>
                  void navigator.clipboard
                    ?.writeText(r.password ?? "")
                    .then(() => (copy.textContent = "Copied"));
                const done = el("button", {
                  type: "button",
                  className: "lg-admin-btn",
                  textContent: "Done",
                });
                done.onclick = idle;
                actions.replaceChildren(
                  el("div", {
                    className: "lg-admin-sub",
                    textContent: "Temporary password (shown once):",
                  }),
                  code,
                  copy,
                  done,
                );
              },
            );
          del.onclick = () =>
            confirmStep(
              `Delete ${u.email}? Their ${u.conversations} conversation(s), sandboxes and snapshots are removed. This cannot be undone.`,
              "Delete account",
              async () => {
                const removed = (await call(`/api/admin/users/${encodeURIComponent(u.id)}`, {
                  method: "DELETE",
                })) as { conversations?: number; pending?: number };
                report(
                  `Deleted ${u.email}: ${removed.conversations ?? 0} conversation(s) removed` +
                    (removed.pending
                      ? `, ${removed.pending} still cleaning up in the background.`
                      : "."),
                );
                await load();
              },
              true,
            );
          actions.append(reset, del);
        };
        const confirmStep = (
          question: string,
          label: string,
          run: () => Promise<void>,
          danger = false,
        ) => {
          const yes = el("button", {
            type: "button",
            className: danger ? "lg-admin-btn lg-admin-danger" : "lg-admin-btn",
            textContent: label,
          });
          const no = el("button", {
            type: "button",
            className: "lg-admin-btn",
            textContent: "Cancel",
          });
          no.onclick = idle;
          yes.onclick = async () => {
            state.clearResult();
            yes.disabled = no.disabled = true;
            yes.textContent = "Working…";
            try {
              await run();
            } catch (error) {
              report(error instanceof Error ? error.message : String(error), true);
              idle();
            }
          };
          actions.replaceChildren(
            el("div", { className: "lg-admin-confirm", textContent: question }),
            yes,
            no,
          );
        };
        idle();
        return row;
      }),
    );
  };
  void load();
  return () => {
    alive = false;
    root.replaceChildren();
  };
}

/** The settings blocks for this account (Users only for admins). */
export function accountExtensions(user: { email: string; admin?: boolean }) {
  return [
    { id: "password", title: "Password", mount: mountChangePassword },
    ...(user.admin
      ? [{ id: "users", title: "Users", mount: (e: HTMLElement) => mountUsers(e, user) }]
      : []),
  ];
}
