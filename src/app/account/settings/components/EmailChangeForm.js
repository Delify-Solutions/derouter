"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionButton, Panel, fieldClass } from "@/app/account/components/ui";
import { dateTimeOf } from "@/shared/components/billing/StatusTag";

/**
 * Request an email change (spec customer-portal "Change email by confirmation
 * link"). A pending change is shown with "Gửi lại" and "Hủy"; the address itself
 * changes on the /confirm-email page.
 */
export default function EmailChangeForm({ currentEmail }) {
  const [pending, setPending] = useState(null);
  const [newEmail, setNewEmail] = useState("");
  const [repeat, setRepeat] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account/email", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPending(data.pending || null);
    } catch {
      // The form still works; the pending block just does not show.
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (event) => {
    event?.preventDefault?.();
    setError("");
    setNotice("");
    // "Gửi lại" with the fields empty resends to the pending address.
    const resend = !newEmail.trim() && !repeat.trim() && pending;
    const target = resend ? pending.newEmail : newEmail.trim();
    if (!target) {
      setError("Nhập email mới.");
      return;
    }
    // A typo would mail the link to a stranger: the address is typed twice.
    if (!resend && target.toLowerCase() !== repeat.trim().toLowerCase()) {
      setError("Hai lần nhập email mới không khớp.");
      return;
    }
    if (target.toLowerCase() === String(currentEmail || "").toLowerCase()) {
      setError("Email mới trùng email hiện tại.");
      return;
    }
    if (!password) {
      setError("Nhập mật khẩu hiện tại.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: target, currentPassword: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không gửi được yêu cầu đổi email.");
        return;
      }
      setPending(data.pending);
      setPassword("");
      setNewEmail("");
      setRepeat("");
      setNotice(`Đã gửi liên kết xác nhận tới ${data.pending.newEmail}. Mở thư và bấm liên kết để hoàn tất.`);
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/account/email", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setPending(null);
      setNotice("Đã hủy yêu cầu đổi email.");
    } catch {
      setError("Không hủy được yêu cầu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="flex flex-col gap-5 p-6">
      {pending ? (
        <div className="flex flex-col gap-3 border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-text-main">
            Đang chờ xác nhận đổi sang <span className="font-mono [overflow-wrap:anywhere]">{pending.newEmail}</span>.
            Liên kết hết hạn lúc <span className="font-mono">{dateTimeOf(pending.expiresAt)}</span>.
          </p>
          <p className="text-xs text-text-muted">
            Chưa nhận được thư? Kiểm tra mục Spam, hoặc nhập mật khẩu rồi bấm &quot;Gửi lại liên kết&quot; (liên kết cũ sẽ hết hiệu lực). Muốn đổi sang địa chỉ khác thì nhập địa chỉ đó bên dưới.
          </p>
          <div>
            <ActionButton size="sm" type="button" onClick={cancel} disabled={busy}>Hủy yêu cầu</ActionButton>
          </div>
        </div>
      ) : null}

      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="flex flex-col gap-2">
          <label htmlFor="new-email" className="meta text-text-muted">Email mới</label>
          <input
            id="new-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            className={fieldClass}
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            disabled={busy}
            placeholder={pending ? pending.newEmail : "ten@example.com"}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="new-email-repeat" className="meta text-text-muted">Nhập lại email mới</label>
          <input
            id="new-email-repeat"
            type="email"
            autoComplete="off"
            inputMode="email"
            className={fieldClass}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="email-password" className="meta text-text-muted">Mật khẩu hiện tại</label>
          <input
            id="email-password"
            type="password"
            autoComplete="current-password"
            className={fieldClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <ActionButton tone="solid" type="submit" loading={busy}>
            {pending ? "Gửi lại liên kết" : "Gửi liên kết xác nhận"}
          </ActionButton>
        </div>
      </form>

      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-brand-700 dark:text-brand-400">{notice}</p> : null}
    </Panel>
  );
}
