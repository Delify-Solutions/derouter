"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import MobileMenu from "./MobileMenu";
import { cn } from "@/shared/utils/cn";
import ThemeToggle from "@/shared/components/ThemeToggle";
import { USAGE_KEY_STORAGE } from "@/shared/constants/usageKeyStorage";

// Order is the spec's (customer-portal "Navigation and language"): the questions a
// customer asks in order — what do I have, what am I paying, what did I spend, what
// was gifted, how do I connect, what did I use.
const NAV = [
  { href: "/account", label: "Tổng quan", icon: "dashboard" },
  { href: "/account/chat", label: "Chat", icon: "chat" },
  { href: "/account/models", label: "Model", icon: "view_list" },
  { href: "/account/plans", label: "Gói của tôi", icon: "workspace_premium" },
  { href: "/account/ledger", label: "Nhật ký credit", icon: "receipt_long" },
  { href: "/account/gift", label: "Mã quà tặng", icon: "redeem" },
  // Affiliate program (spec affiliate-program "Customer affiliate page"). Shown
  // only when the program is on or the account already has wallet history: a
  // disabled program must not hand out a link.
  { href: "/account/affiliate", label: "Giới thiệu", icon: "group_add", affiliateOnly: true },
  { href: "/account/keys", label: "API key", icon: "key" },
  { href: "/account/usage", label: "Lịch sử dùng", icon: "monitoring" },
  { href: "/account/notifications", label: "Thông báo", icon: "notifications", badge: "unread" },
  { href: "/account/settings", label: "Tài khoản", icon: "manage_accounts" },
];

/** "3", "99+": the unread badge text, or null for none. */
function badgeText(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return null;
  return n > 99 ? "99+" : String(n);
}

function isActive(pathname, href) {
  return href === "/account" ? pathname === href : Boolean(pathname?.startsWith(href));
}

/**
 * Customer area frame: a 256px sidebar, a 64px header carrying the current page
 * and the account controls, then the page. Below `lg` the sidebar becomes an app-style
 * liquid-glass tab bar at the bottom (MobileMenu): four main pages and "Thêm" for the rest.
 */
export default function AccountShell({ email = "", name = "", affiliateAvailable = false, unreadCount = 0, channelUrl = "", children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const unread = badgeText(unreadCount);
  const items = NAV
    .filter((item) => !item.affiliateOnly || affiliateAvailable)
    .map((item) => (item.badge === "unread" ? { ...item, badge: unread } : item));
  // The admin's Telegram channel, opened in a new tab (change models-notifications).
  const channelItem = channelUrl ? { href: channelUrl, label: "Kênh Telegram", icon: "send", external: true } : null;
  const current = items.find((item) => isActive(pathname, item.href)) ?? items[0];
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();

  const signOut = async () => {
    setPending(true);
    // A key handed to /usage from the key list must not outlive the session on a
    // shared browser.
    try { localStorage.removeItem(USAGE_KEY_STORAGE); } catch { /* storage blocked */ }
    try {
      await fetch("/api/public/logout", { method: "POST" });
    } catch {
      // The cookie may already be gone; go to the sign-in page regardless.
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <div id="account-shell" className="flex min-h-screen bg-bg">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center px-6">
          <Link href="/account" className="font-mono text-base font-semibold tracking-tight text-text-main">
            <span className="text-text-subtle" aria-hidden="true">{"//"}</span> derouter
          </Link>
        </div>

        <nav aria-label="Tài khoản" className="flex flex-col gap-1 px-4 py-2">
          {items.map((item) => {
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
                <span className="flex-1">{item.label}</span>
                {item.badge ? (
                  <span className="min-w-5 border border-text-main bg-text-main px-1 text-center font-mono text-[11px] leading-5 text-bg">
                    {item.badge}
                    <span className="sr-only"> chưa đọc</span>
                  </span>
                ) : null}
              </Link>
            );
          })}
          {channelItem ? (
            <a
              href={channelItem.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex h-9 items-center gap-3 border-t border-border px-3 pt-2 text-sm font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-main"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{channelItem.icon}</span>
              <span className="flex-1">{channelItem.label}</span>
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
            </a>
          ) : null}
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
            <ThemeToggle variant="square" className="size-8" />
            <span className="hidden max-w-[240px] truncate font-mono text-xs text-text-muted sm:inline" title={email}>
              {email}
            </span>
            <Link
              href="/account/settings"
              aria-label="Tài khoản"
              title="Tài khoản"
              className="flex size-8 items-center justify-center border border-border bg-surface-2 font-mono text-xs font-semibold text-text-main transition-colors duration-150 hover:border-text-main"
            >
              <span aria-hidden="true">{initial}</span>
            </Link>
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


        {/* Below lg the bottom padding keeps the last content clear of the tab bar. */}
        <main className="flex-1 px-6 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-10 lg:px-10 lg:pb-10">
          <div className="mx-auto w-full max-w-[1100px]">{children}</div>
        </main>
      </div>

      <MobileMenu
        items={items.map((item) => ({ ...item, active: isActive(pathname, item.href) }))}
        extraItem={channelItem}
        pathname={pathname}
        email={email}
        onSignOut={signOut}
        signingOut={pending}
      />
    </div>
  );
}
