"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input, Modal } from "@/shared/components";
import { ActionButton, Empty, ListRow, Page, Section, Tag } from "@/app/account/components/ui";
import CopyBlock from "@/app/account/components/CopyBlock";

const NAME_MAX = 80;

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function KeysPageClient({ publicBaseUrl = "" }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // The secret exists in this state ONLY: it is shown once, right after creation,
  // and the reloaded list never carries it.
  const [createdSecret, setCreatedSecret] = useState("");
  const [createdName, setCreatedName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const baseUrl = useMemo(() => {
    const configured = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (configured) return `${configured}/v1`;
    if (typeof window !== "undefined") return `${window.location.origin}/v1`;
    return "/v1";
  }, [publicBaseUrl]);

  const load = useCallback(async () => {
    setLoadError("");
    setLoading(true);
    try {
      const res = await fetch("/api/account/keys", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || "Không tải được danh sách API key");
        return;
      }
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch {
      setLoadError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setName("");
    setFormError("");
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setFormError("Nhập tên cho key"); return; }
    if (trimmed.length > NAME_MAX) { setFormError(`Tên key tối đa ${NAME_MAX} ký tự`); return; }

    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/account/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không tạo được key");
        return;
      }
      setCreateOpen(false);
      setCreatedSecret(data.secret || "");
      setCreatedName(data.key?.name || trimmed);
      // The list itself can be refreshed right away; the secret lives outside it.
      await load();
    } catch {
      setFormError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/account/keys/${deleteTarget.id}`, { method: "DELETE" });
      if (res.ok) {
        setKeys((prev) => prev.filter((key) => key.id !== deleteTarget.id));
      } else {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || "Không xoá được key");
      }
    } catch {
      setLoadError("Không kết nối được máy chủ");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const createAction = <ActionButton tone="solid" onClick={openCreate}>Tạo key</ActionButton>;

  return (
    <Page
      title="API key"
      description="Dùng key này để gọi model trong nhóm của bạn. Key chỉ hiển thị một lần khi tạo."
      actions={createAction}
    >
      <Section title="Kết nối" description="Trỏ client tương thích OpenAI hoặc Anthropic tới địa chỉ này.">
        <div className="flex flex-col gap-3">
          <CopyBlock prompt="url" value={baseUrl} label="Sao chép địa chỉ API" />
          <CopyBlock value={`curl ${baseUrl}/models -H "Authorization: Bearer <key>"`} label="Sao chép lệnh thử" />
        </div>
      </Section>

      <Section title="Key của bạn" description="Mỗi máy hoặc ứng dụng nên có một key riêng để thu hồi riêng khi cần.">
        {loadError ? (
          <div role="alert" className="flex items-start justify-between gap-4 border border-red-600/30 bg-red-500/10 px-5 py-4">
            <span className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
              <span>{loadError}</span>
            </span>
            <ActionButton size="sm" onClick={load}>Thử lại</ActionButton>
          </div>
        ) : loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2].map((row) => <div key={row} className="h-[74px] border border-border bg-surface-2" />)}
          </div>
        ) : keys.length === 0 ? (
          <Empty
            icon="key"
            title="Bạn chưa có API key"
            body="Tạo key đầu tiên để bắt đầu gọi model. Bạn có thể tạo nhiều key cho nhiều máy khác nhau."
            action={createAction}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((key) => (
              <ListRow
                key={key.id}
                title={key.name || "—"}
                tags={
                  <Tag tone={key.isActive ? "success" : "neutral"} icon={key.isActive ? "check_circle" : "block"}>
                    {key.isActive ? "Đang dùng" : "Đã tắt"}
                  </Tag>
                }
                detail={`${key.keyPrefix ? `${key.keyPrefix}…` : "—"} · tạo ${formatDate(key.createdAt)}`}
                actions={
                  <button
                    type="button"
                    aria-label={`Xoá key ${key.name || key.keyPrefix || ""}`}
                    title="Xoá key"
                    onClick={() => setDeleteTarget(key)}
                    className="flex size-9 items-center justify-center border border-border bg-surface text-text-muted transition-colors duration-150 hover:bg-red-500/10 hover:text-red-600"
                  >
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">delete</span>
                  </button>
                }
              />
            ))}
          </ul>
        )}
      </Section>

      {/* Create */}
      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setFormError(""); }}
        title="Tạo API key"
        footer={
          <>
            <ActionButton tone="ghost" onClick={() => { setCreateOpen(false); setFormError(""); }} disabled={saving}>Huỷ</ActionButton>
            <ActionButton tone="solid" onClick={submitCreate} loading={saving} disabled={!name.trim()}>Tạo</ActionButton>
          </>
        }
      >
        <Input
          label="Tên key"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Laptop cá nhân"
          error={formError}
          hint={`1–${NAME_MAX} ký tự`}
          maxLength={NAME_MAX}
          autoFocus
        />
      </Modal>

      {/* Secret shown exactly once */}
      <Modal
        isOpen={!!createdSecret}
        onClose={() => setCreatedSecret("")}
        title="Đã tạo API key"
        closeOnOverlay={false}
        footer={<ActionButton tone="solid" onClick={() => setCreatedSecret("")}>Tôi đã lưu key</ActionButton>}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-main">
            Key <span className="font-mono">{createdName}</span> đã được tạo.
          </p>
          <CopyBlock prompt="key" value={createdSecret} label="Sao chép API key" />
          <div
            role="alert"
            className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
          >
            <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">warning</span>
            <span>Lưu key ngay — bạn sẽ không xem lại được</span>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Xoá API key"
        footer={
          <>
            <ActionButton tone="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Huỷ</ActionButton>
            <ActionButton tone="solid" onClick={submitDelete} loading={deleting} className="border-red-600 bg-red-600 text-white hover:bg-red-700">Xoá key</ActionButton>
          </>
        }
      >
        <p className="text-sm text-text-main">
          Xoá key <span className="font-mono">{deleteTarget?.name || deleteTarget?.keyPrefix}</span>?
          Mọi ứng dụng đang dùng key này sẽ ngừng gọi được ngay. Không thể hoàn tác.
        </p>
      </Modal>
    </Page>
  );
}
