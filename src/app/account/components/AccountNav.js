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
  { href: "/account/ledger", label: "Sổ cái", icon: "receipt_long" },
  { href: "/account/gift", label: "Mã quà tặng", icon: "redeem" },
  { href: "/account/keys", label: "API key", icon: "key" },
  { href: "/account/usage", label: "Lịch sử dùng", icon: "monitoring" },
];

export default function AccountNav({ email = "" }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const isActive = (href) => (href === "/account" ? pathname === href : pathname?.startsWith(href));

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
    <nav aria-label="Tài khoản" className="flex flex-col h-full">
      <div className="h-16 flex items-center px-5 border-b border-border">
        <Link href="/account" className="meta text-text-main hover:text-brand-600 transition-colors">
          derouter
        </Link>
      </div>

      <ul className="flex flex-col py-3">
        {NAV.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 h-10 px-5 font-mono text-[12px] uppercase tracking-[0.08em] border-l-2 transition-colors duration-150",
                isActive(item.href)
                  ? "border-l-brand-500 text-text-main bg-surface-2"
                  : "border-l-transparent text-text-muted hover:text-text-main hover:bg-surface-2"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-auto border-t border-border p-5 flex flex-col gap-3">
        {email && (
          <div>
            <p className="meta text-text-subtle">Đăng nhập với</p>
            <p className="font-mono text-[12px] text-text-muted break-all mt-1">{email}</p>
          </div>
        )}
        <button
          type="button"
          onClick={signOut}
          disabled={pending}
          className="h-9 border border-border font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">logout</span>
          Đăng xuất
        </button>
      </div>
    </nav>
  );
}
