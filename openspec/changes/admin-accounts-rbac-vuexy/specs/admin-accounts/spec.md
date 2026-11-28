## Purpose
Lets the dashboard have more than one named person behind it: each admin signs in as themselves, and the owner can grant a collaborator (ctv) exactly the pages and actions they need instead of handing out the one shared password.

## ADDED Requirements

### Requirement: Admin account identity
Each admin account SHALL have a unique username (case-insensitive, 3–32 characters, letters/digits/`_`/`-`), its own bcrypt password hash, a display name, a role of `super_admin` or `member`, a status of `active` or `disabled`, and a `mustChangePassword` flag. Exactly one `super_admin` account SHALL exist at all times and it SHALL NOT be deleted, disabled, demoted, or have its permissions edited — it always holds every permission on every page.

#### Scenario: Migrating the single shared password
- **WHEN** this change's migration runs against an install that only has `settings.password`
- **THEN** one `super_admin` account named `admin` is created with that password hash, `mustChangePassword` false, and every existing admin session stays valid until it next expires

#### Scenario: Username already taken
- **WHEN** an admin creates an account with a username that only differs by case from an existing one
- **THEN** the request is rejected with HTTP 409 and no account is created

### Requirement: Admin page permission matrix
Every admin dashboard page SHALL have a stable page key: `dashboard` (home/overview), `affiliates`, `announcements`, `basic-chat`, `cli-tools`, `combos`, `console-log`, `content`, `customer-skills`, `dsh-plugins`, `endpoint`, `errors`, `gift-codes`, `groups`, `media-providers`, `mitm`, `orders`, `payments`, `plans`, `pricing`, `profile`, `providers`, `proxy-pools`, `pxpipe`, `quota`, `stats`, `storage`, `telegram`, `token-saver`, `translator`, `usage`, `users`, and `admin-accounts` (this capability's own management page). For each `member` account and each page key, the system SHALL store independent `view`, `edit`, and `delete` booleans (all false by default for a new account). `edit` or `delete` without `view` SHALL be rejected as invalid input.

#### Scenario: View-only collaborator
- **WHEN** a `member` account has `{view: true, edit: false, delete: false}` on `orders`
- **THEN** they can open `/dashboard/orders` and see the list, but every mutating action on that page is hidden and its API route answers HTTP 403 if called directly

#### Scenario: Edit implies nothing about delete
- **WHEN** a `member` account has `{view: true, edit: true, delete: false}` on `gift-codes`
- **THEN** they can create and edit gift codes but the delete action is hidden and its route answers HTTP 403

### Requirement: Permission enforcement on every admin surface
Every page under `/dashboard/**` SHALL check the signed-in account's `view` permission for that page's key before rendering, redirecting to the first page the account can view (or to a "no access" state if none) otherwise. Every admin-mutating API route SHALL check the matching `edit` or `delete` permission before taking effect, independent of the page-level check, and SHALL answer HTTP 403 when missing. The sidebar SHALL show only the pages the signed-in account can view.

#### Scenario: Direct API call without permission
- **WHEN** a `member` account with no `edit` permission on `plans` calls the plan-mutating API directly with a valid session
- **THEN** the response is HTTP 403 and nothing changes

#### Scenario: Super Admin is never blocked
- **WHEN** the `super_admin` account opens any page or calls any admin API route
- **THEN** access is always granted regardless of any stored permission row

### Requirement: Admin account management
`/dashboard/admin-accounts` (page key `admin-accounts`, itself gated like any other page) SHALL let an account with `edit` permission there create, edit, disable/enable, and delete `member` accounts, and set each one's full permission matrix in one form. Deleting an account SHALL require typing its username back, same confirmation pattern as deleting a customer account. A disabled account SHALL be refused at login with a clear message and SHALL have its sessions revoked immediately.

#### Scenario: Create a collaborator
- **WHEN** an admin with `edit` on `admin-accounts` creates a `member` account with a username, a temporary password, and `view+edit` on `orders` and `view` on `usage`
- **THEN** the account can log in with that password, is required to change it on first login (`mustChangePassword` true), sees only "Orders" and "Usage" in the sidebar, and can edit orders but not usage

#### Scenario: Disable revokes access immediately
- **WHEN** an admin disables a `member` account that has an open session
- **THEN** that session's next request is refused and the account cannot log in again until re-enabled

### Requirement: Self-service password change
Any signed-in admin account (including `super_admin`) SHALL be able to change their own password from the dashboard by providing their current password and a new one (minimum 8 characters). A successful change SHALL clear `mustChangePassword` and SHALL revoke every other open session for that account.

#### Scenario: Wrong current password
- **WHEN** an account submits the wrong current password while changing it
- **THEN** the request is rejected with HTTP 400 and the password is unchanged

#### Scenario: Forced change on first login
- **WHEN** a `member` account with `mustChangePassword` true logs in
- **THEN** they are required to set a new password before reaching any dashboard page

### Requirement: Per-account login
`/admin/ss` SHALL ask for a username and a password instead of a password alone. `POST /api/auth/login` SHALL accept `{ username, password }`, rate-limit failed attempts per IP exactly as today, and SHALL NOT reveal whether a failure was an unknown username or a wrong password. OIDC and SAML SSO SHALL continue to work exactly as today and SHALL sign every successful SSO session in as the `super_admin` account.

#### Scenario: Unknown username
- **WHEN** a login attempt uses a username that does not exist
- **THEN** the response is the same generic "Invalid username or password" as a wrong password for a real username

### Requirement: Audit actor is the specific account
Every audit entry written by an existing admin capability (per `admin-user-management` and others) SHALL record the signed-in account's username as the actor, instead of a generic admin label.

#### Scenario: Two different admins act on the same user
- **WHEN** `admin` grants a plan to a customer and later `ctv_hoa` edits that customer's note
- **THEN** the audit log shows `admin` on the grant entry and `ctv_hoa` on the note entry
