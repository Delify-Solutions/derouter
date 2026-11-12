"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/utils/cn";

// The four destinations a customer opens most, as tabs; everything else sits
// under "Thêm" (change mobile-tab-bar).
const TAB_HREFS = ["/account", "/account/plans", "/account/gift", "/account/notifications"];
const TAB_LABELS = {
  "/account": "Tổng quan",
  "/account/plans": "Gói",
  "/account/gift": "Mã quà",
  "/account/notifications": "Thông báo",
};

/**
 * App-style navigation for the customer area below `lg` (change
 * mobile-tab-bar): a floating liquid-glass tab bar at the bottom of the screen
 * with the four main pages and "Thêm", which opens the rest of the pages in a
 * glass sheet above the bar. The glass look (`.liquid-glass` in globals.css) is a
 * documented exception to openspec/ui-dna.md, limited to this navigation.
 *
 * The sheet is a modal dialog rendered into <body> above everything (z-50): the
 * account shell behind it is made `inert`, so neither a pointer, the keyboard nor
 * a screen reader reaches the page while it is open. It closes on choosing an
 * item, Escape, a tap anywhere outside and a route change; focus goes to the
 * first item on open and back to "Thêm" on every close.
 *
 * `items`: [{ href, label, icon, active, badge? }].
 */
