"use client";

import React, { useEffect } from "react";
import useThemeStore from "@/store/themeStore";

export interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const { initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return <>{children}</>;
}
