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
import { effectiveRate } from "../../billing/planQueue.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
// The redeemability window, shared with the affiliate welcome-gift check so an
// advertised code is always one redeemGiftCode would accept (design D7).
import { inWindow } from "../../gift/window.js";
import { topupCreditForAmount } from "../../billing/topup.js";
import { insertAuditSync } from "../../billing/audit.js";

export { inWindow };

// Human-typable alphabet: no 0/O/1/I/L, so codes survive being read aloud or
// copied off a screen by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 4;
const CODE_GROUP_SIZE = 4;

/** Uppercase and drop every separator so "k7qm-3xtp 9wfa" === "K7QM3XTP9WFA". */
export function normalizeGiftCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Bounds of a code the admin types (e.g. WELCOME2026). Short codes are guessable. */
export const CUSTOM_CODE_MIN = 4;
export const CUSTOM_CODE_MAX = 32;

/**
 * Vietnamese error for an admin-typed code, or null when it is acceptable.
 * Letters, digits, dashes and spaces only (separators are dropped on save), and
 * 4–32 characters once normalised.
 */
export function customCodeError(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9 -]+$/.test(raw)) return "Mã chỉ gồm chữ không dấu, số và dấu gạch ngang";
  const key = normalizeGiftCode(raw);
  if (key.length < CUSTOM_CODE_MIN || key.length > CUSTOM_CODE_MAX) {
    return `Mã phải dài từ ${CUSTOM_CODE_MIN} đến ${CUSTOM_CODE_MAX} ký tự (không tính dấu gạch)`;
  }
  return null;
}

/**
 * Display form of a stored code. A generated 16-char key reads best in fours
 * (K7QM-3XTP-9WFA-2BHC); a code the admin chose (WELCOME2026) is shown as is.
 */
export function formatGiftCode(input) {
  const key = normalizeGiftCode(input);
  if (!key) return "";
  if (key.length !== CODE_GROUPS * CODE_GROUP_SIZE) return key;
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

function isUniqueViolation(error) {
  const message = String(error?.message || "");
  return /UNIQUE constraint failed/i.test(message) || error?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

const KIND_CLASH_TEXT = "Một mã chỉ chọn một loại: mã người mới hoặc mã tham gia kênh Telegram";

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
    // Top-up plan gift: the amount in đồng the credit is computed from.
    amountVnd: row.amountVnd == null ? null : Number(row.amountVnd),
    // Credit that amount buys at the plan's current rate (list/preview only;
    // redemption recomputes it).
    amountCreditNanoUsd: row.amountVnd == null ? null : topupCreditForAmount({
      priceVnd: row.planPriceVnd, creditNanoUsd: row.planCreditNanoUsd, unlimitedCredit: row.planUnlimited,
    }, row.amountVnd),
    durationDays: row.durationDays ?? null,
    maxRedemptions: row.maxRedemptions ?? 1,
    redeemedCount: row.redeemedCount ?? 0,
    perUserLimit: row.perUserLimit ?? 1,
    startsAt: row.startsAt ?? null,
    expiresAt: row.expiresAt ?? null,
    isActive: row.isActive === 1 || row.isActive === true,
    newUserOnly: Number(row.newUserOnly) === 1,
    // Channel-join code (change channel-gift) and "listed on the gift page".
    channelJoinOnly: Number(row.channelJoinOnly) === 1,
    listed: Number(row.listed) === 1,
    // RPM/TPM written onto each purchase this code grants. null = the plan's own
    // (none for a credit gift); 0 = no limit.
    rpm: row.rpm == null ? null : Number(row.rpm),
    tpm: row.tpm == null ? null : Number(row.tpm),
    note: row.note ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

// Codes are stored as typed (uppercased, separators kept for readability), so a
// lookup tries the exact key first and then compares normalised forms. The
// table is small and admin-managed; a scan is cheap and separator-agnostic.
// Deleted codes are skipped: their string was freed on delete (see deleteGiftCode).
function findGiftRowByCode(db, code) {
  const key = normalizeGiftCode(code);
  if (!key) return null;
  const exact = db.get(`SELECT * FROM giftCodes WHERE code = ? AND deletedAt IS NULL`, [key]);
  if (exact) return exact;
  const rows = db.all(`SELECT * FROM giftCodes WHERE deletedAt IS NULL`);
  return rows.find((r) => normalizeGiftCode(r.code) === key) || null;
}

// A soft-deleted code keeps its row (redemption history points at it) but gives
// its string back, so the admin can create a new code with the same string. The
// stored value becomes `<CODE>~deleted~<id>`: UNIQUE still holds, and a customer
// can never type it (input is normalised to A-Z0-9).
const DELETED_MARK = "~deleted~";

/** The code as the customer knew it, also for a deleted code. */
export function liveGiftCode(stored) {
  const text = String(stored ?? "");
  const at = text.indexOf(DELETED_MARK);
  return at === -1 ? text : text.slice(0, at);
}

function readSettingsDataSync(db) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) || {} : {};
}

function writeSettingsDataSync(db, data) {
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [stringifyJson(data)]
  );
}

/**
 * Where a code is used outside its own row (spec gift-codes "Delete a gift
 * code"): the referral program's default welcome gift, CTV welcome-gift
 * overrides (both by id), and the promo popup (by code string).
 */
/**
 * The `usage` summary every admin-facing gift row carries (list, single read,
 * create, update), so the delete dialog can always name what it will unlink.
 * `counts` = affiliates per gift id, precomputed by the list for the whole page.
 */
