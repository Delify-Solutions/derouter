// Customer-facing reads for the account area: plan queue, plan history and ledger.
//
// Kept out of the route handlers so the same queries back both the API and (via the
// API) the pages, and so they can be tested against a real database without a
// Next.js runtime. Everything is scoped to the caller: `userId` is always the
// session's, never a query parameter.
//
// The queue itself is NOT computed here — queueViewSync owns ordering, window state
// and the status label, so the page and the request path can never disagree.
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { nano } from "../../billing/ledger.js";
import { parseLimits, describeLimit, windowLabel } from "../../billing/limits.js";
import { queueViewSync } from "../../billing/planQueue.js";
import { UNLIMITED_CREDIT_LABEL } from "../../../shared/utils/money.js";

function nowIso() {
  return new Date().toISOString();
}

/** Money helper shared by both payloads. Kept local so this module stays import-light. */
function usd(nanoUsd) {
  const n = nano(nanoUsd);
  const value = n / 1e9;
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

/**
 * The queue exactly as the customer page and the admission path see it, flattened
 * into the API shape of design D18: each entry carries `statusLabel`, `reopenAt` and
 * one ready-to-render row per limit.
 */
export function getQueueSync(db, userId, nowIsoArg = null) {
  const at = nowIsoArg || nowIso();
  return queueViewSync(db, userId, at).map((entry) => ({
    id: entry.id,
    planId: entry.planId,
    planCode: entry.planCode,
    planName: entry.planName,
    source: entry.source,
    creditTotalNanoUsd: entry.creditTotalNanoUsd,
    creditRemainingNanoUsd: entry.creditRemainingNanoUsd,
    unlimitedCredit: entry.unlimitedCredit === true,
    startsAt: entry.startsAt,
    expiresAt: entry.expiresAt,
    priority: entry.priority,
    statusLabel: entry.statusLabel,
    reopenAt: entry.reopenAt,
    // queueViewSync spreads evaluatePlan's result last, so `entry.windows` is the
    // evaluated array (hours/max/spent/open/reset), not the raw state map.
    windows: (entry.windows ?? []).map((window) => ({
      hours: window.hours,
      label: windowLabel(window.hours),
      maxNanoUsd: window.maxNanoUsd,
      spentNanoUsd: window.spentNanoUsd,
      startedAt: window.startedAt,
      resetAt: window.resetAt,
      open: window.open,
      full: window.full,
    })),
  }));
}

/**
 * Purchases that are no longer in the queue — exhausted, expired or revoked —
 * newest first, capped at 50 (design D18). These are history, not spending: nothing
 * here can pay for a request.
 */
export function getPlanHistorySync(db, userId, { limit = 50 } = {}) {
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 200);
  const rows = db.all(
    `SELECT up.*, p.code AS planCode, p.name AS planName
       FROM userPlans up
       LEFT JOIN plans p ON p.id = up.planId
      WHERE up.userId = ? AND up.status <> 'active'
      ORDER BY up.createdAt DESC, up.id DESC
      LIMIT ?`,
    [userId, take]
  );
  return rows.map((row) => ({
    id: row.id,
    planId: row.planId ?? null,
    planCode: row.planCode ?? null,
    planName: row.planName ?? null,
    source: row.source ?? null,
    creditTotalNanoUsd: nano(row.creditTotalNanoUsd),
    creditRemainingNanoUsd: nano(row.creditRemainingNanoUsd),
    unlimitedCredit: Number(row.unlimitedCredit) === 1,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    status: row.status,
    createdAt: row.createdAt ?? null,
    limits: parseLimits(row.limits),
  }));
}

/**
 * One page of the caller's ledger, newest first (spec customer-portal "Ledger
 * page", design D18).
 *
 * `usageId` is joined to `usageHistory` so a charge row can show WHICH request it
 * paid for: model and input/output token counts. Legacy `charge` rows written
 * before `usageId` existed simply render without them.
 *
 * @param {{ page?:number, pageSize?:number, planId?:string|null, kind?:string|null }} filters
 * @returns {{ entries:Array, total:number, page:number, pageSize:number }}
 */
