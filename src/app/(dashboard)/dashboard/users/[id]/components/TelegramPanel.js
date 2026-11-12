"use client";

import { useState } from "react";
import { Badge, Button } from "@/shared/components";
import ReasonModal from "./ReasonModal";

const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

/**
 * "Telegram" on the user detail page (change telegram-admin): the linked
 * Telegram user and "Gỡ liên kết" (reason required, audited, the Telegram user
 * is told).
 */
export default function TelegramPanel({ user, onChanged }) {
  const [open, setOpen] = useState(false);
  const linked = Boolean(user?.telegramUserId);

  const unlink = async ({ reason }) => {
    const res = await fetch(`/api/users/${user.id}/telegram`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || "Không gỡ được liên kết" };
    onChanged?.();
    return { ok: true };
  };

  return (
    <section className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="meta text-text-muted">Telegram</h2>
          {linked ? (
            <p className="text-sm text-text-main">
              <span className="font-mono">{user.telegramUsername ? `@${user.telegramUsername}` : "—"}</span>
              <span className="text-text-muted"> · ID </span>
              <span className="font-mono">{user.telegramUserId}</span>
              {user.telegramLinkedAt ? (
                <span className="text-text-muted"> · liên kết {DATE.format(new Date(user.telegramLinkedAt))}</span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-text-muted">Chưa liên kết Telegram.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {linked ? <Badge variant="success" dot>Đã liên kết</Badge> : <Badge dot>Chưa liên kết</Badge>}
          {linked ? <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Gỡ liên kết</Button> : null}
        </div>
      </div>
      <ReasonModal
        isOpen={open}
        title="Gỡ liên kết Telegram"
        description="Telegram này sẽ thôi nhận thông báo và được báo về việc gỡ. Khách có thể liên kết lại. Mã quà người mới đã nhận vẫn ghi nhận Telegram cũ."
        confirmLabel="Gỡ liên kết"
        onClose={() => setOpen(false)}
        onConfirm={unlink}
      />
    </section>
  );
}
