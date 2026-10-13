/**
 * Optional UI simplifications an embedding shell may request by setting
 * `globalThis.__T3_UI_FLAGS__` before the app starts. Absent: upstream behavior.
 * (Added by the owned prototype; keep upstream diffs that read these flags minimal.)
 */
export interface UiFlags {
  /** A single implicit workspace: hide project names, pickers and breadcrumbs. */
  readonly hideProjects?: boolean;
  /** No Git checkout behind threads: hide branch/worktree controls. */
  readonly hideGit?: boolean;
  /** Hide the thread details card (environment, Open in editor, project scripts, Commit, Changes) and its header toggle. */
  readonly hideThreadDetails?: boolean;
  /** Hide the sidebar's Usage button. */
  readonly hideUsage?: boolean;
  /** Right panel surface kinds to hide from the "Open a surface" menus; they never open. */
  readonly hiddenRightPanelSurfaces?: readonly string[];
  /** Hide "Open in <editor>" pickers (no local editor can reach the files). */
  readonly hideEditorPicker?: boolean;
  /** Product name shown instead of "T3 Code" (no stage suffix); also shown in the mobile sidebar. */
  readonly appName?: string;
  /** The signed-in user, shown unobtrusively in the sidebar footer (multi-user deployments). */
  readonly signedInUser?: { readonly name: string; readonly login: string };
  /** Sign the user out (shown next to the signed-in user). */
  readonly signOut?: () => void;
  /** Hide the composer's model and traits (thinking level) pickers: the server picks the model. */
  readonly hideModelPicker?: boolean;
  /** Hide the composer's runtime/access mode picker (e.g. "Full access"): the server always runs one mode. */
  readonly hideRuntimeModePicker?: boolean;
  /** Only these settings pages exist (nav, search, direct links); the first is the landing page. */
  readonly settingsPages?: readonly string[];
  /** Settings sections (SettingsSection ids) to hide. */
  readonly hiddenSettingsSections?: readonly string[];
  /**
   * Extra sections the shell renders itself, shown after Account on the Appearance page
   * (e.g. change password, admin Users). `mount` fills the element and returns a cleanup.
   */
  readonly settingsExtensions?: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly mount: (element: HTMLElement) => () => void;
  }>;
}
export const uiFlags: UiFlags = (globalThis as { __T3_UI_FLAGS__?: UiFlags }).__T3_UI_FLAGS__ ?? {};
export const isRightPanelSurfaceHidden = (kind: string) =>
  uiFlags.hiddenRightPanelSurfaces?.includes(kind) ?? false;
