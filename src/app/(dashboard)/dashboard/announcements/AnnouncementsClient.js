"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, CardSkeleton, ConfirmModal, Input, Modal, Toggle } from "@/shared/components";

const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });
const EMPTY = { title: "", body: "", important: false, sendTelegram: false };

function fmt(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

/**
 * Admin announcements (change models-notifications D3): customers read them on
 * /account/notifications, with an unread badge in their menu. A new one can also
 * go out through the Telegram broadcast.
 */
export default function AnnouncementsClient() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | row
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/announcements?limit=100", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được thông báo");
      setRows(Array.isArray(body.announcements) ? body.announcements : []);
    } catch (e) {
      setError(e.message || "Không tải được thông báo");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async () => {
    const row = deleting;
    const res = await fetch(`/api/announcements/${row.id}`, { method: "DELETE" });
    setDeleting(null);
    if (res.ok) {
      setNotice(`Đã xóa thông báo "${row.title}".`);
      load();
    } else {
      setError("Không xóa được thông báo");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-text-muted">Khách hàng</span>
          <h1 className="text-2xl font-semibold tracking-tight text-text-main">Thông báo</h1>
          <p className="max-w-2xl text-sm text-text-muted">
            Khách đọc ở trang Thông báo trong tài khoản, mục menu có số tin chưa đọc. Khi đăng có thể gửi kèm qua Telegram
            tới khách đã liên kết.
          </p>
        </div>
        <Button icon="add" onClick={() => { setNotice(""); setEditing("new"); }}>Thông báo mới</Button>
      </div>

      {notice ? (
        <p role="status" className="border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400">{notice}</p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
          Chưa có thông báo nào. Bấm &quot;Thông báo mới&quot; để đăng.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-3 border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-text-main">{row.title}</h2>
                    {row.important ? <Badge variant="warning" dot>Quan trọng</Badge> : null}
                    {row.telegramBroadcastId ? <Badge variant="info">Đã gửi Telegram</Badge> : null}
                  </div>
                  <span className="font-mono text-[11px] text-text-muted">{fmt(row.createdAt)}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setNotice(""); setEditing(row); }}>Sửa</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(row)}>Xóa</Button>
                </div>
              </div>
              <p className="whitespace-pre-line text-sm text-text-muted [overflow-wrap:anywhere]">{row.body}</p>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <AnnouncementModal
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => { setEditing(null); setNotice(text); load(); }}
        />
      ) : null}

      <ConfirmModal
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Xóa thông báo ${deleting?.title || ""}`}
        message="Thông báo biến mất khỏi trang của khách. Tin đã gửi qua Telegram (nếu có) không thu hồi được."
        confirmText="Xóa"
      />
    </div>
  );
}

function AnnouncementModal({ row, onClose, onSaved }) {
  const [form, setForm] = useState(row ? { title: row.title, body: row.body, important: row.important, sendTelegram: false } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(row ? `/api/announcements/${row.id}` : "/api/announcements", {
        method: row ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không lưu được thông báo");
        return;
      }
      let text = row ? "Đã lưu thông báo." : "Đã đăng thông báo.";
      if (body.telegram?.ok) text += " Đang gửi qua Telegram.";
      else if (body.telegram && !body.telegram.ok) text += ` Chưa gửi được Telegram: ${body.telegram.error}`;
      onSaved(text);
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={row ? "Sửa thông báo" : "Thông báo mới"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button onClick={save} loading={busy}>{row ? "Lưu" : "Đăng"}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Tiêu đề"
          value={form.title}
          maxLength={120}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          placeholder="Ví dụ: Bảo trì hệ thống 23:00 tối nay"
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ann-body" className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Nội dung</label>
          <textarea
            id="ann-body"
            rows={6}
            maxLength={2000}
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
          />
          <span className="text-right font-mono text-[11px] text-text-muted">{form.body.length} / 2000</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-text-main">Đánh dấu quan trọng</span>
          <Toggle aria-label="Đánh dấu quan trọng" checked={form.important} onChange={(v) => setForm((f) => ({ ...f, important: v }))} />
        </div>
        {!row ? (
          <div className="flex items-center justify-between gap-4">
            <span className="flex flex-col">
              <span className="text-sm text-text-main">Gửi kèm qua Telegram</span>
              <span className="text-xs text-text-muted">Tới khách đã liên kết và đang bật &quot;Thông báo từ admin&quot;.</span>
            </span>
            <Toggle aria-label="Gửi kèm qua Telegram" checked={form.sendTelegram} onChange={(v) => setForm((f) => ({ ...f, sendTelegram: v }))} />
          </div>
        ) : (
          <p className="text-xs text-text-muted">Sửa chỉ đổi bản trên web; tin đã gửi qua Telegram giữ nguyên.</p>
        )}
        {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      </div>
    </Modal>
  );
}
