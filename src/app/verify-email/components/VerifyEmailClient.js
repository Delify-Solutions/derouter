"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AuthShell, { FormError } from "@/app/login/components/AuthShell";

export default function VerifyEmailClient({ token = "", next = null }) {
  const [state, setState] = useState(token ? "pending" : "missing");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/public/verify-email?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setState("ok");
          setMessage(data.email ? `${data.email} đã được xác minh.` : "Email của bạn đã được xác minh.");
        } else {
          setState("failed");
          setMessage(data.error || "Liên kết không hợp lệ hoặc đã hết hạn.");
        }
      } catch {
        if (!cancelled) {
          setState("failed");
          setMessage("Không kết nối được máy chủ. Tải lại trang để thử lại.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const title =
    state === "ok" ? "Đã xác minh email" : state === "failed" ? "Liên kết không dùng được" : "Đang xác minh email";

  return (
    <AuthShell
      eyebrow="Tài khoản"
      title={title}
      footer={
        <div className="flex flex-col gap-2">
          <Link
            href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
            className="text-brand-600 dark:text-brand-400 hover:underline"
          >
            Đăng nhập
          </Link>
          <span className="text-xs">
            Cần liên kết mới? Mở trang đăng nhập và dùng “Gửi lại email xác minh”.
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {state === "pending" && (
          <div className="flex items-center gap-3 text-sm text-text-muted">
            <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
            Checking the link.
          </div>
        )}
        {state === "ok" && (
          <div
            role="status"
            className="border border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400 text-sm px-3 py-2 flex items-start gap-2"
          >
            <span className="material-symbols-outlined text-[16px] mt-0.5">check_circle</span>
            <span>{message} You can sign in now.</span>
          </div>
        )}
        {(state === "failed" || state === "missing") && (
          <>
            <FormError message={state === "missing" ? "This page needs a verification token." : message} />
            <p className="text-sm text-text-muted">
              Verification links are single-use and expire after 24 hours. A new one can be sent
              from the sign-in page.
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}
