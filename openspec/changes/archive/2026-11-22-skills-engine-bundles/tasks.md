## 1. Schema

- [x] 1.1 Add `skillBundles` table to `src/lib/db/schema.js` (TABLES): id, slug, name,
      description, usageGuide, sourceHost, sourceOwner, sourceRepo, sourceRef,
      installerEntrypoint, audience, isPublished, sortOrder, createdBy, createdAt,
      updatedAt. Add indexes mirroring `skills` (slug unique, listed, category if used).
- [x] 1.2 Add nullable `bundleId TEXT` column to the `skills` table definition.
- [x] 1.3 Bump `SCHEMA_VERSION` 47 → 48, with a comment explaining the addition ← (verify: additive sync creates the table and column with no destructive migration file; a fresh DB and an upgraded existing DB both end up with the same shape)

## 2. Bundle repository

- [x] 2.1 Create `src/lib/db/repos/skillBundlesRepo.js` mirroring `src/lib/db/repos/skillsRepo.js`'s
      conventions: MAX_* constants, `normalize()`, Vietnamese validation messages,
      slug uniqueness, `createBundle`/`updateBundle`/`listBundles`/`getBundleBySlug`/
      `getBundleById`/`deleteBundle`.
- [x] 2.2 `installerEntrypoint` validation: relative path, no leading slash, no `..`
      segment (reuse or mirror the `SAFE_PATH` convention from `installScript.js`) —
      refuse with a named error otherwise.
- [x] 2.3 `deleteBundle` sets `bundleId = NULL` on every skill row pointing at it before
      deleting the bundle row itself (detach, not cascade) ← (verify: a bundle with linked skills, deleted, leaves those skills intact and unlinked — test this exact scenario)
- [x] 2.4 Add `bundleId` to `src/lib/db/repos/skillsRepo.js`'s `normalize()`, `rowToSkill()`,
      `createSkill` and `updateSkill` (optional, defaults to unchanged/null, never
      required).

## 3. Repository import detects an engine

- [x] 3.1 In `src/lib/skills/repoImport.js` (or the route), after `fetchTree`, check
      whether `lib/mcp-server.mjs` and root-level `install.mjs` are present in the
      returned file list, and whether a root-level `README.md` is present (read its
      text via the existing `fetchFile`).
- [x] 3.2 `POST /api/skills/import-repo` response gains
      `engine: { detected: boolean, installerEntrypoint: string|null, readme: string|null }`.
- [x] 3.3 Add `POST /api/skills/bundles` (create) and the matching update/delete routes,
      calling the new repo functions, following the existing `/api/skills/bulk` route's
      error-shape conventions.

## 4. Admin UI

- [x] 4.1 `RepoImportModal.js`: show "Nhập dạng bundle (kèm engine)" checkbox, default
      checked when `engine.detected`, hidden/disabled otherwise; when checked, show
      bundle name/description (prefilled from `readme`)/usage guide/installer
      entrypoint (prefilled from `engine.installerEntrypoint`) fields, editable before
      confirming.
- [x] 4.2 Confirming in bundle mode creates the bundle via `POST /api/skills/bundles`
      then imports the picked files via the existing bulk endpoint with `bundleId` set
      on each item; confirming without bundle mode behaves exactly as today ← (verify: declining bundle mode on a detected-engine repo still imports plain standalone skills, unchanged from before this feature)
- [x] 4.3 Add a bundle list/detail view in `src/app/(dashboard)/dashboard/customer-skills/`
      (extend `SkillsAdminPageClient.js` or a small new component) so an admin can see,
      edit and delete bundles after import.

## 5. Engine delivery becomes bundle-driven

- [x] 5.1 `src/lib/skills/engineTargets.js`: remove or demote the hardcoded
      `ENGINE_REPO`/`ENGINE_TAG`/`ENGINE_TARBALL`/`ENGINE_BRIDGE_URL`/`ENGINE_HOME`
      constants; keep `ENGINE_TARGETS` (the 8-runtime mcp/bridge/none table) unchanged.
      Unpack directory convention becomes `~/.engines/<bundle-slug>`.
- [x] 5.2 `src/lib/skills/installScript.js`'s `engineShell()`/`buildInstallScript()`
      take bundle data (repo/ref/tarball URL/installer entrypoint/slug) as a parameter
      and render one engine block per bundle a customer has access to (supports N
      bundles, not just one).
- [x] 5.3 After `install_engine_source` unpacks a bundle's tarball: if the runtime is
      Claude Code, the overall install target is the default `$HOME` (not a custom
      `--dir`), and the bundle's `installerEntrypoint` file exists in the unpacked
      tree, run `node "$e_node" "$e_root/<entrypoint>"` (no extra flags — matches that
      installer's own default "user scope" behavior). Missing entrypoint: skip
      silently. Non-zero exit: print a Vietnamese warning in the existing
      `printf 'engine [%s]: ...'` style and continue — do not abort the rest of the
      script. When `--dir` was given, skip this step and print why ← (verify: skills + MCP registration still complete even when the bundle installer step fails or is skipped)
- [x] 5.4 For every runtime in `ENGINE_MCP`/`ENGINE_BRIDGE` other than Claude Code,
      never attempt to run the installer; print one Vietnamese line stating agent/
      command files are a Claude Code concept and were skipped for that runtime.

## 6. Customer-facing page

- [x] 6.1 `src/app/account/skills/SkillsPageClient.js`: replace the static generic
      engine paragraph with per-bundle rendering — each bundle the customer has access
      to shows its description, usage guide and one combined install command.

## 7. Tests

- [x] 7.1 New `test/skill-bundles.test.js`: `skillBundlesRepo` CRUD, slug uniqueness,
      `installerEntrypoint` path validation (rejects traversal), detach-on-delete.
- [x] 7.2 Update `test/skill-repo-import.test.js` for the new `engine.detected`/
      `installerEntrypoint`/`readme` fields (repo with and without `lib/mcp-server.mjs`).
- [x] 7.3 Update `test/skills-install.test.js` for bundle-data-driven engine rendering,
      the conditional installer-execution step (present/absent/failing entrypoint),
      the multi-bundle case, and the non-Claude-Code skip note.
- [x] 7.4 Update `test/skills.test.js` if shared fixtures are affected by the new
      `bundleId` field.
- [x] 7.5 Run `npm run lint`, `npm test`, `npm run build` and confirm all pass ← (verify: full suite green, no regressions in existing skills/runtime tests)
