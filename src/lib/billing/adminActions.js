// Admin actions on a customer's money and purchases (design D13).
//
// One rule shapes every function here: validate first, then write — and when it
// writes, it writes the ledger row (if money moved) AND exactly one audit entry in
// the caller's transaction. A refused action writes NOTHING at all, so a 400 can
// never leave a half-applied change behind.
//
// Synchronous and driver-free (D8): the route opens `db.transaction`, these
// functions run inside it, and the route maps `{ ok: false, status, error }` to the
// HTTP response.
//
// Every action that changes money takes a `reason` (3–500 chars after trim), which
// is what makes the audit trail usable months later: "why did this customer get
// $200 back" is the question the log has to answer.
import { insertAuditSync } from "./audit.js";
import { grantUserPlan, isoPlusDays } from "./grants.js";
import { insertLedgerSync, nano } from "./ledger.js";
import {
  validateLimits,
  parseLimits,
  serializeLimits,
  normalizeLimits,
} from "./limits.js";

const REASON_MIN = 3;
const REASON_MAX = 500;
const CREDIT_MAX_NANO = 10_000_000_000_000; // $10,000
const CREDIT_MIN_NANO = 10_000_000; // $0.01
const DAYS_MAX = 3650;
const NOTE_MAX = 2000;

function nowIso() {
  return new Date().toISOString();
}

/**
 * A reason of 3–500 characters after trimming, or a Vietnamese error.
 * @returns {string|null} trimmed reason, or null when invalid
 */
export function validateReason(reason) {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < REASON_MIN) return null;
  if (value.length > REASON_MAX) return null;
  return value;
}

/** `{ ok:false, status, error }` — the shape every route turns into a response. */
function fail(status, error) {
  return { ok: false, status, error };
}

/** Load a purchase that belongs to `userId`, or null. */
function loadPurchase(db, userId, userPlanId) {
  if (!userPlanId) return null;
  return db.get(
    `SELECT up.*, p.code AS planCode, p.name AS planName
       FROM userPlans up
       LEFT JOIN plans p ON p.id = up.planId
      WHERE up.id = ? AND up.userId = ?`,
    [userPlanId, userId]
  );
}

/** A purchase may be edited while it is active or exhausted, never once expired/revoked. */
function isEditable(purchase) {
  return purchase && (purchase.status === "active" || purchase.status === "exhausted");
}

// ── Grant plan ─────────────────────────────────────────────────────────────

/**
 * Give a customer a purchase without an order (support gesture, compensation).
 *
 * The plan may be inactive: an operator honouring an arrangement for a retired plan
 * is a legitimate case, and the grant is logged with the plan it used.
 */
