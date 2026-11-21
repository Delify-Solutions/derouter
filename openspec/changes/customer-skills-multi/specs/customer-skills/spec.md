## MODIFIED Requirements

### Requirement: Admin publishes a skill

`/dashboard/customer-skills` SHALL list every skill the operator has with its name,
slug, the agents it installs into, download count and last-updated date, and SHALL
show a published / draft / internal badge on each row. The page SHALL offer a text
search over name, slug, summary and category, filters for all, published, draft and
internal rows, and a filter by category. A load failure SHALL show an error with a
retry control, and an empty result SHALL say whether there are no skills or no skills
matching the filters, with a control that clears the filters.

A skill SHALL carry a non-empty list of agents it installs into, chosen from Claude
Code, Codex and Cursor. A payload naming no agent, or the legacy value `generic`,
SHALL mean every agent. An unknown agent SHALL be refused. The directory shown to the
customer for each agent SHALL be derived from the agent and the slug; there SHALL be
no free-text install path.

The page SHALL let an admin create and edit one skill in a modal whose primary
fields are name (required, ≤120 characters), the markdown body (required, ≤512 KB of
UTF-8) and the agents, with a published flag, and whose secondary fields (slug,
summary, description, usage notes, category, audience, version, file name, sort
order) are in a collapsed section. The slug SHALL be derived from the name while the
admin has not typed one. All limits and rules of the previous behaviour (typed slug
validated as typed, ASCII `.md` file name, limits refused not truncated) SHALL still
apply.

An admin SHALL be able to hide a published skill and publish a draft without opening
the form, and SHALL be able to delete a skill after a confirmation stating that
customers who already downloaded a copy keep their file.

#### Scenario: One skill for several agents
- **WHEN** an admin saves a skill with Claude Code and Cursor checked
- **THEN** the list shows both agent tags, the customer card shows both install directories, and the catalogue endpoint lists `claude,cursor` for it

#### Scenario: No agent named
- **WHEN** a payload names no agent, or only `generic`
- **THEN** the skill is stored for every agent

#### Scenario: Last agent cannot be unticked
- **WHEN** one agent is checked and the admin unticks it
- **THEN** it stays checked

### Requirement: Admin adds and changes many skills at once

The page SHALL let an admin add several skills in one operation by choosing several
`.md` files, choosing a whole folder, dropping files, or pasting one skill. Each file
SHALL become a row with an editable name, slug and short description prefilled from
the file's frontmatter (`name`, `description`); a file named `SKILL.md` inside a
folder SHALL take the folder's name as slug. A row SHALL be flagged when its file is
empty, larger than 512 KB, or its slug is already used by another row or an existing
skill. The admin SHALL choose, for all chosen rows, the agents, the category, the
audience, whether to publish, and whether an existing slug is skipped or has its
content updated. A single request SHALL create the rows (at most 100), and the page
SHALL show the outcome of each row: added, updated, skipped, or the reason it failed.
One failing row SHALL NOT prevent the others from being saved.

`POST /api/skills/bulk` SHALL validate every item exactly as a single create and
return a result per item. `PATCH /api/skills/bulk` SHALL apply a change to the
listed skills and SHALL accept only agents, published flag, audience and category;
it SHALL NOT change a body, name or slug. Selecting rows on the list SHALL offer
publish, hide and "set agents" for the selection.

#### Scenario: Dropping a skills folder
- **WHEN** an admin chooses or drops a folder with `rt-recon/SKILL.md`, `rt-recon/README.md`, `rt-exploit/SKILL.md` and `notes.txt`
- **THEN** two rows are listed with slugs `rt-recon` and `rt-exploit` and names from their frontmatter, the page says how many other files were ignored, and after confirming both are created for the chosen agents

#### Scenario: One bad file
- **WHEN** one of ten chosen files is empty
- **THEN** it is flagged and left out, and the other nine are created

#### Scenario: Fixing a failed row
- **WHEN** a submitted row failed or was skipped
- **THEN** it stays in the list, still editable, showing its own outcome, rows that were added are locked, and the admin can correct the failed rows and submit again without choosing the files again

#### Scenario: Two rows with the same slug
- **WHEN** two chosen rows share a slug
- **THEN** each row shows its own outcome (the first added, the second skipped) and the summary counts both

#### Scenario: Slug already exists
- **WHEN** a row's slug matches an existing skill and the admin chose "skip"
- **THEN** that row is reported as skipped and the existing skill is unchanged

#### Scenario: Updating an existing skill keeps its settings
- **WHEN** the admin chose "update" for a row whose slug matches an internal, unpublished skill restricted to Codex, and the shared panel says customer, published, all agents
- **THEN** only the skill's body (and its name and summary, when the file carries them) change; it stays internal, unpublished, Codex-only, and keeps its category

#### Scenario: A visibility value that is null or empty
- **WHEN** a change names `isPublished` or `audience` as null or an empty string
- **THEN** it is refused for that skill and the skill's visibility is unchanged

#### Scenario: Bulk re-target
- **WHEN** an admin selects five skills and sets their agents to Codex only
- **THEN** all five list only Codex, and none of their bodies, names or slugs changed

