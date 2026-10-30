"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Modal, ConfirmModal, Badge } from "@/shared/components";

// Field groups mirror the section order of the landing page, so an admin editing
// copy finds it in the same order they see it on the site.
const COPY_GROUPS = [
  {
    title: "Thông báo đầu trang",
    note: "Dải thông báo phía trên tiêu đề, giống \"New … is now available\" của opencode.ai/go. Chỉ hiện khi đã bật và có nội dung.",
    fields: [
      { key: "bannerText", label: "Nội dung thông báo", type: "text" },
      { key: "bannerHref", label: "Liên kết (để trống nếu chỉ thông báo)", type: "text" },
      { key: "bannerEnabled", label: "Bật thông báo", type: "toggle" },
    ],
  },
  {
    title: "Khối đầu trang",
    fields: [
      { key: "heroTitle", label: "Tiêu đề chính", type: "textarea" },
      { key: "heroPrimaryCta", label: "Nút chính", type: "text" },
      { key: "heroSecondaryCta", label: "Nút phụ", type: "text" },
    ],
  },
  {
    title: "So sánh gói",
    fields: [
      { key: "plansEyebrow", label: "Nhãn nhỏ", type: "text" },
      { key: "plansTitle", label: "Tiêu đề", type: "text" },
      { key: "plansSubtitle", label: "Mô tả", type: "textarea", hint: "{count} = số model, {multiplier} = hệ số hạn mức của gói cao" },
      { key: "plansFootnote", label: "Ghi chú dưới bảng", type: "textarea" },
    ],
  },
  {
    title: "Danh mục model",
    fields: [
      { key: "modelsEyebrow", label: "Nhãn nhỏ", type: "text" },
      { key: "modelsTitle", label: "Tiêu đề", type: "text", hint: "{count} = số model trong danh mục" },
      { key: "modelsSubtitle", label: "Mô tả", type: "textarea" },
    ],
  },
  {
    title: "Bảng giá",
    fields: [
      { key: "pricingEyebrow", label: "Nhãn nhỏ", type: "text" },
      { key: "pricingTitle", label: "Tiêu đề", type: "text" },
      { key: "pricingSubtitle", label: "Mô tả", type: "textarea" },
    ],
  },
  {
    title: "Cách dùng",
    fields: [
      { key: "getStartedEyebrow", label: "Nhãn nhỏ", type: "text" },
      { key: "getStartedTitle", label: "Tiêu đề", type: "text" },
      { key: "getStartedSubtitle", label: "Mô tả", type: "textarea" },
    ],
  },
  {
    title: "Câu hỏi thường gặp",
    fields: [
      { key: "faqEyebrow", label: "Nhãn nhỏ", type: "text" },
      { key: "faqTitle", label: "Tiêu đề", type: "text" },
      { key: "faqSubtitle", label: "Mô tả", type: "textarea" },
    ],
  },
];