function usageSummarySync(db, giftRow, settings, counts = null) {
  const popupKey = normalizeGiftCode(settings.landingCopy?.popupCode);
  const affiliateCount = counts
    ? counts.get(giftRow.id) ?? 0
    : Number(db.get(`SELECT COUNT(*) AS n FROM affiliates WHERE giftCodeId = ?`, [giftRow.id])?.n ?? 0);
  return {
    referralDefault: settings.affiliateDefaultGiftCodeId === giftRow.id,
    affiliateCount,
    popup: Boolean(popupKey) && popupKey === normalizeGiftCode(giftRow.code),
  };
}

/** One admin gift row with its usage, or null. */
function giftWithUsageSync(db, row) {
  if (!row) return null;
  return { ...rowToGiftCode(row), usage: usageSummarySync(db, row, readSettingsDataSync(db)) };
}

export function giftCodeUsageSync(db, giftRow, data = null) {
  const settings = data || readSettingsDataSync(db);
  const popupKey = normalizeGiftCode(settings.landingCopy?.popupCode);
  return {
    referralDefault: Boolean(giftRow?.id) && settings.affiliateDefaultGiftCodeId === giftRow.id,
    affiliates: db.all(
      `SELECT a.userId, a.code, u.email FROM affiliates a LEFT JOIN users u ON u.id = a.userId
        WHERE a.giftCodeId = ? ORDER BY a.createdAt, a.rowid`,
      [giftRow.id]
    ),
    popup: Boolean(popupKey) && popupKey === normalizeGiftCode(giftRow.code),
  };
}

function planRow(db, planId) {
  if (!planId) return null;
  return db.get(`SELECT * FROM plans WHERE id = ?`, [planId]) || null;
}

/**
 * An amount may only be attached to a plan that is sold by custom amount, and the
 * amount must buy some credit at its rate. Throws a Vietnamese message otherwise.
 */
function assertAmountPlan(plan, amountVnd) {
  if (amountVnd == null) return;
  if (!plan || Number(plan.allowCustomAmount) !== 1) {
    throw new Error("Chỉ gói nạp số tiền tùy ý mới tặng theo số tiền");
  }
  if (topupCreditForAmount(plan, amountVnd) <= 0) {
    throw new Error("Số tiền quá nhỏ để quy đổi ra credit");
  }
}

// The plan columns a gift row needs to preview its top-up credit.
const GIFT_SELECT = `SELECT g.*, p.name AS planName, p.priceVnd AS planPriceVnd,
         p.creditNanoUsd AS planCreditNanoUsd, p.unlimitedCredit AS planUnlimited
    FROM giftCodes g
    LEFT JOIN plans p ON p.id = g.planId`;

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
  const hasAmount = input.amountVnd !== undefined && input.amountVnd !== null && input.amountVnd !== "";
  if (hasAmount) {
    if (!hasPlan) throw new Error("Số tiền chỉ dùng cho mã tặng gói nạp tùy ý");
    if (!Number.isSafeInteger(Number(input.amountVnd)) || Number(input.amountVnd) <= 0) {
      throw new Error("Số tiền phải là số đồng nguyên dương");
    }
  }
  return {
    grantKind,
    planId: hasPlan ? input.planId : null,
    amountVnd: hasAmount ? Number(input.amountVnd) : null,
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

const GIFT_RATE_MAX = 1_000_000_000;

/**
 * An RPM/TPM field of a gift code: undefined = not given, null/"" = the plan's own
 * (no limit for a credit gift), else an integer 0 (no limit) … GIFT_RATE_MAX.
 */
function parseGiftRate(value, label) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  const digits = typeof value === "number" ? Number.isInteger(value) : typeof value === "string" && /^\d{1,10}$/.test(value.trim());
  const n = digits ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > GIFT_RATE_MAX) {
    throw new Error(`${label} phải là số nguyên từ 0 đến ${GIFT_RATE_MAX.toLocaleString("vi-VN")} (để trống = theo gói)`);
  }
  return n;
}

/**
 * An unlimited-credit plan is bounded only by its window limits and its RPM/TPM
 * (spec plan-queue-billing "Unlimited-credit plans"). A gift of such a plan must
 * not hand out a purchase with neither: its own RPM/TPM override counts, else
 * the plan's. Returns a Vietnamese message, or null when the gift keeps a bound.
 */
function unboundedGiftError(plan, { rpm, tpm }) {
  if (!plan || Number(plan.unlimitedCredit) !== 1) return null;
  if (parseLimits(plan.limits).length > 0) return null;
  if (effectiveRate(rpm, plan.rpm) != null || effectiveRate(tpm, plan.tpm) != null) return null;
  return "Gói không giới hạn credit cần ít nhất một hạn mức: mã này không được bỏ cả RPM và TPM khi gói không có hạn mức theo khung giờ";
}

