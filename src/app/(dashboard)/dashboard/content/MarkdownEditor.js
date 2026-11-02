"use client";

import { useDeferredValue, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { renderMarkdown } from "@/shared/utils/markdown.js";
import { applyIndent, applyMarkdownCommand } from "@/shared/utils/markdownCommands.js";
import DocsTabsEnhancer from "@/app/docs/components/DocsTabsEnhancer";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const MOD = IS_MAC ? "⌘" : "Ctrl+";

// Toolbar groups; a hairline separates each group.
const TOOLS = [
  [
    { cmd: "h2", label: "H2", title: "Tiêu đề cấp 2" },
    { cmd: "h3", label: "H3", title: "Tiêu đề cấp 3" },
  ],
  [
    { cmd: "bold", icon: "format_bold", title: `Đậm (${MOD}B)` },
    { cmd: "italic", icon: "format_italic", title: `Nghiêng (${MOD}I)` },
    { cmd: "code", icon: "code", title: "Code trong dòng" },
    { cmd: "codeBlock", icon: "data_object", title: "Khối code" },
  ],
  [
    { cmd: "link", icon: "link", title: `Liên kết (${MOD}K)` },
    { cmd: "image", icon: "image", title: "Ảnh" },
  ],
  [
    { cmd: "bulletList", icon: "format_list_bulleted", title: "Danh sách" },
    { cmd: "orderedList", icon: "format_list_numbered", title: "Danh sách đánh số" },
    { cmd: "quote", icon: "format_quote", title: "Trích dẫn" },
    { cmd: "table", icon: "table", title: "Bảng" },
  ],
];

/**
 * Markdown body editor: toolbar + textarea on the left, the rendered page on the
 * right. The preview goes through the same renderMarkdown and the same
 * `docs-body` wrapper as /docs/[slug], so it looks like the public page.
 *
 * Below the lg breakpoint the two panes become "Soạn / Xem trước" tabs. Both
 * stay mounted (the inactive one is hidden) so DocsTabsEnhancer always finds the
 * preview root.
 */
export default function MarkdownEditor({ value, onChange, title, summary, section, textareaId = "doc-body-editor" }) {
  const ref = useRef(null);
  const [pane, setPane] = useState("write");
  // Esc then Tab leaves the textarea (Tab otherwise inserts spaces), the same
  // escape hatch code editors use so the field is never a keyboard trap.
  const tabEscapes = useRef(false);

  const deferred = useDeferredValue(value);
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  const previewId = `${textareaId}-preview`;

  const applyEdit = (edit) => {
    const el = ref.current;
    if (!el || !edit) return;
    el.focus();
    el.setSelectionRange(edit.start, edit.end);
    // insertText keeps the browser's undo stack (Ctrl+Z undoes a toolbar action).
    // execCommand is deprecated but still the only way to do that for a textarea;
    // fall back to a controlled value update when it is unavailable.
    let done = false;
    try {
      done = document.execCommand("insertText", false, edit.text);
    } catch {
      done = false;
    }
    if (!done || el.value.slice(edit.start, edit.start + edit.text.length) !== edit.text) {
      const current = el.value;
      onChange(current.slice(0, edit.start) + edit.text + current.slice(edit.end));
    }
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      // setSelectionRange does not scroll a textarea; bring the caret line into
      // view (approximate: one line-height per newline, wrapped lines ignored).
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
      const y = (el.value.slice(0, edit.selectionEnd).split("\n").length - 1) * lineHeight;
      if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - lineHeight * 2) {
        el.scrollTop = Math.max(0, y - el.clientHeight / 2);
      }
    });
  };

  const run = (cmd) => {
    const el = ref.current;
    if (!el) return;
    applyEdit(applyMarkdownCommand(cmd, el.value, el.selectionStart, el.selectionEnd));
  };

  const onKeyDown = (e) => {
    const el = e.currentTarget;
    if (e.key === "Escape") {
      // First Esc only arms Tab-to-leave; it must not close the dialog.
      if (!tabEscapes.current) {
        tabEscapes.current = true;
        e.stopPropagation();
      }
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (tabEscapes.current) {
        tabEscapes.current = false;
        return;
      }
      e.preventDefault();
      applyEdit(applyIndent(el.value, el.selectionStart, el.selectionEnd, e.shiftKey));
      return;
    }
    // A bare modifier (the Shift of Esc → Shift+Tab) must not disarm the escape.
    if (["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
    tabEscapes.current = false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      const cmd = key === "b" ? "bold" : key === "i" ? "italic" : key === "k" ? "link" : null;
      if (cmd) {
        e.preventDefault();
        run(cmd);
      }
    }
  };

  const paneButton = (id, label) => (
    <button
      type="button"
      role="tab"
      aria-selected={pane === id}
      aria-controls={id === "write" ? `${textareaId}-write` : `${textareaId}-preview-pane`}
      onClick={() => setPane(id)}
      className={`h-8 px-3 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${
        pane === id ? "bg-surface-2 text-text-main" : "text-text-muted hover:text-text-main"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Chế độ xem" className="mb-2 flex w-fit border border-border lg:hidden">
        {paneButton("write", "Soạn")}
        {paneButton("preview", "Xem trước")}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-px border border-border bg-border lg:grid-cols-2">
        {/* Write pane */}
        <div
          id={`${textareaId}-write`}
          className={`min-h-0 flex-col bg-surface ${pane === "write" ? "flex" : "hidden"} lg:flex`}
        >
          <div role="toolbar" aria-label="Định dạng Markdown" aria-controls={textareaId} className="flex flex-wrap items-center border-b border-border bg-bg-alt">
            {TOOLS.map((group, gi) => (
              <div key={gi} className="flex items-center border-r border-border">
                {group.map((tool) => (
                  <button
                    key={tool.cmd}
                    type="button"
                    title={tool.title}
                    aria-label={tool.title}
                    // Keep the textarea selection: a mouse-down on the button would blur it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(tool.cmd)}
                    className="flex size-9 items-center justify-center text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
                  >
                    {tool.icon ? (
                      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{tool.icon}</span>
                    ) : (
                      <span className="font-mono text-[12px] font-semibold">{tool.label}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <label htmlFor={textareaId} className="sr-only">Nội dung (Markdown)</label>
          <textarea
            id={textareaId}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            aria-describedby={`${textareaId}-help`}
            placeholder={"## Tiêu đề mục\n\nViết nội dung bằng Markdown…"}
            className="min-h-0 w-full flex-1 resize-none border-0 bg-surface px-4 py-3 font-mono text-[13px] leading-6 text-text-main outline-none focus:outline-solid focus:outline-1 focus:-outline-offset-1 focus:outline-brand-500"
          />
          <p id={`${textareaId}-help`} className="border-t border-border px-4 py-1.5 font-mono text-[10px] text-text-subtle">
            {MOD}B đậm · {MOD}I nghiêng · {MOD}K liên kết · Tab chèn 2 dấu cách (Esc rồi Tab để rời ô soạn) · :::tabs cho khối tab
          </p>
        </div>

        {/* Preview pane: same wrapper and classes as the public article. */}
        <div
          id={`${textareaId}-preview-pane`}
          aria-label="Xem trước"
          className={`min-h-0 overflow-y-auto bg-bg px-6 py-6 ${pane === "preview" ? "block" : "hidden"} lg:block`}
        >
          <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">Xem trước · giống trang /docs</p>
          <article className="min-w-0 text-text-main">
            {section ? <p className="meta text-text-subtle">{section}</p> : null}
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title || "Chưa có tiêu đề"}</h1>
            {summary ? <p className="mt-3 text-text-muted">{summary}</p> : null}
            {html ? (
              <div
                id={previewId}
                data-i18n-skip="true"
                className="docs-body mt-8 text-text-main"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <p id={previewId} className="docs-body mt-8 text-sm text-text-muted">Chưa có nội dung.</p>
            )}
            <DocsTabsEnhancer rootSelector={`#${previewId}`} watch={html} />
          </article>
        </div>
      </div>
    </div>
  );
}

MarkdownEditor.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  title: PropTypes.string,
  summary: PropTypes.string,
  section: PropTypes.string,
  textareaId: PropTypes.string,
};
