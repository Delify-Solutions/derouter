import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";
import { safeEqual } from "./internalHeaders.js";
// Relative (not @/) — adminUsers.js itself only uses relative imports, so this
// stays resolvable from a plain `node --test` import graph even though nothing
// here needs that property directly.
import { findAdminAccountById } from "./adminUsers.js";

const DEFAULT_PASSWORD = "123456";

// The token and the cookie share one lifetime. Without `maxAge` the cookie is a
// browser-session cookie and the admin is signed out whenever the browser closes.
export const DASHBOARD_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

// Settings key: unix seconds. A dashboard token issued before it is rejected, so
// changing or resetting the admin password signs out every existing session — a
// leaked 30-day token used to stay valid until it expired.
export const SESSIONS_VALID_AFTER_KEY = "dashboardSessionsValidAfter";

/** Value to store under SESSIONS_VALID_AFTER_KEY to revoke every token issued so far. */
export function revokeAllDashboardSessionsValue(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000);
}

// A failed settings read rejects the token: the admin console must fail closed.
async function issuedBeforeGlobalRevocation(payload) {
  try {
    const settings = await getSettings();
    const validAfter = Number(settings?.[SESSIONS_VALID_AFTER_KEY]) || 0;
    return Number(payload?.iat ?? 0) < validAfter;
  } catch {
    return true;
  }
}

// Per-account revocation (spec admin-accounts, design decision 2): a token is
// also rejected when ITS OWN account was disabled, deleted, or had its password
// changed/reset since the token was issued — independent of the coarser global
// kill switch above. Every session minted since this change carries
// `adminUserId`; a session with none predates it and is judged by the global
// check alone (there is nothing per-account to look up).
async function rejectedByAccount(payload) {
  const adminUserId = payload?.adminUserId;
  if (!adminUserId) return false;
  try {
    const account = await findAdminAccountById(adminUserId);
    if (!account) return true; // account deleted since the token was issued
    if (account.status !== "active") return true; // disabled
    return Number(payload?.iat ?? 0) < Number(account.sessionsValidAfter || 0);
  } catch {
    // A DB error must not keep a revoked/deleted account's session alive.
    return true;
  }
}

async function issuedBeforeRevocation(payload) {
  if (await issuedBeforeGlobalRevocation(payload)) return true;
  return rejectedByAccount(payload);
}

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${DASHBOARD_TOKEN_TTL_SECONDS}s`)
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return !(await issuedBeforeRevocation(payload));
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (await issuedBeforeRevocation(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: DASHBOARD_TOKEN_TTL_SECONDS,
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return safeEqual(password, initialPassword);
}
