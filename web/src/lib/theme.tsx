/**
 * Theme — the terminal's light/dark switch.
 *
 * The institutional look is light by default: white canvas, light-grey panels,
 * dark text. Dark mode keeps the original terminal palette. The choice is a
 * class on `<html>` (`.dark`) plus a persisted preference; every colour in the
 * app is a CSS variable, so the flip is instant and total.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { loadState, saveState } from "@/lib/storage";

export type Theme = "light" | "dark";

const THEME_KEY = "nova-theme";

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } | null>(null);

function initial(): Theme {
  return loadState<Theme>(THEME_KEY, "light") === "dark" ? "dark" : "light";
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initial);

  useEffect(() => apply(theme), [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    saveState(THEME_KEY, next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      saveState(THEME_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
