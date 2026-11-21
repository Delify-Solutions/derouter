## 1. Data

- [x] 1.1 Schema v45: `skills` table with slug uniqueness, audience, published flag, indices on `(isPublished, audience, sortOrder)` and `category`
- [x] 1.2 `skillsRepo.js`: `slugifySkill`, `slugError`, `skillInputError`, `normalize`, row mapping that can omit the body
- [x] 1.3 `listSkills` / `listPublishedSkills` / `listSkillCategories` / `getSkillById` / `getSkillBySlug({ publishedOnly })`
- [x] 1.4 `createSkill` / `updateSkill` (merge-then-validate) / `deleteSkill` / `incrementSkillDownload`

## 2. Admin API

- [x] 2.1 `GET /api/skills` → rows without bodies + derived categories
- [x] 2.2 `POST /api/skills` → 201 with `{ id, slug }`; 400 on validation failure or duplicate slug
- [x] 2.3 `GET/PATCH/DELETE /api/skills/{id}` — 404 on unknown id, 400 on a slug clash
- [x] 2.4 Audit actor recorded as `createdBy` via `getAdminActor`

## 3. Customer API

- [x] 3.1 `GET /api/account/skills` — 401 without a `user_token`, published + customer-audience only
- [x] 3.2 `GET /api/account/skills/{slug}` — body for the preview panel; 404 for internal/unpublished
- [x] 3.3 `GET /api/account/skills/{slug}/download` — `text/markdown` attachment, sanitised filename, best-effort counter increment

## 4. UI — admin

- [x] 4.1 `/dashboard/customer-skills` page + sidebar entry "Skill khách hàng"
- [x] 4.2 List: published / draft / internal / category / version badges, slug · file · download count · updated date, all/draft/published filters
- [x] 4.3 Create/edit modal: name with auto-slug that yields to a hand-typed slug, summary, usage notes, category with datalist, runtime, audience, version, file name, install path, markdown textarea with live line + KB count
- [x] 4.4 Hide/publish toggle and delete with a confirmation that names the stale-copy consequence

## 5. UI — customer

- [x] 5.1 `/account/skills` page + sidebar entry "Skill"
- [x] 5.2 Tab "Danh sách": category chips with counts, cards carrying target/version tags, install directory with copy button, usage note, download + preview
- [x] 5.3 Tab "Hướng dẫn cài": five numbered steps (download → create directory → move to SKILL.md → reopen the session → invoke), the per-runtime path for Codex and Cursor, a verification block (`ls ~/.claude/skills/`, `/help`), the four general rules, and a support note
- [x] 5.4 Preview modal renders the raw markdown with a download action

## 6. Hardening

- [x] 6.1 A typed slug is validated as typed (create and update); only a missing slug is derived from the name
- [x] 6.2 File name must be ASCII `.md`; download filename also strips non-ASCII so `Headers` cannot throw
- [x] 6.3 Every limit refused instead of truncated (usage notes, version, category, install path); body limit in UTF-8 bytes; runtime / audience / published flag accept only known values
- [x] 6.4 Tests for each of the above in `test/skills.test.js`

- [x] 6.5 A blank slug on update keeps the current slug (renaming renames customers' install directory); a long name cannot yield a trailing-dash slug; malformed or non-object JSON on the admin routes is a 400
- [x] 6.6 Customer views omit `createdBy` (an admin identity)

## 7. One-line installer

- [x] 7.1 `skillKey.js`: active customer key, active owner, unexpired; header only; generic 401
- [x] 7.2 `installScript.js` + `GET /api/public/skills/install.sh` (public, origin from `publicBaseUrl` or forwarded host, origin shape-checked)
- [x] 7.3 `GET /api/public/skills/catalog` (tab-separated, published customer skills) and `GET /api/public/skills/file/{slug}` (404 for internal/draft, counts download)
- [x] 7.4 `dashboardGuard.js`: catalogue and file endpoints join the unknown-key throttle; install.sh stays unthrottled
- [x] 7.5 Customer page: "Cài nhanh" panel, per-card command, guide tab leads with the one-liner ← (verify: the command shown matches what the script accepts, key stays a placeholder)
- [x] 7.7 Installer reads the key with the guard's own extractor (headers only); validates the whole catalogue before writing; sends the key only over https or loopback; catalogue strips control characters
- [x] 7.8 Customer preview uses the shared `Modal` (Escape, overlay close, scroll lock)
- [x] 7.6 `test/skills-install.test.js`: the real script run by sh and dash against the real handlers — install, re-run, update, `--target`, `--dir`, `--list`, refusals, hostile catalogue, download count ← (verify: hostile slug/file name writes nothing; a refused key writes nothing)

## 8. Checks

- [x] 8.1 `test/skills.test.js` — 20 cases: slug derivation, directory-escape refusal, empty body, create, duplicate slug, internal/draft invisibility, body omission, partial patch, slug de-duplication on rename, category counts, delete, counter
- [x] 8.2 `npm test` — 1522 tests; the skills tests (20 + 21) all pass. Two runs each showed two *different* timing-threshold tests failing under full-suite load (`usage-aggregation` clamp; `client-abort`, `customer-leak-sse` 200k-line mask) that pass when run alone and are in files this change does not touch
- [x] 8.3 `npx eslint` on every touched file — 0 errors, 2 `set-state-in-effect` warnings (the `useEffect(load)` pattern the other account pages use)
- [x] 8.4 `npx next build` — exit 0; the three `/api/public/skills/*` routes, `/account/skills` and the account/admin skill routes are in the route table
- [x] 8.5 `test/skills-install.test.js` runs the real script (sh and dash) against the real handlers on an isolated `DATA_DIR`: install, re-run, update, refusals, hostile catalogue, counter. The browser pages were not re-screenshotted after the "Cài nhanh" panel was added
