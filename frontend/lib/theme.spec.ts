import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  applyTheme,
  embedThemePreference,
  isThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_INIT_SCRIPT,
  THEME_PREFERENCES as THEME_PREFERENCES_VALUES,
  THEME_STORAGE_KEY,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function fakeRoot() {
  return { dataset: {}, style: {} } as unknown as HTMLElement;
}

describe("theme preferences", () => {
  it("accepts only the three supported values", () => {
    expect(THEME_PREFERENCES_VALUES).toEqual(["light", "dark", "system"]);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  it("reads persisted choices and safely falls back for invalid or blocked storage", () => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "invalid" }))).toBe("system");
    expect(readThemePreference(null)).toBe("system");
    expect(readThemePreference({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => {},
    })).toBe("system");
  });

  it("resolves system mode in both directions", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("maps embed auto and invalid values to system mode", () => {
    expect(embedThemePreference("theme=light")).toBe("light");
    expect(embedThemePreference("theme=dark")).toBe("dark");
    expect(embedThemePreference("theme=auto")).toBe("system");
    expect(embedThemePreference("theme=invalid")).toBe("system");
    expect(embedThemePreference("")).toBe("system");
  });

  it("applies DOM state and persists without requiring storage to succeed", () => {
    const root = fakeRoot();
    const storage = memoryStorage();
    expect(applyTheme("system", true, { root, storage })).toBe("dark");
    expect(root.dataset).toMatchObject({ theme: "dark", themePreference: "system" });
    expect(root.style.colorScheme).toBe("dark");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("system");

    expect(() => applyTheme("light", true, {
      root,
      storage: {
        getItem: () => null,
        setItem: () => { throw new Error("blocked"); },
      },
    })).not.toThrow();
    expect(root.dataset.theme).toBe("light");
  });
});

describe("pre-paint theme initializer", () => {
  function execute(stored: string | null, systemDark: boolean, search?: string) {
    const root = fakeRoot();
    const storage = memoryStorage(stored === null ? {} : { [THEME_STORAGE_KEY]: stored });
    runInNewContext(THEME_INIT_SCRIPT, {
      URLSearchParams,
      document: { documentElement: root },
      window: {
        location: search === undefined ? undefined : { pathname: "/embed/frame", search },
        localStorage: storage,
        matchMedia: () => ({ matches: systemDark }),
      },
    });
    return root;
  }

  it("uses an explicit stored theme before hydration", () => {
    expect(execute("dark", false).dataset.theme).toBe("dark");
    expect(execute("light", true).dataset.theme).toBe("light");
  });

  it("uses prefers-color-scheme for system mode and invalid storage", () => {
    expect(execute("system", true).dataset.theme).toBe("dark");
    expect(execute("invalid", true).dataset.theme).toBe("dark");
    expect(execute(null, false).dataset.theme).toBe("light");
  });

  it("uses embed URL themes before paint without consulting app storage", () => {
    expect(execute("light", false, "?theme=dark").dataset.theme).toBe("dark");
    expect(execute("dark", true, "?theme=light").dataset.theme).toBe("light");
    expect(execute("light", true, "?theme=auto").dataset.theme).toBe("dark");
    expect(execute("dark", false, "?theme=auto").dataset.theme).toBe("light");
  });

  it("still initializes when localStorage throws", () => {
    const root = fakeRoot();
    expect(() => runInNewContext(THEME_INIT_SCRIPT, {
      document: { documentElement: root },
      window: {
        get localStorage() { throw new Error("blocked"); },
        matchMedia: () => ({ matches: true }),
      },
    })).not.toThrow();
    expect(root.dataset.theme).toBe("dark");
  });
});
