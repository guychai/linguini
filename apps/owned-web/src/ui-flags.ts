// Owned UI simplification: one implicit workspace, no Git. Upstream reads these via
// apps/web/src/uiFlags.ts; styles.css hides the remaining project controls under
// html[data-owned-ui]. Hide, don't remove, so upstream syncs stay clean.
/** Single owned branding config: the product name shown in the UI (no stage suffix). */
export const APP_NAME = "Linguini";
export const OWNED_UI_FLAGS = {
  hideProjects: true,
  hideGit: true,
  // Until Git operations and usage tracking exist.
  hideThreadDetails: true,
  hideUsage: true,
  hideEditorPicker: true,
  hiddenRightPanelSurfaces: ["preview", "diff", "pull-request", "pull-requests", "device"],
  appName: APP_NAME,
  // Settings are locked to server defaults; only the theme (saved to the account) and the
  // account itself are user-facing. Everyone runs PI_MODEL / PI_THINKING_LEVEL.
  hideModelPicker: true,
  hideRuntimeModePicker: true,
  settingsPages: ["/settings/appearance"],
  hiddenSettingsSections: ["appearance-interface", "typography", "motion"],
} as const;
export function installUiFlags(target: typeof globalThis = globalThis) {
  // A copy: the signed-in user is added once the session is known (before upstream loads).
  (target as { __T3_UI_FLAGS__?: object }).__T3_UI_FLAGS__ = { ...OWNED_UI_FLAGS };
  target.document?.documentElement.setAttribute("data-owned-ui", "simple");
}

export interface SessionUser {
  email: string;
  name: string | null;
}
/** Record the signed-in user for the sidebar footer; must run before upstream modules load. */
export function setSignedInUser(
  user: SessionUser | null,
  onSignOut?: () => void,
  target: typeof globalThis = globalThis,
) {
  const flags = (target as { __T3_UI_FLAGS__?: Record<string, unknown> }).__T3_UI_FLAGS__;
  if (!flags || !user) return;
  flags.signedInUser = { name: user.name || user.email, login: user.email };
  if (onSignOut) flags.signOut = onSignOut;
}

/** Owned settings blocks (account-admin.ts) shown on the settings page; set before startup. */
export function setSettingsExtensions(
  extensions: ReadonlyArray<{ id: string; title: string; mount: (e: HTMLElement) => () => void }>,
  target: typeof globalThis = globalThis,
) {
  const flags = (target as { __T3_UI_FLAGS__?: Record<string, unknown> }).__T3_UI_FLAGS__;
  if (flags && extensions.length) flags.settingsExtensions = extensions;
}