/** Create a gift code. Omit `code` to generate a readable one. */
export async function createGiftCode(input) {
  const db = await getAdapter();
  const grant = validateGrantInput(input || {});
  const maxRedemptions = Number(input?.maxRedemptions ?? 1);
  const newUserOnly = input?.newUserOnly === true;
  const channelJoinOnly = input?.channelJoinOnly === true;
  if (newUserOnly && channelJoinOnly) throw new Error(KIND_CLASH_TEXT);
  // A new-user or channel-join code is one per account by definition (design D5).
  const perUserLimit = newUserOnly || channelJoinOnly ? 1 : validatePerUserLimit(input?.perUserLimit);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
    throw new Error("maxRedemptions must be at least 1");
  }
  const rpm = parseGiftRate(input?.rpm, "RPM") ?? null;
  const tpm = parseGiftRate(input?.tpm, "TPM") ?? null;

  const codeError = customCodeError(input?.code);
  if (codeError) throw new Error(codeError);
  const requested = normalizeGiftCode(input?.code);
  let key = requested;
  if (!key) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateGiftCode();
      if (!findGiftRowByCode(db, candidate)) { key = candidate; break; }
    }
    if (!key) throw new Error("Could not allocate a unique gift code");
  } else {
    const clash = findGiftRowByCode(db, key);
    if (clash) throw new Error("Mã này đã tồn tại");
  }
  if (grant.grantKind === "plan") {
    const plan = planRow(db, grant.planId);
    if (!plan) throw new Error("Plan not found");
    assertAmountPlan(plan, grant.amountVnd);
    const unbounded = unboundedGiftError(plan, { rpm, tpm });
    if (unbounded) throw new Error(unbounded);
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
    amountVnd: grant.amountVnd,
    durationDays: grant.durationDays,
    maxRedemptions,
    redeemedCount: 0,
    perUserLimit,
    startsAt: input?.startsAt || null,
    expiresAt: input?.expiresAt || null,
    isActive: input?.isActive === false ? 0 : 1,
    newUserOnly: newUserOnly ? 1 : 0,
    channelJoinOnly: channelJoinOnly ? 1 : 0,
    listed: input?.listed === true ? 1 : 0,
    rpm,
    tpm,
    note: input?.note || null,
    createdBy: input?.createdBy || null,
    createdAt: now,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO giftCodes(id, code, grantKind, planId, creditNanoUsd, amountVnd, durationDays, maxRedemptions, redeemedCount, perUserLimit, startsAt, expiresAt, isActive, newUserOnly, channelJoinOnly, listed, rpm, tpm, note, createdBy, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gift.id, gift.code, gift.grantKind, gift.planId, gift.creditNanoUsd, gift.amountVnd, gift.durationDays,
      gift.maxRedemptions, gift.redeemedCount, gift.perUserLimit, gift.startsAt, gift.expiresAt,
      gift.isActive, gift.newUserOnly, gift.channelJoinOnly, gift.listed, gift.rpm, gift.tpm, gift.note,
      gift.createdBy, gift.createdAt, gift.updatedAt,
    ]
  );

  return giftWithUsageSync(db, db.get(`${GIFT_SELECT} WHERE g.id = ?`, [gift.id]));
}

/** All gift codes, newest first, with the plan name resolved. */
export async function listGiftCodes() {
  const db = await getAdapter();
  const rows = db.all(`${GIFT_SELECT} WHERE g.deletedAt IS NULL ORDER BY g.createdAt DESC`);
  // Where each code is referenced, so the delete dialog can say what it unlinks.
  // One settings read and one grouped query for the whole list.
  const settings = readSettingsDataSync(db);
  const affiliateCounts = new Map(
    db.all(`SELECT giftCodeId, COUNT(*) AS n FROM affiliates WHERE giftCodeId IS NOT NULL GROUP BY giftCodeId`)
      .map((row) => [row.giftCodeId, Number(row.n)])
  );
  return rows.map((row) => ({
    ...rowToGiftCode(row),
    usage: usageSummarySync(db, row, settings, affiliateCounts),
  }));
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
    unlimitedCredit: plan.unlimitedCredit === true,
    durationDays: plan.durationDays ?? 0,
    isActive: plan.isActive === true,
    // A custom-amount plan can be gifted as an amount in đồng at this rate.
    allowCustomAmount: plan.allowCustomAmount === true,
    priceVnd: plan.priceVnd ?? null,
  }));
}

export async function getGiftCodeById(id) {
  const db = await getAdapter();
  return giftWithUsageSync(db, db.get(`${GIFT_SELECT} WHERE g.id = ? AND g.deletedAt IS NULL`, [id]));
}

/**
 * Patch an existing gift code (spec gift-codes "Edit a gift code"): every field,
 * the code string and what it grants included. A change applies to LATER
 * redemptions only: what earlier redeemers received is a purchase of its own
 * and stays as granted. The total may not drop below the redemptions made.
 */
