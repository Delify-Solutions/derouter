// Time-limited model discounts (spec model-discounts).
//
// A rule lowers the LIST price of a model while its window is open. Rules that
// apply to the same request stack ADDITIVELY and the total is capped at 100%.
//
// Where the discount is applied: `saveRequestUsage` computes the list cost from
// tokens and rates, calls `applyRequestDiscountSync` inside its transaction, and
// stores the discounted figure as the usage row's cost. The charge, the daily
// roll-up, the budgets that read recorded cost and every report therefore agree
// by construction. The list cost, the total percent and the rule ids are kept in
// the usage row's meta so a receipt can say "giảm X%".
//
// SYNCHRONOUS + DRIVER-FREE (design D8): every function takes the adapter so it
// can run inside an existing `db.transaction(fn)`; nothing here awaits, and no
// import reaches ../db/driver.js (plain Node tests import this file directly).
//
// Money: integer nanoUSD, discounts are integer basis points (1 bp = 0.01%).
// The cost is computed with BigInt — no float ever touches a balance.
import { v4 as uuidv4 } from "uuid";
import { parseJson, stringifyJson } from "../db/helpers/jsonCol.js";
import { listQueueSync, evaluatePlan } from "./planQueue.js";
import { nano } from "./ledger.js";

export const MAX_BP = 10000;
export const SCOPE_TYPES = ["combo", "plan", "group"];
const LABEL_MAX = 80;

function nowIso() {
  return new Date().toISOString();
}

// ── Percent / basis points ──────────────────────────────────────────────────

/**
 * Parse a percent typed by a human ("12", "12.5", "0.01", 12.5) into integer
 * basis points. Split on the dot instead of multiplying, so there is no float
 * rounding: step is 0.01, range 0.01..100. Anything else is null.
 */
export function parsePercentToBp(input) {
  if (input === null || input === undefined || typeof input === "boolean") return null;
  const text = String(input).trim().replace(",", ".");
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const bp = Number(m[1]) * 100 + Number(frac || 0);
  return bp >= 1 && bp <= MAX_BP ? bp : null;
}

