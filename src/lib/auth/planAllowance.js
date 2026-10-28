// Subscription-plan allowance enforcement.
//
// This is the layer OpenCode Go-style plans need and the per-key budget cannot
// express: a ceiling that is PER MODEL and re-checked over three nested time
// windows. The key budget in keyEnforcement.js answers "how much may this key
// spend"; this answers "how much may this key spend on THIS model, right now".
//
// Windows are nested, so a request must clear all of them. The month is the
// 100% figure; 5h and week are derived by planLimitsRepo so an admin cannot
// author contradictory numbers.
//
// HTTP contract, matching what an OpenAI-compatible client can act on:
//   403  the plan does not include this model at all
//   429  a window is exhausted (Retry-After points at the next one to refill)
//   402  the wallet itself is empty — handled upstream, not here
import { getApiKeyForAuth } from "@/lib/db/repos/apiKeysRepo.js";
import { getModelCostSinceNano } from "@/lib/db/repos/usageRepo.js";
import {
  listAllPlanModelLimits,
  resolveModelLimit,
  planAllowedModels,
  windowLimitNano,
  PLAN_WINDOWS,
} from "@/lib/db/repos/planLimitsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { matchesAllowed } from "@/lib/auth/modelMatching.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";

// Header names follow the shape OpenAI clients already parse (*-remaining-*).
// Kept custom rather than reusing x-ratelimit-*, which providers already use for
// requests-per-minute; overloading that name would make client metrics lie.
export const ALLOWANCE_HEADERS = {
  modelLimit: "x-plan-model-limit",
  modelRemaining: "x-plan-model-remaining",
  window: "x-plan-window",
  windowLimit: "x-plan-window-limit",
  windowRemaining: "x-plan-window-remaining",
  reset: "x-plan-window-reset",
};

function nowMs() {
  return Date.now();
}

/**
 * Every subscription a user currently holds, oldest purchase first.
 *
 * A customer may own several plans at once (bought one, then upgraded, or stacked
 * two months of the same plan). Their allowances ADD UP: holding Go and Go Plus
 * gives the sum of both ceilings on each model, which is what a customer who paid
 * twice reasonably expects.
 *
 * ORDER BY startsAt, then createdAt: the earliest-purchased plan is consumed
 * first, so when one expires the user is still inside the newer one. expiresAt is
 * deliberately NOT the sort key — a plan bought today that runs 30 days and one
 * bought last week that runs 365 days should still be spent in purchase order.
 *
 * Returns [] when the user is on credit-only grants (gift codes, admin
 * adjustments); those have no per-model allowance, which is a supported state.
 */
async function getActivePlansForUser(db, userId, at) {
  if (!userId) return [];
  const rows = db.all(
    `SELECT p.*, up.startsAt, up.expiresAt, up.createdAt
       FROM userPlans up
       JOIN plans p ON p.id = up.planId
      WHERE up.userId = ?
        AND up.status = 'active'
        AND up.expiresAt > ?
        AND p.id IS NOT NULL
      ORDER BY up.startsAt ASC, up.createdAt ASC`,
    [userId, at]
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    creditNanoUsd: Number(row.creditNanoUsd) || 0,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
  }));
}

/**
 * Combined per-model ceiling across every plan the user holds.
 *
 * Two plans covering the same model add their monthly figures; a model only one
 * plan covers keeps that plan's figure. This is the number the customer was sold,
 * so it is what enforcement uses.
 *
 * @returns {Map<string, {monthlyNanoUsd:number, sources:Array}>} model -> merged
 */
function mergeLimitsAcrossPlans(limitsByPlan, plans) {
  /** @type {Map<string, {monthlyNanoUsd:number, sources:Array}>} */
  const merged = new Map();

  for (const plan of plans) {
    const limits = limitsByPlan.get(plan.id) ?? [];
    for (const limit of limits) {
      const existing = merged.get(limit.model);
      if (existing) {
        existing.monthlyNanoUsd += limit.monthlyNanoUsd;
        existing.sources.push({ planId: plan.id, planName: plan.name || plan.code, monthlyNanoUsd: limit.monthlyNanoUsd });
      } else {
        merged.set(limit.model, {
          monthlyNanoUsd: limit.monthlyNanoUsd,
          sources: [{ planId: plan.id, planName: plan.name || plan.code, monthlyNanoUsd: limit.monthlyNanoUsd }],
        });
      }
    }
  }

  return merged;
}

/** Window start instants for every configured window, relative to `now`. */
export function windowStarts(now = nowMs()) {
  const out = {};
  for (const w of PLAN_WINDOWS) out[w.id] = new Date(now - w.ms).toISOString();
  return out;
}

/**
 * Spend on one model over one window.
 * Cost is summed per window in one query each; three windows per request is
 * cheap because idx_uh_ts_nano covers the range scan, and the per-model filter
 * is applied in SQL rather than by fetching rows.
 */
