"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Modal, ConfirmModal, Badge, Card } from "@/shared/components";

const LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
const INPUT = "h-9 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none";

function fmtDate(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** The fields a bundle's edit form carries. */
function formFromBundle(bundle) {
  return {
    name: bundle.name || "",
    slug: bundle.slug || "",
    description: bundle.description || "",
    usageGuide: bundle.usageGuide || "",
    installerEntrypoint: bundle.installerEntrypoint || "install.mjs",
    sourceHost: bundle.sourceHost || "",
    sourceOwner: bundle.sourceOwner || "",
    sourceRepo: bundle.sourceRepo || "",
    sourceRef: bundle.sourceRef || "",
    audience: bundle.audience || "customer",
    isPublished: bundle.isPublished !== false,
    sortOrder: bundle.sortOrder ?? 0,
  };
}

/** Edit one bundle: everything the admin wrote at import time, still editable. */
function BundleEditorModal({ bundle, onClose, onSaved }) {
  const [form, setForm] = useState(() => formFromBundle(bundle));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/skills/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không lưu được bundle");
        return;
      }
      onSaved();
    } catch {
      setError("Không lưu được bundle. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={() => !saving && onClose()}
      title={`Sửa bundle: ${bundle.name}`}
      size="full"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
          <Button onClick={save} loading={saving}>Lưu thay đổi</Button>
        </div>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        {error && (
          <p role="alert" className="border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Tên bundle</span>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} className={INPUT} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Slug</span>
            <input value={form.slug} onChange={(e) => set({ slug: e.target.value })} className={`${INPUT} font-mono`} />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Mô tả (khách thấy)</span>
          <textarea
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={4}
            className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Hướng dẫn sử dụng (skill nào dùng khi nào)</span>
          <textarea
            value={form.usageGuide}
            onChange={(e) => set({ usageGuide: e.target.value })}
            rows={4}
            className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Installer entrypoint</span>
            <input
              value={form.installerEntrypoint}
              onChange={(e) => set({ installerEntrypoint: e.target.value })}
              className={`${INPUT} font-mono`}
              placeholder="install.mjs"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Nhánh/ref nguồn</span>
            <input value={form.sourceRef} onChange={(e) => set({ sourceRef: e.target.value })} className={`${INPUT} font-mono`} />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Đối tượng</span>
            <select value={form.audience} onChange={(e) => set({ audience: e.target.value })} className={INPUT}>
              <option value="customer">Khách hàng</option>
              <option value="internal">Nội bộ</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Thứ tự (nhỏ lên trước)</span>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => set({ sortOrder: e.target.value === "" ? 0 : Number(e.target.value) })}
              className={`${INPUT} font-mono`}
            />
          </label>
          <label className="mt-6 flex items-center gap-2">
            <input type="checkbox" checked={form.isPublished} onChange={(e) => set({ isPublished: e.target.checked })} className="size-4" />
            <span className="text-sm text-text-main">Phát hành</span>
          </label>
        </div>

        <p className="font-mono text-[11px] text-text-subtle">
          Nguồn: {form.sourceHost}/{form.sourceOwner}/{form.sourceRepo}@{form.sourceRef}
        </p>
      </div>
    </Modal>
  );
}

/**
 * Admin bundle console: the repositories imported as a bundle (skills + engine +,
 * for Claude Code, an installer entrypoint). Sits beside the skill list so an admin
 * can see, edit and delete a bundle without losing the skills it groups — deleting
 * one only detaches its skills, never removes them (skillBundlesRepo.deleteBundle).
 */
export default function BundleManager() {
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/skills/bundles", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setBundles(data.bundles || []);
    } catch {
      setError("Không tải được danh sách bundle.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const togglePublished = async (bundle) => {
    setBusyId(bundle.id);
    try {
      const res = await fetch(`/api/skills/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished: !bundle.isPublished }),
      });
      if (res.ok) await load();
      else setError("Không đổi được trạng thái phát hành.");
    } catch {
      setError("Không đổi được trạng thái phát hành.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    setBusyId(target.id);
    try {
      const res = await fetch(`/api/skills/bundles/${target.id}`, { method: "DELETE" });
      if (res.ok) await load();
      else setError("Không xoá được bundle.");
    } catch {
      setError("Không xoá được bundle.");
    } finally {
      setBusyId(null);
    }
  };

  // Nothing to show while still loading (the skill list above already carries its
  // own skeleton) or when no repository has ever been imported as a bundle — unless
  // the load itself failed, in which case the admin should still see why.
  if (loading || (bundles.length === 0 && !error)) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm font-semibold text-text-main">Bundle (skill + engine)</h2>
        <span className="font-mono text-xs text-text-muted">{bundles.length} bundle</span>
      </div>

      {error && (
        <p role="alert" className="border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {bundles.map((bundle) => (
          <Card key={bundle.id} padding="md" className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-mono text-sm font-semibold text-text-main">{bundle.name}</h3>
                {bundle.isPublished ? <Badge variant="success" size="sm" dot>Đang phát hành</Badge> : <Badge variant="default" size="sm" dot>Bản nháp</Badge>}
                {bundle.audience === "internal" && <Badge variant="warning" size="sm">Nội bộ</Badge>}
              </div>
              <p className="mt-1 font-mono text-[11px] text-text-subtle">
                {bundle.slug} · {bundle.sourceHost}/{bundle.sourceOwner}/{bundle.sourceRepo}@{bundle.sourceRef} ·
                installer: {bundle.installerEntrypoint} · cập nhật {fmtDate(bundle.updatedAt)}
              </p>
              {bundle.description && <p className="mt-1 text-xs leading-5 text-text-muted">{bundle.description}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => togglePublished(bundle)} disabled={busyId === bundle.id}>
                {bundle.isPublished ? "Ẩn" : "Phát hành"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(bundle)} disabled={busyId === bundle.id}>Sửa</Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(bundle)} disabled={busyId === bundle.id} className="text-red-600 hover:bg-red-500/10">Xoá</Button>
            </div>
          </Card>
        ))}
      </div>

      {editing && (
        <BundleEditorModal
          bundle={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      <ConfirmModal
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Xoá bundle"
        message={deleting ? `Xoá bundle "${deleting.name}"? Các skill đã nhập từ bundle này vẫn còn, chỉ không còn gắn với bundle nữa.` : ""}
        confirmText="Xoá"
        variant="danger"
      />
    </div>
  );
}
