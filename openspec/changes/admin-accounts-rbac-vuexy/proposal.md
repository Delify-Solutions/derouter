## Why

The admin dashboard currently has exactly one shared password (`settings.password`) for every person who logs in — there is no concept of a named account. The owner cannot bring on a collaborator (ctv) and hand them only part of the dashboard (e.g. only "Orders" and "Users", view-only), and every audited admin action records a generic "admin" actor instead of a specific person. Separately, the dashboard's visual design (`openspec/ui-dna.md`: square corners, 1px borders, no shadows) is being replaced wholesale with the Vuexy Bootstrap 5 admin template's look, now that more people besides the owner will use the dashboard day to day.

## What Changes

- New `admin_users` table: each admin signs in with a username + their own password (bcrypt), not the one shared secret.
- The password already in `settings.password` becomes the password of a default **Super Admin** account on migration (full access to every page and action, cannot be restricted or deleted) — the owner's existing login keeps working unchanged.
- New per-account permission matrix: for each of the dashboard's pages, an account can be granted **view / edit / delete** independently. A page with no "view" is hidden from that account's sidebar and its API routes answer 403.
- New `/dashboard/admin-accounts` page: list, create, edit, disable and delete admin accounts; assign the permission matrix when creating or editing an account; force a password reset.
- Self-service "Đổi mật khẩu" for whichever account is signed in (any account, not just Super Admin).
- Every admin page route and every admin-mutating API route enforces the signed-in account's permission for that page.
- Audit entries for existing admin actions (per `admin-user-management` spec) now record the specific account's username as actor, not a generic "admin".
- **BREAKING**: the single shared-password login flow is replaced by per-account login. `/admin/ss` now asks for username + password. OIDC/SAML SSO continue to authenticate but, for this change, always sign the session in as the Super Admin account (per-account SSO identity mapping is out of scope).
- Full visual reskin of the entire admin dashboard (all pages under `src/app/(dashboard)/dashboard/**`, the sidebar, topbar, and every shared component: button, card, input, table, modal, badge, pagination, toast) to match the Vuexy Bootstrap 5 admin template's design language. The Vuexy template itself (`vuexy-html-admin-template/`, a licensed static HTML/CSS/jQuery product, kept untracked for local reference only) is not embedded — its visual design (palette, spacing, typography, component shapes) is rebuilt as React/Tailwind components so it keeps working inside Next.js.
- `openspec/ui-dna.md` is rewritten to document the new design language, replacing the current square/1px-border/no-shadow description.

## Capabilities

### New Capabilities
- `admin-accounts`: named admin accounts (username + own password), a default Super Admin created from the existing shared password, a per-page view/edit/delete permission matrix, an account management UI, self-service password change, and permission enforcement on every admin page and admin API route.

### Modified Capabilities
(none — every other existing admin capability's requirements already describe behavior for "the signed-in admin"; this change only adds a permission gate in front of that behavior and resolves "the admin" to a specific account. No existing requirement text changes. The visual reskin changes presentation only, not any spec-level requirement.)

## Impact

- **Schema** (`src/lib/db/schema.js`): new `admin_users` and `admin_permissions` tables; `SCHEMA_VERSION` bump + migration that creates the Super Admin row from `settings.password`.
- **Auth**: `src/app/api/auth/login/route.js`, `src/lib/auth/dashboardSession.js`, `src/dashboardGuard.js`, `src/app/admin/ss/page.js` — session now carries an `adminUserId`/username, not just "authenticated: true"; new `/api/auth/change-password` (self-service, any account) alongside the existing `PATCH /api/settings` (kept for Super Admin's own default-password flow).
- **New API routes**: `/api/admin-accounts` (list/create/update/delete), `/api/admin-accounts/[id]/permissions`.
- **New page**: `/dashboard/admin-accounts`.
- **Permission enforcement**: every route under `src/app/(dashboard)/dashboard/**` and every admin-mutating route under `src/app/api/**` gains a page-key permission check.
- **Audit log**: actor attribution switches from a generic admin label to the account's username, wherever `admin-user-management` and other specs already write an actor.
- **Shared UI components** (`src/shared/components/*`: Button, Card, Input, Table, Sidebar, Header, Modal, Badge, Pagination, Toast, …): rebuilt to the Vuexy design language.
- **All 31 admin pages** under `src/app/(dashboard)/dashboard/**` (the home/overview page, affiliates, announcements, basic-chat, cli-tools, combos, console-log, content, customer-skills, dsh-plugins, endpoint, errors, gift-codes, groups, media-providers, mitm, orders, payments, plans, pricing, profile, providers, proxy-pools, pxpipe, quota, stats, storage, telegram, token-saver, translator, usage, users): visual update to the new components, no behavior change beyond the new permission gate.
- **`openspec/ui-dna.md`**: rewritten for the new design language.
- **Out of scope**: per-account SSO identity mapping (OIDC/SAML keeps mapping to Super Admin only); the customer-facing account area (`src/app/account/**`) and public landing pages are untouched — this change is admin-dashboard only.