const EMPTY_DOC = { slug: "", title: "", summary: "", excerpt: "", section: "", body: "", isPublished: false, sortOrder: 0 };

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("vi-VN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export default function ContentPageClient() {
  const [tab, setTab] = useState("landing");

  // ── Landing copy ────────────────────────────────────────────────────────
  const [copy, setCopy] = useState(null);
  const [copySaving, setCopySaving] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copySaved, setCopySaved] = useState(false);

  const loadCopy = useCallback(async () => {
    setCopyError("");
    try {
      const res = await fetch("/api/landing-copy", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không tải được nội dung");
      setCopy(data.copy);
    } catch (e) {
      setCopyError(e.message);
    }
  }, []);

  useEffect(() => { loadCopy(); }, [loadCopy]);

  const setCopyField = (key, value) => {
    setCopy((c) => ({ ...(c || {}), [key]: value }));
    setCopySaved(false);
  };

  const saveCopy = async () => {
    setCopySaving(true);
    setCopyError("");
    try {
      const res = await fetch("/api/landing-copy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copy }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không lưu được nội dung");
      setCopy(data.copy);
      setCopySaved(true);
    } catch (e) {
      setCopyError(e.message);
    } finally {
      setCopySaving(false);
    }
  };

  // ── Docs pages ──────────────────────────────────────────────────────────
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DOC);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirm, setConfirm] = useState(null);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    setDocsError("");
    try {
      const res = await fetch("/api/docs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không tải được danh sách");
      setDocs(data.docs || []);
    } catch (e) {
      setDocsError(e.message);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  const openNew = () => {
    setEditingId(null);
    setDraft(EMPTY_DOC);
    setFormError("");
    setModalOpen(true);
  };

  const openEdit = async (id) => {
    setFormError("");
    try {
      const res = await fetch(`/api/docs/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không tải được trang");
      setDraft({
        slug: data.doc.slug,
        title: data.doc.title,
        summary: data.doc.summary || "",
        excerpt: data.doc.excerpt || "",
        section: data.doc.section || "",
        body: data.doc.body || "",
        isPublished: data.doc.isPublished,
        sortOrder: data.doc.sortOrder ?? 0,
      });
      setEditingId(id);
      setModalOpen(true);
    } catch (e) {
      setDocsError(e.message);
    }
  };

  const submitDoc = async () => {
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch(editingId ? `/api/docs/${editingId}` : "/api/docs", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không lưu được trang");
      setModalOpen(false);
      await loadDocs();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const removeDoc = async (doc) => {
    try {
      const res = await fetch(`/api/docs/${doc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không xóa được trang");
      await loadDocs();
    } catch (e) {
      setDocsError(e.message);
    }
  };

  const slugPreview = useMemo(() => {
    const s = String(draft.slug || "").trim();
    return s ? `/docs/${s}` : "/docs/…";
  }, [draft.slug]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-1 border border-border">
        {[
          { id: "landing", label: "Trang chủ" },
          { id: "docs", label: "Tài liệu" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${
              tab === t.id
                ? "bg-surface-2 text-text-main"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "landing" && (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-text-muted">
            Câu chữ trên trang chủ. Số liệu (giá gói, hạn mức, danh mục model) không sửa ở đây —
            chúng đọc từ cấu hình gói và registry nên luôn khớp với những gì hệ thống thực sự làm.
          </p>

          {!copy ? (
            copyError ? (
              <p className="text-[12px] text-danger">{copyError}</p>
            ) : (
              <p className="text-[12px] text-text-muted">Đang tải…</p>
            )
          ) : (
            <>
              {COPY_GROUPS.map((group) => (
                <Card key={group.title} className="flex flex-col gap-4 p-5">
                  <div>
                    <h3 className="text-sm font-semibold text-text-main">{group.title}</h3>
                    {group.note ? (
                      <p className="mt-1 text-[11px] text-text-muted">{group.note}</p>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {group.fields.map((field) =>
                      field.type === "toggle" ? (
                        <label key={field.key} className="flex items-center gap-2 text-sm text-text-main">
                          <input
                            type="checkbox"
                            checked={Boolean(copy[field.key])}
                            onChange={(e) => setCopyField(field.key, e.target.checked)}
                          />
                          {field.label}
                        </label>
                      ) : field.type === "textarea" ? (
                        <div key={field.key} className="md:col-span-2">
                          <label className="meta text-text-subtle">{field.label}</label>
                          <textarea
                            value={copy[field.key] ?? ""}
                            onChange={(e) => setCopyField(field.key, e.target.value)}
                            rows={3}
                            className="mt-1 w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
                          />
                          {field.hint ? (
                            <p className="mt-1 font-mono text-[10px] text-text-subtle">{field.hint}</p>
                          ) : null}
                        </div>
                      ) : (
                        <Input
                          key={field.key}
                          label={field.label}
                          value={copy[field.key] ?? ""}
                          onChange={(e) => setCopyField(field.key, e.target.value)}
                          hint={field.hint}
                        />
                      )
                    )}
                  </div>
                </Card>
              ))}

              {copyError && (
                <p className="flex items-center gap-1.5 text-[11px] text-danger">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  {copyError}
                </p>
              )}
              {copySaved && (
                <p className="flex items-center gap-1.5 text-[11px] text-brand-700 dark:text-brand-400">
                  <span className="material-symbols-outlined text-[14px]">check_circle</span>
                  Đã lưu. Tải lại trang chủ để xem.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={saveCopy} loading={copySaving}>Lưu nội dung</Button>
                <a
                  href="/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 border border-border px-4 font-mono text-[11px] uppercase tracking-[0.08em] text-text-main transition-colors hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  Xem trang chủ
                </a>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "docs" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-muted">
              Mỗi trang là một đường dẫn công khai dưới <span className="font-mono">/docs/</span>.
              Nội dung viết bằng Markdown.
            </p>
            <Button onClick={openNew}>
              <span className="material-symbols-outlined text-[16px]">add</span>
              Trang mới
            </Button>
          </div>

          {docsError && <p className="text-[12px] text-danger">{docsError}</p>}

          {docsLoading ? (
            <p className="text-[12px] text-text-muted">Đang tải…</p>
          ) : docs.length === 0 ? (
            <p className="border border-border bg-surface p-6 text-sm text-text-muted">
              Chưa có trang nào.
            </p>
          ) : (
            <ul className="flex flex-col gap-px border border-border bg-border">
              {docs.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-3 bg-surface px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text-main">{doc.title}</span>
                      <Badge variant={doc.isPublished ? "primary" : "default"} className="shrink-0">
                        {doc.isPublished ? "Đã đăng" : "Nháp"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-text-subtle">
                      {doc.section ? `${doc.section} · ` : ""}/docs/{doc.slug} · cập nhật {fmtDate(doc.updatedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {doc.isPublished && (
                      <a
                        href={`/docs/${doc.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="size-8 flex items-center justify-center border border-border text-text-muted hover:text-text-main hover:border-text-muted transition-colors"
                        aria-label={`Xem ${doc.title}`}
                      >
                        <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => openEdit(doc.id)}
                      aria-label={`Sửa ${doc.title}`}
                      className="size-8 flex items-center justify-center border border-border text-text-muted hover:text-text-main hover:border-text-muted transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirm({
                        title: "Xóa trang",
                        message: `Xóa "${doc.title}"? Đường dẫn /docs/${doc.slug} sẽ ngừng hoạt động.`,
                        onConfirm: () => { setConfirm(null); removeDoc(doc); },
                      })}
                      aria-label={`Xóa ${doc.title}`}
                      className="size-8 flex items-center justify-center border border-border text-danger hover:border-danger transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? "Sửa trang tài liệu" : "Trang tài liệu mới"}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>Hủy</Button>
            <Button onClick={submitDoc} loading={saving}>
              {editingId ? "Lưu trang" : "Tạo trang"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="Đường dẫn"
              value={draft.slug}
              onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
              hint={slugPreview}
            />
            <Input
              label="Thứ tự"
              value={String(draft.sortOrder ?? 0)}
              onChange={(e) => setDraft((d) => ({ ...d, sortOrder: e.target.value }))}
              hint="Số nhỏ hiện trước"
            />
          </div>

          <Input
            label="Tiêu đề"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="meta text-text-subtle">Nhóm (tab trên đầu trang docs)</label>
              <input
                list="docs-sections"
                value={draft.section}
                onChange={(e) => setDraft((d) => ({ ...d, section: e.target.value }))}
                placeholder="VD: Bắt đầu, API, Hạn mức"
                className="mt-1 w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
              />
              {/* Gợi ý từ các nhóm đã có, nhưng vẫn cho gõ tên mới: danh sách
                  nhóm được suy ra từ chính các trang, không phải enum cố định. */}
              <datalist id="docs-sections">
                {[...new Set(docs.map((d) => d.section).filter(Boolean))].map((sec) => (
                  <option key={sec} value={sec} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="meta text-text-subtle">Mô tả trên thẻ (index)</label>
              <input
                value={draft.excerpt}
                onChange={(e) => setDraft((d) => ({ ...d, excerpt: e.target.value }))}
                placeholder="Một câu, hiện trên thẻ ở /docs"
                className="mt-1 w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
              />
            </div>
          </div>

          <div>
            <label className="meta text-text-subtle">Mô tả dưới tiêu đề trang</label>
            <textarea
              value={draft.summary}
              onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
              rows={2}
              className="mt-1 w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
            />
          </div>

          <div>
            <label className="meta text-text-subtle">Nội dung (Markdown)</label>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              rows={16}
              spellCheck={false}
              className="mt-1 w-full border border-border bg-surface px-3 py-2 font-mono text-[13px] text-text-main"
            />
            <p className="mt-1 font-mono text-[10px] text-text-subtle">
              Hỗ trợ Markdown: # tiêu đề, **đậm**, `code`, ```khối code```, - danh sách, [liên kết](url).
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={Boolean(draft.isPublished)}
              onChange={(e) => setDraft((d) => ({ ...d, isPublished: e.target.checked }))}
            />
            Đăng công khai
          </label>

          {formError && (
            <p className="flex items-center gap-1.5 text-[11px] text-danger">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {formError}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={confirm?.onConfirm}
        title={confirm?.title || "Xác nhận"}
        message={confirm?.message}
        confirmText="Xóa"
        variant="danger"
      />
    </div>
  );
}
