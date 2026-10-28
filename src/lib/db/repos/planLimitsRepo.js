// Per-model monthly allowance for subscription plans.
//
// Mirrors how a metered subscription (OpenCode Go and friends) works: a plan is
// a monthly dollar ceiling, and that ceiling is sliced PER MODEL rather than
// shared as one pot. A heavy user of a cheap model must not starve themselves
// out of an expensive one, and a runaway loop on one model must not burn the
// whole plan.
//
// The windows are relative to the monthly figure, not stored separately:
//
//   5 hours  = 20% of the monthly ceiling
//   1 week   = 50%
//   1 month  = 100%
//
// Storing all three would allow a plan whose windows contradict each other (e.g.
// a 5h limit above the weekly one), so they are derived here and only the
// monthly number is persisted.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { matchesAllowed } from "../../auth/modelMatching.js";

// A plan usage window, in milliseconds. The 5h figure is the same one the
// OpenCode Go docs use and is what a burst of agent traffic is measured over.
export const PLAN_WINDOWS = [
  { id: "5h", label: "5 giờ", ms: 5 * 60 * 60 * 1000, fraction: 0.2 },
  { id: "week", label: "1 tuần", ms: 7 * 24 * 60 * 60 * 1000, fraction: 0.5 },
  { id: "month", label: "1 tháng", ms: 30 * 24 * 60 * 60 * 1000, fraction: 1 },
];

export const PLAN_WINDOW_5H = "5h";
export const PLAN_WINDOW_WEEK = "week";
export const PLAN_WINDOW_MONTH = "month";

function windowById(id) {
  return PLAN_WINDOWS.find((w) => w.id === id) ?? null;
}

/**
 * The dollar ceiling a given window implies for a monthly figure.
 * Integer nanoUSD in, integer nanoUSD out — never a float, so a limit cannot
 * drift a fraction of a cent over months of rounding.
 */
export function windowLimitNano(monthlyNanoUsd, windowId) {
  const w = windowById(windowId);
  if (!w) return null;
  return Math.round(Math.max(0, Number(monthlyNanoUsd) || 0) * w.fraction);
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function listPlanModelLimits(planId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM planModelLimits WHERE planId = ? ORDER BY model ASC`,
    [planId]
  );
  return rows.map((r) => ({
    id: r.id,
    planId: r.planId,
    model: r.model,
    monthlyNanoUsd: Number(r.monthlyNanoUsd) || 0,
    createdAt: r.createdAt,
  }));
}

/** Every model restriction for every plan, keyed by planId. One query, not N. */
export async function listAllPlanModelLimits() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM planModelLimits ORDER BY planId ASC, model ASC`);
  const byPlan = new Map();
  for (const r of rows) {
    const list = byPlan.get(r.planId) ?? [];
    list.push({
      id: r.id,
      planId: r.planId,
      model: r.model,
      monthlyNanoUsd: Number(r.monthlyNanoUsd) || 0,
      createdAt: r.createdAt,
    });
    byPlan.set(r.planId, list);
  }
  return byPlan;
}

/**
 * Replace a plan's model list wholesale. Callers send the complete desired set;
 * per-model upsert would leave removed models behind and silently keep metering
 * traffic the admin thought they had deleted.
 *
 * SYNCHRONOUS body inside one transaction so a failed write cannot leave a plan
 * with half of its old limits and half of its new ones.
 */
export async function setPlanModelLimits(planId, limits = []) {
  const db = await getAdapter();
  const now = new Date().toISOString();

  const clean = [];
  const seen = new Set();
  for (const raw of Array.isArray(limits) ? limits : []) {
    const model = typeof raw?.model === "string" ? raw.model.trim() : "";
    if (!model) continue;
    if (seen.has(model)) throw new Error(`Model lặp lại: ${model}`);
    seen.add(model);
    const monthly = Math.max(0, Math.round(Number(raw?.monthlyNanoUsd) || 0));
    if (monthly <= 0) throw new Error(`Hạn mức của ${model} phải lớn hơn 0`);
    clean.push({ model, monthly });
  }

  // db.transaction(fn) runs fn immediately (the adapters wrap it), so it must be
  // called as a statement rather than returned and invoked.
  db.transaction(() => {
    db.run(`DELETE FROM planModelLimits WHERE planId = ?`, [planId]);
    for (const entry of clean) {
      db.run(
        `INSERT INTO planModelLimits(id, planId, model, monthlyNanoUsd, createdAt) VALUES(?, ?, ?, ?, ?)`,
        [uuidv4(), planId, entry.model, entry.monthly, now]
      );
    }
  });

  return listPlanModelLimits(planId);
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Pick the limit row that applies to a requested model id.
 *
 * Exact match wins, then the shared matcher (matchesAllowed) handles the
 * provider-prefix equivalence it already implements — "claude-haiku-4-5" and
 * "anthropic/claude-haiku-4-5" resolve to the same row. That matcher does NOT
 * support globs, so a plan must list concrete model ids; using it anyway keeps
 * this consistent with the key allow-list, so a customer never has one part of
 * the system accept a model the other rejects.
 */
export function resolveModelLimit(limits, requestedModel) {
  if (!Array.isArray(limits) || !limits.length || !requestedModel) return null;
  const exact = limits.find((l) => l.model === requestedModel);
  if (exact) return exact;
  return limits.find((l) => matchesAllowed(requestedModel, [l.model])) ?? null;
}

/**
 * Which models this plan is allowed to call at all.
 * A plan with no per-model rows is unrestricted (returns null) — that keeps
 * every plan created before this feature usable without a migration step.
 */
export function planAllowedModels(limits) {
  if (!Array.isArray(limits) || !limits.length) return null;
  return limits.map((l) => l.model);
}
