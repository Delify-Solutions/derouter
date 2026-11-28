// Page-permission enforcement for the admin dashboard (spec admin-accounts
// "Permission enforcement on every admin surface"). Every `/dashboard/**` page
// render and every admin-mutating API route go through this module so there is
// exactly one place that knows how to answer "can this signed-in account do X on
// page Y" — Super Admin always yes, everything else reads `adminPermissions`.
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "./dashboardSession.js";
import { getAdminPermissionForPage, isSuperAdminSession } from "./adminUsers.js";

/**
 * `request.cookies` (Next.js's `RequestCookies`, parsed from the `Cookie` header
 * at construction) is how every route handler normally reads it. A plain Web
 * `Request` — as used by tests that call a route's exported handler directly,
 * bypassing the Next.js runtime — has no such property, so this falls back to
 * parsing the raw `Cookie` header itself; same value either way.
 */
function readCookie(request, name) {
  const viaNextRequest = request?.cookies?.get?.(name)?.value;
  if (viaNextRequest !== undefined) return viaNextRequest;
  const header = request?.headers?.get?.("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function getSessionForRequest(request) {
  const token = readCookie(request, "auth_token");
  return getDashboardAuthSession(token);
}

/**
 * @param {object|null} session   JWT payload from getDashboardAuthSession
 * @param {string} pageKey
 * @param {"view"|"edit"|"delete"} action
 */
export async function sessionCanAccessPage(session, pageKey, action = "view") {
  if (!session) return false;
  if (isSuperAdminSession(session)) return true;
  if (!session.adminUserId) return false;
  const perm = await getAdminPermissionForPage(session.adminUserId, pageKey);
  return !!perm[action];
}

/** Every page key the session may at least `view`, for sidebar/nav filtering. */
export async function viewablePageKeys(session, allKeys) {
  if (!session) return [];
  if (isSuperAdminSession(session)) return [...allKeys];
  if (!session.adminUserId) return [];
  const { getAdminPermissions } = await import("./adminUsers.js");
  const matrix = await getAdminPermissions(session.adminUserId);
  return allKeys.filter((key) => matrix[key]?.view);
}

/**
 * Guard for a mutating API route body: a 403/401 NextResponse when the request
 * should be refused, else null (caller proceeds). Independent of any page-level
 * view check — spec: "every admin-mutating API route SHALL check the matching
 * edit or delete permission... independent of the page-level check".
 *
 * @param {Request} request
 * @param {string} pageKey
 * @param {"edit"|"delete"} action
 */
export async function requirePagePermission(request, pageKey, action = "edit") {
  const session = await getSessionForRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const allowed = await sessionCanAccessPage(session, pageKey, action);
  if (!allowed) {
    return NextResponse.json({ error: "Tài khoản của bạn không có quyền thực hiện thao tác này" }, { status: 403 });
  }
  return null;
}

/**
 * Same as requirePagePermission, but for a route genuinely shared by more than
 * one dashboard page (e.g. POST /api/combos, called from the Combo, CLI Tools
 * and Media Providers pages alike): allowed when the account has `action` on
 * ANY of `pageKeys`, so a member scoped to just one of those pages can still use
 * the shared route from their own page.
 */
export async function requireAnyPagePermission(request, pageKeys, action = "edit") {
  const session = await getSessionForRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  for (const pageKey of pageKeys) {
    if (await sessionCanAccessPage(session, pageKey, action)) return null;
  }
  return NextResponse.json({ error: "Tài khoản của bạn không có quyền thực hiện thao tác này" }, { status: 403 });
}
