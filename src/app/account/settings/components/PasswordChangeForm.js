"use client";

import { useState } from "react";
import { ActionButton, Panel, fieldClass } from "@/app/account/components/ui";
import { PASSWORD_MIN_LENGTH as MIN_LENGTH, PASSWORD_MAX_LENGTH as MAX_LENGTH } from "@/lib/users/passwordPolicy.js";

/** Change password with the current one (spec customer-portal "Change password from the settings page"). */
export default function PasswordChangeForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!current) return setError("Nhập mật khẩu hiện tại.");
    if (next.length < MIN_LENGTH || next.length > MAX_LENGTH) {
      return setError(`Mật khẩu mới cần từ ${MIN_LENGTH} đến ${MAX_LENGTH} ký tự.`);
    }
    if (next !== confirm) return setError("Hai lần nhập mật khẩu mới không khớp.");
    if (next === current) return setError("Mật khẩu mới phải khác mật khẩu hiện tại.");
    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không đổi được mật khẩu.");
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setNotice("Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.");
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setBusy(false);
    }
  };

  const type = show ? "text" : "password";
  return (
    <Panel className="p-6">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
          <label htmlFor="pw-current" className="meta text-text-muted">Mật khẩu hiện tại</label>
          <input id="pw-current" type={type} autoComplete="current-password" className={fieldClass}
            value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="pw-new" className="meta text-text-muted">Mật khẩu mới</label>
          <input id="pw-new" type={type} autoComplete="new-password" className={fieldClass}
            value={next} onChange={(e) => setNext(e.target.value)} disabled={busy}
            aria-describedby="pw-hint" />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="pw-confirm" className="meta text-text-muted">Nhập lại mật khẩu mới</label>
          <input id="pw-confirm" type={type} autoComplete="new-password" className={fieldClass}
            value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
        </div>
        <p id="pw-hint" className="text-xs text-text-muted sm:col-span-2">Ít nhất {MIN_LENGTH} ký tự.</p>
        <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
          <ActionButton tone="solid" type="submit" loading={busy}>Đổi mật khẩu</ActionButton>
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="size-4" />
            Hiện mật khẩu
          </label>
        </div>
      </form>
      {error ? <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {notice ? <p role="status" className="mt-4 text-sm text-brand-700 dark:text-brand-400">{notice}</p> : null}
    </Panel>
  );
}
