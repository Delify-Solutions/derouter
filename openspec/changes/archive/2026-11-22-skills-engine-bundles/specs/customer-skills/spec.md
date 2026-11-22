## ADDED Requirements

### Requirement: Repository import detects an engine

When the admin imports skills from a repository URL, the system SHALL report whether
the repository contains an engine (a `lib/mcp-server.mjs` file) and, if so, whether it
has an installer entrypoint at `install.mjs`, and SHALL include the repository's
`README.md` text when present, before the admin commits to anything.

#### Scenario: Engine detected
- **WHEN** the imported repository contains `lib/mcp-server.mjs`
- **THEN** the import preview reports the engine as detected and offers to import as a bundle

#### Scenario: Plain skill repository
- **WHEN** the imported repository has no `lib/mcp-server.mjs`
- **THEN** the import preview behaves exactly as it did before this capability existed

### Requirement: Admin imports a repository as one bundle

When an import's repository is detected as an engine, the admin SHALL be able to create
one bundle from it, with its description and usage guide prefilled from the repository's
README and editable, and the admin's chosen skill files SHALL be imported linked to that
bundle in the same action. The admin MAY decline bundle mode and import the chosen files
as standalone skills instead.

#### Scenario: Bundle import
- **WHEN** the admin confirms bundle mode for a detected-engine repository
- **THEN** one bundle is created and every imported skill from that repository is linked to it

### Requirement: Install script delivers a bundle's engine per bundle

The generated install script's engine step SHALL be driven by each bundle the customer
has access to, rather than a single fixed source, and SHALL support a customer having
skills from more than one bundle at once, each unpacked to its own location.

#### Scenario: Two bundles
- **WHEN** a customer has published skills from two different bundles
- **THEN** installing with the engine flag fetches and registers both engines independently

### Requirement: Claude Code also receives the bundle's own installer

For the Claude Code runtime only, after a bundle's engine is unpacked, the install
script SHALL run that bundle's installer entrypoint if present in the unpacked tree.
A missing entrypoint SHALL be skipped without error; an entrypoint that exits with a
failure SHALL produce a warning without stopping the rest of the install. For every
other runtime, the installer SHALL NOT be run, and the script SHALL state that
agent/command files are a Claude Code concept and were skipped for that runtime.

#### Scenario: Installer succeeds
- **WHEN** installing a bundle's engine for Claude Code and its installer entrypoint exits successfully
- **THEN** the files that entrypoint produces (its agent presets and orchestrating command) are present afterward

#### Scenario: Installer fails
- **WHEN** a bundle's installer entrypoint exits with a non-zero status
- **THEN** the script prints a warning and the rest of the install (skills, MCP registration) still completes

#### Scenario: Non-Claude-Code runtime
- **WHEN** installing a bundle's engine for Codex
- **THEN** the skill and MCP registration are delivered, no installer is run, and the output states why
