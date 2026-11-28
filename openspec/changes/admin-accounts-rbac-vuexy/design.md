## Context

See `proposal.md` for motivation. Current state that shapes this design:

- `settings.password` (one bcrypt hash) is the entire admin auth model; `src/dashboardGuard.js` treats any valid dashboard JWT as full access, no identity inside it.
- Admin JWT is minted by `src/lib/auth/dashboardSession.js`, revocable only globally via the `dashboardSessionsValidAfter` settings key (changing the password invalidates every token).
- Schema lives in `src/lib/db/schema.js` as declarative `TABLES` (additive auto-sync) + `SCHEMA_VERSION` (currently 51); destructive changes need a file in `src/lib/db/migrations/`.
- The admin dashboard has 30 page directories under `src/app/(dashboard)/dashboard/**`, each with its own API routes.
- `vuexy-html-admin-template/` is a licensed static Bootstrap 5 + jQuery product (forking/redistribution disabled by its license) kept untracked (`.gitignore`) purely as a local visual reference — nothing from it is imported or shipped.
- Icons today are Google's Material Symbols font (already loaded app-wide, e.g. `AccountShell.js`); Vuexy ships its own icon set (boxicons/iconify).

## Goals / Non-Goals

**Goals:**
- Replace the single shared password with named, permissioned admin accounts without changing behavior for the existing owner login on day one.
- Make permission enforcement impossible to bypass by calling an API route directly (not just hiding UI).
- Reskin the dashboard to Vuexy's visual language while keeping it a Next.js/React app (no jQuery/Bootstrap JS runtime).

**Non-Goals:**
- Per-account SSO identity (OIDC/SAML keeps mapping to Super Admin only).
- Swapping the icon font (Material Symbols stays; only color/shape/spacing/layout follow Vuexy).
- Shipping or redistributing any Vuexy source file — it is a design reference only.
- Changing what any admin action does once authorized — only whether it's allowed.

## Decisions

**1. Normalized permission table, not a JSON blob.**
`adminPermissions(adminUserId, pageKey, view, edit, delete)`, one row per (account, page), unique on `(adminUserId, pageKey)`. Alternative considered: a single JSON column on `adminUsers`. Rejected because the permission check runs on every request (needs an indexed point lookup, not a JSON parse + scan) and because `admin-accounts`' own edit form needs to update one page's row at a time.

**2. Session carries account identity + per-account revocation.**
The dashboard JWT payload gains `adminUserId` and `username`. `adminUsers` gets a `sessionsValidAfter` column (unix seconds), checked the same way the existing global `dashboardSessionsValidAfter` is checked today — but per account, so disabling or deleting one account revokes only its sessions. The existing global key is kept as an extra, coarser kill switch (e.g. "reset password to default" via the CLI still invalidates everyone).

**3. Page-key registry is the single source of truth for both nav and enforcement.**
One module (`src/lib/auth/adminPages.js` or similar) exports the ordered list of `{ key, label, pathPrefix }` for all 30 existing pages plus `admin-accounts`. The sidebar filters by it, `dashboardGuard.js` resolves a request path to a key via it, and every mutating API route imports the same key to check `edit`/`delete`. One list, so a new page can't be added to the nav without also being added to enforcement.

**4. Super Admin bypass is unconditional code, not a permission row.**
`isSuperAdmin(session)` short-circuits every check before any `adminPermissions` lookup. Alternative considered: give Super Admin a row with every bit set to true. Rejected — a bug or a bad migration could leave Super Admin's rows incomplete and lock out the one account that must never be lockable.

**5. Unknown-username and wrong-password answer identically, in constant time.**
`POST /api/auth/login` compares against a precomputed dummy bcrypt hash when the username doesn't exist, so the response time and message don't reveal whether the username was real (same property the current single-password flow already has by construction).

**6. Vuexy is rebuilt as Tailwind-styled React components, not imported.**
No Bootstrap CSS, no jQuery, no Vuexy JS files enter the bundle — loading Bootstrap's global stylesheet and resets alongside Tailwind's would fight over base element styles, and Vuexy's JS directly mutates the DOM in ways that corrupt React's virtual DOM. Instead: read `vuexy-html-admin-template/full-version/scss/_custom-variables/*` for the palette, radii, shadow and spacing scale, and port those into `tailwind.config` / CSS variables; rebuild each shared primitive (`Button`, `Card`, `Input`, `Table`, `Sidebar`, `Header`, `Modal`, `Badge`, `Pagination`, `Toast`) to match Vuexy's markup/visual shape using Tailwind utilities. `openspec/ui-dna.md` is rewritten to document the new tokens and component shapes so later pages stay consistent.

**7. Reskin lands page-by-page, grouped by shape, changing only JSX/class names.**
Pages are batched by what they mostly consist of (table-heavy list pages; form-heavy settings pages; chart-heavy usage/stats pages) so each batch reuses the same new primitives the same way. No batch touches data-fetching, handlers, or business logic — only the rendered markup and classes. This keeps the huge visual diff mechanically checkable (behavior unchanged, lint/test/build green) even though it touches most of the admin app.

**8. RBAC backend lands before any visual change, inside the same branch.**
Even though both halves ship together per the owner's choice, the backend (schema, session, permission checks, account-management page built with the *current* design system first) is implemented and tested as its own set of commits before the reskin starts. This keeps the security-critical half bisectable and means the feature still works correctly if the reskin half runs out of time/budget.

## Risks / Trade-offs

- [Risk] A permission-check bug locks an admin out of a page they need → Mitigation: Super Admin bypass is unconditional (Decision 4); every new page-key addition is a one-line registry change, not per-route boilerplate (Decision 3), shrinking the surface for that class of bug.
- [Risk] Reskinning 30 pages hides a behavior change inside a huge visual diff → Mitigation: Decision 7 (markup/class-only batches) + full lint/test/build after each batch + manual smoke pass per batch in the dev server.
- [Risk] Bundling a security rewrite and a full visual rewrite in one branch makes the eventual diff very large to review → Mitigation: Decision 8 keeps the two halves as separable commit groups within the branch.
- [Risk] Accidentally committing the 164MB licensed Vuexy template → Mitigation: already added to `.gitignore` before any other work started.
- [Risk] Scope (RBAC + 30-page reskin) is large enough to span multiple sessions → Mitigation: `tasks.md` is broken into groups that are each independently safe to stop after (schema/migration → auth/session → enforcement → account UI → design tokens → shared components → page batches), so the app is never left half-migrated.

## Migration Plan

1. Add `adminUsers` / `adminPermissions` tables (additive) + bump `SCHEMA_VERSION`; migration inserts the Super Admin row from `settings.password` only if no `super_admin` row exists yet (idempotent, safe to run on every boot).
2. Ship session + enforcement changes behind the existing login flow continuing to work unchanged for the Super Admin (now resolved from `adminUsers` instead of `settings.password` directly) — no behavior change visible to the owner until a second account is actually created.
3. Ship the account-management page and permission matrix UI.
4. Ship the design-token swap and shared-component rebuild, then convert pages batch by batch.
5. Rollback: the branch is never pushed to `main` until asked (standing rule); if something already merged needs reverting, the schema change is additive-only (no destructive migration, no data loss), so a plain code revert is safe without a down-migration.

## Open Questions

- Exact Vuexy color/shadow/radius values to port (light + dark mode) are read directly from `vuexy-html-admin-template/full-version/scss/_custom-variables/` during implementation — a data-gathering detail, not a decision that changes scope or approach.
