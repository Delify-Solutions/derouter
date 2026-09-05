"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import useThemeStore from "@/store/themeStore";

type Theme = "light" | "dark" | "system";

interface ThemeStoreState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  initTheme: () => void;
}

// Subscribe to system theme changes
function subscribeToSystemTheme(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

// Get current system theme preference
function getSystemThemeSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Server snapshot always returns false
function getServerSnapshot(): boolean {
  return false;
}

export interface UseThemeReturn {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  isDark: boolean;
}

export function useTheme(): UseThemeReturn {
  const { theme, setTheme, toggleTheme, initTheme } = useThemeStore() as ThemeStoreState;

  // Use useSyncExternalStore to safely subscribe to system theme
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  // Listen for system theme changes when theme is "system"
  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (): void => initTheme();

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme, initTheme]);

  // Compute isDark from current state (no effect needed)
  const isDark = theme === "dark" || (theme === "system" && systemPrefersDark);

  return {
    theme,
    setTheme,
    toggleTheme,
    isDark,
  };
}