export function grantPlanSync(db, userId, { planId, reason, actor = "admin", now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");
  if (!planId) return fail(400, "Chọn gói cần cấp");

  const plan = db.get(`SELECT * FROM plans WHERE id = ?`, [planId]);
  if (!plan) return fail(404, "Gói không tồn tại");

  const at = now || nowIso();
  const granted = grantUserPlan(db, {
    userId,
    planId: plan.id,
    orderId: null,
    source: "admin",
    creditNanoUsd: nano(plan.creditNanoUsd),
    durationDays: nano(plan.durationDays),
    limits: parseLimits(plan.limits),
    meta: { adminActor: actor },
    now: at,
  });

  insertAuditSync(db, {
    userId,
    actor,
    action: "plan_granted",
    reason: cleanReason,
    details: {
      userPlanId: granted.userPlan.id,
      planId: plan.id,
      planCode: plan.code,
      creditNanoUsd: granted.userPlan.creditTotalNanoUsd,
      durationDays: nano(plan.durationDays),
      appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd,
    },
    now: at,
  });

  return { ok: true, userPlan: granted.userPlan, appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd };
}

// ── Grant credit ───────────────────────────────────────────────────────────

/**
 * Give a customer credit with no plan attached (source `admin`). No limits: a
 * credit grant is money, not a metered plan.
 */
export function grantCreditSync(db, userId, { amountNanoUsd, durationDays, reason, actor = "admin", now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const amount = nano(amountNanoUsd);
  if (!Number.isFinite(amount) || amount < CREDIT_MIN_NANO || amount > CREDIT_MAX_NANO) {
    return fail(400, "Số credit phải từ $0.01 đến $10,000");
  }
  const days = nano(durationDays);
  if (!Number.isInteger(days) || days < 1 || days > DAYS_MAX) {
    return fail(400, "Số ngày phải từ 1 đến 3650");
  }

  const at = now || nowIso();
  const granted = grantUserPlan(db, {
    userId,
    planId: null,
    orderId: null,
    source: "admin",
    creditNanoUsd: amount,
    durationDays: days,
    limits: [],
    meta: { adminActor: actor, creditOnly: true },
    now: at,
  });

  insertAuditSync(db, {
    userId,
    actor,
    action: "credit_granted",
    reason: cleanReason,
    details: {
      userPlanId: granted.userPlan.id,
      amountNanoUsd: amount,
      durationDays: days,
      appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd,
    },
    now: at,
  });

  return { ok: true, userPlan: granted.userPlan, appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd };
}

// ── Extend ─────────────────────────────────────────────────────────────────

/**
 * Move a purchase's expiry later, by `days` or to an explicit `expiresAt`.
 *
 * An explicit date must be later than BOTH now and the purchase's start — a plan
 * that expires before it begins can never pay for anything.
 */
export function extendPlanSync(db, userId, userPlanId, { days, expiresAt, reason, actor = "admin", now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const purchase = loadPurchase(db, userId, userPlanId);
  if (!purchase) return fail(404, "Không tìm thấy gói của người dùng này");
  if (!isEditable(purchase)) return fail(409, "Chỉ gia hạn được gói đang chạy hoặc đã hết credit");

  const at = now || nowIso();
  const nowMs = new Date(at).getTime();
  let nextExpiry = null;

  if (expiresAt != null) {
    const ms = new Date(expiresAt).getTime();
    if (!Number.isFinite(ms)) return fail(400, "Ngày hết hạn mới không hợp lệ");
    const startsMs = new Date(purchase.startsAt).getTime();
    if (ms <= nowMs) return fail(400, "Ngày hết hạn mới phải sau hiện tại");
    if (ms <= startsMs) return fail(400, "Ngày hết hạn mới phải sau ngày bắt đầu gói");
    nextExpiry = new Date(ms).toISOString();
  } else {
    const add = nano(days);
    if (!Number.isInteger(add) || add < 1 || add > DAYS_MAX) {
      return fail(400, "Số ngày gia hạn phải từ 1 đến 3650");
    }
    // Extend from the current expiry when it is still in the future (so the
    // customer keeps the time they paid for), otherwise from now.
    const currentMs = new Date(purchase.expiresAt).getTime();
    const baseMs = Number.isFinite(currentMs) && currentMs > nowMs ? currentMs : nowMs;
    nextExpiry = isoPlusDays(add, baseMs);
  }

  db.run(`UPDATE userPlans SET expiresAt = ? WHERE id = ?`, [nextExpiry, userPlanId]);

  insertAuditSync(db, {
    userId,
    actor,
    action: "plan_extended",
    reason: cleanReason,
    details: { userPlanId, before: { expiresAt: purchase.expiresAt }, after: { expiresAt: nextExpiry } },
    now: at,
  });

  return { ok: true, expiresAt: nextExpiry };
}

// ── Adjust credit ──────────────────────────────────────────────────────────

/**
 * Add or remove credit on one purchase.
 *
 * Rules (spec admin-user-management): non-zero signed amount, absolute value at
 * most $10,000, the result may not go below zero. A result of exactly zero makes
 * the purchase `exhausted`; coming back up from zero while the purchase is still
 * unexpired makes it `active` again.
 */
export function adjustCreditSync(db, userId, userPlanId, { deltaNanoUsd, reason, actor = "admin", now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const purchase = loadPurchase(db, userId, userPlanId);
  if (!purchase) return fail(404, "Không tìm thấy gói của người dùng này");
  if (!isEditable(purchase)) return fail(409, "Chỉ điều chỉnh được gói đang chạy hoặc đã hết credit");

  const delta = nano(deltaNanoUsd);
  if (!Number.isFinite(delta) || delta === 0) return fail(400, "Số credit điều chỉnh phải khác 0");
  if (Math.abs(delta) > CREDIT_MAX_NANO) return fail(400, "Mức điều chỉnh tối đa là $10,000");

  const before = nano(purchase.creditRemainingNanoUsd);
  const after = before + delta;
  if (after < 0) return fail(400, "Không thể trừ quá số credit còn lại");

  const at = now || nowIso();
  const stillLive = new Date(purchase.expiresAt).getTime() > new Date(at).getTime();
  let status = purchase.status;
  if (after === 0) status = "exhausted";
  else if (before === 0 && after > 0 && stillLive) status = "active";

  db.run(`UPDATE userPlans SET creditRemainingNanoUsd = ?, status = ? WHERE id = ?`, [after, status, userPlanId]);

  insertLedgerSync(db, {
    userId,
    userPlanId,
    deltaNanoUsd: delta,
    kind: "adjust",
    meta: { adminActor: actor, reason: cleanReason },
    createdAt: at,
  });

  insertAuditSync(db, {
    userId,
    actor,
    action: "credit_adjusted",
    reason: cleanReason,
    details: {
      userPlanId,
      before: { creditRemainingNanoUsd: before, status: purchase.status },
      after: { creditRemainingNanoUsd: after, status },
      deltaNanoUsd: delta,
    },
    now: at,
  });

  return { ok: true, creditRemainingNanoUsd: after, status };
}

// ── Edit a purchase's limits ───────────────────────────────────────────────

/**
 * Replace one purchase's window limits.
 *
 * Validated against THIS purchase's own credit total and remaining duration (not
 * the plan template's), because that is what the customer actually holds. Window
 * state for a removed length is deleted; state for a kept length keeps its spend —
 * the customer already consumed it, and resetting would hand out a fresh allowance
 * mid-window.
 */
export function setPurchaseLimitsSync(db, userId, userPlanId, { limits, reason, actor = "admin", now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const purchase = loadPurchase(db, userId, userPlanId);
  if (!purchase) return fail(404, "Không tìm thấy gói của người dùng này");
  if (!isEditable(purchase)) return fail(409, "Chỉ sửa hạn mức của gói đang chạy hoặc đã hết credit");

  let normalized;
  try {
    normalized = normalizeLimits(limits ?? []);
  } catch (error) {
    return fail(400, error.message);
  }

  const remainingDays = Math.max(
    1,
    Math.ceil((new Date(purchase.expiresAt).getTime() - Date.now()) / 86_400_000)
  );
  const invalid = validateLimits(normalized, {
    creditNanoUsd: nano(purchase.creditTotalNanoUsd),
    durationDays: remainingDays,
  });
  if (invalid) return fail(400, invalid);

  const at = now || nowIso();
  const before = parseLimits(purchase.limits);
  db.run(`UPDATE userPlans SET limits = ? WHERE id = ?`, [serializeLimits(normalized), userPlanId]);

  const keep = new Set(normalized.map((limit) => limit.hours));
  for (const row of db.all(`SELECT hours FROM userPlanWindows WHERE userPlanId = ?`, [userPlanId])) {
    if (!keep.has(nano(row.hours))) {
      db.run(`DELETE FROM userPlanWindows WHERE userPlanId = ? AND hours = ?`, [userPlanId, row.hours]);
    }
  }

  insertAuditSync(db, {
    userId,
    actor,
    action: "plan_limits_changed",
    reason: cleanReason,
    details: { userPlanId, before, after: normalized },
    now: at,
  });

  return { ok: true, limits: normalized };
}

// ── Revoke ─────────────────────────────────────────────────────────────────

/**
 * Void a purchase: status `revoked`, remaining credit to zero, and the forfeited
 * amount written as a negative `revoke` ledger row so the money is accounted for.
 */
export function revokePlanSync(db, userId, userPlanId, { reason, actor = "admin", now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const purchase = loadPurchase(db, userId, userPlanId);
  if (!purchase) return fail(404, "Không tìm thấy gói của người dùng này");
  if (!isEditable(purchase)) return fail(409, "Chỉ thu hồi được gói đang chạy hoặc đã hết credit");

  const at = now || nowIso();
  const remaining = nano(purchase.creditRemainingNanoUsd);

  db.run(`UPDATE userPlans SET status = 'revoked', creditRemainingNanoUsd = 0 WHERE id = ?`, [userPlanId]);
  db.run(`DELETE FROM userPlanWindows WHERE userPlanId = ?`, [userPlanId]);

  if (remaining > 0) {
    insertLedgerSync(db, {
      userId,
      userPlanId,
      deltaNanoUsd: -remaining,
      kind: "revoke",
      meta: { adminActor: actor, reason: cleanReason },
      createdAt: at,
    });
  }

  insertAuditSync(db, {
    userId,
    actor,
    action: "plan_revoked",
    reason: cleanReason,
    details: {
      userPlanId,
      before: { status: purchase.status, creditRemainingNanoUsd: remaining },
      after: { status: "revoked", creditRemainingNanoUsd: 0 },
      revokedNanoUsd: remaining,
    },
    now: at,
  });

  return { ok: true, revokedNanoUsd: remaining };
}

// ── Apply to active purchases ──────────────────────────────────────────────

/**
 * Apply a plan's new limits to every ACTIVE purchase of that plan (design D14).
 *
 * Called from PATCH /api/plans/[id] in the same transaction as the plan update when
 * the admin ticks "Áp dụng hạn mức mới cho N gói đang chạy". Editing a plan normally
 * affects only later orders — this is the explicit opt-in to rewrite what customers
 * already hold.
 *
 * @returns {{ ok: true, affectedCount: number } | { ok: false, status, error, affectedCount: 0 }}
 */
export function applyLimitsToActiveSync(db, planId, limits, { actor, planCode = null, now = null } = {}) {
  if (!db) throw new Error("applyLimitsToActiveSync requires the db adapter");
  if (!planId) throw new Error("applyLimitsToActiveSync requires a planId");

  let normalized;
  try {
    normalized = normalizeLimits(limits ?? []);
  } catch (error) {
    return { ok: false, status: 400, error: error.message, affectedCount: 0 };
  }

  const plan = db.get(`SELECT code, creditNanoUsd, durationDays FROM plans WHERE id = ?`, [planId]);
  const code = planCode ?? plan?.code ?? planId;
  const invalid = validateLimits(normalized, {
    creditNanoUsd: plan?.creditNanoUsd ?? 0,
    durationDays: plan?.durationDays ?? 0,
  });
  if (invalid) return { ok: false, status: 400, error: invalid, affectedCount: 0 };

  const rows = db.all(
    `SELECT id, userId, limits FROM userPlans WHERE planId = ? AND status = 'active'`,
    [planId]
  );
  if (rows.length === 0) return { ok: true, affectedCount: 0 };

  const serialized = serializeLimits(normalized);
  const keep = new Set(normalized.map((limit) => limit.hours));
  const at = now || nowIso();
  const reason = `Áp dụng hạn mức mới của gói ${code}`;

  for (const row of rows) {
    const before = parseLimits(row.limits);
    db.run(`UPDATE userPlans SET limits = ? WHERE id = ?`, [serialized, row.id]);

    for (const windowRow of db.all(`SELECT hours FROM userPlanWindows WHERE userPlanId = ?`, [row.id])) {
      if (!keep.has(nano(windowRow.hours))) {
        db.run(`DELETE FROM userPlanWindows WHERE userPlanId = ? AND hours = ?`, [row.id, windowRow.hours]);
      }
    }

    insertAuditSync(db, {
      userId: row.userId,
      actor: actor || "admin",
      action: "plan_limits_changed",
      reason,
      details: { before, after: normalized, planId, planCode: code, source: "plan_apply_to_active" },
      now: at,
    });
  }

  return { ok: true, affectedCount: rows.length };
}

// ── Account-level actions ──────────────────────────────────────────────────

/** Change the group a customer belongs to (effective on their next request). */
export function changeGroupSync(db, userId, { groupId, reason, actor = "admin", before = null, now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const group = db.get(`SELECT id, name, isActive FROM keyGroups WHERE id = ?`, [groupId]);
  if (!group) return fail(400, "Nhóm không tồn tại hoặc đã ngừng hoạt động");
  if (group.isActive !== 1 && group.isActive !== true) {
    return fail(400, "Nhóm không tồn tại hoặc đã ngừng hoạt động");
  }

  const at = now || nowIso();
  db.run(`UPDATE users SET groupId = ?, updatedAt = ? WHERE id = ?`, [group.id, at, userId]);

  insertAuditSync(db, {
    userId,
    actor,
    action: "group_changed",
    reason: cleanReason,
    details: { before: { groupId: before }, after: { groupId: group.id, groupName: group.name } },
    now: at,
  });

  return { ok: true, groupId: group.id, groupName: group.name };
}

const VALID_STATUSES = new Set(["active", "suspended", "unverified"]);

/**
 * Change account status. `suspended` and `unverified` also revoke every session:
 * the dashboard must lose the account at the same moment the API does.
 */
export function changeStatusSync(db, userId, { status, reason, actor = "admin", before = null, now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");
  if (!VALID_STATUSES.has(status)) return fail(400, "Trạng thái không hợp lệ");

  const at = now || nowIso();
  db.run(`UPDATE users SET status = ?, updatedAt = ? WHERE id = ?`, [status, at, userId]);

  let revokedSessions = 0;
  if (status !== "active") {
    const res = db.run(
      `UPDATE userSessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL`,
      [at, userId]
    );
    revokedSessions = res?.changes ?? 0;
  }

  insertAuditSync(db, {
    userId,
    actor,
    action: "status_changed",
    reason: cleanReason,
    details: { before: { status: before }, after: { status }, revokedSessions },
    now: at,
  });

  return { ok: true, status, revokedSessions };
}

/** Internal note. No reason required: it changes nothing the customer can do. */
export function setNoteSync(db, userId, { adminNote, actor = "admin", before = null, now = null } = {}) {
  const note = adminNote == null ? null : String(adminNote).trim();
  if (note && note.length > NOTE_MAX) return fail(400, `Ghi chú tối đa ${NOTE_MAX} ký tự`);

  const at = now || nowIso();
  db.run(`UPDATE users SET adminNote = ?, updatedAt = ? WHERE id = ?`, [note || null, at, userId]);

  insertAuditSync(db, {
    userId,
    actor,
    action: "note_changed",
    details: { before: { adminNote: before }, after: { adminNote: note || null } },
    now: at,
  });

  return { ok: true, adminNote: note || null };
}

/**
 * Reset a password and revoke every session.
 *
 * The password itself is NEVER logged — the audit row records that a reset happened,
 * who did it, why, and the before/after state of the thing that actually changed
 * (the credential version). `details.before` carries the previous hash's fingerprint
 * rather than the hash, so support can tell two resets apart without the log becoming
 * a credential store.
 *
 * Requires a reason like every other account-changing action (spec: only Edit note
 * and Reorder are exempt).
 */
export function resetPasswordSync(db, userId, { passwordHash, reason, actor = "admin", before = null, now = null } = {}) {
  if (!passwordHash) return fail(400, "Mật khẩu không hợp lệ");

  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const at = now || nowIso();
  // Read the state being replaced here, not from the caller: a caller holds the
  // public user shape, which has no hash, so a caller-supplied value was always empty.
  const previous = db.get(`SELECT passwordHash FROM users WHERE id = ?`, [userId]);
  const hadPassword = previous ? Boolean(previous.passwordHash) : Boolean(before);
  db.run(`UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?`, [passwordHash, at, userId]);
  const res = db.run(
    `UPDATE userSessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL`,
    [at, userId]
  );

  insertAuditSync(db, {
    userId,
    actor,
    action: "password_reset",
    reason: cleanReason,
    details: {
      // Two booleans, not the credential: enough to prove the hash was replaced.
      before: { hasPassword: hadPassword, passwordChangedAt: null },
      after: { hasPassword: true, passwordChangedAt: at },
      revokedSessions: res?.changes ?? 0,
    },
    now: at,
  });

  return { ok: true, revokedSessions: res?.changes ?? 0 };
}

/** Profile fields (email, display name). */
export function changeProfileSync(db, userId, { email, displayName, reason, actor = "admin", before = null, now = null } = {}) {
  const cleanReason = validateReason(reason);
  if (!cleanReason) return fail(400, "Lý do phải có từ 3 đến 500 ký tự");

  const at = now || nowIso();
  const assignments = [];
  const values = [];
  if (email !== undefined) {
    assignments.push("email = ?");
    values.push(String(email).trim().toLowerCase());
  }
  if (displayName !== undefined) {
    assignments.push("displayName = ?");
    values.push(displayName ? String(displayName).trim() || null : null);
  }
  if (assignments.length === 0) return fail(400, "Không có thay đổi nào");

  assignments.push("updatedAt = ?");
  values.push(at);
  values.push(userId);
  db.run(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`, values);

  insertAuditSync(db, {
    userId,
    actor,
    action: "profile_changed",
    reason: cleanReason,
    details: {
      before: before ?? null,
      after: {
        ...(email !== undefined ? { email: String(email).trim().toLowerCase() } : {}),
        ...(displayName !== undefined ? { displayName: displayName ? String(displayName).trim() : null } : {}),
      },
    },
    now: at,
  });

  return { ok: true };
}

export { CREDIT_MAX_NANO, CREDIT_MIN_NANO, DAYS_MAX, NOTE_MAX };
