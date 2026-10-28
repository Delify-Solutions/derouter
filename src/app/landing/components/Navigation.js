"use client";

import { useState } from "react";
import Link from "next/link";

const PRODUCT_LINKS = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#get-started", label: "Get started" },
];

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg/90 backdrop-blur-sm">
      <div className="shell h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center border border-border text-text-main">
            <span className="material-symbols-outlined text-[18px]">hub</span>
          </span>
          <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em]">derouter</span>
        </Link>

        <nav aria-label="Primary" className="hidden md:flex items-center gap-6">
          {PRODUCT_LINKS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
            >
              {item.label}
            </a>
          ))}
          <Link
            href="/register?next=/account/plans"
            className="font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
          >
            Pricing
          </Link>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
          >
            Docs
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden sm:inline-flex h-8 items-center px-3 font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="hidden sm:inline-flex h-8 items-center border border-brand-500 bg-brand-500 px-4 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600"
          >
            Create account
          </Link>
          <button
            type="button"
            className="md:hidden flex size-8 items-center justify-center border border-border text-text-main"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            <span className="material-symbols-outlined text-[18px]">
              {mobileMenuOpen ? "close" : "menu"}
            </span>
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border bg-bg">
          <nav aria-label="Mobile" className="shell flex flex-col py-2">
            {PRODUCT_LINKS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="h-10 flex items-center font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main"
              >
                {item.label}
              </a>
            ))}
            <Link
              href="/register?next=/account/plans"
              onClick={() => setMobileMenuOpen(false)}
              className="h-10 flex items-center font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main"
            >
              Pricing
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileMenuOpen(false)}
              className="h-10 flex items-center font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main"
            >
              Docs
            </a>
            <div className="mt-2 mb-3 flex flex-col gap-2">
              <Link
                href="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="h-10 flex items-center justify-center border border-border font-mono text-[12px] uppercase tracking-[0.08em] text-text-main"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                onClick={() => setMobileMenuOpen(false)}
                className="h-10 flex items-center justify-center border border-brand-500 bg-brand-500 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-white"
              >
                Create account
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
