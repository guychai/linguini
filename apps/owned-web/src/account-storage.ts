// Browser storage tied to the signed-in account (AUTH_MODE=better-auth).
//
// - Every localStorage key upstream T3 uses (drafts, prompt stash, terminal and panel state,
//   client settings, browser history, ...) is transparently prefixed with `lg:<userId>:` by
//   replacing `window.localStorage` with a scoped view before upstream modules load. IndexedDB
//   database names get the same prefix. Upstream code is unchanged.
// - The theme keys stay unprefixed (the inline boot script in index.html and the sign-in screen
//   read them before anyone is signed in) but their source of truth is the account: they are
//   loaded from /api/me/settings prefs.theme at boot and saved back on every change, so the
//   theme follows the account across devices.
// - Sign-out wipes this account's local content and the theme mirror.
export const THEME_KEYS = [
  "t3code:theme",
  "t3code:themes:v1",
  "t3code:theme-appearance-mode",
  "t3code:theme-follow-system",
  "t3code:theme-halves:v1",
] as const;
const PENDING_WIPE = "lg:pending-wipe";
export const scopePrefix = (userId: string) => `lg:${userId}:`;
const isTheme = (key: string) => (THEME_KEYS as readonly string[]).includes(key);

/** A Storage whose keys (except the theme mirror) live under `prefix`. */
export function scopedStorage(base: Storage, prefix: string, onTheme: () => void): Storage {
  const own = () => {
    const keys: string[] = [];
    for (let i = 0; i < base.length; i++) {
      const k = base.key(i);
      if (k?.startsWith(prefix)) keys.push(k.slice(prefix.length));
    }
    return keys;
  };
  const map = (key: string) => (isTheme(key) ? key : prefix + key);
  const storage = {
    get length() {
      return own().length;
    },
    key: (i: number) => own()[i] ?? null,
    getItem: (key: string) => base.getItem(map(String(key))),
    setItem(key: string, value: string) {
      base.setItem(map(String(key)), String(value));
      if (isTheme(String(key))) onTheme();
    },
    removeItem(key: string) {
      base.removeItem(map(String(key)));
      if (isTheme(String(key))) onTheme();
    },
    clear() {
      for (const k of own()) base.removeItem(prefix + k);
    },
  };
  return storage as Storage;
}

export type ThemePrefs = Partial<Record<(typeof THEME_KEYS)[number], string>>;
export function readTheme(base: Storage): ThemePrefs {
  const out: ThemePrefs = {};
  for (const k of THEME_KEYS) {
    const v = base.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}
/** Make the device mirror match the account's saved theme (absent keys = upstream default). */
export function applyTheme(base: Storage, theme: ThemePrefs | undefined) {
  for (const k of THEME_KEYS) {
    const v = theme?.[k];
    if (typeof v === "string") base.setItem(k, v);
    else base.removeItem(k);
  }
}

/** Removes T3 content keys that predate account scoping (they would otherwise be orphaned). */
export function dropUnscoped(base: Storage) {
  const stale: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const k = base.key(i);
    if (k && !k.startsWith("lg:") && !isTheme(k) && /^(t3|chat_thread)/.test(k)) stale.push(k);
  }
  for (const k of stale) base.removeItem(k);
}

async function deleteDatabases(prefix: string) {
  const factory = globalThis.indexedDB;
  if (!factory?.databases) return;
  const dbs = await factory.databases().catch(() => []);
  await Promise.all(
    dbs
      .filter((d) => d.name?.startsWith(prefix))
      .map(
        (d) =>
          new Promise<void>((res) => {
            const r = origDelete ? origDelete.call(factory, d.name!) : factory.deleteDatabase(d.name!);
            r.onsuccess = r.onerror = r.onblocked = () => res();
          }),
      ),
  );
}
let origDelete: IDBFactory["deleteDatabase"] | undefined;

interface Settings {
  prefs?: Record<string, unknown>;
}
/**
 * Install account scoping for `userId` and load the account's theme. Must run before upstream
 * modules load. `api` reads and writes /api/me/settings.
 */
export async function installAccountStorage(
  userId: string,
  api: { get(): Promise<Settings>; put(s: Settings): Promise<unknown> },
  target: typeof globalThis = globalThis,
) {
  const base = target.localStorage;
  // Finish a wipe the previous sign-out could not complete (databases still open then).
  const pending = base.getItem(PENDING_WIPE);
  if (pending) {
    await deleteDatabases(pending);
    base.removeItem(PENDING_WIPE);
  }
  dropUnscoped(base);
  let prefs: Record<string, unknown> = {};
  try {
    prefs = (await api.get()).prefs ?? {};
  } catch {}
  applyTheme(base, prefs.theme as ThemePrefs | undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      prefs = { ...prefs, theme: readTheme(base) };
      void api.put({ prefs }).catch((e) => console.warn("theme not saved", e));
    }, 400);
  };
  const prefix = scopePrefix(userId);
  const scoped = scopedStorage(base, prefix, save);
  Object.defineProperty(target, "localStorage", { configurable: true, get: () => scoped });
  const factory = target.indexedDB;
  if (factory) {
    const open = factory.open.bind(factory);
    origDelete = factory.deleteDatabase.bind(factory);
    const del = origDelete;
    factory.open = ((name: string, version?: number) =>
      version === undefined ? open(prefix + name) : open(prefix + name, version)) as IDBFactory["open"];
    factory.deleteDatabase = ((name: string) => del(prefix + name)) as IDBFactory["deleteDatabase"];
  }
  current = {
    userId,
    base,
    flush: async () => {
      clearTimeout(timer);
      prefs = { ...prefs, theme: readTheme(base) };
      await api.put({ prefs }).catch(() => undefined);
    },
  };
  return { scoped, base, prefix };
}
let current: { userId: string; base: Storage; flush(): Promise<void> } | undefined;
/** Sign-out of the installed account: save its theme, then wipe its local content. */
export async function signOutAccountStorage() {
  if (!current) return;
  await current.flush();
  await wipeAccountStorage(current.userId, current.base);
}

/** Sign-out: remove this account's local content and the theme mirror. */
export async function wipeAccountStorage(
  userId: string,
  base: Storage,
) {
  const prefix = scopePrefix(userId);
  const keys: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const k = base.key(i);
    if (k?.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) base.removeItem(k);
  applyTheme(base, undefined);
  base.setItem(PENDING_WIPE, prefix);
  await deleteDatabases(prefix);
}