export async function updateGiftCode(id, patch = {}) {
  const db = await getAdapter();
  let updated = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM giftCodes WHERE id = ? AND deletedAt IS NULL`, [id]);
    if (!row) return;
    const next = {
      planId: patch.planId !== undefined ? (patch.planId || null) : row.planId,
      creditNanoUsd: patch.creditNanoUsd !== undefined
        ? (patch.creditNanoUsd === null || patch.creditNanoUsd === "" ? null : Number(patch.creditNanoUsd))
        : row.creditNanoUsd,
      amountVnd: patch.amountVnd !== undefined
        ? (patch.amountVnd === null || patch.amountVnd === "" ? null : Number(patch.amountVnd))
        : row.amountVnd,
      durationDays: patch.durationDays !== undefined
        ? (patch.durationDays === null || patch.durationDays === "" ? null : Number(patch.durationDays))
        : row.durationDays,
      maxRedemptions: patch.maxRedemptions !== undefined ? Number(patch.maxRedemptions) : row.maxRedemptions,
      perUserLimit: patch.perUserLimit !== undefined ? Number(patch.perUserLimit) : row.perUserLimit,
      startsAt: patch.startsAt !== undefined ? (patch.startsAt || null) : row.startsAt,
      expiresAt: patch.expiresAt !== undefined ? (patch.expiresAt || null) : row.expiresAt,
      isActive: patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : row.isActive,
      newUserOnly: patch.newUserOnly !== undefined ? (patch.newUserOnly === true ? 1 : 0) : (Number(row.newUserOnly) === 1 ? 1 : 0),
      channelJoinOnly: patch.channelJoinOnly !== undefined
        ? (patch.channelJoinOnly === true ? 1 : 0)
        : (Number(row.channelJoinOnly) === 1 ? 1 : 0),
      listed: patch.listed !== undefined ? (patch.listed === true ? 1 : 0) : (Number(row.listed) === 1 ? 1 : 0),
      rpm: patch.rpm !== undefined ? parseGiftRate(patch.rpm, "RPM") : (row.rpm ?? null),
      tpm: patch.tpm !== undefined ? parseGiftRate(patch.tpm, "TPM") : (row.tpm ?? null),
      note: patch.note !== undefined ? (patch.note || null) : row.note,
      code: row.code,
    };

    // The code string itself: same rule as a new code, and unique among the
    // codes that are not deleted (a deleted code gave its string back).
    if (patch.code !== undefined && normalizeGiftCode(patch.code) !== normalizeGiftCode(row.code)) {
      const codeError = customCodeError(patch.code);
      if (codeError) throw new Error(codeError);
      const key = normalizeGiftCode(patch.code);
      if (!key) throw new Error("Mã không được để trống");
      const clash = findGiftRowByCode(db, key);
      if (clash && clash.id !== id) throw new Error("Mã này đã tồn tại");
      next.code = key;
    }

    if (next.newUserOnly === 1 && next.channelJoinOnly === 1) throw new Error(KIND_CLASH_TEXT);
    // A new-user or channel-join code is one per account by definition (design D5).
    if (next.newUserOnly === 1 || next.channelJoinOnly === 1) next.perUserLimit = 1;
    if (!Number.isInteger(next.maxRedemptions) || next.maxRedemptions < 1) {
      throw new Error("maxRedemptions must be at least 1");
    }
    const redeemed = Number(row.redeemedCount) || 0;
    if (next.maxRedemptions < redeemed) {
      throw new Error(`Tổng lượt dùng không được nhỏ hơn số lượt đã dùng (${redeemed})`);
    }
    if (!Number.isInteger(next.perUserLimit) || next.perUserLimit < 1) {
      throw new Error("perUserLimit must be at least 1");
    }
    if (next.startsAt && next.expiresAt && next.startsAt > next.expiresAt) {
      throw new Error("Ngày bắt đầu phải trước ngày hết hạn");
    }
    // A code grants exactly one thing. Re-derive grantKind from the effective
    // values so a patch can move a code from plan to credit (or back) without
    // ever leaving both set.
    const hasPlan = Boolean(next.planId);
    const hasCredit = Number(next.creditNanoUsd) > 0;
    if (hasPlan === hasCredit) {
      throw new Error("Provide exactly one of planId or creditNanoUsd");
    }
    if (hasCredit) {
      if (!Number.isSafeInteger(next.creditNanoUsd)) throw new Error("creditNanoUsd must be a positive integer");
      if (!Number.isInteger(next.durationDays) || next.durationDays < 1) {
        throw new Error("durationDays must be at least 1 for credit grants");
      }
    }
    const grantKind = hasPlan ? "plan" : "credit";
    if (!hasPlan) next.amountVnd = null;
    if (hasPlan) next.creditNanoUsd = null;
    if (next.amountVnd != null && (!Number.isSafeInteger(next.amountVnd) || next.amountVnd <= 0)) {
      throw new Error("Số tiền phải là số đồng nguyên dương");
    }
    if (hasPlan) {
      const plan = planRow(db, next.planId);
      if (!plan) throw new Error("Plan not found");
      // The amount rule is checked when the grant is set or changed. An edit of
      // other fields (a note, more uses) must not be blocked because the plan
      // has since stopped selling custom amounts; redemption still refuses an
      // amount the plan can no longer convert.
      const grantChanged = next.planId !== row.planId || (next.amountVnd ?? null) !== (row.amountVnd == null ? null : Number(row.amountVnd));
      if (grantChanged) assertAmountPlan(plan, next.amountVnd);
      const unbounded = unboundedGiftError(plan, next);
      if (unbounded) throw new Error(unbounded);
    }
    db.run(
      `UPDATE giftCodes
          SET code = ?, grantKind = ?, planId = ?, creditNanoUsd = ?, amountVnd = ?, durationDays = ?,
              maxRedemptions = ?, perUserLimit = ?, startsAt = ?, expiresAt = ?, isActive = ?,
              newUserOnly = ?, channelJoinOnly = ?, listed = ?, rpm = ?, tpm = ?, note = ?, updatedAt = ?
        WHERE id = ?`,
      [
        next.code, grantKind, next.planId, next.creditNanoUsd, next.amountVnd, next.durationDays, next.maxRedemptions,
        next.perUserLimit, next.startsAt, next.expiresAt, next.isActive, next.newUserOnly, next.channelJoinOnly,
        next.listed, next.rpm, next.tpm, next.note, nowIso(), id,
      ]
    );
    // The promo popup names its code by string: a rename carries it along so
    // the popup keeps pointing at this code.
    if (next.code !== row.code) {
      const data = readSettingsDataSync(db);
      const popupKey = normalizeGiftCode(data.landingCopy?.popupCode);
      if (popupKey && popupKey === normalizeGiftCode(row.code)) {
        writeSettingsDataSync(db, { ...data, landingCopy: { ...data.landingCopy, popupCode: next.code } });
      }
    }
    updated = giftWithUsageSync(db, db.get(`${GIFT_SELECT} WHERE g.id = ?`, [id]));
  });
  return updated;
}

/**
 * Delete a gift code (spec gift-codes "Delete a gift code"). A code nobody
 * redeemed is removed outright. A redeemed one is soft-deleted: hidden from the
 * admin list and never redeemable again, while its redemption history and the
 * purchases it granted stay intact; its string is freed for a new code.
 *
 * In the same transaction the code is unlinked from every place that uses it:
 * the referral default gift and the promo popup code are cleared, and each CTV
 * override is cleared (audited on that CTV as `affiliate_updated`).
 *
 * @returns {Promise<{ deleted: "hard"|"soft", unlinked: { referralDefault: boolean, affiliates: number, popup: boolean } } | null>}
 *   null = no such code
 */
export async function deleteGiftCode(id, { actor = "admin" } = {}) {
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(`SELECT id, code FROM giftCodes WHERE id = ? AND deletedAt IS NULL`, [id]);
    if (!row) return null;
    const at = nowIso();

    const data = readSettingsDataSync(db);
    const usage = giftCodeUsageSync(db, row, data);
    if (usage.referralDefault || usage.popup) {
      const next = { ...data };
      if (usage.referralDefault) next.affiliateDefaultGiftCodeId = "";
      if (usage.popup) next.landingCopy = { ...data.landingCopy, popupCode: "" };
      writeSettingsDataSync(db, next);
    }
    const label = formatGiftCode(row.code);
    for (const affiliate of usage.affiliates) {
      db.run(`UPDATE affiliates SET giftCodeId = NULL, updatedAt = ? WHERE userId = ?`, [at, affiliate.userId]);
      insertAuditSync(db, {
        userId: affiliate.userId,
        actor,
        action: "affiliate_updated",
        reason: `Mã quà ${label} đã bị xóa`,
        details: { before: { giftCodeId: id }, after: { giftCodeId: null } },
        now: at,
      });
    }
    const unlinked = {
      referralDefault: usage.referralDefault,
      affiliates: usage.affiliates.length,
      popup: usage.popup,
    };

    const used = db.get(`SELECT COUNT(*) AS n FROM giftRedemptions WHERE giftId = ?`, [id]);
    if (Number(used?.n ?? 0) === 0) {
      db.run(`DELETE FROM giftCodes WHERE id = ?`, [id]);
      return { deleted: "hard", unlinked };
    }
    db.run(
      `UPDATE giftCodes SET code = ?, isActive = 0, deletedAt = ?, updatedAt = ? WHERE id = ?`,
      [`${row.code}${DELETED_MARK}${id}`, at, at, id]
    );
    return { deleted: "soft", unlinked };
  });
}

/** Redemption log. Pass a giftId to scope it to one code. */
export async function listRedemptions(giftId) {
  const db = await getAdapter();
  const base = `SELECT r.*, u.email AS userEmail, u.telegramUsername AS userTelegramUsername,
                       u.telegramUserId AS userTelegramUserId, g.code AS giftCode, up.expiresAt AS planExpiresAt
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
    giftCode: row.giftCode ? formatGiftCode(liveGiftCode(row.giftCode)) : null,
    userId: row.userId,
    userEmail: row.userEmail ?? null,
    userPlanId: row.userPlanId ?? null,
    planExpiresAt: row.planExpiresAt ?? null,
    redeemedAt: row.redeemedAt ?? null,
    // Set when the admin gave the code straight to this account.
    assignedBy: row.assignedBy ?? null,
    // Telegram user recorded at redemption; the username is the account's
    // current one, shown only while it still belongs to that same Telegram user.
    telegramUserId: row.telegramUserId ?? null,
    telegramUsername: row.telegramUserId && row.telegramUserId === row.userTelegramUserId
      ? row.userTelegramUsername ?? null
      : null,
  }));
}

