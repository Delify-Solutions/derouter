"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input, Modal, Toast, Toggle } from "@/shared/components";

const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });
const EMPTY = { title: "", body: "", important: false, sendTelegram: false };
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const imageUrl = (row) => `/api/announcements/${row.id}/image?v=${encodeURIComponent(row.updatedAt || "")}`;

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
        <Toast type="success" message={notice} onDismiss={() => setNotice("")} />
      ) : null}
      {error ? <Toast type="error" message={error} onDismiss={() => setError("")} /> : null}

      {loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <Card padding="none" className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <span className="material-symbols-outlined text-[32px] text-vx-text-subtle">campaign</span>
          <p className="text-sm text-vx-text-muted">
            Chưa có thông báo nào. Bấm &quot;Thông báo mới&quot; để đăng.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <Card key={row.id} className="flex flex-col gap-3">
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
              {row.hasImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl(row)}
                  alt={`Ảnh kèm thông báo ${row.title}`}
                  loading="lazy"
                  className="max-h-64 w-auto max-w-full self-start border border-border object-contain"
                />
              ) : null}
              <p className="whitespace-pre-line text-sm text-text-muted [overflow-wrap:anywhere]">{row.body}</p>
            </Card>
          ))}
        </div>
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
  // The picked file (not uploaded until save), its local preview, and whether the
  // saved image should be dropped.
  const [image, setImage] = useState(null);
  const [preview, setPreview] = useState("");
  const [removeImage, setRemoveImage] = useState(false);
  const fileInput = useRef(null);
  const previewRef = useRef("");

  const showPreview = (url) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreview(url);
  };
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const pick = (file) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setError("Chỉ nhận ảnh JPG, PNG hoặc WebP");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError("Ảnh tối đa 5 MB");
      return;
    }
    setError("");
    setImage(file);
    showPreview(URL.createObjectURL(file));
    setRemoveImage(false);
  };

  const dropImage = () => {
    setImage(null);
    showPreview("");
    if (row?.hasImage) setRemoveImage(true);
  };

  const shownImage = preview || (row?.hasImage && !removeImage ? imageUrl(row) : "");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.append("title", form.title);
      data.append("body", form.body);
      data.append("important", String(form.important));
      data.append("sendTelegram", String(form.sendTelegram));
      if (image) data.append("image", image);
      else if (removeImage) data.append("removeImage", "true");
      const res = await fetch(row ? `/api/announcements/${row.id}` : "/api/announcements", {
        method: row ? "PATCH" : "POST",
        body: data,
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
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Ảnh (tuỳ chọn)</span>
          {shownImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shownImage} alt="Ảnh kèm thông báo" className="max-h-48 w-auto max-w-full self-start border border-border object-contain" />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              id="ann-image"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              onChange={(e) => pick(e.target.files?.[0] || null)}
            />
            <Button size="sm" variant="secondary" icon="image" onClick={() => fileInput.current?.click()}>
              {shownImage ? "Đổi ảnh" : "Chọn ảnh"}
            </Button>
            {shownImage ? <Button size="sm" variant="ghost" onClick={dropImage}>Bỏ ảnh</Button> : null}
            {image ? <span className="font-mono text-[11px] text-text-muted [overflow-wrap:anywhere]">{image.name}</span> : null}
          </div>
          <span className="text-xs text-text-muted">
            JPG, PNG hoặc WebP, tối đa 5 MB. Hiện trên trang Thông báo và gửi kèm tin Telegram.
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-text-main">Đánh dấu quan trọng</span>
          <Toggle aria-label="Đánh dấu quan trọng" checked={form.important} onChange={(v) => setForm((f) => ({ ...f, important: v }))} />
        </div>
        {!row ? (
          <div className="flex items-center justify-between gap-4">
            <span className="flex flex-col">
              <span className="text-sm text-text-main">Gửi kèm qua Telegram</span>
              <span className="text-xs text-text-muted">
                Tới khách đã liên kết và đang bật &quot;Thông báo từ admin&quot;. Có ảnh thì gửi ảnh, nội dung làm chú thích
                (dài quá 1024 ký tự thì gửi thành tin riêng ngay sau ảnh).
              </span>
            </span>
            <Toggle aria-label="Gửi kèm qua Telegram" checked={form.sendTelegram} onChange={(v) => setForm((f) => ({ ...f, sendTelegram: v }))} />
          </div>
        ) : (
          <p className="text-xs text-text-muted">Sửa (kể cả ảnh) chỉ đổi bản trên web; tin đã gửi qua Telegram giữ nguyên.</p>
        )}
        {error ? <Toast type="error" message={error} dismissible={false} /> : null}
      </div>
    </Modal>
  );
}
