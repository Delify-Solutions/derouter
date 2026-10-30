import { SignJWT, jwtVerify } from "jose";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { shouldUseSecureCookie } from "./dashboardSession.js";

// Customer session tokens. Deliberately a SEPARATE signing key from the admin
// dashboard (dashboardSession.js uses DATA_DIR/jwt-secret): a 30-day customer
// token must never be replayable as an admin token, and an admin token must never
// grant a customer account. Two key files makes that structural
// rather than a claim-shape check. `kind: "user"` is checked as well, so a
// token signed by this key that was minted for some other purpose still fails.

export const USER_COOKIE = "user_token";
export const USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function loadUserJwtSecret() {
  if (process.env.USER_JWT_SECRET) return process.env.USER_JWT_SECRET;
  const file = path.join(DATA_DIR, "user-jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

let cachedSecret = null;
function secretKey() {
  if (!cachedSecret) {
    // Re-read lazily: DATA_DIR can be redirected (isolated test dirs) between
    // module evaluation and first use in dev.
    cachedSecret = new TextEncoder().encode(loadUserJwtSecret());
  }
  return cachedSecret;
}

export async function createUserToken({ userId, email } = {}) {
  if (!userId) throw new Error("userId is required");
  return new SignJWT({ kind: "user", email: email || null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${USER_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** `{ userId, email }` for a valid customer token, null otherwise. */
export async function verifyUserToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (payload?.kind !== "user") return null;
    if (!payload.sub) return null;
    return { userId: payload.sub, email: payload.email ?? null };
  } catch {
    return null;
  }
}

export async function setUserCookie(cookieStore, request, payload = {}) {
  const token = await createUserToken(payload);
  cookieStore.set(USER_COOKIE, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: USER_TOKEN_TTL_SECONDS,
  });
  return token;
}

export function clearUserCookie(cookieStore) {
  cookieStore.delete(USER_COOKIE);
}

/**
 * Resolve the caller from a Next request: the `user_token` cookie, or an
 * `Authorization: Bearer <token>` header for non-browser clients.
 * Returns `{ userId, email }` or null. Never throws.
 */
export async function getUserSessionFromRequest(request) {
  if (!request) return null;
  try {
    const cookieToken = request.cookies?.get?.(USER_COOKIE)?.value;
    if (cookieToken) {
      const session = await verifyUserToken(cookieToken);
      if (session) return session;
    }
    const header = request.headers?.get?.("authorization");
    if (header && header.startsWith("Bearer ")) {
      const bearer = header.slice(7).trim();
      if (bearer) return await verifyUserToken(bearer);
    }
  } catch {
    return null;
  }
  return null;
}

/** The raw cookie value, for logout-time session revocation. */
export function getUserTokenFromRequest(request) {
  return request?.cookies?.get?.(USER_COOKIE)?.value || null;
}

/**
 * Resolve the caller to a live customer row: valid JWT *and* a session row that
 * is neither revoked nor expired. Route handlers use this (the middleware only
 * checks the signature), so logging out actually invalidates a copied token
 * instead of merely dropping the cookie.
 *
 * Returns `{ userId, email, user }` or null. Never throws.
 */
export async function resolveAccountUser(request) {
  let token = getUserTokenFromRequest(request);
  if (!token) {
    const header = request?.headers?.get?.("authorization");
    if (header?.startsWith("Bearer ")) token = header.slice(7).trim() || null;
  }
  return resolveTokenToAccount(token);
}

/**
 * Strict variant for server components, which only have a cookie store. A
 * suspended account or a revoked session therefore loses the shell on the next
 * navigation instead of keeping access until the JWT expires.
 */
export async function getAccountSession(cookieStore) {
  return resolveTokenToAccount(cookieStore?.get?.(USER_COOKIE)?.value || null);
}

async function resolveTokenToAccount(token) {
  if (!token) return null;
  const claims = await verifyUserToken(token);
  if (!claims) return null;
  try {
    const { getSessionByToken } = await import("@/lib/db/repos/userRepo.js");
    const session = await getSessionByToken(token);
    if (!session || session.userId !== claims.userId) return null;
    return { userId: session.userId, email: session.user.email, user: session.user };
  } catch {
    return null;
  }
}

