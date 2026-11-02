// In-memory progressive lockout for password logins. Resets on process restart.
//
// Every counter is a named bucket, scoped by the login it protects:
//   admin:ip:<ip>            admin password / SAML from one client
//   user:ip:<ip>             customer logins from one client
//   user:account:<email>     customer logins against one account, from anywhere
// A success clears only the bucket that the success proves something about. It
// used to clear the whole IP entry, shared by admin and customer login, so "4
// wrong guesses, then sign in to my own account" reset the count forever and
// made brute force of the admin password (or any customer's) unlimited.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";
import { forwardedClientIp } from "./clientIp.js";

const MAX_FAILS_BEFORE_LOCK = 5;
// Per account across all clients: higher, because anyone can fail against any
// address and a low threshold would let them lock the owner out.
const ACCOUNT_MAX_FAILS_BEFORE_LOCK = 10;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset
// A rotating attacker (new emails, new IPs) must not grow the map without bound.
const MAX_BUCKETS = 10_000;

// Survives dev hot-reload and is shared by every route bundle in the process.
if (!global._loginLimiter) global._loginLimiter = new Map();
const attempts = global._loginLimiter; // bucket → { fails, lockUntil, lockLevel, lastFailAt }

function now() { return Date.now(); }

function getEntry(key) {
  const e = attempts.get(key);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(key);
    return null;
  }
  return e;
}

export function checkLock(key) {
  const e = getEntry(key);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(key, { maxFails = MAX_FAILS_BEFORE_LOCK } = {}) {
  const e = getEntry(key) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= maxFails) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.delete(key);
  attempts.set(key, e); // re-insert: Map order then tracks recency for eviction
  while (attempts.size > MAX_BUCKETS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
  return { remainingBeforeLock: Math.max(0, maxFails - e.fails) };
}

export function recordSuccess(key) {
  attempts.delete(key);
}

// ── Scoped buckets for the login routes ─────────────────────────────────────

export function adminIpBucket(ip) {
  return { key: `admin:ip:${ip}`, maxFails: MAX_FAILS_BEFORE_LOCK };
}

export function userIpBucket(ip) {
  return { key: `user:ip:${ip}`, maxFails: MAX_FAILS_BEFORE_LOCK };
}

export function userAccountBucket(email) {
  return { key: `user:account:${String(email || "").trim().toLowerCase()}`, maxFails: ACCOUNT_MAX_FAILS_BEFORE_LOCK };
}

/** Locked if ANY bucket is; retryAfter is the longest wait among them. */
export function checkLocks(buckets) {
  let retryAfter = 0;
  for (const b of buckets) {
    const lock = checkLock(b.key);
    if (lock.locked) retryAfter = Math.max(retryAfter, lock.retryAfter);
  }
  return retryAfter > 0 ? { locked: true, retryAfter } : { locked: false };
}

/** Count one failure in every bucket; remaining = the closest one to locking. */
export function recordFails(buckets) {
  let remainingBeforeLock = Infinity;
  for (const b of buckets) {
    const res = recordFail(b.key, { maxFails: b.maxFails });
    remainingBeforeLock = Math.min(remainingBeforeLock, res.remainingBeforeLock);
  }
  return { remainingBeforeLock: Number.isFinite(remainingBeforeLock) ? remainingBeforeLock : MAX_FAILS_BEFORE_LOCK };
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-dr-real-ip");
    if (realIp) return realIp;
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = forwardedClientIp(request.headers.get("x-real-ip"), request.headers.get("x-forwarded-for"));
    if (forwarded) return forwarded;
  }
  // Direct exposure without custom-server: no trustworthy client address is
  // available. Collapsing everyone into one literal "unknown" bucket would let one
  // attacker lock out every login, so key on the best stable per-connection value
  // present. Unverified headers are only used as a bucketing input — never for
  // authorization — and rotating them costs the attacker a fresh bucket each time,
  // which is exactly what a per-client bucket is meant to isolate.
  return (
    request.headers.get("x-dr-real-ip") ||
    request.headers.get("host") ||
    "unknown"
  );
}