export function getAccountLedgerSync(db, userId, { page = 1, pageSize = 25, planId = null, kind = null } = {}) {
  const take = Math.min(Math.max(1, Math.floor(Number(pageSize) || 25)), 100);
  const current = Math.max(1, Math.floor(Number(page) || 1));
  const skip = (current - 1) * take;

  const where = ["cl.userId = ?"];
  const params = [userId];
  if (planId) {
    // Filter by the PLAN, not the purchase: the customer knows "Go", not row ids.
    where.push(`up.planId = ?`);
    params.push(planId);
  }
  if (kind) {
    where.push(`cl.kind = ?`);
    params.push(kind);
  }
  const clause = `WHERE ${where.join(" AND ")}`;

  const rows = db.all(
    `SELECT cl.*, p.name AS planName, p.code AS planCode,
            uh.model AS usageModel, uh.promptTokens AS usagePrompt,
            uh.completionTokens AS usageCompletion
       FROM creditLedger cl
       LEFT JOIN userPlans up ON up.id = cl.userPlanId
       LEFT JOIN plans p ON p.id = up.planId
       LEFT JOIN usageHistory uh ON uh.id = cl.usageId
      ${clause}
      ORDER BY cl.createdAt DESC, cl.id DESC
      LIMIT ? OFFSET ?`,
    [...params, take, skip]
  );

  const total = Number(
    db.get(
      `SELECT COUNT(*) AS c
         FROM creditLedger cl
         LEFT JOIN userPlans up ON up.id = cl.userPlanId
        ${clause}`,
      params
    )?.c ?? 0
  );

  return {
    entries: rows.map((row) => {
      const meta = parseJson(row.meta, null);
      return {
        id: row.id,
        createdAt: row.createdAt,
        kind: row.kind,
        planName: row.planName ?? null,
        planCode: row.planCode ?? null,
        // A back-charged row is a `charge` with meta.backfill; the page labels it
        // so support and the customer see the same word.
        backfill: meta?.backfill === true,
        model: row.usageModel ?? null,
        promptTokens: row.usagePrompt == null ? null : nano(row.usagePrompt),
        completionTokens: row.usageCompletion == null ? null : nano(row.usageCompletion),
        deltaNanoUsd: nano(row.deltaNanoUsd),
        deltaUsd: usd(row.deltaNanoUsd),
        balanceAfterNanoUsd: row.balanceAfterNanoUsd == null ? null : nano(row.balanceAfterNanoUsd),
        balanceAfterUsd: row.balanceAfterNanoUsd == null ? null : usd(row.balanceAfterNanoUsd),
      };
    }),
    total,
    page: current,
    pageSize: take,
  };
}

/** `[{ planId, planName, planCode }]` — the filter options for the ledger page. */
export function getLedgerPlanOptionsSync(db, userId) {
  const rows = db.all(
    `SELECT DISTINCT up.planId AS planId, p.name AS planName, p.code AS planCode
       FROM creditLedger cl
       JOIN userPlans up ON up.id = cl.userPlanId
       LEFT JOIN plans p ON p.id = up.planId
      WHERE cl.userId = ? AND up.planId IS NOT NULL
      ORDER BY planName ASC`,
    [userId]
  );
  return rows.map((row) => ({ planId: row.planId, planName: row.planName ?? row.planCode, planCode: row.planCode }));
}

/**
 * Shape a plan row for the customer catalogue (limits + human text + buyability).
 *
 * `methods` is the offered-methods list computed by `offeredMethodsSync`, so the
 * purchase card renders exactly the buttons the checkout route will accept
 * (spec plan-dual-pricing "Offered payment methods"). `priceVnd` passes through
 * from the plan row; the display string is on each method entry.
 */
export function toCatalogPlan(plan, blocker, methods = []) {
  const limits = Array.isArray(plan.limits) ? plan.limits : parseLimits(plan.limits);
  return {
    ...plan,
    priceUsd: usd(plan.priceNanoUsd),
    priceVnd: plan.priceVnd == null ? null : nano(plan.priceVnd),
    priceVndText: plan.priceVnd ? formatVnd(nano(plan.priceVnd)) : null,
    creditUsd: plan.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : usd(plan.creditNanoUsd),
    limits,
    limitsText: [...limits.map(describeLimit), ...describeRates(plan)],
    offeredMethods: methods,
    purchasable: !blocker,
    blockedReason: blocker?.reason ?? null,
    blockedCode: blocker?.code ?? null,
  };
}

/** Rate lines for a plan card: nothing when the plan sets no rate. */
function describeRates(plan) {
  const lines = [];
  if (plan.rpm) lines.push(`${plan.rpm.toLocaleString("vi-VN")} request mỗi phút`);
  if (plan.tpm) lines.push(`${plan.tpm.toLocaleString("vi-VN")} token mỗi phút`);
  return lines;
}

/** "250.000đ" — the same format the checkout strings use (design D2). */
function formatVnd(value) {
  const digits = String(Math.round(Number(value) || 0));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${out}đ`;
}

/** Adapter accessor for routes that need the raw handle (reorder, purchase). */
export async function adapter() {
  return getAdapter();
}
