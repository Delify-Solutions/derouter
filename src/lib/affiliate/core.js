// Affiliate identity: codes, attribution lookup, effective terms.
//
// SYNCHRONOUS + DRIVER-FREE (design D2): every function takes the adapter first
// and runs inside the caller's `db.transaction`. Relative imports only; never
// import ../../db/driver.js or a repo that does.
import {
  REFERRAL_CODE_LENGTH,
  REFERRAL_CODE_LENGTH_FALLBACK,
  generateReferralCode,
  normalizeReferralCode,
} from "./codes.js";
import { readAffiliateSettingsSync } from "./settings.js";

function nowIso() {
  return new Date().toISOString();
}

function isUniqueViolation(error) {
  const message = String(error?.message || "");
  return /UNIQUE constraint failed/i.test(message) || error?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** The affiliate row of one account, or null. */
export function getAffiliateSync(db, userId) {
  if (!db) throw new Error("getAffiliateSync requires the db adapter");
  if (!userId) return null;
  return db.get(`SELECT * FROM affiliates WHERE userId = ?`, [userId]) ?? null;
}

/**
 * The affiliate row for an account, created on first use (design D6: lazily, so
 * an account that never opens the page has no row).
 *
 * `crypto.randomInt` gives the code; UNIQUE(code) is the authority on uniqueness,
 * so a collision is retried rather than pre-checked. Six characters collide
 * rarely; after five failures the code grows to eight, which cannot realistically
 * collide again.
 *
 * @returns {object} the affiliate row (raw)
 */
export function ensureAffiliateSync(db, userId) {
  if (!db) throw new Error("ensureAffiliateSync requires the db adapter");
  if (!userId) throw new Error("ensureAffiliateSync requires a userId");

  const existing = getAffiliateSync(db, userId);
  if (existing) return existing;

  const at = nowIso();
  let length = REFERRAL_CODE_LENGTH;
  let lastError = null;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    if (attempt === 5) length = REFERRAL_CODE_LENGTH_FALLBACK;
    const code = generateReferralCode(length);
    try {
      db.run(
        `INSERT INTO affiliates(userId, code, rateBp, maxOrders, giftCodeId, status, clickCount, createdAt, updatedAt)
         VALUES(?, ?, NULL, NULL, NULL, 'active', 0, ?, ?)`,
        [userId, code, at, at]
      );
      return getAffiliateSync(db, userId);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either another writer created this account's row in the same instant, or
      // the code belongs to someone else. The former is not a retry case.
      const raced = getAffiliateSync(db, userId);
      if (raced) return raced;
      lastError = error;
    }
  }
  throw lastError || new Error("Could not allocate a referral code");
}

/**
 * Resolve a referral code to the referrer's user id, or null.
 *
 * Valid only when the program is enabled, the code belongs to an active
 * affiliate and that account still exists (spec "Registration records the
 * referrer": anything else registers without a referrer). Never says which
 * condition failed — the caller must not leak it.
 */
export function resolveReferrerSync(db, code, { settings = null } = {}) {
  if (!db) throw new Error("resolveReferrerSync requires the db adapter");
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;

  const s = settings || readAffiliateSettingsSync(db);
  if (s.affiliateEnabled !== true) return null;

  const affiliate = db.get(
    `SELECT a.userId, a.status, a.invitedAt FROM affiliates a WHERE a.code = ?`,
    [normalized]
  );
  // Invite-only mode: a link of an account the admin did not invite stops
  // recording new users (the account keeps its wallet and existing referrals).
  if (!linkActive(affiliate, s)) return null;

  const user = db.get(`SELECT id FROM users WHERE id = ?`, [affiliate.userId]);
  if (!user) return null;

  return affiliate.userId;
}

/** True when the program only admits affiliates an admin invited. */
export function isInviteOnly(settings) {
  return settings?.affiliateAccess === "invite";
}

/**
 * Whether this account may hold a referral link at all under the access mode:
 * every account in "open" mode, only invited ones in "invite" mode. Blocking and
 * the program switch are separate checks (see linkActive).
 */
export function mayRefer(affiliateRow, settings) {
  if (!isInviteOnly(settings)) return true;
  return Boolean(affiliateRow?.invitedAt);
}

