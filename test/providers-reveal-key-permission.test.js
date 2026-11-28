// GET /api/providers/[id]/reveal-key — must require "edit" on "providers", not just
// a valid session: this route hands back a decrypted upstream secret, so a member
// scoped to view-only on the Providers page must not be able to extract it by
// calling the API directly (spec admin-accounts "Permission enforcement on every
// admin surface").
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-reveal-key-permission-"));

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createProviderConnection } = await import("../src/lib/db/repos/connectionsRepo.js");
const { createDashboardAuthToken } = await import("../src/lib/auth/dashboardSession.js");
const adminUsers = await import("../src/lib/auth/adminUsers.js");
const { GET } = await import("../src/app/api/providers/[id]/reveal-key/route.js");

await getAdapter();

async function authHeadersFor(account) {
  const token = await createDashboardAuthToken({ adminUserId: account.id, username: account.username, role: account.role });
  return { Cookie: `auth_token=${token}` };
}

const call = (id, headers = {}) =>
  GET(new Request(`https://admin.example/api/providers/${id}/reveal-key`, { headers }), { params: Promise.resolve({ id }) });

let connectionId;
test.before(async () => {
  const connection = await createProviderConnection({
    provider: "openai-compatible-acme",
    authType: "apikey",
    name: "Acme primary",
    apiKey: "sk-real-secret",
  });
  connectionId = connection.id;
});

test("no session at all: 401, secret never returned", async () => {
  const res = await call(connectionId);
  assert.equal(res.status, 401);
});

test("a member with view-only on 'providers' cannot reveal the secret", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_view_providers", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { providers: { view: true, edit: false, delete: false } });
  const res = await call(connectionId, await authHeadersFor(account));
  assert.equal(res.status, 403);
});

test("a member with edit on 'providers' can reveal the secret", async () => {
  const account = await adminUsers.createAdminAccount({ username: "member_edit_providers", password: "correct-horse1", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { providers: { view: true, edit: true, delete: false } });
  const res = await call(connectionId, await authHeadersFor(account));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.apiKey, "sk-real-secret");
});

test("Super Admin bypasses the check", async () => {
  const superAdmin = await adminUsers.getSuperAdminAccount();
  const res = await call(connectionId, await authHeadersFor(superAdmin));
  assert.equal(res.status, 200);
});
