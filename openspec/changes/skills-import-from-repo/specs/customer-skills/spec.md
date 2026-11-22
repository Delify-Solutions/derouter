## ADDED Requirements

### Requirement: Admin imports skills from a repository URL

The admin page SHALL offer an import that takes a GitHub, GitLab or Codeberg repository
URL, optionally narrowed to a folder, and SHALL list the skills found there for review
before anything is written. The read endpoint SHALL require the admin session and SHALL
write nothing; the chosen rows SHALL be created through the existing bulk import with its
per-row results. Each `SKILL.md` SHALL take its folder's name as slug and a loose markdown
file its file name; other markdown inside a folder that holds a `SKILL.md`, and
repository documents at the top level, SHALL NOT be offered as skills. A row that failed
to download, is empty or over 512 KB, or looks like a repository document SHALL be listed
with the reason and unticked. At most 100 files SHALL be read per import. Private
repositories SHALL be refused with a message that says the repository must be public.

#### Scenario: A folder link
- **WHEN** the admin pastes `https://github.com/owner/repo/tree/main/skills/redteam`
- **THEN** only skills under `skills/redteam` are listed and nothing is created until the admin confirms

#### Scenario: Supporting files
- **WHEN** a repository has `skills/alpha/SKILL.md` and `skills/alpha/README.md`
- **THEN** one skill, `alpha`, is offered

#### Scenario: Hostile link
- **WHEN** the URL has a malformed escape or an owner containing `..` or an encoded slash
- **THEN** the request is refused with a 400 and no host request is made

#### Scenario: Rate limited host
- **WHEN** the host answers 403 or 429
- **THEN** the admin sees a message to wait and retry, not a server error
