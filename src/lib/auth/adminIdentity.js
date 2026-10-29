// Who performed an admin action — the actor value written to `userAuditLog`.
//
// The admin dashboard is a single-password JWT surface, but it may sit behind OIDC
// or SAML SSO, in which case the token carries a real identity. The audit trail
// records the most specific identity available and falls back to "admin" for a
// plain password session, which is honest: we genuinely do not know more.
//
// Relative imports only: modules that write audit rows are imported by tests under
// plain `node --test`. dashboardSession itself pulls in `@/`-aliased modules, so it
// is loaded dynamically inside the function — a test that only needs the actor
// string for a fake request never touches it.

/** Raw identity string: OIDC email, SAML email, JWT `sub`, else "admin". */
export async function getAdminIdentity(request) {
  try {
    const token = request?.cookies?.get?.("auth_token")?.value;
    const { getDashboardAuthSession } = await import("./dashboardSession.js");
    const session = await getDashboardAuthSession(token);
    return session?.oidcEmail || session?.samlEmail || session?.sub || "admin";
  } catch {
    return "admin";
  }
}

/**
 * Audit actor, prefixed so a reader can tell an admin action apart from a customer
 * action (`customer`) or an automatic repair (`system`) without another lookup.
 *
 * @returns {Promise<string>} `admin:<identity>`
 */
export async function getAdminActor(request) {
  const identity = await getAdminIdentity(request);
  return `admin:${identity}`;
}