async function spendForModel(userId, model, windows) {
  const spend = {};
  for (const w of PLAN_WINDOWS) {
    const byModel = await getModelCostSinceNano(userId, windows[w.id]);
    // Sum every configured model that resolves to this one, so a plan that lists
    // both a bare id and its provider-prefixed form cannot be split across two
    // counters to double the ceiling.
    let total = 0;
    for (const [spentModel, spent] of byModel) {
      if (spentModel === model || matchesAllowed(spentModel, [model]) || matchesAllowed(model, [spentModel])) {
        total += spent;
      }
    }
    spend[w.id] = total;
  }
  return spend;
}

/**
 * A combo is an alias over concrete provider/model pairs, so metering it needs
 * the members, not the alias name. Without this a plan that allows every member
 * of a combo would still reject the combo itself — the caller would see a 403
 * for a model set they believe they paid for.
 *
 * Returns the member list when `model` names a combo, otherwise null.
 */
async function comboMembers(model) {
  if (!model) return null;
  try {
    const combo = await getComboByName(model);
    const members = Array.isArray(combo?.models) ? combo.models.filter(Boolean) : [];
    return members.length ? members : null;
  } catch {
    return null; // no combos table / lookup failure → treat as a plain model
  }
}

/**
 * Resolve what a plan allowance check should actually meter: a combo becomes its
 * members, everything else stays as-is.
 */
async function meterTargets(model) {
  const members = await comboMembers(model);
  return members ?? [model];
}

/**
 * Check a request against the caller's plan allowance.
 *
 * @returns {Promise<{ok:true, allowance:object|null} | {ok:false, status:number, error:string, retryAfter?:number, resetAt?:string, headers?:object}>}
 *   `allowance` is null when the plan has no per-model limits, so callers can
 *   skip emitting headers rather than advertising a limit that does not exist.
 */
export async function checkPlanAllowance(apiKey, model, { now = nowMs() } = {}) {
  if (!apiKey || !model) return { ok: true, allowance: null };

  const auth = await getApiKeyForAuth(apiKey);
  const userId = auth?.key?.userId ?? null;
  if (!userId) return { ok: true, allowance: null };

  const db = await getAdapter();
  const at = new Date(now).toISOString();

  // Every plan the user holds, oldest purchase first. A customer may stack plans;
  // their ceilings add up rather than one plan silently winning.
  const plans = await getActivePlansForUser(db, userId, at);
  if (!plans.length) return { ok: true, allowance: null };

  const limitsByPlan = await listAllPlanModelLimits();
  const mergedLimits = mergeLimitsAcrossPlans(limitsByPlan, plans);
  if (!mergedLimits.size) return { ok: true, allowance: null };

  // Flatten the merged map back into the shape the rest of this function expects
  // (a list of { model, monthlyNanoUsd }) so the matching logic below does not
  // need a second implementation for the multi-plan case.
  const limits = [...mergedLimits.entries()].map(([model, value]) => ({
    model,
    monthlyNanoUsd: value.monthlyNanoUsd,
    sources: value.sources,
  }));

  const planLabel = plans.length === 1
    ? (plans[0].name || plans[0].code)
    : `${plans.length} gói`;

  // 1. Is this model part of any plan at all? A combo is metered through its
  //    members: a plan that allows every member must accept the alias, and a
  //    combo whose members are all outside every plan must be rejected as a whole
  //    rather than silently routing to something the customer did not buy.
  const targets = await meterTargets(model);
  const allowed = planAllowedModels(limits);

  if (allowed) {
    const outside = targets.filter((t) => !matchesAllowed(t, allowed));
    if (outside.length === targets.length) {
      return {
        ok: false,
        status: 403,
        error: `${planLabel} không bao gồm model ${model}`,
      };
    }
    if (outside.length > 0) {
      // Only some members are covered — the combo would silently fail over into
      // a model the customer did not pay for, so refuse it whole.
      return {
        ok: false,
        status: 403,
        error:
          `${planLabel} chỉ bao gồm một phần model của combo ${model}. ` +
          `Ngoài gói: ${outside.join(", ")}`,
      };
    }
  }

  // The ceiling is the most restrictive of the members, so a combo cannot be used
  // to sidestep a tight limit on one of its models.
  let limit = null;
  for (const t of targets) {
    const l = resolveModelLimit(limits, t);
    if (!l) continue;
    if (!limit || l.monthlyNanoUsd < limit.monthlyNanoUsd) limit = l;
  }
  if (!limit) {
    // Reachable when the allow-list matched through prefix equivalence but no
    // concrete row resolved; treat as allowed with no ceiling rather than
    // inventing one.
    return { ok: true, allowance: null };
  }

  const windows = windowStarts(now);
  // Sum every target's spend against this one ceiling: the binding number for a
  // combo is the total across its members, not any single member.
  const spend = { month: 0, week: 0, "5h": 0 };
  for (const t of targets) {
    const s = await spendForModel(userId, t, windows);
    for (const k of Object.keys(spend)) spend[k] += s[k] ?? 0;
  }

  // 2. Every window must have room. Check the shortest first: it is the one a
  //    client is most likely to hit and it refills soonest, so its Retry-After
  //    is the most useful number to return.
  for (const w of PLAN_WINDOWS) {
    const cap = windowLimitNano(limit.monthlyNanoUsd, w.id);
    if (cap == null) continue;
    if (spend[w.id] >= cap) {
      const resetAt = new Date(now + w.ms).toISOString();
      return {
        ok: false,
        status: 429,
        error:
          `${planLabel} đã dùng hết hạn mức ${w.label} cho model ${model}. ` +
          `Hạn mức ${w.label}: ${cap} nanoUSD, đã dùng ${spend[w.id]}.`,
        retryAfter: Math.ceil(w.ms / 1000),
        resetAt,
        headers: {
          [ALLOWANCE_HEADERS.modelLimit]: String(limit.monthlyNanoUsd),
          [ALLOWANCE_HEADERS.modelRemaining]: String(Math.max(0, limit.monthlyNanoUsd - spend.month)),
          [ALLOWANCE_HEADERS.window]: w.id,
          [ALLOWANCE_HEADERS.windowLimit]: String(cap),
          [ALLOWANCE_HEADERS.windowRemaining]: "0",
          [ALLOWANCE_HEADERS.reset]: resetAt,
        },
      };
    }
  }

  // 3. Allowed — describe the headroom so a client can back off before hitting it.
  //    The binding window is the one with the smallest remaining fraction; that
  //    is the number worth surfacing.
  let binding = null;
  for (const w of PLAN_WINDOWS) {
    const cap = windowLimitNano(limit.monthlyNanoUsd, w.id);
    if (cap == null || cap === 0) continue;
    const remaining = Math.max(0, cap - spend[w.id]);
    const fraction = remaining / cap;
    if (!binding || fraction < binding.fraction) {
      binding = { id: w.id, cap, remaining, fraction, resetAt: new Date(now + w.ms).toISOString() };
    }
  }

  return {
    ok: true,
    allowance: {
      // Every plan is reported, not just a winner: the ceiling is their sum, and
      // a support question ("what did I actually buy?") needs the list.
      plans: plans.map((p) => ({ id: p.id, code: p.code, name: p.name, expiresAt: p.expiresAt })),
      sources: limit.sources ?? [],
      model,
      monthlyNanoUsd: limit.monthlyNanoUsd,
      monthRemainingNanoUsd: Math.max(0, limit.monthlyNanoUsd - spend.month),
      bindingWindow: binding?.id ?? null,
      bindingLimitNanoUsd: binding?.cap ?? null,
      bindingRemainingNanoUsd: binding?.remaining ?? null,
      resetAt: binding?.resetAt ?? null,
    },
  };
}

