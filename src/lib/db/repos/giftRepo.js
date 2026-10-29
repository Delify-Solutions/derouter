// Gift codes: admin-issued entitlements that a user redeems once (or up to
// `perUserLimit` times) for a plan, a credit grant, or both.
//
// Money is integer nanoUSD. Redemption is fully synchronous so it can run inside
// a single `db.transaction(...)` together with the billing grant it produces.

import { v4 as uuidv4 } from "uuid";
import { randomInt } from "crypto";
import { getAdapter } from "../driver.js";
import { grantUserPlan, listPlans } from "./billingRepo.js";
import { parseLimits } from "../../billing/limits.js";

// Human-typable alphabet: no 0/O/1/I/L, so codes survive being read aloud or
// copied off a screen by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 4;
const CODE_GROUP_SIZE = 4;

/** Uppercase and drop every separator so "k7qm-3xtp 9wfa" === "K7QM3XTP9WFA". */
export function normalizeGiftCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Render a normalised 16-char key as K7QM-3XTP-9WFA-2BHC. */
export function formatGiftCode(input) {
  const key = normalizeGiftCode(input);
  if (!key) return "";
  const chunks = [];
  for (let i = 0; i < key.length; i += CODE_GROUP_SIZE) {
    chunks.push(key.slice(i, i + CODE_GROUP_SIZE));
  }
  return chunks.join("-");
}

/** Generate one random code key (16 chars, no separators). */
export function generateGiftCode() {
  let out = "";
  for (let i = 0; i < CODE_GROUPS * CODE_GROUP_SIZE; i += 1) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function toMillis(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isUniqueViolation(error) {
  const message = String(error?.message || "");
  return /UNIQUE constraint failed/i.test(message) || error?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

class GiftError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "GiftError";
    this.reason = reason;
  }
}

function rowToGiftCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: normalizeGiftCode(row.code),
    displayCode: formatGiftCode(row.code),
    grantKind: row.grantKind,
    planId: row.planId ?? null,
    planName: row.planName ?? null,
    creditNanoUsd: row.creditNanoUsd ?? null,
    durationDays: row.durationDays ?? null,
    maxRedemptions: row.maxRedemptions ?? 1,
    redeemedCount: row.redeemedCount ?? 0,
    perUserLimit: row.perUserLimit ?? 1,
    startsAt: row.startsAt ?? null,
    expiresAt: row.expiresAt ?? null,
    isActive: row.isActive === 1 || row.isActive === true,
    note: row.note ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

// Codes are stored as typed (uppercased, separators kept for readability), so a
// lookup tries the exact key first and then compares normalised forms. The
// table is small and admin-managed; a scan is cheap and separator-agnostic.
function findGiftRowByCode(db, code) {
  const key = normalizeGiftCode(code);
  if (!key) return null;
  const exact = db.get(`SELECT * FROM giftCodes WHERE code = ?`, [key]);
  if (exact) return exact;
  const rows = db.all(`SELECT * FROM giftCodes`);
  return rows.find((r) => normalizeGiftCode(r.code) === key) || null;
}

function planRow(db, planId) {
  if (!planId) return null;
  return db.get(`SELECT * FROM plans WHERE id = ?`, [planId]) || null;
}

function inWindow(row, nowMs) {
  const startsAt = toMillis(row.startsAt);
  const expiresAt = toMillis(row.expiresAt);
  if (startsAt !== null && nowMs < startsAt) return false;
  if (expiresAt !== null && nowMs > expiresAt) return false;
  return true;
}

function validateGrantInput(input) {
  const grantKind = input.grantKind || (input.planId ? "plan" : "credit");
  if (grantKind !== "plan" && grantKind !== "credit") {
    throw new Error("grantKind must be 'plan' or 'credit'");
  }
  const hasPlan = Boolean(input.planId);
  const hasCredit = Number(input.creditNanoUsd) > 0;
  if (hasPlan === hasCredit) {
    throw new Error("Provide exactly one of planId or creditNanoUsd");
  }
  if (hasCredit) {
    if (!Number.isInteger(Number(input.creditNanoUsd)) || Number(input.creditNanoUsd) <= 0) {
      throw new Error("creditNanoUsd must be a positive integer");
    }
    if (!Number.isInteger(Number(input.durationDays)) || Number(input.durationDays) < 1) {
      throw new Error("durationDays must be at least 1 for credit grants");
    }
  }
  return {
    grantKind,
    planId: hasPlan ? input.planId : null,
    creditNanoUsd: hasCredit ? Number(input.creditNanoUsd) : null,
    durationDays: hasCredit ? Number(input.durationDays) : (input.durationDays ? Number(input.durationDays) : null),
  };
}

// perUserLimit >= 1, per the API contract. The limit is real: a code may be
// redeemed by the same account up to this many times, each redemption producing
// its own giftRedemptions row and its own billing grant. It is enforced by the
// synchronous claim transaction in redeemGiftCode, not by a table constraint,
// because the limit is per-code and admin-configurable.
function validatePerUserLimit(value) {
  const n = Number(value ?? 1);
  if (!Number.isInteger(n) || n < 1) throw new Error("perUserLimit must be at least 1");
  return n;
}

/** Create a gift code. Omit `code` to generate a readable one. */
export async function createGiftCode(input) {
  const db = await getAdapter();
  const grant = validateGrantInput(input || {});
  const maxRedemptions = Number(input?.maxRedemptions ?? 1);
  const perUserLimit = validatePerUserLimit(input?.perUserLimit);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
    throw new Error("maxRedemptions must be at least 1");
  }

  const requested = normalizeGiftCode(input?.code);
  let key = requested;
  if (!key) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateGiftCode();
      if (!findGiftRowByCode(db, candidate)) { key = candidate; break; }
    }
    if (!key) throw new Error("Could not allocate a unique gift code");
  } else if (findGiftRowByCode(db, key)) {
    throw new Error("That code already exists");
  }
  if (grant.grantKind === "plan") {
    const plan = planRow(db, grant.planId);
    if (!plan) throw new Error("Plan not found");
  }

  const now = nowIso();
  const gift = {
    id: uuidv4(),
    // Stored canonical: uppercase, no separators. formatGiftCode() adds the
    // readable dashes at every display edge.
    code: key,
    grantKind: grant.grantKind,
    planId: grant.planId,
    creditNanoUsd: grant.creditNanoUsd,
    durationDays: grant.durationDays,
    maxRedemptions,
    redeemedCount: 0,
    perUserLimit,
    startsAt: input?.startsAt || null,
    expiresAt: input?.expiresAt || null,
    isActive: input?.isActive === false ? 0 : 1,
    note: input?.note || null,
    createdBy: input?.createdBy || null,
    createdAt: now,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO giftCodes(id, code, grantKind, planId, creditNanoUsd, durationDays, maxRedemptions, redeemedCount, perUserLimit, startsAt, expiresAt, isActive, note, createdBy, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gift.id, gift.code, gift.grantKind, gift.planId, gift.creditNanoUsd, gift.durationDays,
      gift.maxRedemptions, gift.redeemedCount, gift.perUserLimit, gift.startsAt, gift.expiresAt,
      gift.isActive, gift.note, gift.createdBy, gift.createdAt, gift.updatedAt,
    ]
  );

  return rowToGiftCode({ ...gift, planName: planRow(db, gift.planId)?.name ?? null });
}

