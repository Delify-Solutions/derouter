"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGES, type LangCode, getStoredLang, setStoredLang } from "@/i18n";
import { useTranslation } from "react-i18next";
import { Check, Globe } from "lucide-react";

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = (i18n.language as LangCode) || getStoredLang();

  const handleChange = (code: LangCode) => {
    setStoredLang(code);
    void i18n.changeLanguage(code);
  };

  const currentLang = LANGUAGES.find((l) => l.code === current) ?? LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="h-[38px] w-full justify-start gap-2.5 px-3 text-[13px] text-foreground" />
        }
      >
        <Globe className="size-[17px] text-muted-foreground" />
        <span className="flex-1 text-left">
          {currentLang.flag} {currentLang.name}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => handleChange(lang.code)}
            className="cursor-pointer justify-between"
          >
            <span className="flex items-center gap-2">
              {lang.flag} {lang.name}
            </span>
            {lang.code === current && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