/** A single user's own redemption history, newest first. */
export async function listUserRedemptions(userId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT r.id, r.giftId, r.userPlanId, r.redeemedAt, r.assignedBy,
            g.code AS giftCode, g.grantKind, g.creditNanoUsd, g.durationDays, g.planId,
            p.name AS planName,
            up.creditTotalNanoUsd AS grantedCreditNanoUsd,
            up.unlimitedCredit AS grantedUnlimited,
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
    giftCode: row.giftCode ? formatGiftCode(liveGiftCode(row.giftCode)) : null,
    userPlanId: row.userPlanId ?? null,
    redeemedAt: row.redeemedAt ?? null,
    grantKind: row.grantKind,
    planName: row.planName ?? null,
    creditNanoUsd: row.grantedCreditNanoUsd ?? row.creditNanoUsd ?? null,
    unlimitedCredit: Number(row.grantedUnlimited) === 1,
    durationDays: row.durationDays ?? null,
    expiresAt: row.planExpiresAt ?? null,
    assignedByAdmin: Boolean(row.assignedBy),
  }));
}

/**
 * Why `userId` may not take a new-user code, or null when it may (design D3).
 * Ordered so that only a refusal linking Telegram can fix says
 * "telegram_required": an account that already bought a plan is told so first.
 */
