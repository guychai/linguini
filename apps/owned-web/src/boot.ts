import "./client-header.ts";
import "./styles.css";
// Authentication is the only owned screen. Everything after this is upstream T3.
import { OwnedAdapter } from "./adapter.ts";
import { configureOwner } from "./projection.ts";
import { installHttpAdapter } from "./t3-adapter.ts";
import { installRandomUUIDPolyfill } from "./insecure-context.ts";
import { installUiFlags, setSettingsExtensions, setSignedInUser } from "./ui-flags.ts";
import { accountExtensions } from "./account-admin.ts";
import { fetchAuthConfig, showSignIn, signOut } from "./sign-in.ts";
import { installAccountStorage } from "./account-storage.ts";
installRandomUUIDPolyfill();
// Before upstream modules load: apps/web/src/uiFlags.ts reads the flags once.
installUiFlags();
const root = document.getElementById("root")!;
async function start(token: string) {
  const { owner, user } = await new OwnedAdapter(token).session();
  await configureOwner(owner);
  setSignedInUser(user ?? null, () => void signOut());
  // Better Auth accounts: browser storage scoped to the user, theme loaded from the account.
  if (user) {
    setSettingsExtensions(accountExtensions(user));
    const adapter = new OwnedAdapter(token);
    await installAccountStorage(user.id, {
      get: () => adapter.mySettings(),
      put: (s) => adapter.saveMySettings(s),
    });
  }
  sessionStorage.setItem("owned-prototype-token", token);
  installHttpAdapter();
  const { startup } = await import("../../web/src/main.tsx");
  await startup;
}
const saved = sessionStorage.getItem("owned-prototype-token");
// Tailnet mode: the backend accepts requests without a token, so skip the prompt when it does.
// Better Auth mode: the session cookie authenticates, so a 401 means "show the sign-in screen".
start(saved ?? "").catch(async (error: unknown) => {
  console.error("owned UI: tokenless start failed", error);
  const config = await fetchAuthConfig();
  // A fresh load after sign-in: upstream T3 boots once, from a clean root, with the cookie set.
  if (config) return showSignIn(root, config, async () => location.reload());
  if (saved) start(saved).catch(showAuth);
  else showAuth(error);
});
function showAuth(error?: unknown) {
  root.replaceChildren();
  const form = document.createElement("form"),
    label = document.createElement("label"),
    input = document.createElement("input"),
    button = document.createElement("button"),
    status = document.createElement("p");
  label.textContent = "Owner token";
  input.type = "password";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Owner token");
  button.textContent = "Connect to T3";
  status.textContent = error ? String(error) : "Local prototype · use the ignored owner token";
  label.append(input);
  form.append(label, button, status);
  root.append(form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    button.disabled = true;
    void start(input.value).catch((error) => {
      status.textContent = String(error);
      button.disabled = false;
    });
  });
}