/** Basis points as a percent string without float math: 1250 → "12.5", 10000 → "100". */
export function formatBp(bp) {
  const n = Math.max(0, Math.round(Number(bp) || 0));
  const whole = Math.floor(n / 100);
  const frac = String(n % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Sum rule percents and cap at 100% (spec "Additive stacking and the 100% cap").
 * @returns {{ rawBp:number, totalBp:number, capped:boolean }}
 */
export function combineBp(bps) {
  let rawBp = 0;
  for (const bp of bps ?? []) rawBp += Math.max(0, Math.round(Number(bp) || 0));
  return { rawBp, totalBp: Math.min(MAX_BP, rawBp), capped: rawBp > MAX_BP };
}

/**
 * `nanoUsd × (10000 − bp) / 10000`, rounded half up to a whole nanoUSD. Done once,
 * on the request's total list cost. 0 bp is the list cost, 10000 bp is exactly 0;
 * the result is never negative and never above the list cost.
 */
export function applyBp(nanoUsd, bp) {
  const list = Math.max(0, nano(nanoUsd));
  const pct = Math.min(MAX_BP, Math.max(0, Math.round(Number(bp) || 0)));
  if (pct === 0 || list === 0) return list;
  if (pct >= MAX_BP) return 0;
  const out = (BigInt(list) * BigInt(MAX_BP - pct) + 5000n) / 10000n;
  return Number(out);
}

const RATE_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation", "image"];

/**
 * Discounted copy of a pricing object (USD per 1M tokens, `image` per image) for
 * DISPLAY. Rates are the one place the codebase already holds USD floats; this is
 * never used to compute a balance. Rounded to 6 decimals to hide binary noise.
 */
export function applyBpToPricing(pricing, bp) {
  if (!pricing) return pricing;
  const pct = Math.min(MAX_BP, Math.max(0, Math.round(Number(bp) || 0)));
  if (pct === 0) return { ...pricing };
  const out = { ...pricing };
  for (const field of RATE_FIELDS) {
    const v = Number(pricing[field]);
    if (!Number.isFinite(v) || v <= 0) continue;
    out[field] = Number(((v * (MAX_BP - pct)) / MAX_BP).toFixed(6));
  }
  return out;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export function rowToDiscount(row) {
  if (!row) return null;
  const models = parseJson(row.models, null);
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    models: Array.isArray(models) && models.length > 0 ? models : null,
    percentBp: nano(row.percentBp),
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    isActive: row.isActive === 1 || row.isActive === true,
    label: row.label ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ms(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Is the rule's window open at `atMs`? `startsAt` is INCLUSIVE and `endsAt` is
 * EXCLUSIVE, the same convention as plan expiry (`expiresAt > now`): at exactly
 * `endsAt` the discount is already over. An unparseable bound is treated as
 * closed — a corrupt rule must never discount silently.
 */
export function isWindowOpen(rule, atMs) {
  if (rule.startsAt) {
    const s = ms(rule.startsAt);
    if (s == null || atMs < s) return false;
  }
  if (rule.endsAt) {
    const e = ms(rule.endsAt);
    if (e == null || atMs >= e) return false;
  }
  return true;
}

/**
 * One label for the admin list: 'disabled' (switched off), 'upcoming'
 * (not started), 'expired' (ended) or 'active' (running now).
 */
export function ruleStatus(rule, atMs = Date.now()) {
  if (!rule.isActive) return "disabled";
  const s = ms(rule.startsAt);
  if (rule.startsAt && (s == null || atMs < s)) return "upcoming";
  const e = ms(rule.endsAt);
  if (rule.endsAt && (e == null || atMs >= e)) return "expired";
  return "active";
}

/** Does a plan/group rule cover this model? Empty models = every model. */
function coversModel(rule, model) {
  if (!rule.models || rule.models.length === 0) return true;
  return model != null && rule.models.includes(model);
}

/**
 * How the rules of ONE scope add up, for the admin warning (spec "Admin
 * management"). Per model (plus "any other model" for rules that cover all), the
 * rules open at an instant are summed; the figure is evaluated now and at every
 * future start, so an overlap that begins later is flagged before it happens.
 * Only enabled, unexpired rules count. Rules of other scopes that may stack at
 * request time are not visible here.
 *
 * @returns {{ nowRawBp:number, nowTotalBp:number, nowCapped:boolean, peakRawBp:number, peakCapped:boolean }}
 */
export function analyzeOverlap(rules, nowMs = Date.now()) {
  const live = (rules ?? []).filter((r) => {
    if (!r.isActive) return false;
    const e = ms(r.endsAt);
    return !(r.endsAt && (e == null || nowMs >= e));
  });
  const names = new Set();
  for (const r of live) for (const m of r.models ?? []) names.add(m);
  const universe = [...names, null]; // null = a model no rule names explicitly

  const rawAt = (t) => {
    let best = 0;
    for (const model of universe) {
      let sum = 0;
      for (const r of live) {
        if (!isWindowOpen(r, t)) continue;
        if (r.models && r.models.length > 0 && (model == null || !r.models.includes(model))) continue;
        sum += r.percentBp;
      }
      if (sum > best) best = sum;
    }
    return best;
  };

  const nowRawBp = rawAt(nowMs);
  let peakRawBp = nowRawBp;
  for (const r of live) {
    const s = ms(r.startsAt);
    if (s != null && s > nowMs) peakRawBp = Math.max(peakRawBp, rawAt(s));
  }
  return {
    nowRawBp,
    nowTotalBp: Math.min(MAX_BP, nowRawBp),
    nowCapped: nowRawBp > MAX_BP,
    peakRawBp,
    peakCapped: peakRawBp > MAX_BP,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

function toBoolean(value, fallback = true) {
  if (value === undefined) return fallback;
  if (value === false || value === 0 || value === null) return false;
  if (typeof value === "string") {
    return !["", "0", "false", "off", "no"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function parseInstant(value) {
  if (value === undefined || value === null || value === "") return { ok: true, iso: null };
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return { ok: false };
  return { ok: true, iso: new Date(t).toISOString() };
}

/** Does the scope this rule points at exist? */
export function scopeExistsSync(db, scopeType, scopeId) {
  if (!scopeId || typeof scopeId !== "string") return false;
  if (scopeType === "combo") return !!db.get(`SELECT 1 AS ok FROM combos WHERE name = ?`, [scopeId]);
  if (scopeType === "plan") return !!db.get(`SELECT 1 AS ok FROM plans WHERE id = ?`, [scopeId]);
  if (scopeType === "group") return !!db.get(`SELECT 1 AS ok FROM keyGroups WHERE id = ?`, [scopeId]);
  return false;
}

/**
 * Validate and normalise one COMPLETE rule (callers merge a patch into the stored
 * rule first). Percent may be given as `percent` (string/number, step 0.01) or
 * `percentBp` (integer). Instants are normalised to ISO strings.
 *
 * @returns {{ ok:true, value:object } | { ok:false, errors:Array<{field:string,message:string}> }}
 */
export function validateDiscountSync(db, input = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  const scopeType = input.scopeType;
  if (!SCOPE_TYPES.includes(scopeType)) {
    fail("scopeType", "Phạm vi phải là combo, gói hoặc nhóm");
  }
  const scopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";
  if (SCOPE_TYPES.includes(scopeType)) {
    if (!scopeId) fail("scopeId", "Thiếu đối tượng áp dụng");
    else if (!scopeExistsSync(db, scopeType, scopeId)) {
      fail("scopeId", scopeType === "combo" ? "Combo không tồn tại" : scopeType === "plan" ? "Gói không tồn tại" : "Nhóm không tồn tại");
    }
  }

  let percentBp = null;
  if (input.percentBp !== undefined && input.percentBp !== null && input.percent === undefined) {
    const n = Number(input.percentBp);
    percentBp = Number.isInteger(n) && n >= 1 && n <= MAX_BP ? n : null;
  } else {
    percentBp = parsePercentToBp(input.percent);
  }
  if (percentBp == null) fail("percent", "Mức giảm phải từ 0,01% đến 100% (bước 0,01)");

  let models = null;
  if (input.models !== undefined && input.models !== null) {
    if (!Array.isArray(input.models)) fail("models", "Danh sách model không hợp lệ");
    else {
      const cleaned = [...new Set(input.models.map((m) => (typeof m === "string" ? m.trim() : "")))];
      if (cleaned.some((m) => !m)) fail("models", "Tên model không hợp lệ");
      else if (cleaned.length > 0) {
        if (scopeType === "combo") {
          fail("models", "Giảm giá theo combo áp dụng cho chính combo đó, không chọn model");
        } else {
          const missing = cleaned.filter((name) => !db.get(`SELECT 1 AS ok FROM combos WHERE name = ?`, [name]));
          if (missing.length > 0) fail("models", `Model không tồn tại: ${missing.join(", ")}`);
          else models = cleaned;
        }
      }
    }
  }

  const start = parseInstant(input.startsAt);
  if (!start.ok) fail("startsAt", "Thời điểm bắt đầu không hợp lệ");
  const end = parseInstant(input.endsAt);
  if (!end.ok) fail("endsAt", "Thời điểm kết thúc không hợp lệ");
  if (start.ok && end.ok && start.iso && end.iso && new Date(end.iso).getTime() <= new Date(start.iso).getTime()) {
    fail("endsAt", "Thời điểm kết thúc phải sau thời điểm bắt đầu");
  }

  let label = null;
  if (input.label !== undefined && input.label !== null && String(input.label).trim() !== "") {
    label = String(input.label).trim();
    if (label.length > LABEL_MAX) fail("label", `Nhãn tối đa ${LABEL_MAX} ký tự`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      scopeType,
      scopeId,
      models,
      percentBp,
      startsAt: start.iso,
      endsAt: end.iso,
      isActive: toBoolean(input.isActive, true),
      label,
    },
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function getDiscountSync(db, id) {
  return rowToDiscount(db.get(`SELECT * FROM modelDiscounts WHERE id = ?`, [id]));
}

/** Rules, oldest first; optionally for one scope. */
export function listDiscountsSync(db, { scopeType = null, scopeId = null } = {}) {
  const where = [];
  const params = [];
  if (scopeType) { where.push("scopeType = ?"); params.push(scopeType); }
  if (scopeId) { where.push("scopeId = ?"); params.push(scopeId); }
  const rows = db.all(
    `SELECT * FROM modelDiscounts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt ASC, id ASC`,
    params
  );
  return rows.map(rowToDiscount);
}

/** @returns {{ok:true, rule:object}|{ok:false, errors:Array}} */
export function createDiscountSync(db, input, { now = null } = {}) {
  const checked = validateDiscountSync(db, input);
  if (!checked.ok) return checked;
  const v = checked.value;
  const at = now || nowIso();
  const id = uuidv4();
  db.run(
    `INSERT INTO modelDiscounts(id, scopeType, scopeId, models, percentBp, startsAt, endsAt, isActive, label, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, v.scopeType, v.scopeId, v.models ? stringifyJson(v.models) : null, v.percentBp, v.startsAt, v.endsAt, v.isActive ? 1 : 0, v.label, at, at]
  );
  return { ok: true, rule: getDiscountSync(db, id) };
}

/**
 * Patch a rule. The scope of a rule is fixed once created (a rule never moves to
 * another combo/plan/group); everything else may change. Validation runs on the
 * merged rule, so a patch that would leave it invalid (e.g. an `endsAt` before the
 * stored `startsAt`) is refused.
 *
 * @returns {{ok:true, rule:object}|{ok:false, notFound?:true, errors?:Array}}
 */
export function updateDiscountSync(db, id, patch = {}, { now = null } = {}) {
  const current = getDiscountSync(db, id);
  if (!current) return { ok: false, notFound: true };
  const merged = {
    scopeType: current.scopeType,
    scopeId: current.scopeId,
    models: patch.models !== undefined ? patch.models : current.models,
    startsAt: patch.startsAt !== undefined ? patch.startsAt : current.startsAt,
    endsAt: patch.endsAt !== undefined ? patch.endsAt : current.endsAt,
    isActive: patch.isActive !== undefined ? patch.isActive : current.isActive,
    label: patch.label !== undefined ? patch.label : current.label,
  };
  if (patch.percent !== undefined) merged.percent = patch.percent;
  else if (patch.percentBp !== undefined) merged.percentBp = patch.percentBp;
  else merged.percentBp = current.percentBp;

  const checked = validateDiscountSync(db, merged);
  if (!checked.ok) return checked;
  const v = checked.value;
  db.run(
    `UPDATE modelDiscounts SET models = ?, percentBp = ?, startsAt = ?, endsAt = ?, isActive = ?, label = ?, updatedAt = ? WHERE id = ?`,
    [v.models ? stringifyJson(v.models) : null, v.percentBp, v.startsAt, v.endsAt, v.isActive ? 1 : 0, v.label, now || nowIso(), id]
  );
  return { ok: true, rule: getDiscountSync(db, id) };
}

export function deleteDiscountSync(db, id) {
  const res = db.run(`DELETE FROM modelDiscounts WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/** Remove every rule of a scope (a deleted group, for instance). */
export function deleteScopeDiscountsSync(db, scopeType, scopeId) {
  const res = db.run(`DELETE FROM modelDiscounts WHERE scopeType = ? AND scopeId = ?`, [scopeType, scopeId]);
  return res?.changes ?? 0;
}

/**
 * A combo was renamed: rules scoped to it follow the new name, and every
 * plan/group rule listing it in `models` is rewritten to the new name.
 */
export function renameComboInDiscountsSync(db, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  db.run(`UPDATE modelDiscounts SET scopeId = ?, updatedAt = ? WHERE scopeType = 'combo' AND scopeId = ?`, [newName, nowIso(), oldName]);
  for (const row of db.all(`SELECT id, models FROM modelDiscounts WHERE models IS NOT NULL`)) {
    const list = parseJson(row.models, []);
    if (!Array.isArray(list) || !list.includes(oldName)) continue;
    const next = [...new Set(list.map((m) => (m === oldName ? newName : m)))];
    db.run(`UPDATE modelDiscounts SET models = ?, updatedAt = ? WHERE id = ?`, [stringifyJson(next), nowIso(), row.id]);
  }
}

/**
 * A combo was deleted: its own rules are removed. A plan/group rule that listed it
 * drops the name; if that empties the list the rule is SWITCHED OFF (an empty list
 * means "every model", which the admin never asked for).
 */
export function removeComboFromDiscountsSync(db, comboName) {
  if (!comboName) return;
  deleteScopeDiscountsSync(db, "combo", comboName);
  for (const row of db.all(`SELECT id, models FROM modelDiscounts WHERE models IS NOT NULL`)) {
    const list = parseJson(row.models, []);
    if (!Array.isArray(list) || !list.includes(comboName)) continue;
    const next = list.filter((m) => m !== comboName);
    if (next.length === 0) {
      db.run(`UPDATE modelDiscounts SET models = NULL, isActive = 0, updatedAt = ? WHERE id = ?`, [nowIso(), row.id]);
    } else {
      db.run(`UPDATE modelDiscounts SET models = ?, updatedAt = ? WHERE id = ?`, [stringifyJson(next), nowIso(), row.id]);
    }
  }
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Who pays this customer's request, and which group are they in — the two facts
 * plan-scope and group-scope rules need.
 *
 *   groupId  the customer's group (users.groupId) while that group is active, the
 *            same "live group" rule key enforcement uses; null otherwise.
 *   planId   the plan TEMPLATE id (plans.id) of the purchase that pays FIRST: the
 *            first eligible plan in queue order (the one admission would pick), or,
 *            when none is eligible, the first plan with credit left (where pass 2
 *            of chargeSync starts). null when no plan can pay or the paying
 *            purchase has no template (gift/grant).
 */
export function resolvePayerContextSync(db, userId, at) {
  if (!userId) return { groupId: null, planId: null };
  const groupRow = db.get(
    `SELECT u.groupId AS groupId FROM users u
       JOIN keyGroups g ON g.id = u.groupId AND g.isActive = 1
      WHERE u.id = ?`,
    [userId]
  );
  const nowMs = ms(at) ?? Date.now();
  const queue = listQueueSync(db, userId, new Date(nowMs).toISOString());
  let paying = queue.find((entry) => evaluatePlan(entry, nowMs).eligible) ?? null;
  if (!paying) {
    paying = queue.find((entry) => entry.unlimitedCredit === true || nano(entry.creditRemainingNanoUsd) > 0) ?? null;
  }
  return { groupId: groupRow?.groupId ?? null, planId: paying?.planId ?? null };
}

/**
 * Rules that apply to one request (spec "Which rules apply").
 *
 * A rule applies when it is active, its window is open at `at`, and its scope
 * matches:
 *   combo  scopeId === requestedModel (a bare combo name; "provider/model" never
 *          matches a combo rule)
 *   group  scopeId === the customer's group, and the rule covers requestedModel
 *   plan   scopeId === the paying plan's template, and the rule covers requestedModel
 *
 * `userId` resolves the group and paying plan lazily (nothing is read unless a
 * live rule of that scope exists). Pass `groupId` / `planId` explicitly (null =
 * "none") to evaluate for a display surface that has no customer, such as the
 * landing page; an explicit value wins over the lookup.
 */
export function resolveDiscountSync(db, {
  at = null,
  requestedModel = null,
  userId = null,
  groupId,
  planId,
} = {}) {
  const atMs = ms(at) ?? Date.now();
  const empty = { rules: [], ruleIds: [], rawBp: 0, totalBp: 0, capped: false, endsAt: null };

  const live = db
    .all(`SELECT * FROM modelDiscounts WHERE isActive = 1`)
    .map(rowToDiscount)
    .filter((rule) => isWindowOpen(rule, atMs));
  if (live.length === 0) return empty;

  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : null;
  const needsPayer = live.some((r) => r.scopeType === "group" || r.scopeType === "plan");
  let ctx = { groupId: groupId ?? null, planId: planId ?? null };
  if (needsPayer && userId && (groupId === undefined || planId === undefined)) {
    const found = resolvePayerContextSync(db, userId, new Date(atMs).toISOString());
    ctx = {
      groupId: groupId === undefined ? found.groupId : groupId,
      planId: planId === undefined ? found.planId : planId,
    };
  }

  const rules = live.filter((rule) => {
    if (rule.scopeType === "combo") return model != null && !model.includes("/") && rule.scopeId === model;
    if (rule.scopeType === "group") return ctx.groupId != null && rule.scopeId === ctx.groupId && coversModel(rule, model);
    if (rule.scopeType === "plan") return ctx.planId != null && rule.scopeId === ctx.planId && coversModel(rule, model);
    return false;
  });
  if (rules.length === 0) return empty;

  const { rawBp, totalBp, capped } = combineBp(rules.map((r) => r.percentBp));
  // The price changes at the earliest end among the applied rules: that is the
  // "remaining time" a customer can rely on.
  let endsAt = null;
  for (const rule of rules) {
    if (rule.endsAt && (endsAt == null || ms(rule.endsAt) < ms(endsAt))) endsAt = rule.endsAt;
  }
  return { rules, ruleIds: rules.map((r) => r.id), rawBp, totalBp, capped, endsAt };
}

/**
 * Discount one request's list cost. The only place a charge's discount is decided.
 *
 * @returns {{ listCostNanoUsd:number, costNanoUsd:number, discountBp:number,
 *             ruleIds:string[], capped:boolean, rawBp:number }}
 */
export function applyRequestDiscountSync(db, { listCostNanoUsd, at = null, requestedModel = null, userId = null } = {}) {
  const list = Math.max(0, nano(listCostNanoUsd));
  if (list === 0) {
    return { listCostNanoUsd: 0, costNanoUsd: 0, discountBp: 0, ruleIds: [], capped: false, rawBp: 0 };
  }
  const found = resolveDiscountSync(db, { at, requestedModel, userId });
  return {
    listCostNanoUsd: list,
    costNanoUsd: applyBp(list, found.totalBp),
    discountBp: found.totalBp,
    ruleIds: found.ruleIds,
    capped: found.capped,
    rawBp: found.rawBp,
  };
}
