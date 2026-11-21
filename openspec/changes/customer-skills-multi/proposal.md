## Why

The admin skills page (`/dashboard/customer-skills`) was hard to use: one skill per
modal, fourteen fields, a single "runtime" choice, no way to add the dozens of
skills the owner already keeps in a folder, and no way to change many skills at
once. A skill can serve several agents (Claude Code, Codex, Cursor) but could only be
tagged for one.

## What Changes

- A skill targets **a list of agents** (`targets`), not one `target`. The install
  directory is derived per agent (`~/.claude/skills/<slug>/`, `~/.codex/skills/…`,
  `~/.cursor/skills/…`); the free-text "install path" field is dropped. One list of
  agents lives in `src/lib/skills/runtimes.js`, so a new agent is one line.
- **Add many skills at once**: pick several `.md` files or a whole `skills/` folder
  (or drop them, or paste one). Name, slug and summary are prefilled from each
  file's frontmatter, a folder's name becomes the slug, the admin reviews and edits
  the list, chooses agents / category / audience / published for all of them, and
  one request creates them (`POST /api/skills/bulk`) with a per-row result. Existing
  slugs are skipped or updated, as chosen.
- **Select rows** to publish, hide or set agents for many skills in one action
  (`PATCH /api/skills/bulk`); only agents, published, audience and category can be
  changed this way.
- Simpler editor: name, markdown and agents up front; the rarely changed fields
  (slug, category, summary, usage notes, audience, version, file name) under
  "Tuỳ chọn thêm". The list gets search, a filter by status or "Nội bộ", a category
  filter, and a retry link on error.
- **Installer**: the catalogue carries each skill's agents; the script installs a
  skill into every agent it supports that exists on the machine, falls back to the
  skill's first agent on a machine with none, and `--target a,b` narrows it.
- Customer page: a card shows every agent a skill supports with that agent's path.

## Capabilities

### Modified Capabilities
- `customer-skills`: multiple agents per skill, bulk add, bulk change, installer
  multi-agent behaviour.

## Impact

- `src/lib/skills/{runtimes,frontmatter,installScript}.js`, `src/lib/db/repos/skillsRepo.js`
  (`targets`, `importSkills`, `patchSkills`), `src/lib/db/schema.js` (v46, `targets`)
- `src/app/api/skills/bulk/route.js`, `src/app/api/public/skills/catalog/route.js`
- `src/app/(dashboard)/dashboard/customer-skills/*`, `src/app/account/skills/SkillsPageClient.js`
- `test/skills.test.js`, `test/skills-install.test.js`, `test/skills-frontmatter.test.js`
