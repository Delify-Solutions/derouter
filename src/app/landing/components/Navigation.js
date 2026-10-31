"use client";

import { useState } from "react";
import Link from "next/link";
import ThemeToggle from "@/shared/components/ThemeToggle";

const PRODUCT_LINKS = [
  { href: "#plans", label: "Gói" },
  { href: "#models", label: "Model" },
  { href: "#pricing", label: "Bảng giá" },
  { href: "#get-started", label: "Cách dùng" },
  { href: "#faq", label: "Hỏi đáp" },
];

const DOCS_URL = "/docs";
const SIGNUP_URL = "/register?next=/account/plans";

/**
 * `session` is resolved on the server and passed in. This is the customer shop,
 * so the only states are anonymous and signed-in customer — an admin browsing
 * here is anonymous by design and gets no operator entry point.
 *
 *   null          → Đăng nhập + Mua gói
 *   "customer"    → Tài khoản của tôi
 */
export default function Navigation({ session = null }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg">
      <div className="shell flex h-16 items-center justify-between gap-4">
        <Link href="/" className="font-mono text-base font-semibold tracking-tight text-text-main">
          <span className="text-text-subtle" aria-hidden="true">{"//"}</span> derouter
        </Link>

        <nav aria-label="Chính" className="hidden items-center gap-6 md:flex">
          {PRODUCT_LINKS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-text-muted transition-colors duration-150 hover:text-text-main"
            >
              {item.label}
            </a>
          ))}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-text-muted transition-colors duration-150 hover:text-text-main"
          >
            Tài liệu
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle variant="square" />
          {session === "customer" ? (
            <Link
              href="/account"
              className="hidden h-9 items-center border border-text-main bg-text-main px-4 font-mono text-[13px] font-medium text-bg transition-colors duration-150 hover:bg-text-main/85 sm:inline-flex"
            >
              Tài khoản của tôi
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden h-9 items-center px-3 text-sm font-medium text-text-muted transition-colors duration-150 hover:text-text-main sm:inline-flex"
              >
                Đăng nhập
              </Link>
              <Link
                href={SIGNUP_URL}
                className="hidden h-9 items-center border border-text-main bg-text-main px-4 font-mono text-[13px] font-medium text-bg transition-colors duration-150 hover:bg-text-main/85 sm:inline-flex"
              >
                Mua gói
              </Link>
            </>
          )}
          <button
            type="button"
            className="flex size-9 items-center justify-center border border-border text-text-main md:hidden"
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
                className="flex h-11 items-center text-sm font-medium text-text-muted hover:text-text-main"
              >
                {item.label}
              </a>
            ))}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileMenuOpen(false)}
              className="flex h-11 items-center text-sm font-medium text-text-muted hover:text-text-main"
            >
              Tài liệu
            </a>
            <div className="mb-3 mt-2 flex flex-col gap-2">
              {session === "customer" ? (
                <Link
                  href="/account"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex h-11 items-center justify-center border border-text-main bg-text-main font-mono text-[13px] font-medium text-bg"
                >
                  Tài khoản của tôi
                </Link>
              ) : (
                <>
                  <Link
                    href="/login"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex h-11 items-center justify-center border border-border font-mono text-[13px] font-medium text-text-main"
                  >
                    Đăng nhập
                  </Link>
                  <Link
                    href={SIGNUP_URL}
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex h-11 items-center justify-center border border-text-main bg-text-main font-mono text-[13px] font-medium text-bg"
                  >
                    Mua gói
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
