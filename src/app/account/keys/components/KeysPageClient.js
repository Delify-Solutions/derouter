"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Modal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const NAME_MAX = 80;

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Static skeleton: no shimmer (openspec/ui-dna.md: content does not animate in). */
function Skeleton() {
  return (
    <div className="border border-border bg-surface" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-14 border-b border-border last:border-b-0 flex items-center gap-4 px-4">
          <div className="h-3 w-40 bg-surface-2" />
          <div className="h-3 w-24 bg-surface-2" />
          <div className="h-3 w-16 bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

function CopyButton({ text, label, id, copied, copy }) {
  return (
    <button
      type="button"
      onClick={() => copy(text, id)}
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center size-9 border border-border text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors duration-150 shrink-0"
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
        {copied === id ? "check" : "content_copy"}
      </span>
    </button>
  );
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
  const { copied, copy } = useCopyToClipboard();

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

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <span className="meta text-text-muted">Tài khoản</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">API key</h1>
        <p className="max-w-xl text-sm text-text-muted">
          Dùng key này để gọi model trong nhóm của bạn. Key chỉ hiển thị một lần khi tạo.
        </p>
      </header>

      {/* Base URL */}
      <section className="border border-border bg-surface p-6 flex flex-col gap-3">
        <span className="meta text-text-muted">Địa chỉ API</span>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 min-w-0 border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] text-text-main truncate" title={baseUrl}>
            {baseUrl}
          </code>
          <CopyButton text={baseUrl} label="Sao chép địa chỉ API" id="base-url" copied={copied} copy={copy} />
        </div>
        <p className="text-xs text-text-muted">
          Ví dụ: <span className="font-mono">curl {baseUrl}/chat/completions -H &quot;Authorization: Bearer &lt;key&gt;&quot; …</span>
        </p>
      </section>

      {/* Key list */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="meta text-text-muted">Key của bạn</span>
          <Button size="sm" icon="add" onClick={openCreate}>Tạo key</Button>
        </div>

        {loadError ? (
          <div role="alert" className="border border-red-600/30 bg-red-500/10 px-4 py-3 flex items-start justify-between gap-4">
            <span className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
              <span>{loadError}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={load}>Thử lại</Button>
          </div>
        ) : loading ? (
          <Skeleton />
        ) : keys.length === 0 ? (
          <div className="border border-border bg-surface px-6 py-14 flex flex-col items-start gap-3">
            <span className="material-symbols-outlined text-[28px] text-text-muted" aria-hidden="true">key</span>
            <p className="text-text-main font-medium">Bạn chưa có API key</p>
            <p className="text-sm text-text-muted max-w-md">
              Tạo key đầu tiên để bắt đầu gọi model. Bạn có thể tạo nhiều key cho nhiều máy khác nhau.
            </p>
            <Button icon="add" onClick={openCreate}>Tạo key</Button>
          </div>
        ) : (
          <div className="border border-border bg-surface overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="meta text-text-muted font-medium px-4 py-3">Tên</th>
                  <th scope="col" className="meta text-text-muted font-medium px-4 py-3">Key</th>
                  <th scope="col" className="meta text-text-muted font-medium px-4 py-3">Tạo ngày</th>
                  <th scope="col" className="meta text-text-muted font-medium px-4 py-3">Trạng thái</th>
                  <th scope="col" className="meta text-text-muted font-medium px-4 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3">
                      <span className="text-sm text-text-main block max-w-[220px] truncate" title={key.name}>
                        {key.name || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-text-muted">
                      {key.keyPrefix ? `${key.keyPrefix}…` : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{formatDate(key.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        key.isActive
                          ? "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400"
                          : "border-border bg-surface-2 text-text-muted"
                      }`}>
                        <span className="size-1.5 bg-current" aria-hidden="true" />
                        {key.isActive ? "Đang dùng" : "Đã tắt"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="delete"
                          aria-label={`Xoá key ${key.name || key.keyPrefix || ""}`}
                          className="text-red-600 hover:bg-red-500/10"
                          onClick={() => setDeleteTarget(key)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create */}
      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setFormError(""); }}
        title="Tạo API key"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreateOpen(false); setFormError(""); }} disabled={saving}>Huỷ</Button>
            <Button onClick={submitCreate} loading={saving} disabled={!name.trim()}>Tạo</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
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
          {formError && (
            <p role="alert" className="text-[11px] text-red-600 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
              {formError}
            </p>
          )}
        </div>
      </Modal>

      {/* Secret shown exactly once */}
      <Modal
        isOpen={!!createdSecret}
        onClose={() => setCreatedSecret("")}
        title="Đã tạo API key"
        closeOnOverlay={false}
        footer={
          <Button onClick={() => setCreatedSecret("")}>Tôi đã lưu key</Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-main">
            Key <span className="font-mono">{createdName}</span> đã được tạo.
          </p>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 min-w-0 border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] text-text-main break-all">
              {createdSecret}
            </code>
            <CopyButton text={createdSecret} label="Sao chép API key" id="secret" copied={copied} copy={copy} />
          </div>
          <div
            role="alert"
            className="border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300"
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
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Huỷ</Button>
            <Button variant="danger" onClick={submitDelete} loading={deleting}>Xoá key</Button>
          </>
        }
      >
        <p className="text-sm text-text-main">
          Xoá key <span className="font-mono">{deleteTarget?.name || deleteTarget?.keyPrefix}</span>?
          Mọi ứng dụng đang dùng key này sẽ ngừng gọi được ngay. Không thể hoàn tác.
        </p>
      </Modal>
    </div>
  );
}
