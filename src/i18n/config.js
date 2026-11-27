export const LOCALES = ["en", "vi"];
export const DEFAULT_LOCALE = "vi";
export const LOCALE_COOKIE = "locale";

export const LOCALE_NAMES = {
  en: "English",
  vi: "Tiếng Việt",
};

export function normalizeLocale(locale) {
  if (locale === "en") return "en";
  if (locale === "vi") return "vi";
  return DEFAULT_LOCALE;
}

export function isSupportedLocale(locale) {
  return LOCALES.includes(locale);
}
