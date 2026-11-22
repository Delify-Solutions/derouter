## Purpose

A skill bundle groups the skills, engine (MCP server) and install-time setup that came
from one imported repository, so a customer installs and understands them as one thing
instead of a set of unrelated rows that happen to share a dependency.

## ADDED Requirements

### Requirement: Skill bundle entity

The system SHALL store a skill bundle with: a unique slug, a name, an admin-written
description, an admin-written usage guide describing which skill to use for which
situation, the source repository (host, owner, repository, ref), and the path to that
repository's own installer entrypoint. A bundle SHALL have the same audience,
publication and ordering fields as a standalone skill.

#### Scenario: Minimal bundle
- **WHEN** a bundle is created with only the required fields
- **THEN** it is stored with an empty description and usage guide, visible to the admin and not yet published to customers

### Requirement: A skill may belong to one bundle

A skill row SHALL carry an optional link to the bundle it was imported from. A skill
with no bundle SHALL behave exactly as a skill always has: its installation, display and
lifecycle are unaffected by this capability existing.

#### Scenario: Standalone skill unaffected
- **WHEN** a skill was created before this capability existed, or is created without a bundle
- **THEN** its behavior is unchanged

### Requirement: Deleting a bundle detaches its skills

Deleting a bundle SHALL clear the bundle link on every skill that pointed to it and
SHALL NOT delete those skills.

#### Scenario: Bundle removed, skills remain
- **WHEN** an admin deletes a bundle that has three linked skills
- **THEN** the bundle is gone and the three skills still exist, now with no bundle

### Requirement: Installer entrypoint path is validated

A bundle's installer entrypoint SHALL be a relative path inside the repository with no
parent-directory segments and no leading slash; a path that would escape the
unpacked repository SHALL be refused with an error naming the problem.

#### Scenario: Path traversal attempt
- **WHEN** an admin sets the installer entrypoint to `../../etc/passwd`
- **THEN** saving the bundle is refused

### Requirement: Customer sees a bundle as one unit

A customer with access to a published bundle's skills SHALL see the bundle's
description, usage guide, and a single combined install command, instead of one
generic paragraph shared by every skill regardless of whether it needs an engine.

#### Scenario: Bundle with skills installed
- **WHEN** a customer opens the skills page and has access to a published bundle
- **THEN** the bundle's own description, usage guide and install command are shown next to its skills
