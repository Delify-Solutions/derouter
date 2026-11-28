// End-to-end permission enforcement across several different pages' mutating API
// routes (spec admin-accounts "Permission enforcement on every admin surface",
// tasks.md 4.5 — "spot-check at least 5 different pages' API routes, not just one").
//
// Calls the real exported route handlers directly (same pattern as
// test/providers-clone.test.js and test/model-case.test.js), with a crafted
// `auth_token` cookie for a scoped `member` account, and asserts:
//   - no session at all -> 401
//   - member with view-only on a page -> edit/delete route answers 403
//   - member with edit but not delete -> edit succeeds, delete is 403
//   - member with no permission at all on a page -> 403 (unauthenticated-equivalent
//     for that resource), even though the account IS signed in
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-permission-enforcement-"));
process.env.DATA_DIR = tmpDir;
register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createDashboardAuthToken } = await import("../src/lib/auth/dashboardSession.js");
const adminUsers = await import("../src/lib/auth/adminUsers.js");

const groupsRoute = await import("../src/app/api/groups/route.js");
const groupsIdRoute = await import("../src/app/api/groups/[id]/route.js");
const plansRoute = await import("../src/app/api/plans/route.js");
const combosRoute = await import("../src/app/api/combos/route.js");
const pricingRoute = await import("../src/app/api/pricing/route.js");
const adminAccountsRoute = await import("../src/app/api/admin-accounts/route.js");
const { viewablePageKeys, sessionCanAccessPage } = await import("../src/lib/auth/adminAccess.js");
const { PAGE_KEYS } = await import("../src/lib/auth/adminPages.js");

let db;

before(async () => {
  db = await getAdapter();
});

after(() => {
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function authHeadersFor(account) {
  const token = await createDashboardAuthToken({
    adminUserId: account.id,
    username: account.username,
    role: account.role,
  });
  return { Cookie: `auth_token=${token}` };
}

function req(url, { method = "GET", headers = {}, body } = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("no session at all: a direct call to a mutating admin route is 401", async () => {
  const res = await groupsRoute.POST(req("http://x/api/groups", { method: "POST", body: { name: "no-session-group" } }));
  assert.equal(res.status, 401);
});

test("a member with view-only on 'groups' gets 403 from POST /api/groups", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_view_groups", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { groups: { view: true, edit: false, delete: false } });
  const headers = await authHeadersFor(account);

  const res = await groupsRoute.POST(req("http://x/api/groups", { method: "POST", headers, body: { name: "view-only-group" } }));
  assert.equal(res.status, 403);
});

test("a member with edit on 'groups' can create a group, but without delete cannot delete one", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_edit_groups", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { groups: { view: true, edit: true, delete: false } });
  const headers = await authHeadersFor(account);

  const created = await groupsRoute.POST(req("http://x/api/groups", { method: "POST", headers, body: { name: "scoped-created-group" } }));
  assert.equal(created.status, 201);
  const { group } = await created.json();

  const deleted = await groupsIdRoute.DELETE(
    req(`http://x/api/groups/${group.id}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ id: group.id }) }
  );
  assert.equal(deleted.status, 403);

  // The group really is still there — the 403 refused the delete, not just the response.
  const stillThere = await groupsIdRoute.GET(req(`http://x/api/groups/${group.id}`), { params: Promise.resolve({ id: group.id }) });
  assert.equal(stillThere.status, 200);
});

test("a member with permission on one page cannot mutate a different, unrelated page", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_groups_only", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { groups: { view: true, edit: true, delete: true } });
  const headers = await authHeadersFor(account);

  const res = await plansRoute.POST(req("http://x/api/plans", {
    method: "POST",
    headers,
    body: { code: "p1", name: "Plan 1", priceNanoUsd: 0, creditNanoUsd: 0, durationDays: 30 },
  }));
  assert.equal(res.status, 403);
});

test("a shared route (POST /api/combos) is allowed when the account has edit on ANY of its owning pages", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_cli_tools", password: "correct-horse1", role: "member" });
  // No permission on "combos" itself, only on "cli-tools" — one of the other pages
  // POST /api/combos is legitimately called from.
  await adminUsers.setAdminPermissions(account.id, { "cli-tools": { view: true, edit: true, delete: false } });
  const headers = await authHeadersFor(account);

  const res = await combosRoute.POST(req("http://x/api/combos", {
    method: "POST",
    headers,
    body: { name: "shared-route-combo", models: ["acme/model-a"] },
  }));
  assert.equal(res.status, 201);
});

test("the shared /api/pricing route still enforces its own page key", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_no_pricing", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { groups: { view: true, edit: true, delete: true } });
  const headers = await authHeadersFor(account);

  const res = await pricingRoute.PATCH(req("http://x/api/pricing", {
    method: "PATCH",
    headers,
    body: { acme: { "model-a": { input: 1, output: 2 } } },
  }));
  assert.equal(res.status, 403);
});

