// Telegram Mini App launch data (spec telegram-link).
//
// Telegram hands a Mini App `initData`: a query string with the user, auth_date,
// start_param and a `hash`. The hash is HMAC-SHA256 over the data-check string
// (every field except `hash`, as `key=value`, sorted by key, joined with "\n"),
// keyed with HMAC-SHA256("WebAppData", botToken). Only someone holding the bot
// token can produce it, so a valid hash proves Telegram issued the data.
//
// Pure functions with relative-only imports: tests import this directly.

import crypto from "node:crypto";

/** Launch data older than this is refused, so a captured payload cannot be replayed later. */
export const INIT_DATA_MAX_AGE_SEC = 60 * 60;

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/** The hash Telegram would compute for `fields` (a Map/URLSearchParams minus `hash`). */
export function signInitData(params, botToken) {
  const pairs = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  // Sorted by key, as Telegram specifies (not by the whole "key=value" string).
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const secret = hmac("WebAppData", botToken);
  return hmac(secret, pairs.map(([key, value]) => `${key}=${value}`).join("\n")).toString("hex");
}

/**
 * Verify and parse Mini App init data.
 *
 * @returns {{ ok: true, user: { id: string, username: string|null, firstName: string|null }, startParam: string|null, authDate: number }
 *          | { ok: false, reason: "malformed"|"bad_hash"|"expired"|"no_user" }}
 */
export function verifyInitData(initData, botToken, { nowSec = Math.floor(Date.now() / 1000), maxAgeSec = INIT_DATA_MAX_AGE_SEC } = {}) {
  if (typeof initData !== "string" || !initData || initData.length > 8192) return { ok: false, reason: "malformed" };
  if (typeof botToken !== "string" || !botToken) return { ok: false, reason: "malformed" };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(signInitData(params, botToken), "hex");
  const given = Buffer.from(hash.toLowerCase(), "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_hash" };
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: "malformed" };
  // A little tolerance for clock skew in the future, none for age beyond the limit.
  if (nowSec - authDate > maxAgeSec || authDate - nowSec > 300) return { ok: false, reason: "expired" };

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!user || (typeof user.id !== "number" && typeof user.id !== "string") || !String(user.id).match(/^\d{1,20}$/)) {
    return { ok: false, reason: "no_user" };
  }

  return {
    ok: true,
    user: {
      id: String(user.id),
      username: typeof user.username === "string" && user.username ? user.username : null,
      firstName: typeof user.first_name === "string" && user.first_name ? user.first_name : null,
    },
    startParam: params.get("start_param") || null,
    authDate,
  };
}