/** All gift codes, newest first, with the plan name resolved. */
export async function listGiftCodes() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT g.*, p.name AS planName
       FROM giftCodes g
       LEFT JOIN plans p ON p.id = g.planId
      ORDER BY g.createdAt DESC`
  );
  return rows.map(rowToGiftCode);
}

/**
 * Plans available to a gift code, for the admin picker. Delegates to the one
 * plans reader in billingRepo so the gift screen cannot drift from it: no
 * argument means every plan, inactive included, and the picker filters.
 */
export async function listGiftPlans() {
  const plans = await listPlans();
  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    name: plan.name ?? plan.code,
    creditNanoUsd: plan.creditNanoUsd ?? 0,
    durationDays: plan.durationDays ?? 0,
    isActive: plan.isActive === true,
  }));
}

export async function getGiftCodeById(id) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT g.*, p.name AS planName
       FROM giftCodes g
       LEFT JOIN plans p ON p.id = g.planId
      WHERE g.id = ?`,
    [id]
  );
  return rowToGiftCode(row);
}

/** Patch an existing gift code. Only the fields below are writable. */
export async function updateGiftCode(id, patch = {}) {
  const db = await getAdapter();
  let updated = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM giftCodes WHERE id = ?`, [id]);
    if (!row) return;
    const next = {
      planId: patch.planId !== undefined ? patch.planId : row.planId,
      creditNanoUsd: patch.creditNanoUsd !== undefined ? patch.creditNanoUsd : row.creditNanoUsd,
      durationDays: patch.durationDays !== undefined ? patch.durationDays : row.durationDays,
      maxRedemptions: patch.maxRedemptions !== undefined ? Number(patch.maxRedemptions) : row.maxRedemptions,
      perUserLimit: patch.perUserLimit !== undefined ? Number(patch.perUserLimit) : row.perUserLimit,
      startsAt: patch.startsAt !== undefined ? (patch.startsAt || null) : row.startsAt,
      expiresAt: patch.expiresAt !== undefined ? (patch.expiresAt || null) : row.expiresAt,
      isActive: patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : row.isActive,
      note: patch.note !== undefined ? (patch.note || null) : row.note,
    };
    if (!Number.isInteger(next.maxRedemptions) || next.maxRedemptions < 1) {
      throw new Error("maxRedemptions must be at least 1");
    }
    if (!Number.isInteger(next.perUserLimit) || next.perUserLimit < 1) {
      throw new Error("perUserLimit must be at least 1");
    }
    // A code grants exactly one thing. Re-derive grantKind from the effective
    // values so a patch can move a code from plan to credit (or back) without
    // ever leaving both set.
    const hasPlan = Boolean(next.planId);
    const hasCredit = Number(next.creditNanoUsd) > 0;
    if (hasPlan === hasCredit) {
      throw new Error("Provide exactly one of planId or creditNanoUsd");
    }
    if (hasCredit && (!Number.isInteger(next.durationDays) || next.durationDays < 1)) {
      throw new Error("durationDays must be at least 1 for credit grants");
    }
    const grantKind = hasPlan ? "plan" : "credit";
    db.run(
      `UPDATE giftCodes
          SET grantKind = ?, planId = ?, creditNanoUsd = ?, durationDays = ?,
              maxRedemptions = ?, perUserLimit = ?, startsAt = ?, expiresAt = ?, isActive = ?,
              note = ?, updatedAt = ?
        WHERE id = ?`,
      [
        grantKind, next.planId, next.creditNanoUsd, next.durationDays, next.maxRedemptions,
        next.perUserLimit, next.startsAt, next.expiresAt, next.isActive, next.note, nowIso(), id,
      ]
    );
    updated = rowToGiftCode({
      ...row,
      ...next,
      grantKind,
      planName: planRow(db, next.planId)?.name ?? null,
      updatedAt: nowIso(),
    });
  });
  return updated;
}

/** Soft delete: a redeemed code must keep its history, so deactivate instead. */
export async function deleteGiftCode(id) {
  const db = await getAdapter();
  const res = db.run(`UPDATE giftCodes SET isActive = 0, updatedAt = ? WHERE id = ?`, [nowIso(), id]);
  return (res?.changes ?? 0) > 0;
}

/** Redemption log. Pass a giftId to scope it to one code. */
export async function listRedemptions(giftId) {
  const db = await getAdapter();
  const base = `SELECT r.*, u.email AS userEmail, g.code AS giftCode, up.expiresAt AS planExpiresAt
                  FROM giftRedemptions r
                  LEFT JOIN users u ON u.id = r.userId
                  LEFT JOIN giftCodes g ON g.id = r.giftId
                  LEFT JOIN userPlans up ON up.id = r.userPlanId`;
  const rows = giftId
    ? db.all(`${base} WHERE r.giftId = ? ORDER BY r.redeemedAt DESC`, [giftId])
    : db.all(`${base} ORDER BY r.redeemedAt DESC LIMIT 500`);
  return rows.map((row) => ({
    id: row.id,
    giftId: row.giftId,
    giftCode: row.giftCode ? formatGiftCode(row.giftCode) : null,
    userId: row.userId,
    userEmail: row.userEmail ?? null,
    userPlanId: row.userPlanId ?? null,
    planExpiresAt: row.planExpiresAt ?? null,
    redeemedAt: row.redeemedAt ?? null,
  }));
}

/** A single user's own redemption history, newest first. */
export async function listUserRedemptions(userId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT r.id, r.giftId, r.userPlanId, r.redeemedAt,
            g.code AS giftCode, g.grantKind, g.creditNanoUsd, g.durationDays, g.planId,
            p.name AS planName,
            up.creditTotalNanoUsd AS grantedCreditNanoUsd,
            up.expiresAt AS planExpiresAt
       FROM giftRedemptions r
       JOIN giftCodes g ON g.id = r.giftId
       LEFT JOIN plans p ON p.id = g.planId
       LEFT JOIN userPlans up ON up.id = r.userPlanId
      WHERE r.userId = ?
      ORDER BY r.redeemedAt DESC`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    giftId: row.giftId,
    giftCode: row.giftCode ? formatGiftCode(row.giftCode) : null,
    userPlanId: row.userPlanId ?? null,
    redeemedAt: row.redeemedAt ?? null,
    grantKind: row.grantKind,
    planName: row.planName ?? null,
    creditNanoUsd: row.grantedCreditNanoUsd ?? row.creditNanoUsd ?? null,
    durationDays: row.durationDays ?? null,
    expiresAt: row.planExpiresAt ?? null,
  }));
}

