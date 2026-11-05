"use client";

import Link from "next/link";
import { useState } from "react";
import AuthShell, { FormError } from "@/app/login/components/AuthShell";

/**
 * Applies an email change only when the person presses "Xác nhận đổi email":
 * neither the GET of the link nor a mail scanner that runs the page's script
 * can use the token on its own (change account-settings, design D1).
 */
export default function ConfirmEmailClient({ token = "" }) {
  const [state, setState] = useState(token ? "ready" : "missing");
  const [message, setMessage] = useState("");

  const confirm = async () => {
    setState("pending");
    try {
      const res = await fetch("/api/public/confirm-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setState("ok");
        setMessage(`Email đăng nhập của bạn giờ là ${data.email}.`);
      } else {
        setState("failed");
        setMessage(data.error || "Liên kết không hợp lệ hoặc đã hết hạn.");
      }
    } catch {
      setState("ready");
      setMessage("Không kết nối được máy chủ. Thử lại.");
    }
  };

  const title = state === "ok" ? "Đã đổi email" : state === "failed" || state === "missing" ? "Liên kết không dùng được" : "Xác nhận đổi email";

  return (
    <AuthShell
      eyebrow="Tài khoản"
      title={title}
      footer={
        <div className="flex flex-col gap-2">
          <Link href="/account/settings" className="font-medium text-text-main underline underline-offset-4">
            Về trang Tài khoản
          </Link>
          <span className="text-xs">Chưa đăng nhập thì trang sẽ đưa bạn tới trang đăng nhập.</span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {(state === "ready" || state === "pending") && (
          <>
            <p className="text-sm text-text-muted">
              Bấm nút bên dưới để đổi email đăng nhập sang địa chỉ đã nhận thư này. Nếu bạn không yêu cầu đổi email, hãy đóng trang này.
            </p>
            {message ? <FormError message={message} /> : null}
            <button
              type="button"
              onClick={confirm}
              disabled={state === "pending"}
              className="inline-flex min-h-10 items-center justify-center gap-2 border border-text-main bg-text-main px-4 py-2 font-mono text-[13px] font-medium text-bg transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === "pending" ? (
                <span className="material-symbols-outlined animate-spin text-[16px]" aria-hidden="true">progress_activity</span>
              ) : null}
              Xác nhận đổi email
            </button>
          </>
        )}
        {state === "ok" && (
          <div
            role="status"
            className="flex items-start gap-2 border border-brand-500/30 bg-brand-500/10 px-3 py-2 text-sm text-brand-700 dark:text-brand-400"
          >
            <span className="material-symbols-outlined mt-0.5 text-[16px]" aria-hidden="true">check_circle</span>
            <span>{message} Lần sau hãy đăng nhập bằng địa chỉ này.</span>
          </div>
        )}
        {(state === "failed" || state === "missing") && (
          <>
            <FormError message={state === "missing" ? "Trang này cần liên kết xác nhận trong email." : message} />
            <p className="text-sm text-text-muted">
              Liên kết đổi email dùng được một lần và hết hạn sau 24 giờ. Có thể yêu cầu lại trong trang Tài khoản.
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}