export function newUserRefusalSync(db, userId, telegramUserId) {
  const purchased = db.get(
    `SELECT 1 AS x FROM userPlans WHERE userId = ? AND source = 'purchase' LIMIT 1`,
    [userId]
  );
  const priorWelcome = db.get(
    `SELECT 1 AS x FROM giftRedemptions r JOIN giftCodes g ON g.id = r.giftId
      WHERE r.userId = ? AND g.newUserOnly = 1 LIMIT 1`,
    [userId]
  );
  if (purchased || priorWelcome) return "not_new_user";
  if (!telegramUserId) return "telegram_required";
  const claimed = db.get(
    `SELECT 1 AS x FROM giftRedemptions r JOIN giftCodes g ON g.id = r.giftId
      WHERE r.telegramUserId = ? AND g.newUserOnly = 1 LIMIT 1`,
    [String(telegramUserId)]
  );
  if (claimed) return "telegram_used";
  return null;
}

/**
 * Why `userId` may not take channel-join code `giftId`, or null when it may
 * (change channel-gift). Membership is checked by the caller BEFORE the
 * transaction (Telegram is async); `verifiedTelegramUserId` is the Telegram user
 * that check found in the channel, and it must still be the account's link.
 */
export function channelRefusalSync(db, giftId, telegramUserId, verifiedTelegramUserId = null) {
  if (!telegramUserId) return "telegram_required";
  if (channelClaimedSync(db, giftId, telegramUserId)) return "telegram_channel_used";
  if (!verifiedTelegramUserId || String(verifiedTelegramUserId) !== String(telegramUserId)) return "channel_required";
  return null;
}

/** Has this Telegram user already taken this channel-join code (on any account)? */
export function channelClaimedSync(db, giftId, telegramUserId) {
  if (!telegramUserId) return false;
  return Boolean(db.get(
    `SELECT 1 AS x FROM giftRedemptions WHERE giftId = ? AND telegramUserId = ? LIMIT 1`,
    [giftId, String(telegramUserId)]
  ));
}

/**
 * What the redeem route must know before its transaction: whether the typed
 * code is a channel-join code, the account's Telegram user, and whether asking
 * Telegram is worth it (`checkChannel`). null = no such code (the transaction
 * then refuses it as usual).
 *
 * `checkChannel` is false whenever the transaction would refuse anyway: the code
 * is off, outside its window or used up, the account took it already, there is
 * no Telegram link, or this Telegram user claimed it. A dead code then answers
 * "not valid" instead of a Telegram error, and costs no Bot API call.
 */
export function giftRequirementSync(db, { userId, code, now = Date.now() }) {
  const row = findGiftRowByCode(db, code);
  if (!row || row.deletedAt) return null;
  const telegramUserId = db.get(`SELECT telegramUserId FROM users WHERE id = ?`, [userId])?.telegramUserId ?? null;
  const channelJoinOnly = Number(row.channelJoinOnly) === 1;
  let checkChannel = false;
  if (channelJoinOnly && telegramUserId) {
    const live = (row.isActive === 1 || row.isActive === true)
      && inWindow(row, now)
      && Number(row.redeemedCount ?? 0) < Number(row.maxRedemptions ?? 1);
    const mine = Number(db.get(
      `SELECT COUNT(*) AS c FROM giftRedemptions WHERE giftId = ? AND userId = ?`,
      [row.id, userId]
    )?.c ?? 0);
    checkChannel = live && mine < Math.max(1, Number(row.perUserLimit) || 1) && !channelClaimedSync(db, row.id, telegramUserId);
  }
  return {
    giftId: row.id,
    channelJoinOnly,
    newUserOnly: Number(row.newUserOnly) === 1,
    telegramUserId: telegramUserId ? String(telegramUserId) : null,
    checkChannel,
  };
}

/**
 * Redeem a code for a user. Fully synchronous: call it inside the caller's
 * `db.transaction(...)` so the redemption row, the counter bump and the billing
 * grant commit (or roll back) together.
 *
 * @returns {{ok: true, userPlan: object, appliedToOverdraftNanoUsd: number}
 *          | {ok: false, reason: "not_found"|"not_active"|"exhausted"|"already_redeemed"|"invalid_plan"
 *                       |"not_new_user"|"telegram_required"|"telegram_used"
 *                       |"channel_required"|"telegram_channel_used"}}
 *
 * `channelMemberTelegramUserId`: the Telegram user the caller just found in the
 * channel (channel-join codes only; see channelRefusalSync).
 */
