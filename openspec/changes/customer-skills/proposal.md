## Why

The owner publishes agent skills — markdown files that teach an AI coding agent
(Claude Code, Codex, Cursor) a repeatable workflow — and until now the only way to
distribute one was to paste a GitHub raw URL into a chat. That breaks down as soon
as the skill is not public: an internal skill has nowhere to live, a customer has
no list of what they are entitled to, and there is no way to retire a skill without
editing a constant and redeploying.

The admin already has a form for every other piece of customer-facing content
(gift codes, docs pages, landing copy). Skills are the same shape of thing: a
markdown body the operator writes, publishes and retires over time. This change
gives that body a table, an admin page and a customer page with an install guide.

## What Changes

- New table **`skills`** (schema v45): slug, display name, summary, description,
  markdown body, file name, target runtime, install path, audience
  (`customer` | `internal`), published flag, usage notes, version, download count,
  sort order. Slug is unique and restricted to a directory-safe shape.
- New admin page **`/dashboard/customer-skills`** (sidebar "Skill khách hàng"):
  list with published/draft/internal badges and filters, a create/edit modal whose
  main field is the markdown body, hide/publish toggle, delete with confirmation.
- New customer page **`/account/skills`** (sidebar "Skill"): the catalogue the
  customer is entitled to, filtered by category, each card carrying the exact
  install directory and a download button; plus a **"Hướng dẫn cài"** tab with the
  five steps from download to a working skill, the per-runtime install path, and
  the checks to run when a skill does not appear.
- **One-line installer**: `curl -fsSL <origin>/api/public/skills/install.sh |
  DEROUTER_KEY=<key> sh -s -- --all` downloads every skill the customer may use and
  writes each to its runtime's skills directory; re-running updates. It
  authenticates with the customer's existing API key.
- API: `GET/POST /api/skills`, `GET/PATCH/DELETE /api/skills/{id}` (admin),
  `GET /api/account/skills`, `GET /api/account/skills/{slug}`,
  `GET /api/account/skills/{slug}/download` (customer session),
  `GET /api/public/skills/install.sh` (public, no secret),
  `GET /api/public/skills/catalog`, `GET /api/public/skills/file/{slug}`
  (customer API key).
- Input validation tightened: a typed slug is refused rather than rewritten, file
  names are ASCII `.md`, every stated limit is enforced rather than truncated, the
  body limit counts bytes.
- An internal or unpublished skill is filtered in the repository, not the page:
  no customer endpoint can return one, and its download is a 404.

## Capabilities

### New Capabilities
- `customer-skills`: publishing a skill, listing it to customers, and downloading
  the file with an install guide.

### Modified Capabilities
- `customer-portal`: a "Skill" entry in the customer navigation.

## Impact

- `src/lib/db/schema.js` (v45, `skills` table)
- `src/lib/db/repos/skillsRepo.js` (new)
- `src/app/api/skills/**`, `src/app/api/account/skills/**`, `src/app/api/public/skills/**` (new)
- `src/lib/skills/installScript.js`, `src/lib/skills/skillKey.js` (new)
- `src/dashboardGuard.js` (installer key endpoints join the unknown-key throttle)
- `src/app/(dashboard)/dashboard/customer-skills/**` (new admin page)
- `src/app/account/skills/**` (new customer page)
- `src/app/account/components/AccountShell.js`, `src/shared/components/Sidebar.js`
- `test/skills.test.js`, `test/skills-install.test.js` (new)
