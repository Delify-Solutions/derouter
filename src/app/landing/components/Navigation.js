"use client";

import { useState } from "react";
import Link from "next/link";

const PRODUCT_LINKS = [
  { href: "#plans", label: "Gói" },
  { href: "#models", label: "Model" },
  { href: "#pricing", label: "Bảng giá" },
  { href: "#get-started", label: "Cách dùng" },
  { href: "#faq", label: "Hỏi đáp" },
];

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";
const SIGNUP_URL = "/register?next=/account/plans";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg/90 backdrop-blur-sm">
      <div className="shell flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center border border-border text-text-main">
            <span className="material-symbols-outlined text-[18px]">hub</span>
          </span>
          <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em]">derouter</span>
        </Link>

        <nav aria-label="Chính" className="hidden items-center gap-6 md:flex">
          {PRODUCT_LINKS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
            >
              {item.label}
            </a>
          ))}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
          >
            Tài liệu
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden h-8 items-center px-3 font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main sm:inline-flex"
          >
            Đăng nhập
          </Link>
          <Link
            href={SIGNUP_URL}
            className="hidden h-8 items-center border border-brand-500 bg-brand-500 px-4 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600 sm:inline-flex"
          >
            Mua gói
          </Link>
          <button
            type="button"
            className="flex size-8 items-center justify-center border border-border text-text-main md:hidden"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? "Đóng menu" : "Mở menu"}
          >
            <span className="material-symbols-outlined text-[18px]">
              {mobileMenuOpen ? "close" : "menu"}
            </span>
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="border-t border-border bg-bg md:hidden">
          <nav aria-label="Di động" className="shell flex flex-col py-2">
            {PRODUCT_LINKS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="flex h-10 items-center font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main"
              >
                {item.label}
              </a>
            ))}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileMenuOpen(false)}
              className="flex h-10 items-center font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main"
            >
              Tài liệu
            </a>
            <div className="mb-3 mt-2 flex flex-col gap-2">
              <Link
                href="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="flex h-10 items-center justify-center border border-border font-mono text-[12px] uppercase tracking-[0.08em] text-text-main"
              >
                Đăng nhập
              </Link>
              <Link
                href={SIGNUP_URL}
                onClick={() => setMobileMenuOpen(false)}
                className="flex h-10 items-center justify-center border border-brand-500 bg-brand-500 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-white"
              >
                Mua gói
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