export function redeemGiftCode(db, { userId, code, assignedBy = null, channelMemberTelegramUserId = null } = {}) {
  if (!db) throw new Error("redeemGiftCode requires a db adapter");
  if (!userId) return { ok: false, reason: "not_found" };

  const row = findGiftRowByCode(db, code);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.deletedAt || (row.isActive !== 1 && row.isActive !== true)) return { ok: false, reason: "not_found" };
  if (!inWindow(row, Date.now())) return { ok: false, reason: "not_active" };
  if ((row.redeemedCount ?? 0) >= (row.maxRedemptions ?? 1)) return { ok: false, reason: "exhausted" };

  let grant;
  if (row.grantKind === "plan") {
    const plan = planRow(db, row.planId);
    if (!plan || (plan.isActive !== 1 && plan.isActive !== true)) {
      return { ok: false, reason: "invalid_plan" };
    }
    // Never grant an unlimited purchase with no bound, even if the plan changed
    // after the code was saved.
    if (unboundedGiftError(plan, { rpm: row.rpm ?? null, tpm: row.tpm ?? null })) {
      return { ok: false, reason: "invalid_plan" };
    }
    // A top-up plan gifted as an amount: credit at the plan's own rate.
    const amountCredit = row.amountVnd != null ? topupCreditForAmount(plan, row.amountVnd) : null;
    if (amountCredit === 0) return { ok: false, reason: "invalid_plan" };
    grant = {
      planId: plan.id,
      creditNanoUsd: amountCredit ?? (Number(plan.creditNanoUsd) || 0),
      unlimitedCredit: Number(plan.unlimitedCredit) === 1,
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

      const telegramUserId = db.get(`SELECT telegramUserId FROM users WHERE id = ?`, [userId])?.telegramUserId ?? null;
      // New-user codes (spec gift-codes "New-user codes"). Inside the savepoint so
      // two accounts sharing one Telegram user cannot both pass. An admin
      // assignment skips them (design D4) but still records the Telegram user.
      if (Number(row.newUserOnly) === 1 && !assignedBy) {
        const refusal = newUserRefusalSync(db, userId, telegramUserId);
        if (refusal) return { ok: false, reason: refusal };
      }
      // Channel-join codes (change channel-gift): same savepoint, so one
      // Telegram user cannot take the code twice through two accounts.
      if (Number(row.channelJoinOnly) === 1 && !assignedBy) {
        const refusal = channelRefusalSync(db, row.id, telegramUserId, channelMemberTelegramUserId);
        if (refusal) return { ok: false, reason: refusal };
      }

      db.run(
        `INSERT INTO giftRedemptions(id, giftId, userId, userPlanId, redeemedAt, assignedBy, telegramUserId) VALUES(?, ?, ?, NULL, ?, ?, ?)`,
        [redemptionId, row.id, userId, now, assignedBy, telegramUserId]
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
        unlimitedCredit: grant.unlimitedCredit === true,
        durationDays: grant.durationDays,
        limits: grant.limits ?? [],
        // The code's own RPM/TPM, if set, rides on the purchase it grants.
        rpm: row.rpm ?? null,
        tpm: row.tpm ?? null,
        meta: {
          giftId: row.id,
          giftRedemptionId: redemptionId,
          giftCode: formatGiftCode(row.code),
          ...(row.amountVnd != null ? { amountVnd: Number(row.amountVnd) } : {}),
          ...(assignedBy ? { assignedBy } : {}),
        },
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

/**
 * What a live code grants, for the customer's "Mã có thể sử dụng" list. Mirrors
 * the grant in redeemGiftCode; null when it could not be redeemed now.
 */
function grantPreviewSync(db, row) {
  if (row.grantKind === "plan") {
    const plan = planRow(db, row.planId);
    if (!plan || (plan.isActive !== 1 && plan.isActive !== true)) return null;
    if (unboundedGiftError(plan, { rpm: row.rpm ?? null, tpm: row.tpm ?? null })) return null;
    const amountCredit = row.amountVnd != null ? topupCreditForAmount(plan, row.amountVnd) : null;
    if (amountCredit === 0) return null;
    return {
      kind: "plan",
      planName: plan.name ?? null,
      creditNanoUsd: amountCredit ?? (Number(plan.creditNanoUsd) || 0),
      unlimitedCredit: Number(plan.unlimitedCredit) === 1 && amountCredit == null,
      durationDays: Number(plan.durationDays) || 30,
    };
  }
  const credit = Number(row.creditNanoUsd) || 0;
  if (credit <= 0) return null;
  return { kind: "credit", planName: null, creditNanoUsd: credit, unlimitedCredit: false, durationDays: Number(row.durationDays) || 30 };
}

/**
 * Codes this account can still take, for the customer gift page (change
 * channel-gift). Only active, in-window, not exhausted codes whose grant is still
 * valid; a code this account (or, for a new-user / channel-join code, its
 * Telegram user) can no longer take is left out. A code that only lacks a
 * Telegram link stays, flagged `needsTelegram`.
 *
 * `listedOnly` false also returns unlisted codes (the welcome-code offer looks
 * for any channel-join code). Listed codes come first, then newest.
 */
export function listAvailableGiftsSync(db, userId, {
  now = Date.now(), listedOnly = true, channelOnly = false, includeChannel = true,
} = {}) {
  if (!userId) return [];
  const where = ["g.deletedAt IS NULL", "g.isActive = 1", "g.redeemedCount < g.maxRedemptions"];
  if (listedOnly) where.push("g.listed = 1");
  if (channelOnly) where.push("g.channelJoinOnly = 1");
  // Channel-join codes are left out when the channel check is not set up: they
  // could only ever fail.
  if (!includeChannel) where.push("COALESCE(g.channelJoinOnly, 0) = 0");
  // No SQL LIMIT: the window and per-account filters run below, and a cap before
  // them could push live codes out behind expired ones. The table is small and
  // admin-managed; the result is capped after filtering.
  const rows = db.all(
    `SELECT g.* FROM giftCodes g WHERE ${where.join(" AND ")} ORDER BY g.listed DESC, g.createdAt DESC, g.rowid DESC`
  );
  const telegramUserId = db.get(`SELECT telegramUserId FROM users WHERE id = ?`, [userId])?.telegramUserId ?? null;
  const out = [];
  for (const row of rows) {
    if (!inWindow(row, now)) continue;
    const mine = Number(db.get(
      `SELECT COUNT(*) AS c FROM giftRedemptions WHERE giftId = ? AND userId = ?`,
      [row.id, userId]
    )?.c ?? 0);
    if (mine >= Math.max(1, Number(row.perUserLimit) || 1)) continue;
    const newUserOnly = Number(row.newUserOnly) === 1;
    const channelJoinOnly = Number(row.channelJoinOnly) === 1;
    let needsTelegram = false;
    if (newUserOnly) {
      const refusal = newUserRefusalSync(db, userId, telegramUserId);
      if (refusal && refusal !== "telegram_required") continue;
      needsTelegram = refusal === "telegram_required";
    }
    if (channelJoinOnly) {
      if (channelClaimedSync(db, row.id, telegramUserId)) continue;
      needsTelegram = !telegramUserId;
    }
    const grant = grantPreviewSync(db, row);
    if (!grant) continue;
    out.push({
      id: row.id,
      code: formatGiftCode(row.code),
      kind: channelJoinOnly ? "channel" : newUserOnly ? "new_user" : "normal",
      grant,
      expiresAt: row.expiresAt ?? null,
      remaining: Math.max(0, Number(row.maxRedemptions) - Number(row.redeemedCount || 0)),
      needsTelegram,
    });
    if (out.length >= AVAILABLE_MAX) break;
  }
  return out;
}

const AVAILABLE_MAX = 50;

/** Vietnamese text for a refused redemption, shown to the admin per account. */
export const GIFT_REASON_TEXT = {
  not_found: "Mã không tồn tại hoặc đã tắt",
  not_active: "Mã chưa tới ngày dùng hoặc đã hết hạn",
  exhausted: "Mã đã hết lượt dùng",
  already_redeemed: "Tài khoản đã dùng mã này đủ số lần cho phép",
  invalid_plan: "Gói của mã không còn bán hoặc không quy đổi được",
  not_new_user: "Mã này chỉ dành cho tài khoản mới.",
  telegram_required: "Mã dành cho tài khoản mới, cần liên kết Telegram để nhận.",
  telegram_used: "Tài khoản Telegram này đã nhận ưu đãi người mới.",
  channel_required: "Bạn cần tham gia kênh Telegram để nhận mã này.",
  telegram_channel_used: "Tài khoản Telegram này đã nhận mã này rồi.",
  user_not_found: "Không tìm thấy tài khoản",
};

/** Accounts by id or e-mail (case-insensitive), in the order given, deduplicated. */
function resolveUsersSync(db, { userIds = [], emails = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (input, row) => {
    const key = row?.id ?? `missing:${input}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ input, user: row ?? null });
  };
  for (const id of Array.isArray(userIds) ? userIds : []) {
    const value = String(id ?? "").trim();
    if (value) push(value, db.get(`SELECT id, email FROM users WHERE id = ?`, [value]));
  }
  for (const email of Array.isArray(emails) ? emails : []) {
    const value = String(email ?? "").trim();
    if (value) push(value, db.get(`SELECT id, email FROM users WHERE lower(email) = lower(?)`, [value]));
  }
  return out;
}

/**
 * Give a gift code straight to accounts, without the customer typing it (spec
 * gift-codes "Admin assigns a code to accounts").
 *
 * Each account is a normal redemption — the code's active flag, validity window,
 * total and per-user limits all apply and the redemption counts against them — so
 * an assigned code and a typed one can never grant more than the code allows. Each
 * account succeeds or fails on its own; the result lists every one with its reason.
 * The redemption records the admin, and an audit row is written per account.
 *
 * @returns {{ ok: true, results: Array<{ input, userId, email, ok, reason?, message?, userPlanId? }> }
 *          | { ok: false, reason: "not_found"|"no_users" }}
 */
export function assignGiftCodeSync(db, giftId, { userIds = [], emails = [], actor = "admin" } = {}) {
  const row = db.get(`SELECT * FROM giftCodes WHERE id = ? AND deletedAt IS NULL`, [giftId]);
  if (!row) return { ok: false, reason: "not_found" };
  const targets = resolveUsersSync(db, { userIds, emails });
  if (targets.length === 0) return { ok: false, reason: "no_users" };

  const results = targets.map(({ input, user }) => {
    if (!user) {
      return { input, userId: null, email: null, ok: false, reason: "user_not_found", message: GIFT_REASON_TEXT.user_not_found };
    }
    const redeemed = redeemGiftCode(db, { userId: user.id, code: row.code, assignedBy: actor });
    if (!redeemed.ok) {
      return {
        input, userId: user.id, email: user.email, ok: false,
        reason: redeemed.reason, message: GIFT_REASON_TEXT[redeemed.reason] ?? redeemed.reason,
      };
    }
    insertAuditSync(db, {
      userId: user.id,
      actor,
      action: "gift_assigned",
      details: {
        giftId: row.id,
        giftCode: formatGiftCode(row.code),
        userPlanId: redeemed.userPlan?.id ?? null,
        ...(row.amountVnd != null ? { amountVnd: Number(row.amountVnd) } : {}),
      },
    });
    return {
      input, userId: user.id, email: user.email, ok: true,
      userPlanId: redeemed.userPlan?.id ?? null,
      startsAt: redeemed.userPlan?.startsAt ?? null,
      expiresAt: redeemed.userPlan?.expiresAt ?? null,
    };
  });
  return { ok: true, results };
}

export async function assignGiftCode(giftId, options = {}) {
  const db = await getAdapter();
  return assignGiftCodeSync(db, giftId, options);
}
