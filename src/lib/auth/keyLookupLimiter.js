// Throttle API-key guessing. Every endpoint that answers "is this key valid?"
// without a login — the LLM API (/v1/*) and the public usage page
// (/api/usage/key*) — counts unknown keys per client IP; past the limit that
// client gets 429 for a while, valid key or not. Only failures count, so a
// customer polling their own usage page is never throttled.
//
// Keys minted before the keyId was made long had ~31 bits of secret; this is
// what keeps those enumerable-in-principle keys out of reach.
//
// Only a trusted PUBLIC client address is limited. A private, loopback or missing
// address is what the app sees when the reverse proxy's client IP is not trusted
// (nginx on a Docker host without TRUST_PRIVATE_PROXY): every customer would
// share that one bucket, and one guesser would cut off the whole API.
// Relative imports only: tests import this directly.
import { hitLimit, peekLimit } from "./actionLimiter.js";
import { getRequestIp } from "./clientIp.js";

export const KEY_LOOKUP_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

/** Loopback, private, CGNAT/Tailscale, link-local or unique-local. */
export function isNonPublicAddress(address) {
  let ip = String(address || "").trim().toLowerCase();
  if (!ip) return true;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === "::1" || ip === "::" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

function bucketOf(request) {
  const ip = getRequestIp(request);
  if (isNonPublicAddress(ip)) return null;
  return `key-lookup:ip:${ip}`;
}

/** `{ limited, retryAfterSec }` for this client, without counting anything. */
export function keyLookupLimited(request, now = Date.now()) {
  const bucket = bucketOf(request);
  if (!bucket) return { limited: false, retryAfterSec: 0 };
  return peekLimit(bucket, { ...KEY_LOOKUP_LIMIT, now });
}

/** Count one unknown key against this client. */
export function recordKeyLookupMiss(request, now = Date.now()) {
  const bucket = bucketOf(request);
  if (bucket) hitLimit(bucket, { ...KEY_LOOKUP_LIMIT, now });
}
