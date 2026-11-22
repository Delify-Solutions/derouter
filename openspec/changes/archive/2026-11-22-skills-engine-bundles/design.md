## Context

See `proposal.md` for motivation. Current state, verified in this repository and in
`Delify-Solutions/rea_policy` (the one bundle that exists today):

- `src/lib/skills/engineTargets.js` hardcodes `ENGINE_REPO`, `ENGINE_TAG`,
  `ENGINE_TARBALL`, `ENGINE_BRIDGE_URL`, `ENGINE_HOME = "rt-claude"`. `ENGINE_TARGETS`
  (the 8-runtime `mcp`/`bridge`/`none` mode table) is correct and unrelated to any one
  bundle — it stays.
- `src/lib/skills/installScript.js`'s `engineShell()`/`buildInstallScript()` render
  those constants into the generated `install.sh`; `install_engine_source()` fetches
  and unpacks the tarball once, `install_engine()`/`register_mcp()` register the MCP
  server per supported runtime. None of this runs the source repository's own
  installer or touches its agents/command.
- `rea_policy`'s own `install.mjs` (read in full): no-argument run installs to
  `~/.claude` (`SCOPE = 'user'`); `--project` installs to `./.claude` instead; `--dry`
  previews without writing. It renders 40 skills, 6 agent presets and the `/rea`
  command from the engine's own `lib/store-core.js` prompts — logic specific to this
  one repository that derouter does not and should not reimplement.
- `skills` (`src/lib/db/schema.js`) is flat, one row per file, no grouping.

## Goals / Non-Goals

**Goals:**
- Make the engine source, its unpack location and its installer entrypoint data
  driven per bundle, so a second, unrelated bundle can exist without touching this code
  again.
- Deliver a bundle's agents/command on Claude Code by running its own installer, not
  by parsing or re-deriving its logic.
- Keep every existing standalone skill (no bundle) byte-for-byte unaffected.

**Non-Goals:**
- Generalizing agent/command delivery to runtimes that have no subagent concept
  (Codex, Cursor, …) — not possible without that runtime having an equivalent concept
  to deliver into.
- Supporting a bundle installer invoked with `--dir <path>` (a non-default install
  location). `rea_policy`'s own `--project` flag targets `./.claude` under the
  current working directory, which is not necessarily the `--dir` the customer gave
  derouter's own installer. Running a bundle's installer with mismatched target
  semantics would write agent files to the wrong place silently, which is worse than
  not running it: when `--dir` is given, the generated script skips the bundle
  installer step entirely and prints why.
- Any change to pricing, billing, or the cost columns.

## Decisions

**New `skillBundles` table, `skills.bundleId` nullable column — not a bundle-only
rewrite of `skills`.** A skill already has its own lifecycle (CRUD, audience,
publish state, categories, bulk patch) that has nothing to do with whether it came
from a bundle. Folding bundle fields directly onto `skills` would mean every
standalone skill carries NULL bundle columns forever and every bundle-aware query
has to re-derive "is this actually one bundle's rows" by matching on source repo
strings instead of an id. A separate table with an optional FK is the same shape
already used elsewhere in this schema for optional groupings and costs nothing for
rows that don't use it.

**Detach, not cascade, on bundle delete.** A skill is independently published,
categorized and potentially already relied on by customers; deleting its bundle (e.g.
because the admin is re-importing a reorganized version of the same repository) is
not a reason to make the skill disappear. The admin can delete the skills separately
if that is genuinely what they want.

**Engine detection stays a literal `lib/mcp-server.mjs` check.** A heuristic trying to
guess "this looks like an MCP server" from arbitrary JS would both false-positive
(any `lib/` with a `.js` file) and false-negative (a server entry named anything
else), and the admin always sees the import preview before committing, so a repo
that is a bundle in substance but fails the literal check still imports fine as
plain skills — the admin notices this and nothing is silently lost; it is simply not
offered bundle mode automatically for that one repository.

**Run the bundle's own installer rather than generalize its rendering.** Considered:
(a) have derouter parse a bundle's agent-prompt source and render presets itself —
rejected, this is bespoke per bundle (role names, counts, prompt shape all differ) and
would need new code for every future bundle; (b) ship only skills+MCP and never
attempt agents — rejected, it is the literal gap this change exists to close, and the
source repository already contains a working, deterministic way to produce them.
Running `node <entrypoint>` after unpacking the tarball is the one mechanism that
generalizes: any future bundle that ships its own installer gets the same treatment
for free, with no new code here.

**Unpack directory becomes `~/.engines/<bundle-slug>`.** The former fixed
`~/rt-claude` cannot serve two different bundles at once and was never deployed to
production, so there is no migration to carry forward.

## Risks / Trade-offs

- [Risk] Running a bundle's installer executes third-party code on the customer's
  machine beyond what `--engine` does today (today it only runs as a long-lived MCP
  server process). → Mitigation: this only happens for bundles the admin explicitly
  imported and published through the admin panel — the same trust boundary the engine
  tarball itself already crosses; the customer still opts in with the existing
  `--engine` flag; a failing installer is reported, never silently swallowed.
- [Risk] A bundle's installer could write outside the customer's Claude Code config in
  surprising ways. → Mitigation: out of scope to sandbox a third-party installer;
  this is the same trust decision the admin already made by importing and publishing
  the bundle, documented plainly in this design.
- [Risk] A badly-typed installer entrypoint path could be used to run an arbitrary
  file inside the unpacked tree. → Mitigation: validated as a relative path with no
  parent-directory segments at bundle save time (same convention as the existing
  `SAFE_PATH` check in `installScript.js`), and it only ever resolves inside that
  bundle's own unpack directory.

## Migration Plan

Additive only: new table, new nullable column, `SCHEMA_VERSION` 47 → 48 (triggers the
existing pre-migration backup, no custom migration script needed since nothing is
destructive). No existing customer has the former `--engine` flag in production, so
no rollout step is needed for the unpack-directory rename.
