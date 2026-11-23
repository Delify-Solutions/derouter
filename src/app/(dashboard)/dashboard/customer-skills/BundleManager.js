"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, ConfirmModal, Badge, Card } from "@/shared/components";
import { renderBundleMarkdown, excerptFromMarkdown } from "@/app/account/skills/renderBundleMarkdown";
import SkillRow from "./SkillRow";

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
    version: bundle.version || "",
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
          <span className={LABEL}>Phiên bản (tự đặt — repo này không có git tag/release để lấy tự động)</span>
          <input
            value={form.version}
            onChange={(e) => set({ version: e.target.value })}
            className={`${INPUT} font-mono`}
            placeholder="v1.0.0"
            maxLength={40}
          />
        </label>

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
 * for Claude Code, an installer entrypoint). Sits above the skill list — a bundle's
 * own skills are managed here, expanded on demand, and never duplicated in the flat
 * list below. Deleting a bundle only detaches its skills, never removes them
 * (skillBundlesRepo.deleteBundle).
 *
 * @param {object[]} skills every skill (standalone and bundled); only rows whose
 *   `bundleId` matches a bundle here are shown, under that bundle
 * @param {string|null} busyId the skill row currently mid-request, from the parent
 * @param {(skill: object) => void} onTogglePublished
 * @param {(skill: object) => void} onEditSkill
 * @param {(skill: object) => void} onDeleteSkill
 */
export default function BundleManager({ skills = [], busyId, onTogglePublished, onEditSkill, onDeleteSkill }) {
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [bundleBusyId, setBusyId] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  const byBundle = useMemo(() => {
    const map = new Map();
    for (const skill of skills) {
      if (!skill.bundleId) continue;
      if (!map.has(skill.bundleId)) map.set(skill.bundleId, []);
      map.get(skill.bundleId).push(skill);
    }
    return map;
  }, [skills]);

  const toggleExpanded = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  // Acknowledges the source has moved: not a re-import, just marks the latest
  // commit as the one this bundle's content now reflects, so the banner clears.
  // Re-importing the content itself is still the admin's own call in RepoImportModal.
  const markSynced = async (bundle) => {
    if (!bundle.latestSha) return;
    setBusyId(bundle.id);
    try {
      const res = await fetch(`/api/skills/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importedSha: bundle.latestSha }),
      });
      if (res.ok) await load();
      else setError("Không đánh dấu đồng bộ được.");
    } catch {
      setError("Không đánh dấu đồng bộ được.");
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
        {bundles.map((bundle) => {
          const linked = byBundle.get(bundle.id) || [];
          const isOpen = expanded.has(bundle.id);
          return (
            <Card key={bundle.id} padding="md" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono text-sm font-semibold text-text-main">{bundle.name}</h3>
                    {bundle.version && <Badge variant="default" size="sm">{bundle.version}</Badge>}
                    {bundle.isPublished ? <Badge variant="success" size="sm" dot>Đang phát hành</Badge> : <Badge variant="default" size="sm" dot>Bản nháp</Badge>}
                    {bundle.audience === "internal" && <Badge variant="warning" size="sm">Nội bộ</Badge>}
                    {bundle.hasUpdate && <Badge variant="warning" size="sm" dot>Có bản cập nhật từ nguồn</Badge>}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-text-subtle">
                    {bundle.slug} · {bundle.sourceHost}/{bundle.sourceOwner}/{bundle.sourceRepo}@{bundle.sourceRef} ·
                    installer: {bundle.installerEntrypoint} · cập nhật {fmtDate(bundle.updatedAt)}
                  </p>
                  {bundle.description && (
                    <p className="mt-1 text-xs leading-5 text-text-muted">{excerptFromMarkdown(bundle.description)}</p>
                  )}
                  {bundle.hasUpdate && (
                    <div className="mt-2 flex flex-col gap-1.5 border border-amber-500/40 bg-amber-500/5 p-2.5">
                      <p className="font-mono text-[11px] text-amber-700 dark:text-amber-400">
                        Commit mới nhất trên {bundle.sourceRef}: {bundle.latestSha?.slice(0, 7)} (đã nhập: {bundle.importedSha?.slice(0, 7) || "—"})
                      </p>
                      <p className="text-xs leading-5 text-text-muted">
                        Xem lại nội dung repo nguồn, nhập lại qua &quot;Nhập từ repo&quot; nếu cần, rồi bấm nút bên dưới để tắt cảnh báo này.
                      </p>
                      <Button variant="secondary" size="sm" className="w-fit" onClick={() => markSynced(bundle)} disabled={bundleBusyId === bundle.id}>
                        Đã xem, đánh dấu đồng bộ
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => togglePublished(bundle)} disabled={bundleBusyId === bundle.id}>
                    {bundle.isPublished ? "Ẩn" : "Phát hành"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(bundle)} disabled={bundleBusyId === bundle.id}>Sửa</Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(bundle)} disabled={bundleBusyId === bundle.id} className="text-red-600 hover:bg-red-500/10">Xoá</Button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => toggleExpanded(bundle.id)}
                aria-expanded={isOpen}
                className="flex w-fit items-center gap-1.5 border-t border-border pt-2 font-mono text-xs text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  {isOpen ? "expand_less" : "expand_more"}
                </span>
                {isOpen ? "Ẩn chi tiết" : "Xem chi tiết"} ({linked.length} skill)
              </button>

              {isOpen && (
                <div className="flex flex-col gap-4 border-t border-border pt-3">
                  {(bundle.description || bundle.usageGuide) && (
                    <div className="flex flex-col gap-3 border border-border bg-surface-2 p-4">
                      {bundle.description && (
                        <div
                          className="docs-body text-sm text-text-main"
                          dangerouslySetInnerHTML={{ __html: renderBundleMarkdown(bundle.description) }}
                        />
                      )}
                      {bundle.usageGuide && (
                        <div className="border-l-2 border-border pl-3">
                          <span className={LABEL}>Hướng dẫn sử dụng</span>
                          <div
                            className="docs-body mt-1 text-sm text-text-main"
                            dangerouslySetInnerHTML={{ __html: renderBundleMarkdown(bundle.usageGuide) }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {linked.length === 0 ? (
                    <p className="text-sm text-text-muted">Bundle này chưa có skill nào.</p>
                  ) : (
                    linked.map((skill) => (
                      <SkillRow
                        key={skill.id}
                        row={skill}
                        busy={busyId === skill.id}
                        onTogglePublished={onTogglePublished}
                        onEdit={onEditSkill}
                        onDelete={onDeleteSkill}
                      />
                    ))
                  )}
                </div>
              )}
            </Card>
          );
        })}
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
