// Audit actor attribution (spec admin-accounts "Audit actor is the specific
// account", tasks.md 6.1/6.2): every admin action's audit row now names the
// signed-in account's own username instead of a generic "admin" label.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-audit-actor-"));
process.env.DATA_DIR = tmpDir;
register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createDashboardAuthToken } = await import("../src/lib/auth/dashboardSession.js");
const { getAdminIdentity, getAdminActor } = await import("../src/lib/auth/adminIdentity.js");
const adminUsers = await import("../src/lib/auth/adminUsers.js");
const usersIdRoute = await import("../src/app/api/users/[id]/route.js");
const { createUser } = await import("../src/lib/db/repos/userRepo.js");

let db;

before(async () => {
  db = await getAdapter();
});

after(() => {
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeRequestWithCookie(token) {
  return { cookies: { get: (name) => (name === "auth_token" ? { value: token } : undefined) } };
}

test("getAdminIdentity reads the signed-in account's own username, not a generic label", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_hoa_identity", password: "correct-horse1", role: "member" });
  const token = await createDashboardAuthToken({ adminUserId: account.id, username: account.username, role: account.role });

  const identity = await getAdminIdentity(fakeRequestWithCookie(token));
  assert.equal(identity, "ctv_hoa_identity");

  const actor = await getAdminActor(fakeRequestWithCookie(token));
  assert.equal(actor, "admin:ctv_hoa_identity");
});

test("a request with no session falls back to the generic 'admin' label", async () => {
  const identity = await getAdminIdentity(fakeRequestWithCookie("not-a-real-token"));
  assert.equal(identity, "admin");
});

test("spec 'Two different admins act on the same user': distinct accounts write distinct actors on the same customer's audit log", async () => {
  const admin1 = await adminUsers.createAdminAccount({ username: "admin_ops1", password: "correct-horse1", role: "member" });
  const admin2 = await adminUsers.createAdminAccount({ username: "ctv_hoa_audit", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(admin1.id, { users: { view: true, edit: true, delete: false } });
  await adminUsers.setAdminPermissions(admin2.id, { users: { view: true, edit: true, delete: false } });

  const token1 = await createDashboardAuthToken({ adminUserId: admin1.id, username: admin1.username, role: admin1.role });
  const token2 = await createDashboardAuthToken({ adminUserId: admin2.id, username: admin2.username, role: admin2.role });

  const customer = await createUser({ email: "shared-customer@test.local", passwordHash: "x", status: "active" });

  const patch = (token, body) =>
    usersIdRoute.PATCH(
      new Request(`http://x/api/users/${customer.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", Cookie: `auth_token=${token}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: customer.id }) }
    );

  const res1 = await patch(token1, { adminNote: "Ghi chú của admin_ops1" });
  assert.equal(res1.status, 200);
  const res2 = await patch(token2, { adminNote: "Ghi chú của ctv_hoa_audit" });
  assert.equal(res2.status, 200);

  const rows = db.all(`SELECT actor, details FROM userAuditLog WHERE userId = ? AND action = 'note_changed' ORDER BY createdAt ASC`, [customer.id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, "admin:admin_ops1");
  assert.equal(rows[1].actor, "admin:ctv_hoa_audit");
});
