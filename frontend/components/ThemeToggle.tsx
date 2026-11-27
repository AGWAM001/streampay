"use client";

import { useId } from "react";
import { useT } from "@/lib/i18n/provider";
import { THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";
import { useTheme } from "./ThemeProvider";

const LABEL_KEYS = {
  light: "settings.theme.light",
  dark: "settings.theme.dark",
  system: "settings.theme.system",
} as const;

/** Native radios provide arrow-key navigation and an accessible group label. */
export default function ThemeToggle() {
  const t = useT();
  const { preference, resolvedTheme, setPreference } = useTheme();
  const descriptionId = useId();
  const statusId = useId();
  const resolvedLabel = t(LABEL_KEYS[resolvedTheme]);

  return (
    <fieldset className="theme-fieldset" aria-describedby={descriptionId}>
      <legend>{t("settings.theme.title")}</legend>
      <p id={descriptionId} className="muted">
        {t("settings.theme.description")}
      </p>
      <div className="theme-options">
        {THEME_PREFERENCES.map((value) => (
          <label
            key={value}
            className={`theme-option${preference === value ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name="streampay-theme"
              value={value}
              checked={preference === value}
              onChange={() => setPreference(value as ThemePreference)}
            />
            <span>{t(LABEL_KEYS[value])}</span>
          </label>
        ))}
      </div>
      <p id={statusId} className="muted theme-status" aria-live="polite">
        {t("settings.theme.current", { theme: resolvedLabel })}
      </p>
    </fieldset>
  );
}
