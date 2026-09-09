// i18n entry for DeRouter dashboard.
// The actual i18next/react-i18next init lives in I18nProvider.tsx ("use client") so
// that it never runs during Next.js static page-collection (where React server
// rendering has no createContext, causing "createContext is not a function").
// Import from this module is safe from any context (server or client); only
// I18nProvider + useTranslation trigger client-only initialization.
export { default as I18nProvider } from "./I18nProvider";
export { LANGUAGES, type LangCode, getStoredLang, setStoredLang } from "./I18nProvider";
