"use client";

import { useState, useEffect } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { LOCALE_FLAGS } from "@/shared/constants/locales";
import LanguageSwitcher from "./LanguageSwitcher";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

export default function HeaderLanguage({ variant = "default" }) {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState(DEFAULT_LOCALE);

  useEffect(() => {
    setLocale(getLocaleFromCookie());
  }, [open]);

  return (
    <>
      {variant === "square" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-none border border-border px-2.5 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-main"
          title="Language"
          aria-label={`Language: ${locale}`}
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">language</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.08em]" data-i18n-skip="true">{locale}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all"
          title="Language"
          data-i18n-skip="true"
        >
          <span className="text-lg leading-none">{LOCALE_FLAGS[locale] || "🌐"}</span>
        </button>
      )}

      <LanguageSwitcher
        hideTrigger
        isOpen={open}
        onClose={(next) => {
          setOpen(false);
          setLocale(next);
        }}
      />
    </>
  );
}