/**
 * Whether an affiliate's link records new users right now: the program is on,
 * the affiliate is not blocked and the access mode admits it.
 */
export function linkActive(affiliateRow, settings) {
  if (settings?.affiliateEnabled !== true) return false;
  if (!affiliateRow || affiliateRow.status !== "active") return false;
  return mayRefer(affiliateRow, settings);
}

/**
 * Whether the customer area shows the "Giới thiệu" item for this account:
 * the program is on and the account may refer, or the account has something to
 * keep (wallet history, or users it already referred — those still earn
 * commission after invite-only mode leaves the account out).
 */
export function affiliateAreaAvailableSync(db, userId, settings = null) {
  if (!db) throw new Error("affiliateAreaAvailableSync requires the db adapter");
  if (!userId) return false;
  const s = settings || readAffiliateSettingsSync(db);
  if (s.affiliateEnabled === true) {
    if (!isInviteOnly(s)) return true;
    const row = getAffiliateSync(db, userId);
    if (row?.invitedAt) return true;
    if (row && db.get(`SELECT 1 AS x FROM users WHERE referredByUserId = ? LIMIT 1`, [userId])) return true;
  }
  return hasWalletHistorySync(db, userId);
}

/**
 * An affiliate's effective rate, first-N and welcome gift code: the affiliate's
 * own override when set, otherwise the program default (spec "Effective terms per
 * affiliate"). `settings` is the merged object from readAffiliateSettingsSync.
 */
export function effectiveTermsSync(affiliateRow, settings) {
  const rateBp = affiliateRow?.rateBp == null
    ? Number(settings?.affiliateDefaultRateBp ?? 0)
    : Number(affiliateRow.rateBp);
  const maxOrders = affiliateRow?.maxOrders == null
    ? Number(settings?.affiliateDefaultMaxOrders ?? 0)
    : Number(affiliateRow.maxOrders);
  const giftCodeId = affiliateRow?.giftCodeId == null || affiliateRow.giftCodeId === ""
    ? (settings?.affiliateDefaultGiftCodeId || null)
    : affiliateRow.giftCodeId;

  return { rateBp, maxOrders, giftCodeId };
}

/** True when this account holds wallet history (any ledger row, either currency). */
export function hasWalletHistorySync(db, userId) {
  if (!userId) return false;
  const row = db.get(`SELECT 1 AS x FROM affiliateLedger WHERE userId = ? LIMIT 1`, [userId]);
  if (row) return true;
  // A held commission is history too: the page must stay
  // reachable after the program is switched off (spec "Customer affiliate page").
  const commission = db.get(
    `SELECT 1 AS x FROM affiliateCommissions WHERE affiliateUserId = ? LIMIT 1`,
    [userId]
  );
  return Boolean(commission);
}

/**
 * The first VALID referral among `candidates`, in priority order: `{ code,
 * referrerId }` or null. Registration passes `[body.ref, cookie]` and the register
 * page passes `[?ref=, cookie]`, so a stale or mistyped `ref` falls through to a
 * valid cookie on BOTH sides: the banner the visitor saw and the binding the
 * account gets can never disagree.
 */
export function resolveFirstReferralSync(db, candidates, { settings = null } = {}) {
  const s = settings || readAffiliateSettingsSync(db);
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const code = normalizeReferralCode(candidate);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const referrerId = resolveReferrerSync(db, code, { settings: s });
    if (referrerId) return { code, referrerId };
  }
  return null;
}

/**
 * Whether opening `/r/<code>` should count a click: at most once per browser, so a
 * repeat click of the same link is not counted, while a newer valid link is
 * (spec "Referral link redirect").
 */
export function shouldCountClick(currentCode, code) {
  const incoming = normalizeReferralCode(code);
  if (!incoming) return false;
  return normalizeReferralCode(currentCode) !== incoming;
}

/** Mark a click on a referral link. The caller decides, with shouldCountClick. */
export function recordClickSync(db, userId) {
  if (!userId) return 0;
  db.run(
    `UPDATE affiliates SET clickCount = COALESCE(clickCount, 0) + 1, updatedAt = ? WHERE userId = ?`,
    [nowIso(), userId]
  );
  return 1;
}
