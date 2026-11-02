"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "@/app/account/components/ui";
import AuthShell, { FormError, FormNotice } from "@/app/login/components/AuthShell";

// Telegram's official Mini App bridge. Allowed for this path only (next.config.mjs).
const TELEGRAM_SDK = "https://telegram.org/js/telegram-web-app.js";

function webApp() {
  return typeof window !== "undefined" ? window.Telegram?.WebApp ?? null : null;
}

/** initData from the SDK, or straight from the launch fragment if the SDK did not load. */
function readInitData() {
  const fromSdk = webApp()?.initData;
  if (fromSdk) return fromSdk;
  try {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    return hash.get("tgWebAppData") || "";
  } catch {
    return "";
  }
}

/**
 * Ask Telegram to let the bot message this user, so account notifications can
 * reach them (spec telegram-notify). Resolves true/false, or null when the client
 * cannot ask (old Telegram, SDK missing). Never blocks linking for long.
 */
function requestWriteAccess() {
  const app = webApp();
  if (!app?.requestWriteAccess || !app.isVersionAtLeast?.("6.9")) return Promise.resolve(null);
  if (app.initDataUnsafe?.user?.allows_write_to_pm) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 60_000);
    try {
      app.requestWriteAccess((granted) => {
        clearTimeout(timer);
        resolve(Boolean(granted));
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export default function TelegramLinkClient() {
  const [state, setState] = useState({ phase: "waiting" }); // waiting | linking | done | error
  const started = useRef(false);

  const link = useCallback(async () => {
    if (started.current) return;
    const initData = readInitData();
    if (!initData) return; // the SDK may still be loading; onLoad and the timeout retry
    started.current = true;
    webApp()?.ready?.();
    setState({ phase: "linking" });
    // Before linking: the server sends a confirmation message right after.
    await requestWriteAccess();
    try {
      const res = await fetch("/api/public/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ phase: "error", message: data.error || "Không liên kết được. Hãy tạo link mới trên trang web." });
        return;
      }
      setState({ phase: "done", email: data.email, username: data.telegramUsername });
    } catch {
      started.current = false;
      setState({ phase: "error", message: "Không kết nối được máy chủ. Thử lại." });
    }
  }, []);

  useEffect(() => {
    // initData can already sit in the launch fragment before the SDK loads.
    const first = setTimeout(link, 0);
    // Opened outside Telegram (or the SDK never loaded): say so instead of spinning.
    const timer = setTimeout(() => {
      if (!started.current) {
        link();
        if (!started.current) {
          setState({ phase: "error", message: "Trang này chỉ mở được từ Telegram. Hãy bấm \"Liên kết Telegram\" trên trang web." });
        }
      }
    }, 4000);
    return () => {
      clearTimeout(first);
      clearTimeout(timer);
    };
  }, [link]);

  return (
    <>
      <Script src={TELEGRAM_SDK} strategy="afterInteractive" onLoad={link} />
      <AuthShell eyebrow="Telegram" title="Liên kết Telegram">
        <div className="flex flex-col gap-4">
          {(state.phase === "waiting" || state.phase === "linking") && (
            <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined animate-spin text-[16px]" aria-hidden="true">progress_activity</span>
              Đang liên kết tài khoản…
            </p>
          )}
          {state.phase === "done" && (
            <>
              <FormNotice
                message={`Đã liên kết${state.username ? ` @${state.username}` : ""} với tài khoản ${state.email}.`}
              />
              <p className="text-sm text-text-muted">Quay lại trình duyệt để tiếp tục. Trang web sẽ tự cập nhật.</p>
              {webApp()?.close && (
                <ActionButton tone="solid" fullWidth onClick={() => webApp()?.close?.()}>
                  Đóng
                </ActionButton>
              )}
            </>
          )}
          {state.phase === "error" && <FormError message={state.message} />}
        </div>
      </AuthShell>
    </>
  );
}