/**
 * Would this plan accept a combo, given its members? Used by /v1/models so an
 * alias over permitted models is advertised — otherwise a customer sees the
 * members but not the combo that wraps them.
 */
export async function planAcceptsCombo(userId, comboName, { now = nowMs() } = {}) {
  const allowed = await planModelAllowList(userId, { now });
  if (!allowed) return true; // no per-model restriction
  const members = await comboMembers(comboName);
  if (!members) return matchesAllowed(comboName, allowed);
  return members.every((m) => matchesAllowed(m, allowed));
}

/**
 * Response headers for an allowed request. Empty when the plan has no limits. */
export function allowanceHeaders(allowance) {
  if (!allowance) return {};
  const h = {
    [ALLOWANCE_HEADERS.modelLimit]: String(allowance.monthlyNanoUsd),
    [ALLOWANCE_HEADERS.modelRemaining]: String(allowance.monthRemainingNanoUsd),
  };
  if (allowance.bindingWindow) {
    h[ALLOWANCE_HEADERS.window] = allowance.bindingWindow;
    h[ALLOWANCE_HEADERS.windowLimit] = String(allowance.bindingLimitNanoUsd);
    h[ALLOWANCE_HEADERS.windowRemaining] = String(allowance.bindingRemainingNanoUsd);
    if (allowance.resetAt) h[ALLOWANCE_HEADERS.reset] = allowance.resetAt;
  }
  return h;
}

/**
 * The model ids the user's plans meter between them, or null when no plan imposes
 * a per-model restriction. Used by /v1/models so the catalog matches what the
 * request path will actually accept.
 *
 * The union across plans: holding Go (haiku only) and Pro (haiku + gpt-4o) must
 * advertise both models, not just the newest plan's.
 */
export async function planModelAllowList(userId, { now = nowMs() } = {}) {
  if (!userId) return null;
  const db = await getAdapter();
  const plans = await getActivePlansForUser(db, userId, new Date(now).toISOString());
  if (!plans.length) return null;

  const limitsByPlan = await listAllPlanModelLimits();
  const merged = mergeLimitsAcrossPlans(limitsByPlan, plans);
  if (!merged.size) return null;

  return [...merged.keys()];
}

/** Two model ids naming the same model, using the shared allow-list matcher. */
export function sameModel(a, b) {
  return a === b || matchesAllowed(a, [b]) || matchesAllowed(b, [a]);
}
