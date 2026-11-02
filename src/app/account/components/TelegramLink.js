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

  return { status, setStatus, pending, busy, error, start, cancel, unlink };
}

// Customer-facing groups (spec telegram-notify). Security messages are always on.
const NOTIFY_OPTIONS = [
  { key: "billing", label: "Thanh toán & gói", hint: "Đơn được duyệt, gói được kích hoạt, nhận quà." },
  { key: "expiry", label: "Gói sắp hết", hint: "Trước khi gói hết hạn và khi credit còn dưới 10%." },
  { key: "announcements", label: "Thông báo từ admin", hint: "Khuyến mãi, bảo trì, tin chung." },
];

/** Notification switches, the test button and the "bot cannot reach you" warning. */
function NotifySettings({ status, setStatus }) {
  const [saving, setSaving] = useState("");
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const prefs = status.notifyPrefs || {};

  const toggle = async (key, value) => {
    setError("");
    setNotice("");
    setSaving(key);
    try {
      const res = await fetch("/api/account/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyPrefs: { [key]: value } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "save");
      setStatus(data);
    } catch {
      setError("Không lưu được tuỳ chọn. Thử lại.");
    } finally {
      setSaving("");
    }
  };

  const sendTest = async () => {
    setError("");
    setNotice("");
    setTesting(true);
    try {
      const res = await fetch("/api/account/telegram/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice("Đã gửi tin nhắn thử. Kiểm tra Telegram của bạn.");
        setStatus((prev) => (prev ? { ...prev, dmBlocked: false } : prev));
      } else {
        setError(data.error || "Không gửi được tin nhắn thử.");
        if (data.code === "blocked") setStatus((prev) => (prev ? { ...prev, dmBlocked: true } : prev));
      }
    } catch {
      setError("Không kết nối được máy chủ. Thử lại.");
    } finally {
      setTesting(false);
    }
  };

  const botUrl = status.botUsername ? `https://t.me/${status.botUsername}?start=notify` : null;

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div>
        <p className="text-sm font-medium text-text-main">Thông báo qua Telegram</p>
        <p className="mt-1 text-sm text-text-muted">
          Tin bảo mật (đăng nhập từ IP mới, đổi mật khẩu, tạo API key, khoá tài khoản) luôn được gửi.
        </p>
      </div>
      {status.dmBlocked && (
        <div role="alert" className="flex flex-col gap-3 border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="flex items-start gap-2 text-sm text-text-main">
            <span className="material-symbols-outlined text-[16px] mt-0.5 text-amber-700 dark:text-amber-400" aria-hidden="true">warning</span>
            <span>
              Bot chưa nhắn tin được cho bạn, nên bạn sẽ không nhận được thông báo. Mở bot, bấm
              <b> Start</b> (Bắt đầu), rồi bấm &quot;Gửi tin thử&quot;.
            </span>
          </p>
          {botUrl && (
            <div>
              <a href={botUrl} target="_blank" rel="noopener noreferrer" className={buttonClass({ tone: "solid" })}>
                Mở bot Telegram
              </a>
            </div>
          )}
        </div>
      )}
      <ul className="flex flex-col divide-y divide-border border border-border">
        {NOTIFY_OPTIONS.map((option) => {
          const id = `tg-notify-${option.key}`;
          const checked = prefs[option.key] !== false;
          return (
            <li key={option.key} className="flex items-start gap-3 p-3">
              <input
                id={id}
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-brand-500"
                checked={checked}
                disabled={saving === option.key}
                onChange={(e) => toggle(option.key, e.target.checked)}
              />
              <label htmlFor={id} className="min-w-0 cursor-pointer">
                <span className="block text-sm text-text-main">{option.label}</span>
                <span className="block text-xs text-text-muted">{option.hint}</span>
              </label>
              <span className="ml-auto shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                {checked ? "Bật" : "Tắt"}
              </span>
            </li>
          );
        })}
      </ul>
      <div>
        <ActionButton type="button" loading={testing} onClick={sendTest}>
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
          Gửi tin thử
        </ActionButton>
      </div>
      {notice && (
        <p role="status" className="flex items-start gap-2 text-sm text-text-main">
          <span className="material-symbols-outlined text-[16px] mt-0.5" aria-hidden="true">check_circle</span>
          <span>{notice}</span>
        </p>
      )}
      <ErrorLine message={error} />
    </div>
  );
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
  const { status, setStatus, pending, busy, error, start, cancel, unlink } = useTelegramLink();
  if (!status || !status.configured) return null;
  return (
    <div className={`flex flex-col gap-4 p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-main">Telegram</p>
          <p className="mt-1 text-sm text-text-muted">
            {status.linked
              ? `Đã liên kết${status.telegramUsername ? ` với @${status.telegramUsername}` : ""}.`
              : "Liên kết Telegram để nhận ưu đãi dành cho tài khoản mới và thông báo về tài khoản."}
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
      {status.linked && <NotifySettings status={status} setStatus={setStatus} />}
    </div>
  );
}
