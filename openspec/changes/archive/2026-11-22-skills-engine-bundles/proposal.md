## Why

A skill a customer downloads from the catalogue can call tools that only exist in a
separate MCP server ("engine") — `--engine` (shipped in a prior change) fetches that
engine and registers it per agent, but it is wired to one hardcoded source repository
and never delivers the agents or slash command that repository's own installer
produces. The admin's "Nhập từ repo" import, separately, only ever reads markdown and
has no idea an imported skill set might need an engine at all. The two mechanisms
happen to work together today only because they coincidentally point at the same
repository. A customer who installs via derouter gets skills and a working MCP server,
but not the agent presets or orchestrating command the source repository ships —
specifically because those are produced by that repository's own install script, which
derouter's installer never runs.

## What Changes

- Add a `skillBundles` entity: one row per imported "repo that ships an engine",
  carrying an admin-written description and usage guide (prefilled from the
  repository's README at import time), the source repository reference, and the path
  to that repository's own installer entrypoint.
- `skills` rows gain an optional link to the bundle they came from; a skill imported
  without a bundle behaves exactly as before.
- "Nhập từ repo" detects an engine (`lib/mcp-server.mjs` present in the repository
  tree) and offers to import the whole thing as one bundle instead of loose skill
  rows.
- The generated install script's engine step becomes data-driven per bundle instead of
  reading one hardcoded repository, and supports more than one bundle at once.
  **BREAKING**: the engine's default unpack directory moves from the fixed `~/rt-claude`
  to a per-bundle `~/.engines/<slug>` — acceptable because the prior `--engine` flag has
  not been deployed to production yet.
- For the Claude Code runtime specifically, after the engine is unpacked, the install
  script now also runs the bundle's own installer entrypoint (default `install.mjs`),
  which is what actually produces that repository's agent presets and orchestrating
  command — derouter never reimplements that rendering itself. Other runtimes
  (Codex, Cursor, …) still receive skills and the MCP registration only, with an
  explicit note that agent/command files are a Claude Code concept.
- The customer skills page replaces its one generic paragraph about the engine with
  per-bundle rendering: each bundle's own description, usage guide, and install
  command.
- The admin skills page gains a bundle list/detail view alongside the existing
  skill list.

## Capabilities

### New Capabilities
- `skill-bundles`: the bundle entity itself — its fields, its lifecycle (create via
  repo import, edit, delete-detaches-not-cascades), and how a bundle's skills and
  engine are presented together to a customer.

### Modified Capabilities
- `customer-skills`: "Nhập từ repo" gains engine detection and bundle-mode import;
  the generated install script's engine step becomes bundle-data-driven, supports
  multiple bundles, and (Claude Code only) runs the bundle's own installer entrypoint
  after unpacking the engine.

## Impact

- **Schema**: new `skillBundles` table; new nullable `bundleId` column on `skills`.
  `SCHEMA_VERSION` 47 → 48. Purely additive — no destructive migration.
- **Code**: `src/lib/db/repos/skillBundlesRepo.js` (new), `src/lib/db/repos/skillsRepo.js`,
  `src/lib/skills/repoImport.js`, `src/app/api/skills/import-repo/route.js`,
  `src/app/api/skills/bundles/route.js` (new), `src/lib/skills/engineTargets.js`,
  `src/lib/skills/installScript.js`,
  `src/app/(dashboard)/dashboard/customer-skills/RepoImportModal.js`,
  `src/app/(dashboard)/dashboard/customer-skills/SkillsAdminPageClient.js`,
  `src/app/account/skills/SkillsPageClient.js`.
- **Tests**: new `test/skill-bundles.test.js`; updates to `test/skill-repo-import.test.js`,
  `test/skills-install.test.js`, `test/skills.test.js`.
- **Out of scope**: reimplementing a bundle's bespoke agent-rendering logic generically
  inside derouter (only ever exec the bundle's own installer); billing/pricing;
  the separately-paused translation of one bundle's skill docs; the existing 8-runtime
  mcp/bridge/none mode table, which is unchanged.
