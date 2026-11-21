## ADDED Requirements

### Requirement: Admin publishes a skill

`/dashboard/customer-skills` SHALL list every skill the operator has with its
name, slug, file name, download count and last-updated date, and SHALL show a
published / draft / internal badge on each row. The page SHALL offer filters for
all, published and draft rows.

The page SHALL let an admin create and edit a skill in a modal carrying: name
(required, ≤120 characters), slug (≤64 characters, lower-case letters, digits and
single dashes), summary (≤200 characters), description (≤2000 characters), usage
notes (≤4000 characters), category (free text, with existing categories offered),
target runtime (`claude` | `codex` | `cursor` | `generic`), audience
(`customer` | `internal`), version (≤40 characters), file name, install path,
sort order, published flag, and a markdown body (required, ≤512 KB).

The slug SHALL be derived from the name while the admin has not typed one, and
SHALL stop following the name once the admin edits it. A slug the admin typed
SHALL be validated exactly as typed and refused when it does not match the allowed
shape; it SHALL NOT be rewritten into a different slug. A slug already used by
another skill SHALL be refused with a message naming the collision. The modal
SHALL show the body's line count and size.

The file name SHALL be ASCII letters, digits, `.`, `_` and `-`, start with a
letter or digit and end in `.md` (blank means `SKILL.md`). Every limit named above
SHALL be refused with a message naming it, never silently truncated; the body
limit SHALL count UTF-8 bytes. Target runtime, audience and the published flag
SHALL accept only their listed values.

An admin SHALL be able to hide a published skill and publish a draft without
opening the edit form, and SHALL be able to delete a skill after a confirmation
stating that customers who already downloaded a copy keep their file.

#### Scenario: Creating a skill derives the slug
- **WHEN** an admin types the name "Recon Pipeline" and does not touch the slug field
- **THEN** the slug field reads `recon-pipeline`, and saving stores the markdown body against that slug

#### Scenario: Slug collision
- **WHEN** an admin saves a second skill whose slug resolves to one already in the table
- **THEN** the response is HTTP 400 with a message that the slug is taken, and no row is written

#### Scenario: A slug that could escape a directory
- **WHEN** a request arrives with slug `../etc/passwd`, `a/b` or `UPPER`
- **THEN** the response is HTTP 400 and nothing is written, on create and on update

#### Scenario: A file name that is not plain ASCII
- **WHEN** an admin saves a skill with file name `Kỹ-năng.md`, `../SKILL.md` or `SKILL.txt`
- **THEN** the response is HTTP 400 naming the file-name rule, and no row is written

#### Scenario: A limit is exceeded
- **WHEN** an admin saves usage notes of 4001 characters, a 41-character version, or a body of 600,000 UTF-8 bytes
- **THEN** the response is HTTP 400 naming that limit, and the stored row is unchanged

#### Scenario: Editing a summary keeps the body
- **WHEN** an admin changes only the summary of an existing skill
- **THEN** the body, category and every other field are unchanged afterwards

### Requirement: Customer downloads a published skill

`/account/skills` SHALL list only skills that are published and of audience
`customer`. It SHALL group them behind category chips carrying their counts, with
an "all" chip first, and SHALL render one card per skill showing its name, target
runtime, version, summary, download count, the directory the file belongs in (with
a copy control), its usage notes, and a download button labelled with the file
name.

The card SHALL offer a preview that shows the markdown body, with a download
action.

`GET /api/account/skills/{slug}/download` SHALL return the stored body as
`text/markdown; charset=utf-8` with `Content-Disposition: attachment`. The
filename SHALL be the row's file name with path separators, quotes and control
characters removed, falling back to `SKILL.md`. The endpoint SHALL answer 404 for
a skill that is unpublished or of audience `internal`, and SHALL answer 401
without a customer session. Each successful download SHALL increment the row's
download count, and a failure to increment SHALL NOT fail the download.

#### Scenario: Internal skill is invisible and undownloadable
- **WHEN** an admin created a skill with audience `internal`, and a signed-in customer loads the catalogue and then requests its download URL directly
- **THEN** the catalogue does not list it and the download returns HTTP 404

#### Scenario: Draft skill behaves like an internal one
- **WHEN** a skill has `isPublished` false
- **THEN** it appears in the admin list as "Bản nháp", is absent from the customer catalogue, and its download returns HTTP 404

#### Scenario: Download carries the markdown unchanged
- **WHEN** a customer downloads a skill whose body begins with a YAML frontmatter block
- **THEN** the response body byte-for-byte matches the stored text, with `Content-Disposition: attachment; filename="SKILL.md"`

#### Scenario: No session
- **WHEN** an unauthenticated request hits a download URL
- **THEN** the response is HTTP 401 and no body is returned

#### Scenario: Catalogue carries no bodies
- **WHEN** a customer loads the catalogue
- **THEN** the response contains each skill's metadata and no `body` field, and the body arrives only from the single-skill endpoint

### Requirement: One-line installer

The server SHALL serve a POSIX shell script at `GET /api/public/skills/install.sh`
without authentication. The script SHALL contain no secret and SHALL depend only on
`curl`. It SHALL read the customer's API key from the `DEROUTER_KEY` environment
variable, or ask for it without echo when a terminal is available, and SHALL send
it only as an `Authorization: Bearer` header supplied to curl on standard input,
never on a command line.

