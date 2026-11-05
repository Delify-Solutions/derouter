"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "@/shared/components";

/**
 * Command bot (change telegram-bot-commands): turn the bot's commands on (webhook
 * + command menus), list the Telegram ids allowed to use the admin commands, and
 * show whether Telegram is delivering updates.
 */
export default function TelegramBotCommandsCard() {
  const [status, setStatus] = useState(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [adminIds, setAdminIds] = useState("");
  const [savedIds, setSavedIds] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState({ tone: "", text: "" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/telegram-bot", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setStatus(data);
      const ids = Array.isArray(data.adminIds) ? data.adminIds.join(", ") : "";
      setAdminIds(ids);
      setSavedIds(ids);
      setBaseUrl((current) => current || data.baseUrl || (typeof window !== "undefined" ? window.location.origin : ""));
    } catch {
      setStatus({ configured: false, enabled: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveIds = async () => {
    setBusy("ids");
    setMessage({ tone: "", text: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramAdminIds: adminIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: body.error || "Không lưu được" });
        return;
      }
      const ids = Array.isArray(body.telegramAdminIds) ? body.telegramAdminIds.join(", ") : adminIds.trim();
      setAdminIds(ids);
      setSavedIds(ids);
      setMessage({ tone: "ok", text: "Đã lưu. Bấm \"Bật / cập nhật lệnh\" để admin thấy menu lệnh quản trị." });
    } catch {
      setMessage({ tone: "error", text: "Không kết nối được máy chủ" });
    } finally {
      setBusy("");
    }
  };

  const act = async (action) => {
    setBusy(action);
    setMessage({ tone: "", text: "" });
    try {
      const res = await fetch("/api/telegram-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, baseUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setMessage({ tone: "error", text: body.error || "Không thực hiện được" });
      } else if (action === "disable") {
        setMessage({ tone: "ok", text: "Đã tắt lệnh bot. Bot vẫn gửi thông báo như cũ." });
      } else {
        const failed = Array.isArray(body.failedAdmins) && body.failedAdmins.length
          ? ` Chưa gắn menu quản trị cho ${body.failedAdmins.join(", ")}: người đó cần mở bot và bấm Start một lần, rồi bấm lại nút này.`
          : "";
        setMessage({ tone: "ok", text: `Đã bật. Khách gõ /help trong bot để xem lệnh.${failed}` });
      }
      await load();
    } catch {
      setMessage({ tone: "error", text: "Không kết nối được máy chủ" });
    } finally {
      setBusy("");
    }
  };

  const enabled = status?.enabled === true;

  return (
    <section className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-text-main">Lệnh bot</h2>
        <p className="max-w-2xl text-sm text-text-muted">
          Khách đã liên kết Telegram dùng lệnh trong bot: /me (số dư), /usage, /gifts và /gift MÃ, /plans, /keys, /settings.
          Admin có thêm /stats, /orders (duyệt / hủy đơn) và /user email. Gõ /id trong bot để biết Telegram ID của mình.
        </p>
      </div>

      <p className="flex items-center gap-2 text-sm" role="status">
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          {status == null
            ? "hourglass_empty"
            : !status.configured || status.reachable === false ? "error" : enabled ? "check_circle" : "radio_button_unchecked"}
        </span>
        <span className="text-text-main">
          {status == null
            ? "Đang kiểm tra…"
            : !status.configured
              ? "Chưa có bot token. Cấu hình bot Telegram trước."
              : status.reachable === false
                ? "Không kết nối được bot: kiểm tra lại bot token."
                : enabled ? "Đang bật: bot nhận lệnh." : "Đang tắt: bot chỉ gửi thông báo."}
        </span>
      </p>
      {status?.lastError ? (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">Lỗi gần nhất từ Telegram: {status.lastError}</p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Input
            label="Địa chỉ trang (https)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://ai.delify.vn"
            hint="Telegram gửi lệnh về địa chỉ này; nút trong bot cũng mở trang này."
          />
        </div>
        <Button onClick={() => act("enable")} loading={busy === "enable"} disabled={!status?.configured || Boolean(busy)}>
          {enabled ? "Cập nhật lệnh" : "Bật lệnh bot"}
        </Button>
        {enabled ? (
          <Button variant="secondary" onClick={() => act("disable")} loading={busy === "disable"} disabled={Boolean(busy)}>
            Tắt
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <div className="min-w-[240px] flex-1">
          <Input
            label="Telegram ID admin"
            value={adminIds}
            onChange={(e) => setAdminIds(e.target.value)}
            placeholder="123456789, 987654321"
            hint="Chỉ các ID này dùng được lệnh quản trị. Cách nhau bằng dấu phẩy."
          />
        </div>
        <Button variant="secondary" onClick={saveIds} loading={busy === "ids"} disabled={adminIds.trim() === savedIds || Boolean(busy)}>
          Lưu
        </Button>
      </div>

      {message.text ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-700 dark:text-red-400" : "text-sm text-brand-700 dark:text-brand-400"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
