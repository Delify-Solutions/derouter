"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/shared/utils/cn";

// Order is the spec's (customer-portal "Navigation and language"): the questions a
// customer asks in order — what do I have, what am I paying, what did I spend, what
// was gifted, how do I connect, what did I use.
const NAV = [
  { href: "/account", label: "Tổng quan", icon: "dashboard" },
  { href: "/account/plans", label: "Gói của tôi", icon: "workspace_premium" },
  { href: "/account/ledger", label: "Nhật ký credit", icon: "receipt_long" },
  { href: "/account/gift", label: "Mã quà tặng", icon: "redeem" },
  { href: "/account/keys", label: "API key", icon: "key" },
  { href: "/account/usage", label: "Lịch sử dùng", icon: "monitoring" },
];

function isActive(pathname, href) {
  return href === "/account" ? pathname === href : Boolean(pathname?.startsWith(href));
}

/**
 * Customer area frame: a 256px sidebar, a 64px header carrying the current page
 * and the account controls, then the page. Below `lg` the sidebar becomes a row
 * of links under the header, so every destination stays one tap away.
 */
export default function AccountShell({ email = "", name = "", children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const current = NAV.find((item) => isActive(pathname, item.href)) ?? NAV[0];
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();

  const signOut = async () => {
    setPending(true);
    try {
      await fetch("/api/public/logout", { method: "POST" });
    } catch {
      // The cookie may already be gone; go to the sign-in page regardless.
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center px-6">
          <Link href="/account" className="font-mono text-base font-semibold tracking-tight text-text-main">
            <span className="text-text-subtle" aria-hidden="true">{"//"}</span> derouter
          </Link>
        </div>

        <nav aria-label="Tài khoản" className="flex flex-col gap-1 px-4 py-2">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 px-3 text-sm font-medium transition-colors duration-150",
                  active ? "bg-surface-2 text-text-main" : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-border bg-bg px-6 lg:px-10">
          <div className="flex items-center gap-3">
            <Link href="/account" className="font-mono text-base font-semibold text-text-main lg:hidden">
              <span className="text-text-subtle" aria-hidden="true">{"//"}</span>
              <span className="sr-only">derouter</span>
            </Link>
            <span className="material-symbols-outlined hidden text-[18px] text-text-subtle lg:inline" aria-hidden="true">
              {current.icon}
            </span>
            <span className="text-sm font-medium text-text-main">{current.label}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden max-w-[240px] truncate font-mono text-xs text-text-muted sm:inline" title={email}>
              {email}
            </span>
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center border border-border bg-surface-2 font-mono text-xs font-semibold text-text-main"
            >
              {initial}
            </span>
            <button
              type="button"
              onClick={signOut}
              disabled={pending}
              aria-label="Đăng xuất"
              title="Đăng xuất"
              className="flex size-8 items-center justify-center border border-border text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">logout</span>
            </button>
          </div>
        </header>

        <nav aria-label="Tài khoản (thu gọn)" className="flex overflow-x-auto border-b border-border lg:hidden">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium transition-colors duration-150",
                  active ? "border-b-text-main text-text-main" : "border-b-transparent text-text-muted hover:text-text-main"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <main className="flex-1 px-6 py-10 lg:px-10">
          <div className="mx-auto w-full max-w-[1100px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