The script SHALL support `--all`, `--list`, one or more skill slugs, `--target`
(`claude` | `codex` | `cursor`), `--dir` and `--url`. Without `--all` or a slug it
SHALL only list the catalogue. By default each skill SHALL be written to
`<runtime directory>/<slug>/<fileName>` for the runtime the skill is for
(`~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills`), creating the directory.
A skill already installed SHALL be overwritten when its content differs and left
alone when it does not, and the script SHALL say which happened.

`GET /api/public/skills/catalog` and `GET /api/public/skills/file/{slug}` SHALL
answer only a request carrying an active customer API key whose owner is active and
whose key has not expired; any other request (no key, unknown key, admin key,
suspended owner, expired key, key in the query string) SHALL receive HTTP 401 with
one generic message. The catalogue SHALL list only published, customer-audience
skills as tab-separated `slug`, `fileName`, `version`, `runtime`, `name` lines, an
empty version or runtime written as `-`. The file endpoint SHALL return the stored
body unchanged, answer 404 for an unpublished or internal skill, and count the
download. Both endpoints SHALL be subject to the same per-address limit on unknown
keys as the public usage endpoint.

Before writing anything, the script SHALL check every slug and file name in the
catalogue against the allowed shape and stop without writing when any entry does
not match. It SHALL send the key only to an `https://` address or to this machine
(`localhost`, `127.0.0.1`, `[::1]`), and the catalogue SHALL strip control
characters from the fields it returns. The customer-facing skill views SHALL NOT
include the admin identity that published a skill. The key SHALL be read with the
same extractor the request guard uses (headers only), so the unknown-key throttle
counts exactly the keys these endpoints try.

The "Hướng dẫn cài" tab and the catalogue SHALL show the command with the page's
own origin and a `<API_KEY>` placeholder, and each skill card SHALL show the
command for that skill's slug.

#### Scenario: Installing everything
- **WHEN** a customer runs the command with a valid key and `--all` on a machine with no skills installed
- **THEN** each published customer skill is written to its runtime's directory as `<slug>/SKILL.md`, an internal or draft skill is not, and the script ends by telling the customer to reopen the agent session

#### Scenario: Running it again
- **WHEN** the same command is run twice without any skill changing
- **THEN** the second run reports every skill as already current and rewrites nothing; after the admin edits a body, the next run reports that skill as updated and the file holds the new text

#### Scenario: Wrong or unusable key
- **WHEN** the key is unknown, belongs to an admin, belongs to a suspended customer, or is passed in the URL
- **THEN** the endpoints answer HTTP 401, the script exits non-zero with a message that the key is not valid, and nothing is written

#### Scenario: A hostile server response
- **WHEN** the catalogue names a slug or file name such as `../escaped`, `/etc/passwd` or `.hidden`, on any line, even after valid lines
- **THEN** the script exits non-zero before writing anything

#### Scenario: Plain-http server address
- **WHEN** the script's address is `http://skills.example.com` or `http://127.0.0.1.evil.com`
- **THEN** it exits non-zero before contacting the server, and the key is not sent

#### Scenario: Script served without a usable origin
- **WHEN** the server cannot determine a public origin
- **THEN** the script still downloads and requires `--url` (or `DEROUTER_URL`) rather than guessing

### Requirement: Install guide on the customer page

`/account/skills` SHALL carry a "Hướng dẫn cài" tab that does not depend on any
one skill. It SHALL lead with the one-line installer, and SHALL then give the
manual route. The manual route SHALL state, in order: how to download the file; that the directory
name must equal the skill's slug, with a runnable `mkdir -p` line; that the file
must be renamed to `SKILL.md` inside that directory, with a runnable `mv` line;
that the agent session must be reopened because skills load at startup; and how to
invoke the skill in a session.

The tab SHALL name the install path for Codex (`~/.codex/skills/<slug>/`) and
Cursor (`~/.cursor/skills/<slug>/`) alongside Claude Code, SHALL give the way to
verify an install (`ls ~/.claude/skills/` and the session's own skill list), and
SHALL state the four standing rules: one directory per skill, keep the
frontmatter block, update by overwriting `SKILL.md`, remove by deleting the
directory.

#### Scenario: A customer who has never installed a skill
- **WHEN** a customer opens the "Hướng dẫn cài" tab
- **THEN** every step carries a copyable command or a fully-qualified path, so no step requires knowledge from outside the page

#### Scenario: Wrong runtime
- **WHEN** a customer uses Codex or Cursor
- **THEN** the guide shows that runtime's path rather than only Claude Code's

## MODIFIED Requirements

### Requirement: Navigation and language
The customer navigation SHALL list, in this order: `Tổng quan`, `Chat`, `Model`,
`Gói của tôi`, `Nhật ký credit`, `Mã quà tặng`, `Giới thiệu` (only when the
affiliate program applies), `API key`, `Skill`, `CDN ảnh`, `Lịch sử dùng`,
`Thông báo`, `Tài khoản`. Every label SHALL be in Vietnamese and every page SHALL
be reachable from the navigation on both the desktop sidebar and the mobile tab
bar's "Thêm" sheet.

#### Scenario: Skill page reachable on mobile
- **WHEN** a customer below the `lg` breakpoint opens "Thêm"
- **THEN** `Skill` is listed there and opens `/account/skills`
