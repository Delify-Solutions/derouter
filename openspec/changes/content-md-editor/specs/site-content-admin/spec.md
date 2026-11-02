## ADDED Requirements

### Requirement: Banner status in the content admin
The "Thông báo đầu trang" card on `/dashboard/content` SHALL show a status line computed from the landing copy as last loaded from or saved to the server (never from the unsaved draft), each with an icon and text: "Đang hiện trên trang chủ" when the strip is visible under the public-landing visibility rule, "Đang ẩn: chưa bật thông báo" when `bannerEnabled` is false, and "Đang ẩn: chưa có nội dung thông báo" when it is enabled with blank text. The switch SHALL be the shared Toggle component. Under the fields the card SHALL warn "Đã bật nhưng chưa có nội dung: thông báo sẽ không hiện." when the draft is enabled with blank text, and "Có nội dung nhưng chưa bật: thông báo sẽ không hiện." when the draft has text but is disabled. The card SHALL preview the strip by rendering the landing page's own banner component with the draft values (non-interactive), or say that no strip would show. While any landing copy field differs from the saved copy, "Có thay đổi chưa lưu" SHALL be shown beside the save button. The landing-copy API contract SHALL NOT change.

#### Scenario: Enabled but not saved
- **WHEN** the saved copy has the banner disabled and the admin switches it on and types text without saving
- **THEN** the status still reads "Đang ẩn: chưa bật thông báo", the preview shows the strip, and "Có thay đổi chưa lưu" is shown

#### Scenario: Saved live banner
- **WHEN** the admin saves the banner enabled with text "Có model mới"
- **THEN** the status reads "Đang hiện trên trang chủ" and the unsaved-changes notice disappears

#### Scenario: Enabled with empty text
- **WHEN** the draft has the switch on and blank text
- **THEN** the card warns under the text field that the banner will not show

### Requirement: Markdown editor for docs pages
Creating or editing a docs page SHALL open a full-height editor with the page fields (title, slug, sort order, section, card excerpt, summary, published as a Toggle) and a Markdown body editor. The body editor SHALL offer a toolbar (H2, H3, bold, italic, inline code, code block, link, image, bullet list, numbered list, quote, table) that wraps or prefixes the current selection, the shortcuts Ctrl/Cmd+B (bold), Ctrl/Cmd+I (italic) and Ctrl/Cmd+K (link), and Tab inserting two spaces (Esc then Tab moves focus out). A live preview SHALL render the body with the same Markdown renderer, sanitiser and `docs-body` wrapper as `/docs/[slug]`, together with the section, title and summary. On wide screens the editor and preview SHALL be side by side; on narrow screens they SHALL be "Soạn / Xem trước" tabs. The editor SHALL flag an invalid slug or a slug already used by another page before saving, and SHALL ask before closing with unsaved changes. Nothing SHALL be stored until the admin clicks "Tạo trang" or "Lưu trang".

#### Scenario: Bold shortcut
- **WHEN** the admin selects "quan trọng" in the body and presses Ctrl+B
- **THEN** the body contains "**quan trọng**" and the preview shows it in bold

#### Scenario: Preview matches the public page
- **WHEN** the body contains a `:::tabs` block, a table and an image
- **THEN** the preview renders them with the same markup and styles as the published `/docs/<slug>` page

#### Scenario: Close with unsaved changes
- **WHEN** the admin edits the body and presses Esc outside the text area
- **THEN** the editor asks whether to discard the changes instead of closing

### Requirement: Import a docs page from a Markdown file
The docs tab SHALL offer "Tải lên .md", which reads a local `.md`/`.markdown` file in the browser and opens the editor prefilled as a NEW page; nothing SHALL be saved until the admin creates the page. Files over 1 MB, other extensions and non-text content SHALL be refused with a Vietnamese error. The file MAY start with front matter: a `---` line, `key: value` lines, and a closing `---` line; the keys `title`, `slug`, `section`, `excerpt`, `summary`, `sortOrder` (integer) and `published` (`true`/`false`) SHALL be read, a value MAY be wrapped in double quotes (JSON escapes) or single quotes, a value MAY contain colons, and CRLF line endings SHALL be accepted. Without a front matter title the first `# ` heading outside a code fence SHALL become the title and be removed from the body. Without a valid front matter slug the slug SHALL be derived from the filename (else the title): lower case, Vietnamese diacritics stripped (đ → d), runs of other characters → `-`, at most 64 characters, a reserved slug suffixed with `-doc`, so it passes the docs slug rules. An invalid `sortOrder`, `published` or `slug` SHALL be ignored with a warning shown in the editor. Inside the editor, "Thay nội dung bằng file .md" SHALL replace the body and fill only empty metadata fields from the file (never the published flag), with an undo.

#### Scenario: File without front matter
- **WHEN** the admin uploads "Hướng dẫn Codex.md" whose first line is "# Cài Codex"
- **THEN** the editor opens as a new page titled "Cài Codex" with slug `huong-dan-codex`, the heading removed from the body, and nothing saved

#### Scenario: Oversized file
- **WHEN** the admin uploads a 2 MB `.md` file
- **THEN** an error says the file is over the 1 MB limit and no editor opens

#### Scenario: Replace keeps existing metadata
- **WHEN** the admin editing page "bat-dau" replaces its content with a file whose front matter has another title and an empty section is filled by the file
- **THEN** the body is replaced, the title and slug stay, and the section takes the file's value

### Requirement: Export a docs page as a Markdown file
Each page in the docs list and the open editor SHALL offer "Tải .md", which downloads `<slug>.md` containing front matter with `title`, `slug`, `section`, `excerpt`, `summary` (double-quoted), `sortOrder` and `published`, a blank line, and the body. Importing an exported file SHALL reproduce the same field values and body. The editor's export SHALL use the current (possibly unsaved) values.

#### Scenario: Round trip
- **WHEN** the admin exports page "bat-dau" and imports the downloaded file
- **THEN** the new-page editor shows the same title, slug, section, excerpt, summary, sort order, published flag and body
