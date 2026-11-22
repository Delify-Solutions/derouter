## Context

`npx skills add` (vercel-labs/skills, `src/agents.ts`, `src/installer.ts`) keeps one record
per agent — display name, project and global skills folder, how to detect it — and treats
agents that read `~/.agents/skills` as "universal". It copies a skill once into that
canonical folder and symlinks agent folders to it (falling back to a copy), with `--copy`
to opt out. It detects installed agents and only prompts when none is found.

## Decisions

- **A curated registry, not all ~75 agents.** A skill written to a folder the agent never
  reads is silently useless, so an entry is added only with a documented location.
  Locations come from the vercel table and each agent's own docs: `omp` reads
  `~/.omp/agent/skills` (oh-my-pi `discovery/builtin.ts`), `dsh` reads `~/.dsh/skills` or
  `$DSH_HOME/skills`. Codex stays at `~/.codex/skills` (where earlier installs already
  are) rather than moving to the shared folder.
- **"All" is `[]` in storage.** Storing today's ids would exclude every agent added later.
  `parseRuntimes` already read an empty list as every agent, so reads need no change; the
  write path normalises a full set to `[]`. `allAgents` is derived on read. The legacy
  `target` column keeps `generic` for such rows.
- **Migration 007** rewrites rows that hold exactly `claude, codex, cursor` — the only way
  to say "all" before — to `[]`. It is guarded for databases without the column.
- **Links only when they pay off.** One destination folder is a plain copy. Two or more
  different folders get a canonical copy under `~/.agents/skills` and links, so an update
  touches one place. A real folder at the destination is updated in place (it may hold the
  customer's own notes); a filesystem that cannot link gets a copy.
- **Generated shell, validated.** The id list and the two lookups are rendered from the
  registry after strict pattern checks (ids `[a-z]+`, paths `[A-Za-z0-9._/-]`, env
  `[A-Z0-9_]`), because the output runs on customers' machines.

## Risks

- A customer who installed a skill with the old installer has a real folder in
  `~/.claude/skills/<slug>`; it keeps working and is updated in place, but is not turned
  into a link.
- Agent folders move over time; a wrong entry is a one-line fix and the catalogue is
  unaffected.
- The canonical copy under `~/.agents/skills` is readable by every agent that scans that
  folder (Cline, Pi, Warp, and per the vercel table Codex, OpenCode and Gemini CLI too),
  not only the agents the skill was installed for. That is the cost of one shared copy;
  `--copy` avoids it. Codex may then see a skill both there and in `~/.codex/skills`.
- A link the customer made themselves, pointing elsewhere, is never re-pointed: its target
  folder is updated in place. Only the installer's own link (or a dangling one) is remade.
- OpenCode, Goose and Amp follow `$XDG_CONFIG_HOME`; the registry carries that so a
  customer who moved their config home is not written to a folder the agent ignores.
