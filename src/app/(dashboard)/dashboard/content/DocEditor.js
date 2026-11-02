"use client";

import { useEffect, useId, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Toggle } from "@/shared/components";
import { validateSlug } from "@/lib/content/docsSlug.js";
import {
  MAX_DOC_FILE_BYTES,
  docFileName,
  parseDocMarkdownFile,
  serializeDocMarkdownFile,
} from "@/shared/utils/docsMarkdownFile.js";
import MarkdownEditor from "./MarkdownEditor";

export const EMPTY_DOC = { slug: "", title: "", summary: "", excerpt: "", section: "", body: "", isPublished: false, sortOrder: 0 };

/**
 * Read a local .md file chosen by the admin. Rejects (with a Vietnamese message)
 * anything that is not a .md/.markdown file, is over 1 MB, or is not text.
 */
export function readMarkdownFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("Chưa chọn file."));
    if (!/\.(md|markdown)$/i.test(file.name || "")) {
      return reject(new Error(`"${file.name}" không phải file .md — chỉ nhận file Markdown (.md).`));
    }
    if (file.size > MAX_DOC_FILE_BYTES) {
      const kb = Math.ceil(file.size / 1024);
      return reject(new Error(`File "${file.name}" nặng ${kb} KB — tối đa 1 MB.`));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Không đọc được file "${file.name}".`));
    reader.onload = () => {
      const text = String(reader.result ?? "");
      if (text.includes("\u0000")) {
        reject(new Error(`"${file.name}" không phải file văn bản.`));
        return;
      }
      resolve(text);
    };
    reader.readAsText(file, "utf-8");
  });
}

/** Save a page as `<slug>.md` (front matter + body). */
export function downloadDocFile(doc) {
  const blob = new Blob([serializeDocMarkdownFile(doc)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = docFileName(doc.slug);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Page fields for a NEW page built from an uploaded file. */
export function draftFromFile(text, filename) {
  const parsed = parseDocMarkdownFile(text, { filename });
  return {
    draft: { ...EMPTY_DOC, ...parsed.fields, body: parsed.body },
    warnings: parsed.warnings,
  };
}

const FIELD_LABELS = { title: "tiêu đề", slug: "đường dẫn", section: "nhóm", excerpt: "mô tả thẻ", summary: "mô tả dưới tiêu đề", sortOrder: "thứ tự" };

function isEmptyField(key, value) {
  if (key === "sortOrder") return String(value ?? "").trim() === "" || Number(value) === 0;
  return !String(value ?? "").trim();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Full-height editor for one docs page: metadata on top, Markdown editor with a
 * live preview below. Remount it (via `key`) to start a different page.
 */
export default function DocEditor({ editingId, initialDraft, initialWarnings, sections, docs, onClose, onSubmit }) {
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState(initialWarnings || []);
  const [notice, setNotice] = useState(null); // { text, undo }
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Page fields start open for a new page (they are empty) and folded for an
  // existing one, so the Markdown editor gets the height.
  const [metaOpen, setMetaOpen] = useState(!editingId);
  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const fileRef = useRef(null);
  const headingId = useId();

  // sortOrder arrives as a number and comes back from the field as a string, so
  // compare it as text: retyping the same value is not a change.
  const comparable = (d) => JSON.stringify({ ...d, sortOrder: String(d?.sortOrder ?? "") });
  const dirty = comparable(draft) !== comparable(initialDraft);
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  // Lock page scroll, move focus in, and give it back on close.
  useEffect(() => {
    const previous = document.activeElement;
    document.body.style.overflow = "hidden";
    if (titleRef.current) titleRef.current.focus();
    else document.getElementById("doc-body-editor")?.focus();
    return () => {
      document.body.style.overflow = "";
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  const requestClose = () => {
    if (dirty && !saving) setConfirmDiscard(true);
    else onClose();
  };

  const onDialogKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
      return;
    }
    // Keep Tab inside the dialog (the textarea consumes its own Tab first).
    if (e.key === "Tab" && !e.defaultPrevented && dialogRef.current) {
      const nodes = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await onSubmit(draft);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  // "Thay nội dung bằng file .md": the body is replaced; front matter (or the
  // file's first heading / name) only fills metadata fields that are empty.
  const replaceFromFile = async (file) => {
    setError("");
    try {
      const text = await readMarkdownFile(file);
      const parsed = parseDocMarkdownFile(text, {
        filename: isEmptyField("slug", draft.slug) ? file.name : "",
        extractTitle: isEmptyField("title", draft.title),
      });
      const before = draft;
      const filled = [];
      const next = { ...draft, body: parsed.body };
      for (const [key, value] of Object.entries(parsed.fields)) {
        if (key === "isPublished") continue;
        if (isEmptyField(key, draft[key]) && !isEmptyField(key, value)) {
          next[key] = value;
          filled.push(FIELD_LABELS[key] || key);
        }
      }
      setDraft(next);
      setWarnings(parsed.warnings);
      setNotice({
        text: `Đã thay nội dung bằng "${file.name}".${filled.length ? ` Điền thêm: ${filled.join(", ")}.` : ""}`,
        undo: () => { setDraft(before); setNotice(null); setWarnings([]); },
      });
    } catch (e) {
      setError(e.message);
    }
  };

  const slugValue = String(draft.slug || "").trim();
  const slugProblem = slugValue ? validateSlug(slugValue) : null;
  const slugClash = slugValue && docs.find((d) => d.slug === slugValue && d.id !== editingId);
  const slugError = slugProblem || (slugClash ? `Đường dẫn này đã dùng cho "${slugClash.title}".` : null);
  // A slug problem keeps the fields open: the error must be visible to be fixed.
  const showMeta = metaOpen || Boolean(slugError);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center sm:p-4">
      {/* Flat dim, no click-to-close: an accidental click must not drop a long edit. */}
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onDialogKeyDown}
        className="relative flex h-full w-full max-w-[1440px] flex-col border border-border bg-surface"
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <h2 id={headingId} className="meta truncate text-text-main">
            {editingId ? "Sửa trang tài liệu" : "Trang tài liệu mới"}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) replaceFromFile(file);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              icon="upload_file"
              onClick={() => fileRef.current?.click()}
              aria-label="Thay nội dung bằng file .md"
              title="Thay nội dung bằng file .md"
            >
              <span className="hidden md:inline">Thay nội dung bằng file .md</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="download"
              onClick={() => downloadDocFile(draft)}
              aria-label="Tải .md (bản đang sửa)"
              title="Tải bản đang sửa về máy dưới dạng .md"
            >
              <span className="hidden md:inline">Tải .md</span>
            </Button>
            <button
              type="button"
              onClick={requestClose}
              aria-label="Đóng"
              className="flex size-9 shrink-0 items-center justify-center border border-border text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
            </button>
          </div>
        </div>

        {confirmDiscard && (
          <div role="alertdialog" aria-label="Bỏ thay đổi" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-3 sm:px-6">
            <p className="flex items-center gap-1.5 text-sm text-text-main">
              <span className="material-symbols-outlined text-[18px] text-amber-700 dark:text-amber-300" aria-hidden="true">warning</span>
              Trang có thay đổi chưa lưu. Đóng sẽ bỏ các thay đổi này.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmDiscard(false)} autoFocus>Tiếp tục sửa</Button>
              <Button variant="danger" size="sm" onClick={onClose}>Bỏ thay đổi</Button>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 custom-scrollbar sm:p-6">
          {notice && (
            <p className="flex flex-wrap items-center gap-2 border border-border bg-bg-alt px-3 py-2 text-[12px] text-text-main">
              <span className="material-symbols-outlined text-[16px] text-brand-700 dark:text-brand-400" aria-hidden="true">check_circle</span>
              <span className="flex-1">{notice.text}</span>
              <button type="button" onClick={notice.undo} className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-main underline underline-offset-2">
                Hoàn tác
              </button>
            </p>
          )}
          {warnings.length > 0 && (
            <ul className="flex flex-col gap-1 border border-amber-500/50 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
              {warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5">
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">warning</span>
                  {w}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              aria-expanded={showMeta}
              aria-controls="doc-meta-fields"
              onClick={() => setMetaOpen((v) => !v)}
              disabled={Boolean(slugError)}
              className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.14em] text-text-main transition-colors hover:text-brand-600 disabled:cursor-default disabled:hover:text-text-main"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                {showMeta ? "expand_less" : "expand_more"}
              </span>
              Thông tin trang
            </button>
            {!showMeta && (
              <p className="min-w-0 truncate font-mono text-[11px] text-text-muted">
                {draft.title || "Chưa có tiêu đề"} · /docs/{slugValue || "…"}
                {draft.section ? ` · ${draft.section}` : ""} · {draft.isPublished ? "Đã đăng" : "Nháp"}
              </p>
            )}
          </div>

          {showMeta && (
          <div id="doc-meta-fields" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Input
              ref={titleRef}
              label="Tiêu đề"
              value={draft.title}
              onChange={(e) => set("title", e.target.value)}
              className="md:col-span-2"
            />
            <Input
              label="Đường dẫn"
              value={draft.slug}
              onChange={(e) => set("slug", e.target.value)}
              hint={slugValue ? `/docs/${slugValue}` : "/docs/…"}
              error={slugError || undefined}
            />
            <Input
              label="Thứ tự"
              value={String(draft.sortOrder ?? 0)}
              inputMode="numeric"
              onChange={(e) => set("sortOrder", e.target.value)}
              hint="Số nhỏ hiện trước"
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="doc-section" className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Nhóm (tab trên đầu trang docs)
              </label>
              <input
                id="doc-section"
                list="docs-sections"
                value={draft.section}
                onChange={(e) => set("section", e.target.value)}
                placeholder="VD: Bắt đầu, API, Hạn mức"
                className="w-full border border-border bg-surface px-3 py-2.5 text-[16px] text-text-main transition-colors duration-150 focus:border-brand-500 focus:outline-none sm:text-sm"
              />
              {/* Suggestions from existing sections; a new name creates a new group. */}
              <datalist id="docs-sections">
                {sections.map((sec) => <option key={sec} value={sec} />)}
              </datalist>
            </div>
            <Input
              label="Mô tả trên thẻ (index)"
              value={draft.excerpt}
              onChange={(e) => set("excerpt", e.target.value)}
              placeholder="Một câu, hiện trên thẻ ở /docs"
              className="md:col-span-2"
            />
            <div className="flex items-end pb-1">
              <Toggle
                checked={Boolean(draft.isPublished)}
                onChange={(v) => set("isPublished", v)}
                label="Đăng công khai"
                description={draft.isPublished ? "Bật: ai cũng xem được" : "Tắt: bản nháp, chỉ admin thấy"}
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2 xl:col-span-4">
              <label htmlFor="doc-summary" className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Mô tả dưới tiêu đề trang
              </label>
              <textarea
                id="doc-summary"
                value={draft.summary}
                onChange={(e) => set("summary", e.target.value)}
                rows={2}
                className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main transition-colors duration-150 focus:border-brand-500 focus:outline-none"
              />
            </div>
          </div>
          )}

          <div className="flex min-h-[420px] flex-1 flex-col">
            <MarkdownEditor
              value={draft.body}
              onChange={(v) => set("body", v)}
              title={draft.title}
              summary={draft.summary}
              section={draft.section}
            />
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            {error ? (
              <p role="alert" className="flex items-center gap-1.5 text-[12px] text-danger">
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
                {error}
              </p>
            ) : dirty ? (
              <p className="flex items-center gap-1.5 font-mono text-[11px] text-text-muted">
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">edit_note</span>
                Có thay đổi chưa lưu
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={requestClose} disabled={saving}>Hủy</Button>
            <Button onClick={submit} loading={saving} disabled={Boolean(slugError)}>
              {editingId ? "Lưu trang" : "Tạo trang"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

DocEditor.propTypes = {
  editingId: PropTypes.string,
  initialDraft: PropTypes.object.isRequired,
  initialWarnings: PropTypes.arrayOf(PropTypes.string),
  sections: PropTypes.arrayOf(PropTypes.string).isRequired,
  docs: PropTypes.array.isRequired,
  onClose: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
};
