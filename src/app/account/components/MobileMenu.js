"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/utils/cn";

/**
 * Hamburger + liquid-glass menu panel for the customer area below `lg`
 * (change account-settings, design D4). The glass look (`.liquid-glass` in
 * globals.css) is a documented exception to openspec/ui-dna.md, limited to this
 * panel.
 *
 * The panel is a modal dialog rendered into <body> above everything (z-50): the
 * account shell behind it is made `inert`, so neither a pointer, the keyboard nor
 * a screen reader reaches the page while it is open. It closes on choosing an
 * item, Escape, a tap anywhere outside (header included) and a route change;
 * focus goes to the first item on open and back to the button on every close.
 *
 * `items`: [{ href, label, icon, active }].
 */
export default function MobileMenu({ items, pathname, email = "", onSignOut, signingOut = false }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    // After the shell is no longer inert, or the focus call is ignored.
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  // A route change (a link chosen, back/forward) closes the menu.
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

    // Leaving the mobile breakpoint with the menu open: drop it.
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

  const panel = open ? (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Covers the header too: any tap outside the panel closes it. */}
      <div className="liquid-glass-dim absolute inset-0" aria-hidden="true" onClick={close} />
      <div
        id={panelId}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu tài khoản"
        className="liquid-glass liquid-glass-enter absolute inset-x-3 top-[4.75rem] max-h-[calc(100dvh-5.5rem)] overflow-y-auto p-2"
      >
        <div className="relative flex items-center justify-between gap-3 px-3 pb-2 pt-1">
          <p className="min-w-0 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300" title={email}>{email}</p>
          <button
            type="button"
            onClick={close}
            aria-label="Đóng menu"
            className="liquid-glass-item flex size-9 shrink-0 items-center justify-center text-zinc-800 hover:bg-black/5 dark:text-zinc-200 dark:hover:bg-white/10"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
          </button>
        </div>
        <nav aria-label="Các trang tài khoản" className="relative">
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  onClick={() => { if (item.active) close(); }}
                  className={cn(
                    "liquid-glass-item flex min-h-11 items-center gap-3 px-3 text-[15px] font-medium transition-colors duration-150",
                    item.active
                      ? "text-zinc-950 dark:text-white"
                      : "text-zinc-800 hover:bg-black/5 dark:text-zinc-200 dark:hover:bg-white/10"
                  )}
                >
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {/* Not colour alone: the current page also carries a mark. */}
                  {item.active ? (
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">check</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="relative mt-1 border-t border-black/10 pt-1 dark:border-white/10">
          <button
            type="button"
            onClick={() => { close(); onSignOut?.(); }}
            disabled={signingOut}
            className="liquid-glass-item flex min-h-11 w-full items-center gap-3 px-3 text-left text-[15px] font-medium text-red-700 transition-colors duration-150 hover:bg-black/5 disabled:opacity-50 dark:text-red-400 dark:hover:bg-white/10"
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
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label={open ? "Đóng menu" : "Mở menu"}
        className="flex size-8 items-center justify-center border border-border text-text-main transition-colors duration-150 hover:bg-surface-2 lg:hidden"
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{open ? "close" : "menu"}</span>
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  );
}