### Requirement: One-line installer

The server SHALL serve a POSIX shell script at `GET /api/public/skills/install.sh`
without authentication. The script SHALL contain no secret and SHALL depend only on
`curl`. It SHALL read the customer's API key from the `DEROUTER_KEY` environment
variable, or ask for it without echo when a terminal is available, and SHALL send
it only as an `Authorization: Bearer` header supplied to curl on standard input,
never on a command line.

The script SHALL support `--all`, `--list`, one or more skill slugs, `--target`
(`claude`, `codex`, `cursor`; a comma list or repeated), `--dir` and `--url`. Without
`--all` or a slug it SHALL only list the catalogue. By default a skill SHALL be
written to `<agent skills directory>/<slug>/<fileName>` for **each agent the skill
supports whose home folder exists on this machine**, creating the directory. When a
skill supports none of the agents present, it SHALL be installed for the skill's
first agent and the script SHALL say so. With `--target`, a skill SHALL be installed
only for the named agents it supports, a skill supporting none of them SHALL be
skipped with a message, and an unknown agent name SHALL be refused. A skill already
installed SHALL be overwritten when its content differs and left alone when it does
not, and the script SHALL say which happened for each agent.

`GET /api/public/skills/catalog` and `GET /api/public/skills/file/{slug}` SHALL
answer only a request carrying an active customer API key whose owner is active and
whose key has not expired; any other request (no key, unknown key, admin key,
suspended owner, expired key, key in the query string) SHALL receive HTTP 401 with
one generic message. The catalogue SHALL list only published, customer-audience
skills as tab-separated `slug`, `fileName`, `version`, `agents` (comma list), `name`
lines, an empty version written as `-`. The file endpoint SHALL return the stored
body unchanged, answer 404 for an unpublished or internal skill, and count the
download. Both endpoints SHALL be subject to the same per-address limit on unknown
keys as the public usage endpoint.

Before writing anything, the script SHALL check every slug, file name and agent list
in the catalogue against the allowed shape — every agent in the list SHALL be one the
script knows, with no empty element — and stop without writing when any entry does
not match. It SHALL refuse a server address containing `@`, and an empty `--target`. It SHALL send the key only to an `https://` address or to this
machine (`localhost`, `127.0.0.1`, `[::1]`), and the catalogue SHALL strip control
characters from the fields it returns. The customer-facing skill views SHALL NOT
include the admin identity that published a skill. The key SHALL be read with the
same extractor the request guard uses (headers only), so the unknown-key throttle
counts exactly the keys these endpoints try.

#### Scenario: Skill for two agents, both installed
- **WHEN** a skill supports Claude Code and Cursor and both `~/.claude` and `~/.cursor` exist
- **THEN** the skill is written under both agents' skills directories, and not under Codex even if `~/.codex` exists

#### Scenario: Only one supported agent present
- **WHEN** that skill is installed on a machine with only `~/.cursor`
- **THEN** it is written under Cursor only, and `~/.claude` is not created

#### Scenario: No supported agent present
- **WHEN** a Codex-only skill is installed on a machine with no agent folders
- **THEN** it is written under Codex's skills directory and the script says no agent was found

#### Scenario: Target the skill does not support
- **WHEN** `--target codex` is given for a skill that supports Claude Code and Cursor
- **THEN** that skill is skipped with a message and nothing is written for it

#### Scenario: Installing everything
- **WHEN** a customer runs the command with a valid key and `--all` on a machine with no skills installed
- **THEN** each published customer skill is written for its agents, an internal or draft skill is not, and the script ends by telling the customer to reopen the agent session

#### Scenario: Running it again
- **WHEN** the same command is run twice without any skill changing
- **THEN** the second run reports every skill as already current and rewrites nothing; after the admin edits a body, the next run reports that skill as updated and the file holds the new text

#### Scenario: Wrong or unusable key
- **WHEN** the key is unknown, belongs to an admin, belongs to a suspended customer, or is passed in the URL
- **THEN** the endpoints answer HTTP 401, the script exits non-zero with a message that the key is not valid, and nothing is written

#### Scenario: A hostile server response
- **WHEN** the catalogue names a slug, file name or agent list such as `../escaped`, `/etc/passwd` or `.hidden`, on any line, even after valid lines
- **THEN** the script exits non-zero before writing anything

#### Scenario: An agent the script does not know
- **WHEN** the catalogue lists the agent `ssh`, `foo` or `,claude` for a skill
- **THEN** the script exits non-zero before writing anything and creates no `~/.ssh`, `~/.foo` or `~/skills` directory

#### Scenario: A server address that hides another host
- **WHEN** the script's address is `http://127.0.0.1:1@evil.example`
- **THEN** it exits non-zero before contacting any server, and the key is not sent

#### Scenario: Plain-http server address
- **WHEN** the script's address is `http://skills.example.com` or `http://127.0.0.1.evil.com`
- **THEN** it exits non-zero before contacting the server, and the key is not sent

#### Scenario: Script served without a usable origin
- **WHEN** the server cannot determine a public origin
- **THEN** the script still downloads and requires `--url` (or `DEROUTER_URL`) rather than guessing
