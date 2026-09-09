"use client";

import { useState, type ReactNode } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18n from "i18next";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

export const LANGUAGES = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "vi", name: "Tiếng Việt", flag: "🇻🇳" },
] as const;

export type LangCode = (typeof LANGUAGES)[number]["code"];

export function getStoredLang(): LangCode {
  if (typeof window === "undefined") return "vi";
  const stored = localStorage.getItem("derouter-lang");
  if (stored === "en" || stored === "vi") return stored;
  return "vi";
}

export function setStoredLang(code: LangCode) {
  if (typeof window !== "undefined") localStorage.setItem("derouter-lang", code);
}

// Module-level singleton; init runs once even across re-renders.
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      vi: { translation: vi },
    },
    lng: "vi",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export default function I18nProvider({ children }: { children: ReactNode }) {
  const [instance] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = getStoredLang();
      if (stored !== i18n.language) void i18n.changeLanguage(stored);
    }
    return i18n;
  });
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
