## Why

The owner turned the announcement banner on in `/dashboard/content` and the landing page never showed it. The code path works (the strip renders when `bannerEnabled` is true AND `bannerText` is non-blank), but the admin UI gave no signal: the switch was a bare checkbox, nothing said whether the strip was live, and nothing said that a save was still pending. The stored state on production was most likely "enabled but empty" or "text but disabled".

Docs pages are already Markdown, but the editor is a small textarea in a modal with no formatting help and no preview, and there is no way to author a page in a local `.md` file and bring it in (or take one out). The owner asked for "thêm sửa tài liệu bằng .md và editor .md luôn".

## What Changes

- Banner card in `/dashboard/content`:
  - a status line computed from the copy as last loaded/saved: "Đang hiện trên trang chủ", "Đang ẩn: chưa bật thông báo", "Đang ẩn: chưa có nội dung thông báo" (icon + text, never colour alone);
  - "Có thay đổi chưa lưu" beside the save button while the draft differs from the saved copy;
  - a live preview that renders the real `AnnouncementBanner` with the draft values;
  - a warning under the field when the text is set but the switch is off, or the reverse;
  - the shared `Toggle` instead of a raw checkbox (also for the docs "Đăng công khai" switch).
- Docs editor becomes a full-height dialog: metadata fields on top, a Markdown editor (toolbar: H2, H3, bold, italic, inline code, code block, link, image, bullet list, numbered list, quote, table; Ctrl/Cmd+B/I/K; Tab inserts two spaces, Esc then Tab leaves the field) and a live preview that uses the same `renderMarkdown` and `docs-body` wrapper as `/docs/[slug]`. Side by side on wide screens, "Soạn / Xem trước" tabs on narrow ones. Closing with unsaved changes asks first.
- Import: "Tải lên .md" on the docs tab reads a local file (≤ 1 MB) and opens the editor prefilled as a NEW page; nothing is saved until "Tạo trang". Optional `---` front matter (`title`, `slug`, `section`, `excerpt`, `summary`, `sortOrder`, `published`); without it the first `# ` heading becomes the title and the slug comes from the filename. Inside the editor, "Thay nội dung bằng file .md" replaces the body and fills only empty metadata fields (with an undo).
- Export: "Tải .md" per page in the list and in the editor downloads `<slug>.md` (front matter + body); export → import round-trips.

## Capabilities

### New Capabilities
- `site-content-admin`: the admin content page — banner status and preview, the docs Markdown editor, `.md` import and export.

### Modified Capabilities
- `public-landing`: states the announcement strip's visibility rule, which the admin status line mirrors (no behaviour change).

## Impact

- **Code**: `src/app/(dashboard)/dashboard/content/{ContentPageClient,BannerCard,DocEditor,MarkdownEditor}.js`; new pure modules `src/shared/utils/docsMarkdownFile.js` (parse/serialise) and `src/shared/utils/markdownCommands.js` (toolbar text transforms). `markdown.js` (marked + sanitiser), `docsTabs.js`, `docsSlug.js` and `AnnouncementBanner` are now also imported by the admin client bundle, unchanged.
- **API / database**: none. `/api/landing-copy` and `/api/docs/**` keep their contracts.
- **Tests**: `test/docs-markdown-file.test.js`, `test/markdown-commands.test.js`.
