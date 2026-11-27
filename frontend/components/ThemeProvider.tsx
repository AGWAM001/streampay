"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname } from "next/navigation";
import {
  applyTheme,
  EMBED_FRAME_PATH,
  readThemePreference,
  resolveTheme,
  subscribeToSystemTheme,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function createPreferenceStore() {
  let snapshot: ThemePreference | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      snapshot = readThemePreference();
      emit();
    }
  };

  return {
    getSnapshot(): ThemePreference {
      if (snapshot === null) snapshot = readThemePreference();
      return snapshot;
    },
    subscribe(listener: () => void) {
      if (listeners.size === 0 && typeof window !== "undefined") {
        window.addEventListener("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") {
          window.removeEventListener("storage", onStorage);
        }
      };
    },
    setPreference(next: ThemePreference) {
      const nextSystemDark = systemPrefersDark();
      // Keep an in-memory choice so the active theme still changes if storage
      // writes are blocked. Storage events adopt the canonical persisted value.
      snapshot = next;
      applyTheme(next, nextSystemDark);
      emit();
    },
  };
}

const subscribeToMount = () => () => {};
const serverSystemDark = () => false;
const clientMounted = () => true;

/**
 * The inline layout script owns the first paint. This provider adopts that
 * choice after hydration, persists changes, follows OS changes in system mode,
 * and synchronizes explicit choices across tabs. Embed frames own their theme
 * through the documented URL parameter instead of the host app preference.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preferenceStore] = useState(createPreferenceStore);
  const preference = useSyncExternalStore(
    preferenceStore.subscribe,
    preferenceStore.getSnapshot,
    () => "system" as const
  );
  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    systemPrefersDark,
    serverSystemDark
  );
  const ready = useSyncExternalStore(subscribeToMount, clientMounted, serverSystemDark);
  const pathname = usePathname();
  const ownsTheme = pathname !== EMBED_FRAME_PATH;

  useEffect(() => {
    if (ready && ownsTheme) applyTheme(preference, systemDark);
  }, [ready, ownsTheme, preference, systemDark]);

  const setPreference = preferenceStore.setPreference;

  return (
    <ThemeContext.Provider
      value={{ preference, resolvedTheme: resolveTheme(preference, systemDark), setPreference }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within a ThemeProvider");
  return value;
}
