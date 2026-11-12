"use client";

import { useEffect, useState } from "react";
import { Button, Input } from "@/shared/components";

/**
 * The public Telegram channel link (change models-notifications D6). Shown to
 * visitors and customers as "Kênh Telegram" when set. Also the chat the bot
 * checks for channel-join gift codes (change channel-gift): the link's username,
 * or an explicit chat id for a private channel.
 */
export default function TelegramChannelCard() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [chatId, setChatId] = useState("");
  const [savedChatId, setSavedChatId] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState({ tone: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ tone: "", text: "" });

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((s) => {
        const url = typeof s.telegramChannelUrl === "string" ? s.telegramChannelUrl : "";
        setValue(url);
        setSaved(url);
        const chat = typeof s.telegramChannelChatId === "string" ? s.telegramChannelChatId : "";
        setChatId(chat);
        setSavedChatId(chat);
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
        body: JSON.stringify({ telegramChannelUrl: value, telegramChannelChatId: chatId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: body.error || "Không lưu được" });
        return;
      }
      const url = typeof body.telegramChannelUrl === "string" ? body.telegramChannelUrl : value.trim();
      setValue(url);
      setSaved(url);
      const chat = typeof body.telegramChannelChatId === "string" ? body.telegramChannelChatId : chatId.trim();
      setChatId(chat);
      setSavedChatId(chat);
      setMessage({ tone: "ok", text: url ? "Đã lưu. Khách thấy \"Kênh Telegram\" ở trang chủ và trong tài khoản." : "Đã gỡ link kênh." });
    } catch {
      setMessage({ tone: "error", text: "Không kết nối được máy chủ" });
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    setCheck({ tone: "", text: "" });
    try {
      const res = await fetch("/api/telegram-channel/check", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setCheck(body.ok
        ? { tone: "ok", text: `Bot đọc được thành viên kênh ${body.chatId}. Mã tham gia kênh hoạt động được.` }
        : { tone: "error", text: body.error || "Không kiểm tra được kênh." });
    } catch {
      setCheck({ tone: "error", text: "Không kết nối được máy chủ" });
    } finally {
      setChecking(false);
    }
  };

  const dirty = value.trim() !== saved || chatId.trim() !== savedChatId;

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
        <div className="min-w-[200px] flex-1">
          <Input
            label="ID kênh để kiểm tra thành viên (tùy chọn)"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="@ten_kenh hoặc -100…"
          />
        </div>
        <Button onClick={save} loading={busy} disabled={!dirty}>Lưu</Button>
        {saved ? (
          <a href={saved} target="_blank" rel="noopener noreferrer" className="text-sm text-text-muted underline underline-offset-4">Mở kênh</a>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="max-w-2xl text-sm text-text-muted">
          Mã quà &quot;tham gia kênh&quot; cần bot kiểm tra khách có trong kênh không: thêm bot làm quản trị viên của kênh.
          Kênh công khai dùng luôn tên trong link; kênh riêng tư (link t.me/+…) cần điền ID kênh dạng -100….
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={runCheck} loading={checking} disabled={dirty}>Kiểm tra bot</Button>
          {dirty ? <span className="text-xs text-text-muted">Lưu trước rồi kiểm tra.</span> : null}
        </div>
        {check.text ? (
          <p role={check.tone === "error" ? "alert" : "status"} className={check.tone === "error" ? "text-sm text-red-700 dark:text-red-400" : "text-sm text-brand-700 dark:text-brand-400"}>
            {check.text}
          </p>
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
