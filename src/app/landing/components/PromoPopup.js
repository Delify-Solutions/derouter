"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  giftPageHref,
  isPopupDismissed,
  promoTargetHref,
  readPopupDismissal,
  readPromoPopup,
  savePendingGiftCode,
  savePopupDismissal,
} from "@/shared/utils/promoPopup.js";

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure context: a hidden textarea + execCommand.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * The dialog itself, without timing or storage: the landing page wraps it in
 * PromoPopup, the admin editor renders it as a static preview.
 */
export function PromoPopupDialog({ popup, signedIn = false, onClose, onCopy, onFollow, copied = false, copyFailed = false, preview = false }) {
  const titleId = preview ? undefined : "promo-popup-title";
  const href = promoTargetHref(popup.code, { signedIn });
  const loginHref = `/login?next=${encodeURIComponent(giftPageHref(popup.code))}`;

  return (
    <div className="relative w-full max-w-md border border-border bg-surface text-text-main">
      <button
        type="button"
        onClick={onClose}
        aria-label="Đóng"
        className="absolute right-2 top-2 inline-flex size-9 items-center justify-center text-text-muted hover:text-text-main"
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
      </button>
      <div className="flex flex-col gap-4 p-6">
        {popup.title && (
          <h2 id={titleId} className="pr-8 text-xl font-semibold tracking-tight">{popup.title}</h2>
        )}
        {popup.body && <p className="whitespace-pre-line text-sm text-text-muted">{popup.body}</p>}
        {popup.code && (
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Mã ưu đãi</span>
            <button
              type="button"
              onClick={onCopy}
              className="group flex items-center justify-between gap-3 border border-dashed border-brand-500/60 bg-brand-500/5 px-4 py-3 text-left hover:border-brand-500"
              aria-label={`Sao chép mã ${popup.code}`}
              aria-describedby={copyFailed ? "promo-copy-failed" : undefined}
            >
              <span className="font-mono text-lg tracking-[0.12em]">{popup.code}</span>
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-700 dark:text-brand-400">
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{copied ? "check" : "content_copy"}</span>
                {copied ? "Đã copy" : "Copy"}
              </span>
            </button>
            <span role="status" className="sr-only">{copied ? "Đã sao chép mã" : ""}</span>
            {copyFailed && (
              <span id="promo-copy-failed" className="text-xs text-text-muted">
                Trình duyệt không cho sao chép tự động. Hãy chọn mã ở trên và sao chép thủ công.
              </span>
            )}
          </div>
        )}
        <a
          href={href}
          onClick={onFollow}
          className="inline-flex h-11 items-center justify-center border border-text-main bg-text-main px-5 font-mono text-[12px] uppercase tracking-[0.14em] text-bg transition-colors duration-150 hover:bg-text-main/85"
        >
          {popup.cta}
        </a>
        {!signedIn && popup.code && (
          <p className="text-center text-xs text-text-muted">
            Đã có tài khoản?{" "}
            <a href={loginHref} onClick={onFollow} className="underline hover:text-text-main">
              Đăng nhập để nhập mã
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

PromoPopupDialog.propTypes = {
  popup: PropTypes.object.isRequired,
  signedIn: PropTypes.bool,
  onClose: PropTypes.func,
  onCopy: PropTypes.func,
  onFollow: PropTypes.func,
  copied: PropTypes.bool,
  copyFailed: PropTypes.bool,
  preview: PropTypes.bool,
};

/**
 * Landing-page popup (spec promo-popup): opens after the configured delay unless
 * this version was dismissed recently; Esc, the close button or the backdrop
 * dismiss it. Clicking the code copies it and remembers it for the gift page.
 */
export default function PromoPopup({ copy, signedIn = false }) {
  const popup = readPromoPopup(copy);
  const live = popup.enabled && Boolean(popup.title || popup.body || popup.code);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const dialogRef = useRef(null);
  const lastFocus = useRef(null);
  const { version, delaySec, repeatDays } = popup;

  useEffect(() => {
    if (!live) return undefined;
    if (isPopupDismissed(readPopupDismissal(), version, repeatDays)) return undefined;
    const timer = setTimeout(() => {
      lastFocus.current = document.activeElement;
      setOpen(true);
    }, delaySec * 1000);
    return () => clearTimeout(timer);
  }, [live, version, delaySec, repeatDays]);

  const close = useCallback(() => {
    setOpen(false);
    savePopupDismissal(version);
    lastFocus.current?.focus?.();
  }, [version]);

  useEffect(() => {
    if (!open) return undefined;
    const node = dialogRef.current;
    node?.querySelector("button, a")?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !node) return;
      // Keep focus inside the dialog while it is open.
      const items = [...node.querySelectorAll("button, a")];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const onCopy = async () => {
    savePendingGiftCode(popup.code);
    const ok = await copyText(popup.code);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  // Acting on the offer counts as seeing it: it should not reopen on the next
  // visit for someone who already took it.
  const onFollow = () => {
    if (popup.code) savePendingGiftCode(popup.code);
    savePopupDismissal(version);
  };

  // The page behind must not scroll while the dialog is open.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  if (!live || !open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={popup.title ? "promo-popup-title" : undefined}
        aria-label={popup.title ? undefined : "Ưu đãi"}
        className="w-full max-w-md"
      >
        <PromoPopupDialog
          popup={popup}
          signedIn={signedIn}
          onClose={close}
          onCopy={onCopy}
          onFollow={onFollow}
          copied={copied}
          copyFailed={copyFailed}
        />
      </div>
    </div>
  );
}

PromoPopup.propTypes = {
  copy: PropTypes.object.isRequired,
  signedIn: PropTypes.bool,
};
