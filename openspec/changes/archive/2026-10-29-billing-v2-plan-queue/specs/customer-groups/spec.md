## Purpose

Guarantees that every customer account belongs to exactly one active group at all times, defines how the default group for new accounts is chosen, and prevents the admin from deleting or disabling a group that customers still depend on.

## ADDED Requirements

### Requirement: An active group always exists
On every start, if no active group exists, the system SHALL create a group named `Mặc định` with no model allow-list and no RPM/TPM/budget limits, and SHALL set it as the default customer group.

#### Scenario: Fresh install
- **WHEN** the server starts with an empty `keyGroups` table
- **THEN** a group `Mặc định` exists afterwards and the setting `defaultUserGroupId` holds its id

### Requirement: Every customer has exactly one active group
Registration and admin account creation SHALL assign the default group. On every start, any user whose group is empty, unknown or inactive SHALL be reassigned to the default group and an audit entry `group_auto_assigned` with actor `system` SHALL be written for each reassigned user.

#### Scenario: Ungrouped legacy user repaired
- **WHEN** the server starts and user U has `groupId = NULL`
- **THEN** U belongs to the default group and U's audit log contains `group_auto_assigned`

### Requirement: The default group is always an active group
The `defaultUserGroupId` setting SHALL only accept the id of an existing active group; any other value SHALL be rejected with HTTP 400 and the setting left unchanged. When the setting is empty or invalid at read time, the default group SHALL be the oldest active group.

#### Scenario: Inactive group rejected as default
- **WHEN** an admin saves settings with `defaultUserGroupId` pointing to an inactive group
- **THEN** the response is HTTP 400 and the previous default stays in effect

#### Scenario: Fallback skips inactive groups
- **WHEN** the setting is empty, the oldest group is inactive and the second-oldest is active
- **THEN** new registrations receive the second-oldest group

### Requirement: Groups in use are protected
`DELETE /api/groups/[id]` and a `PATCH /api/groups/[id]` that sets `isActive` to false SHALL be rejected with HTTP 409 and body `{ error, memberCount, isDefault }` when the group still has at least one user, is the default group, or is the last active group. The groups admin page SHALL show each group's member count and a `Mặc định` badge on the default group, and SHALL display the 409 message with a link to the users list filtered by that group.

#### Scenario: Deleting a group with members
- **WHEN** an admin deletes a group that 12 users belong to
- **THEN** the response is HTTP 409 with `memberCount: 12` and the group still exists

#### Scenario: Deleting an empty non-default group
- **WHEN** an admin deletes an active group with no users that is not the default and another active group exists
- **THEN** the group is deleted and admin keys that pointed to it lose their group as today

### Requirement: A user's group can only be changed to an active group
`PATCH /api/users/[id]` with `groupId` SHALL accept only the id of an active group; an empty value or an unknown or inactive id SHALL be rejected with HTTP 400. The change SHALL take effect on the user's next API request.

#### Scenario: Clearing a group is refused
- **WHEN** an admin sends `groupId: ""` for a user
- **THEN** the response is HTTP 400 and the user keeps the current group

### Requirement: Group coverage report before rollout
The repository SHALL provide a read-only command `node scripts/report-group-coverage.mjs [--days 30]` that, against the configured data directory, prints for each group: (1) every model its members called in the last N days that the group's allow-list does not allow, with request counts and the top 5 users per model; (2) members whose combined requests in any single minute of the last 7 days exceeded the group RPM; (3) members whose combined tokens in any single minute of the last 7 days exceeded the group TPM. The command SHALL NOT modify the database and SHALL exit with code 0.

#### Scenario: Report flags an uncovered model
- **WHEN** members of group G called `model-z` 40 times in the last 30 days and G does not allow `model-z`
- **THEN** the report lists `model-z` under G with a count of 40 and the database file is unchanged
