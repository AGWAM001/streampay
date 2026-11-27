/** Theme preference and DOM synchronization shared by the app and Storybook. */

export const THEME_STORAGE_KEY = "streampay:theme";
export const EMBED_FRAME_PATH = "/embed/frame";
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Embed `auto` (and missing/invalid values) follows the system preference. */
export function embedThemePreference(search: string): ThemePreference {
  const requested = new URLSearchParams(search).get("theme");
  return isThemePreference(requested) ? requested : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function browserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can be unavailable in privacy modes or an opaque origin.
    return null;
  }
}

export function readThemePreference(storage?: ThemeStorage | null): ThemePreference {
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return "system";
  try {
    const value = target.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Apply the resolved theme before paint and optionally persist the preference. */
export function applyTheme(
  preference: ThemePreference,
  systemDark: boolean,
  options: {
    root?: HTMLElement;
    /** null disables persistence (used by Storybook's theme toolbar). */
    storage?: ThemeStorage | null;
  } = {}
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemDark);
  const root =
    options.root ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  const storage = options.storage === undefined ? browserStorage() : options.storage;

  if (root) {
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolved;
  }

  if (storage) {
    try {
      storage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // The active theme still works when persistence is blocked.
    }
  }

  return resolved;
}

export function subscribeToSystemTheme(
  onChange: (systemDark: boolean) => void
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange(query.matches);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }
  query.addListener(handler);
  return () => query.removeListener(handler);
}

/**
 * Parser-blocking inline script rendered in <head>. It reads the persisted
 * choice and sets data-theme before the browser can paint the SSR document.
 * Kept dependency-free so the exact same source is unit-tested in a VM.
 */
export const THEME_INIT_SCRIPT = `(function () {
  var preference = "system";
  var isEmbed = window.location && window.location.pathname === ${JSON.stringify(EMBED_FRAME_PATH)};
  if (isEmbed) {
    var requestedTheme = new URLSearchParams(window.location.search).get("theme");
    if (requestedTheme === "light" || requestedTheme === "dark") {
      preference = requestedTheme;
    }
  } else {
    try {
      var stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
      if (stored === "light" || stored === "dark" || stored === "system") {
        preference = stored;
      }
    } catch (error) {}
  }
  var dark = preference === "dark" ||
    (preference === "system" && window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  var resolved = dark ? "dark" : "light";
  var root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
})();`;
