import { signOutAccountStorage } from "./account-storage.ts";
// Sign-in / sign-up screen for AUTH_MODE=better-auth (the backend's /api/auth/* routes).
// Same-origin fetches: the browser stores and sends Better Auth's HttpOnly session cookie.
export interface AuthConfig {
  signupEnabled: boolean;
}
/** The backend's auth config, or null when it does not use Better Auth (tailnet / token mode). */
export async function fetchAuthConfig(fetchFn: typeof fetch = fetch): Promise<AuthConfig | null> {
  try {
    const r = await fetchFn("/api/auth/linguini-config");
    if (!r.ok) return null;
    return (await r.json()) as AuthConfig;
  } catch {
    return null;
  }
}
export async function submitAuth(
  mode: "sign-in" | "sign-up",
  input: { name?: string; email: string; password: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const r = await fetchFn(mode === "sign-in" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      mode === "sign-in"
        ? { email: input.email, password: input.password }
        : { name: input.name || input.email.split("@")[0], email: input.email, password: input.password },
    ),
  });
  if (!r.ok) {
    let message = `Request failed (${r.status})`;
    try {
      const e = (await r.json()) as { message?: string; error?: string };
      message = e.message ?? e.error ?? message;
    } catch {}
    throw new Error(message);
  }
}
export async function signOut(fetchFn: typeof fetch = fetch) {
  // Theme saved to the account first (needs the session), then this account's local data goes.
  await signOutAccountStorage().catch(() => undefined);
  await fetchFn("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
  sessionStorage.removeItem("owned-prototype-token");
  location.assign("/");
}

export function showSignIn(root: HTMLElement, config: AuthConfig, onSignedIn: () => Promise<void>) {
  let mode: "sign-in" | "sign-up" = "sign-in";
  // Plain props bag: TypeScript's Partial<HTMLElementTagNameMap[K]> is too complex here.
  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    Object.assign(node, props);
    return node;
  }
  const wrap = el("div", { className: "lg-auth" });
  const form = el("form", { className: "lg-auth-card" });
  form.setAttribute("aria-label", "Sign in to Linguini");
  const brand = el("div", { className: "lg-auth-brand" });
  const mark = el("span", { className: "lg-auth-mark", textContent: "L" });
  mark.setAttribute("role", "presentation");
  brand.append(mark, el("span", { textContent: "Linguini" }));
  const sub = el("p", { className: "lg-auth-sub" });
  const field = (label: string, input: HTMLInputElement) => {
    const l = el("label", { textContent: label });
    l.append(input);
    return l;
  };
  const name = el("input", { type: "text", name: "name", autocomplete: "name" });
  const email = el("input", { type: "email", name: "email", autocomplete: "email", required: true });
  const password = el("input", { type: "password", name: "password", required: true, minLength: 8 });
  const nameField = field("Name", name);
  const submit = el("button", { type: "submit" });
  const error = el("p", { className: "lg-auth-error" });
  error.setAttribute("role", "alert");
  const sw = el("p", { className: "lg-auth-switch" });
  const swText = el("span");
  const swButton = el("button", { type: "button" });
  sw.append(swText, swButton);
  const render = () => {
    const up = mode === "sign-up";
    sub.textContent = up ? "Create your account" : "Sign in to continue";
    submit.textContent = up ? "Create account" : "Sign in";
    // style.display on purpose: Tailwind scans this file, and the name of the boolean
    // visibility property would emit a late utility that breaks upstream's `md:block` sidebar.
    nameField.style.display = up ? "" : "none";
    password.autocomplete = up ? "new-password" : "current-password";
    swText.textContent = up ? "Already have an account? " : "New here? ";
    swButton.textContent = up ? "Sign in" : "Create an account";
    sw.style.display = config.signupEnabled ? "" : "none";
    error.textContent = "";
  };
  swButton.addEventListener("click", () => {
    mode = mode === "sign-in" ? "sign-up" : "sign-in";
    render();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void submitAuth(mode, { name: name.value.trim(), email: email.value.trim(), password: password.value })
      .then(onSignedIn)
      .catch((err: unknown) => {
        error.textContent = err instanceof Error ? err.message : String(err);
        submit.disabled = false;
      });
  });
  form.append(brand, sub, nameField, field("Email", email), field("Password", password), submit, error, sw);
  wrap.append(form);
  render();
  root.replaceChildren(wrap);
  email.focus();
}
