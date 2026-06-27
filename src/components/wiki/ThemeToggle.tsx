"use client";

import { useEffect, useState } from "react";

type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "noosphere-theme";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function applyTheme(theme: ThemePreference) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }

  document.documentElement.dataset.theme = theme;
}

function getInitialTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function cycleTheme() {
    const nextTheme: ThemePreference =
      theme === "system" ? "dark" : theme === "dark" ? "light" : "system";

    setTheme(nextTheme);
    applyTheme(nextTheme);

    try {
      if (nextTheme === "system") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, nextTheme);
      }
    } catch {
      // Theme choice is an enhancement; ignore storage failures.
    }
  }

  const label =
    theme === "system"
      ? "Use dark theme"
      : theme === "dark"
        ? "Use light theme"
        : "Use system theme";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycleTheme}
      aria-label={label}
      title={label}
      suppressHydrationWarning
    >
      <span aria-hidden suppressHydrationWarning>
        {theme === "system" ? "◐" : theme === "dark" ? "☾" : "☼"}
      </span>
    </button>
  );
}
