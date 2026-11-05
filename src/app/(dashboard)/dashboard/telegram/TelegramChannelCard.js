"use client";

import { useEffect, useState } from "react";
import { Button, Input } from "@/shared/components";

/**
 * The public Telegram channel link (change models-notifications D6). Shown to
 * visitors and customers as "Kênh Telegram" when set.
 */
export default function TelegramChannelCard() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ tone: "", text: "" });

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((s) => {
        const url = typeof s.telegramChannelUrl === "string" ? s.telegramChannelUrl : "";
        setValue(url);
        setSaved(url);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage({ tone: "", text: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramChannelUrl: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: body.error || "Không lưu được" });
        return;
      }
      const url = typeof body.telegramChannelUrl === "string" ? body.telegramChannelUrl : value.trim();
      setValue(url);
      setSaved(url);
      setMessage({ tone: "ok", text: url ? "Đã lưu. Khách thấy \"Kênh Telegram\" ở trang chủ và trong tài khoản." : "Đã gỡ link kênh." });
    } catch {
      setMessage({ tone: "error", text: "Không kết nối được máy chủ" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-text-main">Kênh Telegram công khai</h2>
        <p className="max-w-2xl text-sm text-text-muted">
          Link kênh hoặc nhóm Telegram của bạn. Khi có, trang chủ, trang Model và menu tài khoản hiện nút &quot;Kênh Telegram&quot;. Để trống để ẩn.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <Input label="Link kênh" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://t.me/ten_kenh" />
        </div>
        <Button onClick={save} loading={busy} disabled={value.trim() === saved}>Lưu</Button>
        {saved ? (
          <a href={saved} target="_blank" rel="noopener noreferrer" className="text-sm text-text-muted underline underline-offset-4">Mở kênh</a>
        ) : null}
      </div>
      {message.text ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-700 dark:text-red-400" : "text-sm text-brand-700 dark:text-brand-400"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