/**
 * Redeem a code for a user. Fully synchronous: call it inside the caller's
 * `db.transaction(...)` so the redemption row, the counter bump and the billing
 * grant commit (or roll back) together.
 *
 * @returns {{ok: true, userPlan: object, appliedToOverdraftNanoUsd: number}
 *          | {ok: false, reason: "not_found"|"not_active"|"exhausted"|"already_redeemed"|"invalid_plan"}}
 */
export function redeemGiftCode(db, { userId, code } = {}) {
  if (!db) throw new Error("redeemGiftCode requires a db adapter");
  if (!userId) return { ok: false, reason: "not_found" };

  const row = findGiftRowByCode(db, code);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.isActive !== 1 && row.isActive !== true) return { ok: false, reason: "not_found" };
  if (!inWindow(row, Date.now())) return { ok: false, reason: "not_active" };
  if ((row.redeemedCount ?? 0) >= (row.maxRedemptions ?? 1)) return { ok: false, reason: "exhausted" };

  let grant;
  if (row.grantKind === "plan") {
    const plan = planRow(db, row.planId);
    if (!plan || (plan.isActive !== 1 && plan.isActive !== true)) {
      return { ok: false, reason: "invalid_plan" };
    }
    grant = {
      planId: plan.id,
      creditNanoUsd: Number(plan.creditNanoUsd) || 0,
      durationDays: Number(plan.durationDays) || 30,
      planName: plan.name ?? null,
      // A plan gift snapshots the plan's limits at grant time (spec
      // plan-queue-billing "Each grant creates an independent purchased plan").
      limits: parseLimits(plan.limits),
    };
  } else {
    const credit = Number(row.creditNanoUsd) || 0;
    if (credit <= 0) return { ok: false, reason: "invalid_plan" };
    grant = {
      planId: row.planId || null,
      creditNanoUsd: credit,
      durationDays: Number(row.durationDays) || 30,
      planName: null,
      // A credit-only gift has no windows: it is money, not a plan.
      limits: [],
    };
  }

  const now = nowIso();
  const redemptionId = uuidv4();

  // The claim (redemption row + counter bump) and the grant commit or roll back
  // together. The savepoint makes redeemGiftCode atomic even when the caller
  // does not wrap it in its own transaction; nesting into the caller's
  // transaction still works because every adapter supports savepoints.
  try {
    return db.transaction(() => {
      // Explicit per-user limit: giftRedemptions has no UNIQUE(giftId, userId)
      // (the limit is configurable, so a constraint cannot express it). Counting
      // inside the savepoint is race-free because every adapter is synchronous —
      // no other request can interleave between this read and the inserts below.
      const perUser = Math.max(1, Number(row.perUserLimit) || 1);
      const mine = db.get(
        `SELECT COUNT(*) AS c FROM giftRedemptions WHERE giftId = ? AND userId = ?`,
        [row.id, userId]
      );
      if ((mine?.c ?? 0) >= perUser) return { ok: false, reason: "already_redeemed" };

      db.run(
        `INSERT INTO giftRedemptions(id, giftId, userId, userPlanId, redeemedAt) VALUES(?, ?, ?, NULL, ?)`,
        [redemptionId, row.id, userId, now]
      );
      // Conditional bump: the last slot cannot be sold twice even if the
      // counter read above was stale.
      const res = db.run(
        `UPDATE giftCodes SET redeemedCount = redeemedCount + 1, updatedAt = ?
          WHERE id = ? AND (maxRedemptions IS NULL OR redeemedCount < maxRedemptions)`,
        [now, row.id]
      );
      if ((res?.changes ?? 0) === 0) throw new GiftError("exhausted");

      const granted = grantUserPlan(db, {
        userId,
        planId: grant.planId,
        orderId: null,
        source: "gift",
        creditNanoUsd: grant.creditNanoUsd,
        durationDays: grant.durationDays,
        limits: grant.limits ?? [],
        meta: { giftId: row.id, giftRedemptionId: redemptionId, giftCode: formatGiftCode(row.code) },
      });

      db.run(
        `UPDATE giftRedemptions SET userPlanId = ? WHERE id = ?`,
        [granted.userPlan?.id ?? null, redemptionId]
      );

      return {
        ok: true,
        userPlan: granted.userPlan,
        appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd ?? 0,
        planName: grant.planName,
      };
    });
  } catch (error) {
    if (error instanceof GiftError) return { ok: false, reason: error.reason };
    // Belt and braces: the schema no longer declares UNIQUE(giftId, userId),
    // but if a future schema re-adds it, a collision there still means this
    // account already reached the allowed number of redemptions.
    if (isUniqueViolation(error) && /giftRedemptions/i.test(String(error?.message))) {
      return { ok: false, reason: "already_redeemed" };
    }
    throw error;
  }
}
