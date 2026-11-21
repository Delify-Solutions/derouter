## Context

A skill is a markdown file with a YAML frontmatter block. The agent runtime reads
it from a fixed directory (`~/.claude/skills/<slug>/SKILL.md`) at session start.
There is nothing to install and nothing to execute — the file *is* the artifact.

That property decides the design:

1. **The body is the payload, not a description of it.** Storing a URL instead of
   the text would make the catalogue depend on a third-party host and would leak
   an internal skill's existence through the path. The table stores the text.
2. **Two audiences, one table.** "Who may see this" is a column
   (`audience`), not a second table or a naming convention. An operator staging
   next quarter's recon skill next to the published one is the normal case.
3. **The slug is load-bearing.** It becomes a directory name on the customer's
   machine and a URL segment on ours. It is validated on the server against
   `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` before any write, so no row can carry `../` or a
   slash even if the admin form is bypassed.

## Decisions

**Repository-level filtering, not page-level.** `listPublishedSkills()` and
`getSkillBySlug(slug, { publishedOnly: true })` are the only functions the customer
routes call. If the filter lived in the page component, a future endpoint that
forgot it would leak an internal skill; putting it in the query means the answer
is the same for every caller. The test suite pins this by creating an internal and
a draft row and asserting both are absent from the customer view while the admin
view still lists them.

**List omits bodies.** The catalogue endpoint returns metadata only; the body
arrives from the single-skill endpoint when the customer opens the preview. Forty
skills at even 5 KB each is 200 KB of markdown the page would otherwise ship on
every visit. `listSkills()` therefore projects an explicit column list rather than
`SELECT *`.

**Partial patch merges before validating.** `PATCH /api/skills/{id}` reads the
current row, merges the patch over it, and validates the *result* — so changing a
summary cannot fail because the body is momentarily absent from the payload.
`updateSkill()` repeats the merge for direct repository callers.

**Download is an attachment, not a render.** `Content-Disposition: attachment`
plus a sanitised filename: the row's `fileName` is admin-controlled, so
separators, quotes and control characters are stripped before it reaches a header.
The download counter increments best-effort — a counter failure must never fail a
customer's download.

**Categories are derived, not enumerated.** Like `docsPages.section`, a new
category is whatever the admin types. `listSkillCategories()` groups the
customer-visible rows, so an internal skill cannot contribute a filter chip that
would hint at its existence.

**The installer authenticates with the customer's API key, not the browser
session.** The script runs in a terminal, where the customer has a key (they
already use it for the proxy) and no cookie. The catalogue and file endpoints
therefore sit under `/api/public/` and call `resolveSkillKey()`: a customer key
that is active, whose owner is active and which has not expired. Admin keys are
refused, so an operator key pasted into a customer's script does not become a
second way to read internal skills. Everything else gets one generic 401, so the
endpoints never say which part was wrong. The key is read from a header only, never
`?key=`, and the two endpoints join the per-address unknown-key throttle that the
public usage page already uses.

**The script is public and secret-free.** It is a template with the server's
public origin substituted (`publicBaseUrl`, else the forwarded host, and only if it
is a plain http(s) origin, since the value is placed inside single quotes). The key
comes from `DEROUTER_KEY` or a hidden prompt, goes to curl as a config line on
stdin so it never shows in `ps`, and is rejected up front if it contains anything
that could break out of that line. The whole body is inside `main()` so a download
cut short cannot execute half a script.

**Plain text catalogue, not JSON.** Shell without `jq` cannot parse JSON reliably.
The catalogue is one tab-separated line per skill with an empty field written as
`-`, because `read` with a tab separator merges empty fields and would shift the
columns. The script re-validates every slug and file name it receives before using
it as a path, so a compromised or mistaken server cannot make it write outside the
skills directory.

**Rejected: an npm package.** A package would need publishing and a Node runtime on
the customer's machine for what is a download and a `mkdir`. The shell script needs
only curl, runs on macOS, Linux and WSL / Git Bash, and ships with the server so it
can never drift from the API it calls. A native Windows (PowerShell) installer is
not provided; the manual steps remain for that case.

**A typed slug is validated, not normalised.** Slugifying what the admin typed
before validating it made the validation unreachable and turned `../etc/passwd`
into a different, valid slug without telling anyone. Only a missing slug is derived
from the name.

## Risks

- **Body size.** Capped at 512 KB per skill with a Vietnamese error naming the
  limit. A skill larger than that is almost certainly a mistake (a pasted log, an
  entire repo), and inlining it would bloat every catalogue query.
- **Stale copies.** A customer who downloaded a skill keeps it after the admin
  retires or edits the row. This is inherent to a file-on-disk distribution and is
  stated on the delete confirmation ("Khách đã tải bản sao vẫn giữ được file").
  `version` exists so a support conversation can ask "which version do you have".
- **The older `/dashboard/skills` page was removed.** It listed derouter's own API
  capability docs from a source constant (`src/shared/constants/skills.js`, raw
  GitHub URLs). The owner dropped it, so `/dashboard/customer-skills` is the only
  skills page in the admin.
