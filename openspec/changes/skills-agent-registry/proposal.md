## Why

Skills could only be installed into three agents (Claude Code, Codex, Cursor). Customers
use many more — `omp` (Oh My Pi), `dsh` (DeepSeek Harness), OpenCode, Gemini CLI, Cline,
Windsurf and others — and the installer refused any agent it did not know. The
`vercel-labs/skills` CLI (`npx skills add`) handles ~75 agents with one table of
directories, one shared `.agents/skills` folder, and symlinks; this change brings the
same model here.

## What Changes

- **Agent registry**: `src/lib/skills/runtimes.js` becomes a table of 26 agents with the
  folder that marks an agent as installed, an optional environment override
  (`CLAUDE_CONFIG_DIR`, `DSH_HOME`) and the folder it reads skills from. The shell
  installer is generated from the same table, so the two cannot drift.
- **"Every agent" is the default and follows the registry**: a skill for all agents is
  stored as an empty `targets` list (not today's ids), so an agent added later is
  covered without re-saving every skill. The catalogue sends `all`. Migration 007
  turns rows that held exactly the original three agents into "all"; real subsets stay.
- **Installer**: agents that read one folder (`~/.agents/skills`: Cline, Pi, Warp)
  share one write. A skill going to several different folders is written once to
  `~/.agents/skills/<slug>` and the other agents link to it; `--copy` writes each folder
  separately. A real folder left by an earlier install is updated in place, never
  replaced by a link. `--target` accepts every registered agent id.
- **Admin picker**: "Mọi agent" (default) or "Chọn agent" with a checkbox per agent.
- **Customer page**: a skill shows "Mọi agent" or its agent tags, and one install path
  chosen from a list of the agents it supports instead of a path per agent.

## Capabilities

### Modified Capabilities
- `customer-skills`: agent registry, "all agents" stored as an empty list, shared-copy
  installer, `--copy`, and the admin and customer pickers.

## Impact

- `src/lib/skills/{runtimes,installScript}.js`, `src/lib/db/repos/skillsRepo.js`,
  `src/lib/db/schema.js` (v47), `src/lib/db/migrations/007-skills-all-agents.js`
- `src/app/api/public/skills/catalog/route.js`
- `src/app/(dashboard)/dashboard/customer-skills/{RuntimePicker,SkillsAdminPageClient}.js`,
  `src/app/account/skills/SkillsPageClient.js`
- `test/skills.test.js`, `test/skills-install.test.js`, `test/skills-frontmatter.test.js`,
  `test/skills-import-drafts.test.js`
