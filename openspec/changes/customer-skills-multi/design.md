## Decisions

**`targets` is a JSON array column, `target` stays.** The new column is the source
of truth; `target` keeps the first agent so v45 rows and any reader of the old column
still work, and a v45 row with no `targets` reads as `[target]`. The additive schema
sync adds the column; no destructive migration. `installPath` is no longer read or
written; the column stays because dropping it needs a versioned migration.

**"No agent named" means every agent.** An empty or unusable list, and the legacy
`generic`, resolve to all agents rather than to none, so a skill can never become
uninstallable by an empty selection. The pickers keep at least one agent checked.

**Install where the agent is.** Installing into `~/.cursor/skills` on a machine
without Cursor creates a stray directory and tells the customer nothing. The script
therefore installs into the agents the skill supports **that exist on the machine**
(their home folder is there). A machine with none still gets the skill, in the
skill's first agent's directory, with a line saying so. `--target` is explicit and
bypasses the presence check; a skill that does not support the target is skipped
with a message instead of installed somewhere it was not meant for.

**Bulk is per item, never all-or-nothing.** `importSkills` and `patchSkills` apply
each item on its own and return a result per item. One bad file in forty must not
discard the other thirty-nine, and the admin needs to see which failed and why.
Bulk change is allow-listed to `targets`, `isPublished`, `audience`, `category`: a
bulk action can never rewrite a body, name or slug. Both are capped at 100 items per
request.

**Import reads in the browser, validates on the server.** Files are read client-side
(`File.text()`), the frontmatter is parsed there for the preview, and the server
re-validates every field exactly as for a single create. A file inside a folder takes
the folder name as slug (it is the directory the customer's agent will see); a loose
file takes its frontmatter name, then its file name.

**The frontmatter reader is deliberately small.** It reads `name` and `description`
(plain, quoted, folded `>` and literal `|`) and nothing else; a value it cannot read
stays empty and the admin types it. The file's text is stored whole, frontmatter
included.

## Risks

- A browser without `webkitdirectory` (old Firefox mobile) can only pick files; the
  folder button then behaves like the file picker.
- Selecting rows is by id and not by filter, so "select all" means the rows currently
  shown, not every skill; the control says so.