test("Super Admin bypasses every permission check, on every page", async () => {
  const superAdmin = await adminUsers.getSuperAdminAccount();
  const headers = await authHeadersFor(superAdmin);

  const groupRes = await groupsRoute.POST(req("http://x/api/groups", { method: "POST", headers, body: { name: "super-admin-group" } }));
  assert.equal(groupRes.status, 201);

  const planRes = await plansRoute.POST(req("http://x/api/plans", {
    method: "POST",
    headers,
    body: { code: "p-super", name: "Super Plan", priceNanoUsd: 0, creditNanoUsd: 1000, durationDays: 30 },
  }));
  assert.equal(planRes.status, 201);
});

// ── Admin account management UI's own API (group 5) ─────────────────────────

test("a member without edit on 'admin-accounts' cannot create a collaborator", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_no_admin_accounts", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { groups: { view: true, edit: true, delete: true } });
  const headers = await authHeadersFor(account);

  const res = await adminAccountsRoute.POST(req("http://x/api/admin-accounts", {
    method: "POST",
    headers,
    body: { username: "should_not_exist", password: "whatever123", permissions: { orders: { view: true, edit: true, delete: false } } },
  }));
  assert.equal(res.status, 403);
});

test("spec 'Create a collaborator': Super Admin creates a scoped member end to end, and its session matches exactly what was granted", async () => {
  const superAdmin = await adminUsers.getSuperAdminAccount();
  const superHeaders = await authHeadersFor(superAdmin);

  const createRes = await adminAccountsRoute.POST(req("http://x/api/admin-accounts", {
    method: "POST",
    headers: superHeaders,
    body: {
      username: "ctv_scoped_e2e",
      password: "temp-password-1",
      permissions: {
        orders: { view: true, edit: true, delete: false },
        usage: { view: true, edit: false, delete: false },
      },
    },
  }));
  assert.equal(createRes.status, 201);
  const { account } = await createRes.json();

  // "the account can log in with that password, is required to change it on
  // first login (mustChangePassword true)"
  const login = await adminUsers.verifyAdminCredentials("ctv_scoped_e2e", "temp-password-1");
  assert.equal(login.ok, true);
  assert.equal(login.account.mustChangePassword, true);

  // Build the session payload exactly as login/route.js would, then check what
  // the sidebar (viewablePageKeys) and the per-route gate (sessionCanAccessPage)
  // say for it — this IS "the sidebar and API access", read through the same
  // functions the real UI and routes call.
  const session = { adminUserId: account.id, username: account.username, role: account.role };

  const viewable = await viewablePageKeys(session, PAGE_KEYS);
  assert.deepEqual([...viewable].sort(), ["orders", "usage"]);

  assert.equal(await sessionCanAccessPage(session, "orders", "view"), true);
  assert.equal(await sessionCanAccessPage(session, "orders", "edit"), true);
  assert.equal(await sessionCanAccessPage(session, "orders", "delete"), false);
  assert.equal(await sessionCanAccessPage(session, "usage", "view"), true);
  assert.equal(await sessionCanAccessPage(session, "usage", "edit"), false);
  assert.equal(await sessionCanAccessPage(session, "users", "view"), false);

  // And the real route agrees: can edit orders, cannot touch an unrelated page.
  const headers = await authHeadersFor(account);
  const ordersDenied = await (await import("../src/lib/auth/adminAccess.js")).requirePagePermission(
    req("http://x/api/orders/x1", { method: "PATCH", headers }),
    "orders",
    "edit"
  );
  assert.equal(ordersDenied, null);
  const usersDenied = await (await import("../src/lib/auth/adminAccess.js")).requirePagePermission(
    req("http://x/api/users/x1", { method: "PATCH", headers }),
    "users",
    "edit"
  );
  assert.equal(usersDenied.status, 403);
});