export default function MobileMenu({ items, extraItem = null, pathname, email = "", onSignOut, signingOut = false }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  // Order pages and quota belong to "Gói": the bar always marks a current tab there.
  const plansArea = /^\/account\/(orders|quota)(\/|$)/.test(pathname || "");
  const tabs = TAB_HREFS
    .map((href) => items.find((item) => item.href === href))
    .filter(Boolean)
    .map((item) => (item.href === "/account/plans" && plansArea ? { ...item, active: true } : item));
  const more = items.filter((item) => !TAB_HREFS.includes(item.href));
  const moreActive = more.some((item) => item.active);
  const moreUnread = more.some((item) => Boolean(item.badge));

  const close = useCallback(() => {
    setOpen(false);
    // After the shell is no longer inert, or the focus call is ignored.
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  // A route change (a link chosen, back/forward) closes the sheet.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      if (open) close();
    }
  }, [pathname, open, close]);

  useEffect(() => {
    if (!open) return undefined;
    const shell = document.getElementById("account-shell");
    shell?.setAttribute("inert", "");
    const panel = panelRef.current;
    panel?.querySelector("a, button")?.focus();

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll("a[href], button:not([disabled])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Leaving the mobile breakpoint with the sheet open: drop it.
    const query = window.matchMedia("(min-width: 1024px)");
    const onWide = (event) => { if (event.matches) setOpen(false); };
    query.addEventListener("change", onWide);

    return () => {
      shell?.removeAttribute("inert");
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      query.removeEventListener("change", onWide);
    };
  }, [open, close]);

  const sheet = open ? (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Covers the tab bar too: any tap outside the sheet closes it. */}
      <div className="liquid-glass-dim absolute inset-0" aria-hidden="true" onClick={close} />
      <div
        id={panelId}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Các trang khác"
        className="liquid-glass liquid-glass-enter-up absolute inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] overflow-y-auto p-2"
      >
        <div className="relative flex items-center justify-between gap-3 px-3 pb-2 pt-1">
          <p className="min-w-0 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300" title={email}>{email}</p>
          <button
            type="button"
            onClick={close}
            aria-label="Đóng"
            className="liquid-glass-item flex size-9 shrink-0 items-center justify-center text-zinc-800 hover:bg-black/5 dark:text-zinc-200 dark:hover:bg-white/10"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
          </button>
        </div>
        <nav aria-label="Các trang khác" className="relative">
          <ul className="grid grid-cols-1 gap-0.5 min-[420px]:grid-cols-2">
            {more.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  onClick={close}
                  className={cn(
                    "liquid-glass-item flex min-h-12 items-center gap-3 px-3 text-[15px] font-medium transition-colors duration-150",
                    item.active
                      ? "text-zinc-950 dark:text-white"
                      : "text-zinc-800 hover:bg-black/5 dark:text-zinc-200 dark:hover:bg-white/10"
                  )}
                >
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {item.badge ? (
                    <span className="min-w-6 bg-zinc-900 px-1.5 text-center font-mono text-[12px] leading-6 text-white dark:bg-white dark:text-zinc-900">
                      {item.badge}
                      <span className="sr-only"> chưa đọc</span>
                    </span>
                  ) : null}
                  {/* Not colour alone: the current page also carries a mark. */}
                  {item.active ? (
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">check</span>
                  ) : null}
                </Link>
              </li>
            ))}
            {extraItem ? (
              <li>
                <a
                  href={extraItem.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  className="liquid-glass-item flex min-h-12 items-center gap-3 px-3 text-[15px] font-medium text-zinc-800 transition-colors duration-150 hover:bg-black/5 dark:text-zinc-200 dark:hover:bg-white/10"
                >
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{extraItem.icon}</span>
                  <span className="flex-1">{extraItem.label}</span>
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_new</span>
                </a>
              </li>
            ) : null}
          </ul>
        </nav>
        <div className="relative mt-1 border-t border-black/10 pt-1 dark:border-white/10">
          <button
            type="button"
            onClick={() => { close(); onSignOut?.(); }}
            disabled={signingOut}
            className="liquid-glass-item flex min-h-12 w-full items-center gap-3 px-3 text-left text-[15px] font-medium text-red-700 transition-colors duration-150 hover:bg-black/5 disabled:opacity-50 dark:text-red-400 dark:hover:bg-white/10"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">logout</span>
            Đăng xuất
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <nav
        aria-label="Điều hướng tài khoản"
        className="liquid-glass liquid-glass-bar fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 p-1.5 lg:hidden"
      >
        <ul className="relative grid grid-cols-5 gap-1">
          {tabs.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={cn(
                  "liquid-glass-item liquid-glass-tab relative flex h-14 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
                  item.active ? "text-zinc-950 dark:text-white" : "text-zinc-600 dark:text-zinc-300"
                )}
              >
                <span className={cn("material-symbols-outlined text-[24px]", item.active && "fill-1")} aria-hidden="true">
                  {item.icon}
                </span>
                <span className={cn("text-[10.5px] leading-none", item.active ? "font-semibold" : "font-medium")}>
                  {TAB_LABELS[item.href] || item.label}
                </span>
                {item.badge ? (
                  <span className="absolute left-1/2 top-1 ml-1.5 min-w-[18px] bg-red-600 px-1 text-center font-mono text-[10px] font-semibold leading-[18px] text-white">
                    {item.badge}
                    <span className="sr-only"> chưa đọc</span>
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
          <li>
            <button
              ref={buttonRef}
              type="button"
              onClick={() => (open ? close() : setOpen(true))}
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              aria-haspopup="dialog"
              aria-current={moreActive ? "page" : undefined}
              aria-label={moreUnread ? "Thêm, có thông báo chưa đọc" : "Thêm"}
              className={cn(
                "liquid-glass-item liquid-glass-tab relative flex h-14 w-full flex-col items-center justify-center gap-0.5 transition-colors duration-150",
                moreActive ? "text-zinc-950 dark:text-white" : "text-zinc-600 dark:text-zinc-300"
              )}
            >
              <span className={cn("material-symbols-outlined text-[24px]", moreActive && "fill-1")} aria-hidden="true">
                {open ? "close" : "apps"}
              </span>
              <span className={cn("text-[10.5px] leading-none", moreActive ? "font-semibold" : "font-medium")} aria-hidden="true">Thêm</span>
              {moreUnread && !open ? (
                <span aria-hidden="true" className="absolute left-1/2 top-1.5 ml-2 size-2.5 bg-red-600" />
              ) : null}
            </button>
          </li>
        </ul>
      </nav>
      {sheet ? createPortal(sheet, document.body) : null}
    </>
  );
}
