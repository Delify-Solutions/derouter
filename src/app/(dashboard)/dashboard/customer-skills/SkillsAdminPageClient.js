"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Modal, ConfirmModal, Badge, CardSkeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const TARGETS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "generic", label: "Khác" },
];

const AUDIENCES = [
  { value: "customer", label: "Khách hàng" },
  { value: "internal", label: "Nội bộ" },
];

const FILTERS = [
  { value: "all", label: "Tất cả" },
  { value: "published", label: "Đang phát hành" },
  { value: "draft", label: "Bản nháp" },
];

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Suggested slug from a display name; mirrors slugifySkill on the server. */
function suggestSlug(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const EMPTY_FORM = {
  name: "",
  slug: "",
  summary: "",
  description: "",
  category: "",
  body: "",
  fileName: "SKILL.md",
  target: "claude",
  installPath: "",
  audience: "customer",
  isPublished: true,
  usageNotes: "",
  version: "",
  sortOrder: 0,
};

/**
 * Admin skills console: publish a markdown skill, edit it, retire it.
 *
 * The body is the artifact, so the editor is the page: name and slug on one row,
 * metadata in a bordered panel, then a full-width monospace textarea with a live
 * line count. Everything else exists to help the customer find and place the file.
 */
export default function SkillsAdminPageClient() {
  const [skills, setSkills] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const { copy } = useCopyToClipboard(2000);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/skills", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setSkills(data.skills || []);
      setCategories(data.categories || []);
    } catch {
      setError("Không tải được danh sách skill. Tải lại trang để thử lại.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    if (filter === "published") return skills.filter((s) => s.isPublished);
    if (filter === "draft") return skills.filter((s) => !s.isPublished);
    return skills;
  }, [skills, filter]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setFormOpen(true);
  };

  const openEdit = async (row) => {
    setBusyId(row.id);
    setFormError("");
    try {
      // The list omits bodies, so the edit form fetches the one row it needs.
      const res = await fetch(`/api/skills/${row.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      const s = data.skill;
      setEditing(s);
      setForm({
        name: s.name || "",
        slug: s.slug || "",
        summary: s.summary || "",
        description: s.description || "",
        category: s.category || "",
        body: s.body || "",
        fileName: s.fileName || "SKILL.md",
        target: s.target || "generic",
        installPath: s.installPath || "",
        audience: s.audience || "customer",
        isPublished: s.isPublished !== false,
        usageNotes: s.usageNotes || "",
        version: s.version || "",
        sortOrder: s.sortOrder ?? 0,
      });
      setFormOpen(true);
    } catch {
      setError("Không mở được skill để sửa.");
    } finally {
      setBusyId(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setFormError("");
    try {
      const payload = { ...form, slug: form.slug || suggestSlug(form.name) };
      const res = await fetch(
        editing ? `/api/skills/${editing.id}` : "/api/skills",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không lưu được skill");
        return;
      }
      setFormOpen(false);
      await load();
    } catch {
      setFormError("Không lưu được skill. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const togglePublished = async (row) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/skills/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished: !row.isPublished }),
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
      const res = await fetch(`/api/skills/${target.id}`, { method: "DELETE" });
      if (res.ok) await load();
      else setError("Không xoá được skill.");
    } catch {
      setError("Không xoá được skill.");
    } finally {
      setBusyId(null);
    }
  };

  const bodyLines = form.body ? form.body.split("\n").length : 0;
  const bodyBytes = new TextEncoder().encode(form.body || "").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-text-main">
            <span className="mr-2 text-text-subtle" aria-hidden="true">{"//"}</span>
            Skills
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
            Skill markdown phát hành cho khách tải về cài vào agent của họ. Khách thấy mục
            &quot;Skill&quot; trong khu tài khoản; skill đánh dấu nội bộ thì không hiện ở đó.
          </p>
        </div>
        <Button onClick={openCreate} icon="add">
          Skill mới
        </Button>
      </div>

      {error && (
        <p role="alert" className="border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setFilter(item.value)}
            aria-pressed={filter === item.value}
            className={`h-8 border px-3 font-mono text-xs font-medium transition-colors duration-150 ${
              filter === item.value
                ? "border-text-main bg-text-main text-bg"
                : "border-border bg-surface text-text-muted hover:text-text-main"
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-xs text-text-muted">
          {visible.length} skill
        </span>
      </div>

      {loading ? (
        <CardSkeleton />
      ) : visible.length === 0 ? (
        <Card padding="md">
          <p className="py-8 text-center text-sm text-text-muted">
            Chưa có skill nào. Bấm &quot;Skill mới&quot; để phát hành skill đầu tiên.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-start gap-3 border border-border bg-surface p-4"
            >
              <span className="flex size-9 shrink-0 items-center justify-center border border-border bg-surface-2 text-text-muted">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">extension</span>
              </span>

              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-mono text-sm font-semibold text-text-main">{row.name}</h3>
                  {row.isPublished ? (
                    <Badge variant="success" size="sm" dot>Đang phát hành</Badge>
                  ) : (
                    <Badge variant="default" size="sm" dot>Bản nháp</Badge>
                  )}
                  {row.audience === "internal" && (
                    <Badge variant="warning" size="sm">Nội bộ</Badge>
                  )}
                  {row.category && <Badge variant="info" size="sm">{row.category}</Badge>}
                  {row.version && <Badge variant="default" size="sm">v{row.version}</Badge>}
                </div>
                <p className="mt-1 font-mono text-[11px] text-text-subtle">
                  {row.slug} · {row.fileName} · {row.downloadCount ?? 0} lượt tải · cập nhật {fmtDate(row.updatedAt)}
                </p>
                {row.summary && (
                  <p className="mt-1 text-xs leading-5 text-text-muted">{row.summary}</p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copy(row.slug)}
                  title="Sao chép slug"
                >
                  Slug
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => togglePublished(row)}
                  disabled={busyId === row.id}
                >
                  {row.isPublished ? "Ẩn" : "Phát hành"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openEdit(row)}
                  disabled={busyId === row.id}
                >
                  Sửa
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleting(row)}
                  disabled={busyId === row.id}
                  className="text-red-600 hover:bg-red-500/10"
                >
                  Xoá
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        title={editing ? `Sửa: ${editing.name}` : "Skill mới"}
        size="full"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Huỷ
            </Button>
            <Button onClick={save} loading={saving}>
              {editing ? "Lưu thay đổi" : "Phát hành"}
            </Button>
          </div>
        }
      >
        <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pr-1">
          {formError && (
            <p role="alert" className="border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {formError}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Tên skill <span className="text-red-600">*</span>
              </span>
              <input
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((prev) => ({
                    ...prev,
                    name,
                    // Only auto-fill a slug the admin has not typed themselves.
                    slug: prev.slug && prev.slug !== suggestSlug(prev.name) ? prev.slug : suggestSlug(name),
                  }));
                }}
                className="h-10 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none"
                placeholder="rt-recon-pipeline"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Slug (tên thư mục)
              </span>
              <input
                value={form.slug}
                onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
                className="h-10 w-full border border-border bg-surface px-3 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                placeholder="rt-recon-pipeline"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
              Mô tả ngắn (hiện trên thẻ)
            </span>
            <input
              value={form.summary}
              maxLength={200}
              onChange={(e) => setForm((prev) => ({ ...prev, summary: e.target.value }))}
              className="h-10 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none"
              placeholder="Pipeline thu thập tài sản domain → subdomain → port → sống"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
              Hướng dẫn sử dụng (hiện dưới nút tải)
            </span>
            <textarea
              value={form.usageNotes}
              onChange={(e) => setForm((prev) => ({ ...prev, usageNotes: e.target.value }))}
              rows={3}
              className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
              placeholder="Tải file, đặt vào ~/.claude/skills/<slug>/SKILL.md, rồi gõ /rea trong Claude Code."
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Nhóm</span>
              <input
                value={form.category}
                onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                list="skill-categories"
                className="h-10 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none"
                placeholder="Red team"
              />
              <datalist id="skill-categories">
                {categories.map((c) => (
                  <option key={c.category} value={c.category} />
                ))}
              </datalist>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Runtime</span>
              <select
                value={form.target}
                onChange={(e) => setForm((prev) => ({ ...prev, target: e.target.value }))}
                className="h-10 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none"
              >
                {TARGETS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Đối tượng</span>
              <select
                value={form.audience}
                onChange={(e) => setForm((prev) => ({ ...prev, audience: e.target.value }))}
                className="h-10 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none"
              >
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Phiên bản</span>
              <input
                value={form.version}
                onChange={(e) => setForm((prev) => ({ ...prev, version: e.target.value }))}
                className="h-10 w-full border border-border bg-surface px-3 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                placeholder="1.0.0"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Tên file</span>
              <input
                value={form.fileName}
                onChange={(e) => setForm((prev) => ({ ...prev, fileName: e.target.value }))}
                className="h-10 w-full border border-border bg-surface px-3 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                placeholder="SKILL.md"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Đường dẫn cài</span>
              <input
                value={form.installPath}
                onChange={(e) => setForm((prev) => ({ ...prev, installPath: e.target.value }))}
                className="h-10 w-full border border-border bg-surface px-3 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                placeholder="~/.claude/skills/<slug>/"
              />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Nội dung markdown <span className="text-red-600">*</span>
              </span>
              <span className="font-mono text-[11px] text-text-subtle">
                {bodyLines} dòng · {(bodyBytes / 1024).toFixed(1)} KB
              </span>
            </div>
            <textarea
              value={form.body}
              onChange={(e) => setForm((prev) => ({ ...prev, body: e.target.value }))}
              rows={18}
              spellCheck={false}
              className="w-full border border-border bg-surface px-3 py-2 font-mono text-[12px] leading-5 text-text-main focus:border-text-main focus:outline-none"
              placeholder={"---\nname: rt-example\ndescription: ...\n---\n\n# Tiêu đề\n\nNội dung skill..."}
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isPublished}
              onChange={(e) => setForm((prev) => ({ ...prev, isPublished: e.target.checked }))}
              className="size-4 border border-border"
            />
            <span className="text-sm text-text-main">Phát hành ngay (khách thấy trong khu tài khoản)</span>
          </label>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Xoá skill"
        message={
          deleting
            ? `Xoá "${deleting.name}"? Khách đã tải bản sao vẫn giữ được file, nhưng mục này biến mất khỏi danh sách.`
            : ""
        }
        confirmText="Xoá"
        variant="danger"
      />
    </div>
  );
}
