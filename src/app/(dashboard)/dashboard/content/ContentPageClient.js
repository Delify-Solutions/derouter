"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Button, Input, ConfirmModal, Badge } from "@/shared/components";
import BannerCard from "./BannerCard";
import PopupCard from "./PopupCard";
import DocEditor, { EMPTY_DOC, downloadDocFile, draftFromFile, readMarkdownFile } from "./DocEditor";

// Field groups mirror the section order of the landing page, so an admin editing
// copy finds it in the same order they see it on the site.
const COPY_GROUPS = [
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

// Copy keys compared for the "unsaved changes" indicator.
function copyDiffers(a, b) {
  if (!a || !b) return false;
  return Object.keys({ ...a, ...b }).some((key) => (a[key] ?? "") !== (b[key] ?? ""));
}

function docToDraft(doc) {
  return {
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary || "",
    excerpt: doc.excerpt || "",
    section: doc.section || "",
    body: doc.body || "",
    isPublished: Boolean(doc.isPublished),
    sortOrder: doc.sortOrder ?? 0,
  };
}

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
  // The copy as the server last returned it (load or save). The banner status
  // describes this, not the draft, because it is what visitors currently see.
  const [savedCopy, setSavedCopy] = useState(null);
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
      setSavedCopy(data.copy);
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
      setSavedCopy(data.copy);
      setCopySaved(true);
    } catch (e) {
      setCopyError(e.message);
    } finally {
      setCopySaving(false);
    }
  };

  const copyDirty = copyDiffers(copy, savedCopy);

  // ── Docs pages ──────────────────────────────────────────────────────────
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState("");
  // { key, editingId, draft, warnings } while the editor is open. `key` remounts
  // the editor so each page starts from its own initial state.
  const [editor, setEditor] = useState(null);
  const editorSeq = useRef(0);
  const [confirm, setConfirm] = useState(null);
  const importRef = useRef(null);

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

  const openEditor = (editingId, draft, warnings = []) => {
    editorSeq.current += 1;
    setEditor({ key: editorSeq.current, editingId, draft, warnings });
  };

  const openNew = () => openEditor(null, EMPTY_DOC);

  const fetchDoc = async (id) => {
    const res = await fetch(`/api/docs/${id}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Không tải được trang");
    return data.doc;
  };

  const openEdit = async (id) => {
    setDocsError("");
    try {
      openEditor(id, docToDraft(await fetchDoc(id)));
    } catch (e) {
      setDocsError(e.message);
    }
  };

  // "Tải lên .md": opens the editor prefilled as a NEW page; nothing is saved
  // until the admin clicks "Tạo trang".
  const importFile = async (file) => {
    setDocsError("");
    try {
      const text = await readMarkdownFile(file);
      const { draft, warnings } = draftFromFile(text, file.name);
      openEditor(null, draft, warnings);
    } catch (e) {
      setDocsError(e.message);
    }
  };

  const exportDoc = async (doc) => {
    setDocsError("");
    try {
      // The list omits bodies, so fetch the full page first.
      downloadDocFile(docToDraft(await fetchDoc(doc.id)));
    } catch (e) {
      setDocsError(e.message);
    }
  };

  // Throws on failure so the editor can show the error and stay open.
  const submitDoc = async (draft) => {
    const editingId = editor?.editingId;
    const res = await fetch(editingId ? `/api/docs/${editingId}` : "/api/docs", {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Không lưu được trang");
    setEditor(null);
    await loadDocs();
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

  const sections = useMemo(
    () => [...new Set(docs.map((d) => d.section).filter(Boolean))],
    [docs]
  );

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
              <BannerCard copy={copy} saved={savedCopy} onChange={setCopyField} />
              <PopupCard copy={copy} saved={savedCopy} onChange={setCopyField} />

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
                      field.type === "textarea" ? (
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

              {/* Sticky: the banner card is at the top of a long form, and a save
                  button only at the bottom is easy to miss. */}
              <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-border bg-bg px-1 py-3">
                <Button onClick={saveCopy} loading={copySaving}>Lưu nội dung</Button>
                {copyDirty ? (
                  <span role="status" className="inline-flex items-center gap-1.5 font-mono text-[11px] text-amber-800 dark:text-amber-300">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">edit_note</span>
                    Có thay đổi chưa lưu
                  </span>
                ) : null}
                {copySaved && !copyDirty ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-700 dark:text-brand-400">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">check_circle</span>
                    Đã lưu. Tải lại trang chủ để xem.
                  </span>
                ) : null}
                {copyError ? (
                  <span role="alert" className="inline-flex items-center gap-1.5 text-[11px] text-danger">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
                    {copyError}
                  </span>
                ) : null}
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
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={importRef}
                type="file"
                accept=".md,.markdown,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) importFile(file);
                }}
              />
              <Button variant="secondary" icon="upload_file" onClick={() => importRef.current?.click()}>
                Tải lên .md
              </Button>
              <Button icon="add" onClick={openNew}>
                Trang mới
              </Button>
            </div>
          </div>

          {docsError && (
            <p role="alert" className="flex items-center gap-1.5 text-[12px] text-danger">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
              {docsError}
            </p>
          )}

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
                      onClick={() => exportDoc(doc)}
                      aria-label={`Tải ${doc.title} dưới dạng .md`}
                      title="Tải .md"
                      className="size-8 flex items-center justify-center border border-border text-text-muted hover:text-text-main hover:border-text-muted transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">download</span>
                    </button>
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
                        message: `Xóa "${doc.title}"? Đường dẫn /docs/${doc.slug} sẽ ngừng hoạt động. Nếu đây là trang mặc định của hệ thống, nó sẽ được tạo lại khi khởi động; muốn ẩn thì bỏ đăng thay vì xóa.`,
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

      {editor && (
        <DocEditor
          key={editor.key}
          editingId={editor.editingId}
          initialDraft={editor.draft}
          initialWarnings={editor.warnings}
          sections={sections}
          docs={docs}
          onClose={() => setEditor(null)}
          onSubmit={submitDoc}
        />
      )}

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
