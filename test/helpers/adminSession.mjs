// Mints a valid Super Admin dashboard session for tests that call an admin API
// route handler directly (bypassing dashboardGuard's middleware, which normally
// authenticates the request before the handler ever runs). Since the
// admin-accounts change, every admin-mutating route checks the signed-in
// account's permission itself — a handler called with no session now correctly
// answers 401, so a test exercising its business logic needs a real session.
//
// Only usable from a test that has already registered src-alias-hook.mjs and
// next-server-hook.mjs (dashboardSession.js and adminUsers.js are reached via
// the "@/" alias through that hook).
import { createDashboardAuthToken } from "../../src/lib/auth/dashboardSession.js";
import { getSuperAdminAccount } from "../../src/lib/auth/adminUsers.js";

/** `{ Cookie: "auth_token=..." }` for the Super Admin account, for `new Request(url, { headers })`. */
export async function superAdminAuthHeaders() {
  const superAdmin = await getSuperAdminAccount();
  const token = await createDashboardAuthToken(
    superAdmin
      ? { adminUserId: superAdmin.id, username: superAdmin.username, role: "super_admin" }
      : {}
  );
  return { Cookie: `auth_token=${token}` };
}
