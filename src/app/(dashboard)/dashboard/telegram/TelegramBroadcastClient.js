"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, ConfirmModal, Badge, CardSkeleton } from "@/shared/components";

const POLL_MS = 3000;

const STATUS = {
  sending: { label: "Đang gửi", variant: "info", icon: "progress_activity" },
  done: { label: "Xong", variant: "success", icon: "check_circle" },
  failed: { label: "Lỗi", variant: "error", icon: "error" },
  interrupted: { label: "Bị ngắt", variant: "warning", icon: "warning" },
};

const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

function Stat({ label, value, hint }) {
  return (
    <div className="flex flex-col gap-1 border border-border p-4">
      <span className="meta text-text-muted">{label}</span>
      <span className="font-mono text-2xl text-text-main">{value}</span>
      {hint && <span className="text-xs text-text-muted">{hint}</span>}
    </div>
  );
}

export default function TelegramBroadcastClient() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/telegram-broadcasts", { cache: "no-store" });
      const next = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(next.error || "load");
      setData(next);
      setLoadError("");
    } catch {
      setLoadError("Không tải được dữ liệu.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const running = Boolean(data?.broadcasts?.some((b) => b.status === "sending"));
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const maxLength = data?.maxLength || 3500;
  const trimmed = text.trim();
  const recipients = data?.audience?.recipients ?? 0;
  const canSend = data?.configured && trimmed.length > 0 && trimmed.length <= maxLength && recipients > 0 && !running;

  const send = async () => {
    setError("");
    setSending(true);
    try {
      const res = await fetch("/api/telegram-broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(result.error || "Không gửi được thông báo.");
        return;
      }
      setText("");
      await load();
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setSending(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-8 px-1 sm:px-0">
      <div className="flex flex-col gap-1.5">
        <span className="meta text-text-muted">Khách hàng</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">Thông báo Telegram</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          Gửi tin tới mọi khách đã liên kết Telegram và đang bật &quot;Thông báo từ admin&quot;. Tin thanh toán, gói và
          bảo mật được gửi tự động, không cần soạn ở đây.
        </p>
      </div>

      {!data && !loadError && <CardSkeleton />}
      {loadError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">{loadError}</p>
      )}

      {data && (
        <>
          {!data.configured && (
            <div role="alert" className="flex items-start gap-3 border border-amber-500/40 bg-amber-500/5 px-5 py-4">
              <span className="material-symbols-outlined text-[20px] text-amber-700 dark:text-amber-400" aria-hidden="true">warning</span>
              <p className="text-sm text-text-main">
                Chưa có bot token. Nhập trong{" "}
                <Link href="/dashboard/profile" className="underline">Settings → Customer accounts → Telegram</Link>.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Đã liên kết" value={data.audience.linked} />
            <Stat label="Sẽ nhận tin" value={data.audience.recipients} hint="Đang bật thông báo từ admin, tài khoản hoạt động" />
            <Stat label="Bot bị chặn" value={data.audience.blocked} hint="Telegram từ chối gửi; khách cần mở bot và gửi tin thử" />
          </div>

          <Card>
            <div className="flex flex-col gap-3">
              <label htmlFor="broadcast-text" className="meta text-text-muted">Nội dung</label>
              <textarea
                id="broadcast-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                maxLength={maxLength + 200}
                placeholder="Ví dụ: Hệ thống bảo trì từ 23:00 đến 23:30 tối nay."
                aria-describedby="broadcast-count"
                className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span id="broadcast-count" className={`font-mono text-[11px] ${trimmed.length > maxLength ? "text-red-700 dark:text-red-400" : "text-text-muted"}`}>
                  {trimmed.length} / {maxLength} ký tự · gửi dạng văn bản thường
                </span>
                <Button icon="send" onClick={() => setConfirming(true)} disabled={!canSend}>
                  Gửi tới {recipients} khách
                </Button>
              </div>
              {running && (
                <p role="status" className="text-xs text-text-muted">Đang gửi một thông báo, chờ xong rồi gửi tiếp.</p>
              )}
              {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-3">
              <span className="meta text-text-muted">Đã gửi</span>
              {data.broadcasts.length === 0 ? (
                <p className="text-sm text-text-muted">Chưa gửi thông báo nào.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="meta py-2 pr-4 font-normal text-text-muted">Lúc</th>
                        <th className="meta py-2 pr-4 font-normal text-text-muted">Nội dung</th>
                        <th className="meta py-2 pr-4 font-normal text-text-muted">Trạng thái</th>
                        <th className="meta py-2 text-right font-normal text-text-muted">Gửi được / lỗi / bỏ qua / tổng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.broadcasts.map((b) => {
                        const status = STATUS[b.status] || STATUS.failed;
                        return (
                          <tr key={b.id} className="border-b border-border align-top last:border-b-0">
                            <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs text-text-muted">
                              {DATE.format(new Date(b.createdAt))}
                            </td>
                            <td className="max-w-md py-2 pr-4 text-text-main">
                              <p className="line-clamp-3 whitespace-pre-line break-words">{b.text}</p>
                            </td>
                            <td className="py-2 pr-4">
                              <Badge variant={status.variant} size="sm">{status.label}</Badge>
                            </td>
                            <td className="whitespace-nowrap py-2 text-right font-mono text-xs text-text-main">
                              {b.sent} / {b.failed} / {b.skipped ?? 0} / {b.total}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {data.broadcasts.some((b) => (b.skipped ?? 0) > 0) && (
                <p className="text-xs text-text-muted">
                  Bỏ qua: khách tắt thông báo hoặc bị khoá trong lúc đang gửi. Lỗi: Telegram từ chối hoặc không gửi được.
                </p>
              )}
            </div>
          </Card>
        </>
      )}

      <ConfirmModal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={send}
        title="Gửi thông báo"
        message={`Gửi tin này tới ${recipients} khách qua Telegram? Không thu hồi được sau khi gửi.`}
        confirmText="Gửi"
        cancelText="Huỷ"
        variant="primary"
        loading={sending}
      />
    </div>
  );
}
