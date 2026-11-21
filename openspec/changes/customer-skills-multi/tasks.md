## 1. Agents per skill

- [x] 1.1 `src/lib/skills/runtimes.js`: the one agent list, `parseRuntimes`, `runtimeInstallDir`, `runtimeLabel`
- [x] 1.2 Schema v46: `targets` JSON column; `target` kept as the first agent; `installPath` deprecated
- [x] 1.3 `skillsRepo`: read/write `targets` (legacy `target`, `generic`, NULL all resolve), validate unknown agents, drop `installPath`
- [x] 1.4 Customer card: every agent with its own install directory
- [x] 1.5 Tests: multi-agent create/update/keep, legacy and `generic`, NULL `targets`, duplicates collapse ← (verify: a skill can never end up with no agent)

## 2. Bulk add and bulk change

- [x] 2.1 `importSkills` (per-item results, skip/update, ≤100) and `POST /api/skills/bulk`
- [x] 2.2 `patchSkills` (allow-listed keys, per-item results, ≤100) and `PATCH /api/skills/bulk`
- [x] 2.3 `src/lib/skills/frontmatter.js` (`name`/`description`, quoted, folded, literal, CRLF, BOM) and `slugFromName`
- [x] 2.4 Tests for import, patch (body/slug/name ignored), same slug twice, limits, frontmatter, runtimes ← (verify: one bad item never blocks the others; bulk patch cannot touch a body)

## 3. Admin page

- [x] 3.1 List: search, status/internal filters, category filter, retry link, filtered-empty state with clear, row selection and bulk publish / hide / set agents
- [x] 3.2 Import modal: choose files, choose folder, drop, paste; editable rows; flags for empty / too large / duplicate / existing; shared agents, category, audience, publish, skip-or-update; per-row result
- [x] 3.4 Pure `importDrafts.js` (pick files, draft fields, problem flags) and `toggleRuntime` with tests in `test/skills-import-drafts.test.js`
- [x] 3.3 Editor modal: name, markdown, agents, published up front; the rest under "Tuỳ chọn thêm"; the last agent cannot be unticked ← (verify: UI follows `openspec/ui-dna.md`, every control has a label, keyboard operable)

## 4. Installer

- [x] 4.1 Catalogue lists the agents as a comma list
- [x] 4.2 Script installs into each supported agent present on the machine, falls back to the first agent, `--target` comma list / repeat, skips unsupported with a message, validates the agent list before writing
- [x] 4.3 Tests: both agents present, one present, none present, `--target` forms, unsupported target skipped, unknown target refused ← (verify: no stray directory for an agent the machine lacks)

## 5. Checks

- [x] 5.1 `npm test`, eslint on touched files, `next build`
- [x] 5.2 Independent verify findings fixed: update-mode import keeps visibility/agents/category; installer rejects unknown agents, `@` in the address, empty `--target`; null/empty visibility refused; bulk errors shown and selection pruned; folder import takes only `SKILL.md`; results map by row position; failed rows stay editable; description and sort order editable; drop of a folder supported
