"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, Tag, buttonClass } from "./ui";

const POLL_MS = 3000;

async function fetchStatus() {
  const res = await fetch("/api/account/telegram", { cache: "no-store" });
  if (!res.ok) throw new Error("status");
  return res.json();
}

/**
 * Telegram link state for the signed-in customer (spec telegram-link).
 *
 * `start()` asks for a one-time Mini App link and opens it; while it is pending
 * the status is polled every 3 s and whenever the tab regains focus (the customer
 * comes back from the Telegram app) until the account is linked or the link
 * expires. `onLinked` fires once when that happens.
 */
export function useTelegramLink({ onLinked } = {}) {
  const [status, setStatus] = useState(null); // { configured, linked, telegramUsername }
  const [pending, setPending] = useState(null); // { url, expiresAt }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onLinkedRef = useRef(onLinked);
  useEffect(() => { onLinkedRef.current = onLinked; }, [onLinked]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchStatus();
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((next) => { if (!cancelled) setStatus(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Poll while a link is pending.
  useEffect(() => {
    if (!pending) return undefined;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      if (Date.parse(pending.expiresAt) < Date.now()) {
        setPending(null);
        setError("Link đã hết hạn. Bấm \"Liên kết Telegram\" để tạo link mới.");
        return;
      }
      const next = await refresh();
      if (!stopped && next?.linked) {
        stopped = true;
        setPending(null);
        onLinkedRef.current?.(next);
      }
    };
    const timer = setInterval(check, POLL_MS);
    const onFocus = () => { if (document.visibilityState !== "hidden") check(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [pending, refresh]);

  const start = useCallback(async () => {
    setError("");
    setBusy(true);
    // Open the tab inside the click so pop-up blockers allow it, then point it at
    // the link once the server has issued one.
    const win = typeof window !== "undefined" ? window.open("", "_blank") : null;
    try {
      const res = await fetch("/api/account/telegram/link", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        win?.close();
        setError(data.error || "Không tạo được link Telegram. Thử lại.");
        return;
      }
      if (win) win.location.href = data.url;
      setPending({ url: data.url, expiresAt: data.expiresAt });
    } catch {
      win?.close();
      setError("Không kết nối được máy chủ. Thử lại.");
    } finally {
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const unlink = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/account/telegram", { method: "DELETE" });
      if (!res.ok) throw new Error("unlink");
      await refresh();
    } catch {
      setError("Không gỡ được liên kết. Thử lại.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { status, pending, busy, error, start, cancel, unlink };
}

function ErrorLine({ message }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
      <span className="material-symbols-outlined text-[16px] mt-0.5" aria-hidden="true">error</span>
      <span>{message}</span>
    </p>
  );
}

/** The waiting state: shared by the account page and the gift page. */
function PendingBlock({ pending, cancel }) {
  return (
    <div role="status" className="flex flex-col gap-3 border border-border bg-surface-2 p-4">
      <p className="flex items-center gap-2 text-sm text-text-main">
        <span className="material-symbols-outlined animate-spin text-[16px]" aria-hidden="true">progress_activity</span>
        Đang chờ xác nhận từ Telegram…
      </p>
      <p className="text-sm text-text-muted">
        Telegram sẽ mở trang liên kết và tự xác nhận. Xong thì quay lại đây, trang sẽ tự cập nhật.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={pending.url} target="_blank" rel="noopener noreferrer" className={buttonClass({ tone: "solid" })}>
          Mở lại Telegram
        </a>
        <ActionButton type="button" onClick={cancel}>Huỷ</ActionButton>
      </div>
    </div>
  );
}

/** "Liên kết Telegram" button with its waiting state, for a page that needs a link (the gift page). */
export function TelegramLinkPrompt({ onLinked }) {
  const { status, pending, busy, error, start, cancel } = useTelegramLink({ onLinked });
  if (status && status.configured === false) {
    return <ErrorLine message="Hệ thống chưa cấu hình liên kết Telegram. Vui lòng liên hệ admin." />;
  }
  return (
    <div className="flex flex-col gap-3">
      {pending ? (
        <PendingBlock pending={pending} cancel={cancel} />
      ) : (
        <div>
          <ActionButton tone="solid" type="button" loading={busy} onClick={start}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
            Liên kết Telegram
          </ActionButton>
        </div>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

/** Telegram row on the account overview: state, link and unlink. Hidden until configured. */
export function TelegramLinkCard({ className = "" }) {
  const { status, pending, busy, error, start, cancel, unlink } = useTelegramLink();
  if (!status || !status.configured) return null;
  return (
    <div className={`flex flex-col gap-4 p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-main">Telegram</p>
          <p className="mt-1 text-sm text-text-muted">
            {status.linked
              ? `Đã liên kết${status.telegramUsername ? ` với @${status.telegramUsername}` : ""}.`
              : "Liên kết Telegram để nhận ưu đãi dành cho tài khoản mới."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status.linked ? (
            <>
              <Tag tone="success" icon="check_circle">Đã liên kết</Tag>
              <ActionButton type="button" loading={busy} onClick={unlink}>Gỡ liên kết</ActionButton>
            </>
          ) : (
            !pending && (
              <ActionButton tone="solid" type="button" loading={busy} onClick={start}>
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
                Liên kết Telegram
              </ActionButton>
            )
          )}
        </div>
      </div>
      {pending && !status.linked && <PendingBlock pending={pending} cancel={cancel} />}
      <ErrorLine message={error} />
    </div>
  );
}
