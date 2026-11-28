// Who performed an admin action — the actor value written to `userAuditLog`.
//
// Since the admin-accounts change, every dashboard session carries the signed-in
// account's own `username` (spec admin-accounts "Audit actor is the specific
// account") — OIDC/SAML SSO still maps to the Super Admin account (design.md
// Non-Goals: per-account SSO identity is out of scope), so its own email/sub
// stays the more specific identity when present. "admin" is only the last-resort
// fallback for a session this module could not read at all.
//
// Relative imports only: modules that write audit rows are imported by tests under
// plain `node --test`. dashboardSession itself pulls in `@/`-aliased modules, so it
// is loaded dynamically inside the function — a test that only needs the actor
// string for a fake request never touches it.

// `request.cookies` (Next.js's `RequestCookies`, parsed from the `Cookie` header
// at construction) is how a real request normally carries this. A plain Web
// `Request` has no such property, so this falls back to parsing the raw
// `Cookie` header itself — same value either way. Mirrors adminAccess.js's
// readCookie (duplicated, not imported: keeps this module free of any import
// that would drag `next/server` into the dynamic-import-only testability story).
function readAuthTokenCookie(request) {
  const viaNextRequest = request?.cookies?.get?.("auth_token")?.value;
  if (viaNextRequest !== undefined) return viaNextRequest;
  const header = request?.headers?.get?.("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "auth_token") return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Raw identity string: OIDC email, SAML email, the signed-in account's username, else "admin". */
export async function getAdminIdentity(request) {
  try {
    const token = readAuthTokenCookie(request);
    const { getDashboardAuthSession } = await import("./dashboardSession.js");
    const session = await getDashboardAuthSession(token);
    return session?.oidcEmail || session?.samlEmail || session?.username || session?.sub || "admin";
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
