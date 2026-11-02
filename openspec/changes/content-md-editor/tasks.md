## 1. Banner status
- [x] 1.1 `BannerCard.js`: saved-state status line (icon + text), shared `Toggle`, field warnings, live preview with `AnnouncementBanner` (inert).
- [x] 1.2 `ContentPageClient.js`: keep the server copy (`savedCopy`) apart from the draft; "Có thay đổi chưa lưu" beside the save button.

## 2. Markdown editor
- [x] 2.1 `src/shared/utils/markdownCommands.js`: toolbar commands and Tab indent as pure text transforms.
- [x] 2.2 `MarkdownEditor.js`: toolbar, shortcuts, Esc-then-Tab escape, preview through `renderMarkdown` + `docs-body` + `DocsTabsEnhancer`; side by side on lg, "Soạn / Xem trước" tabs below.
- [x] 2.3 `DocEditor.js`: full-height dialog with metadata fields, `Toggle` for "Đăng công khai", slug checks, discard confirmation, focus handling.

## 3. Import / export
- [x] 3.1 `src/shared/utils/docsMarkdownFile.js`: front matter parse/serialise, title from first `# `, slug from filename.
- [x] 3.2 "Tải lên .md" (new page), "Thay nội dung bằng file .md" (fill empty fields, undo), "Tải .md" in the list and the editor.

## 4. Tests and checks
- [x] 4.1 `test/docs-markdown-file.test.js`, `test/markdown-commands.test.js`.
- [x] 4.2 `npm test`, `npm run lint`, `npm run build`; screenshots of the content page from the built app.
- [ ] 4.3 Merge the deltas into `openspec/specs/` and archive the change (after owner review).
