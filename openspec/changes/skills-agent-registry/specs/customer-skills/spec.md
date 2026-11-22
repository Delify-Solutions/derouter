## ADDED Requirements

### Requirement: Skills install into any registered agent

The system SHALL keep one registry of the agents a skill can be installed into, each with
the folder that marks the agent as present on a machine, an optional environment variable
that moves that folder, and the folder it reads skills from. The registry SHALL include
Claude Code, Codex, Cursor, omp, dsh, OpenCode, Gemini CLI, GitHub Copilot, Windsurf,
Droid, Kilo Code, Roo Code, Trae, Qwen Code, Goose, Kiro CLI, Junie, Qoder, Continue, Antigravity,
Antigravity CLI, ZCode, Amp, Cline, Pi and Warp. The installer script SHALL be generated from this registry and SHALL
accept every registered agent id in `--target`, refusing any other.

#### Scenario: omp and dsh
- **WHEN** a skill for omp and dsh is installed on a machine that has `~/.omp` and `~/.dsh`
- **THEN** it is available under `~/.omp/agent/skills/<slug>` and `~/.dsh/skills/<slug>`, and `DSH_HOME` replaces `~/.dsh` for both detection and the skills folder

#### Scenario: Unknown agent
- **WHEN** `--target vim` is given
- **THEN** the installer stops before writing anything and lists the agent ids it knows

### Requirement: A skill for every agent follows the registry

A skill for every agent SHALL be stored as an empty `targets` list, so an agent added to
the registry later is covered without saving the skill again. Naming every registered
agent SHALL be stored the same way. The catalogue endpoint SHALL send `all` in the agents
column for such a skill. A database migration SHALL rewrite rows holding exactly Claude
Code, Codex and Cursor to the empty list and SHALL leave any other list unchanged.

#### Scenario: Registry grows
- **WHEN** a skill saved for all agents exists and a new agent is added to the registry
- **THEN** the catalogue still says `all` and the installer offers the skill to the new agent

#### Scenario: Subset stays a subset
- **WHEN** a skill is saved for omp and dsh only
- **THEN** it is stored as that list and the customer sees only those two agents

### Requirement: Installer shares one copy across agents

When a skill is installed for several agents, agents that read the same folder SHALL share
one write. When it goes to two or more different folders the installer SHALL write one
canonical copy to `~/.agents/skills/<slug>` and link the other folders to it, and `--copy`
SHALL write each folder separately instead. A real folder already at a destination SHALL
be updated in place and not replaced by a link, and a failed link SHALL fall back to a copy.
Installing for a single folder SHALL write that folder directly.

#### Scenario: Two agents
- **WHEN** a skill for Claude Code and Cursor is installed on a machine with both
- **THEN** one copy exists under `~/.agents/skills/<slug>` and each agent folder links to it

#### Scenario: Earlier install
- **WHEN** `~/.claude/skills/<slug>` is a real folder with an extra file of the customer's
- **THEN** its `SKILL.md` is updated and the extra file is still there

### Requirement: Agent choice in the admin and customer pages

The admin picker SHALL offer "Mọi agent" as the default and "Chọn agent" with one checkbox
per registered agent, never allowing zero agents. The customer card SHALL show "Mọi agent"
or the agent tags, and one install path chosen from a list of the agents the skill supports.

#### Scenario: Customer picks an agent
- **WHEN** a customer opens a skill for all agents and selects omp
- **THEN** the card shows `~/.omp/agent/skills/<slug>/`
