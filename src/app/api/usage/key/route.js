import { NextResponse } from "next/server";
import {
  getApiKeyForAuth,
  getKeyRateUsage,
  getKeyCostSince,
  getKeyRequestCountSince,
} from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { getQueueSync, getPlanHistorySync } from "@/lib/db/repos/accountPlansRepo.js";
import { getUserRateUsage } from "@/lib/db/repos/usageRepo.js";
import { payingRatesSync } from "@/lib/billing/rates.js";
import { getDebtNanoSync } from "@/lib/billing/ledger.js";

/**
 * The account behind a customer key, as /account/plans shows it: every plan in the
 * queue (limits with their window state, RPM/TPM, start and expiry), recent plans
 * that stopped, and the rate applied right now. A customer key is billed and
 * rate-limited by these — not by the key's own budget/RPM fields, which only apply
 * to admin keys — so the page must show them (spec customer-portal "Public usage
 * page shows the account's plans").
 */
function customerAccountSync(db, userId, rates, used) {
  const queue = getQueueSync(db, userId);
  const started = queue.filter((entry) => entry.statusLabel !== "scheduled");
  const debtNanoUsd = getDebtNanoSync(db, userId);
  const credit = started.reduce((sum, entry) => sum + Math.max(0, entry.creditRemainingNanoUsd), 0);
  return {
    queue,
    history: getPlanHistorySync(db, userId, { limit: 10 }),
    availableNanoUsd: Math.max(0, credit - debtNanoUsd),
    hasUnlimitedCredit: started.some((entry) => entry.unlimitedCredit),
    debtNanoUsd,
    rate: { ...rates, requests: used.requests, tokens: used.tokens },
  };
}

export const dynamic = "force-dynamic";

// Window duration in ms for the "5h" / "day" / "week" reset windows.
const WINDOW_MS = {
  "5h": 5 * 3600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/**
 * GET /api/usage/key?key=<apikey>
 * Public — a key holder looks up their own usage. No admin login required.
 *
 * Returns 404 (generic) if the key is not found, so existence is not leaked.
 *
 * Response shape:
 * {
 *   name, active, groupId, groupName,
 *   allowedModels: string[] | null,     // null = all models allowed
 *   rpm: number | null,                  // resolved (key || group || null)
 *   tpm: number | null,
 *   budgetUsd: number | null,
 *   resetWindow: "5h" | "day" | "week" | null,
 *   windowStartedAt: string | null,
 *   windowCostUsd: number,               // cost spent in current window
 *   windowRequests: number,              // requests in current window
 *   remainingBudgetUsd: number | null,   // null = unlimited
 *   resetAt: string | null,               // when the window resets
 *   expiresAt: string | null,
 *   limitCount: { requests: number, tokens: number } // last 60s (live RPM / TPM)
 * }
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");

    if (!key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const auth = await getApiKeyForAuth(key);
    if (!auth || !auth.key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const k = auth.key;
    const group = auth.group;
    const resolved = auth.resolved;

    // Determine the effective reset window (key value wins, else group).
    const resetWindow = resolved.resetWindow;
    const windowMs = resetWindow ? WINDOW_MS[resetWindow] ?? null : null;

    // Window start: use stored windowStartedAt, else fall back to createdAt,
    // else "now" for a never-used key.
    let windowStartedAt = k.windowStartedAt;
    if (!windowStartedAt) {
      windowStartedAt = k.createdAt || new Date().toISOString();
    }
    const startMs = new Date(windowStartedAt).getTime();

    // If the window has elapsed, the effective window has already rolled in
    // the enforcement layer; for display purposes, clamp cost/requests to 0
    // and report resetAt = now + window.
    let displayWindowStart = windowStartedAt;
    let displayCost = k.windowCostUsd ?? 0;
    let displayRequests = 0;
    let resetAt = null;

    if (windowMs) {
      const nowMs = Date.now();
      const elapsed = nowMs - startMs;
      if (elapsed >= windowMs) {
        // Window has rolled (enforcement would reset it on next request).
        displayWindowStart = new Date(nowMs - (nowMs % windowMs)).toISOString();
        displayCost = 0;
        // Recompute fresh cost/requests from the (rolled) window start.
        displayCost = await getKeyCostSince(key, displayWindowStart);
        displayRequests = await getKeyRequestCountSince(key, displayWindowStart);
        resetAt = new Date(new Date(displayWindowStart).getTime() + windowMs).toISOString();
      } else {
        displayCost = await getKeyCostSince(key, windowStartedAt);
        displayRequests = await getKeyRequestCountSince(key, windowStartedAt);
        resetAt = new Date(startMs + windowMs).toISOString();
      }
    } else {
      // No reset window (unlimited budget window): report all-time cost.
      displayCost = await getKeyCostSince(key, new Date(0).toISOString());
      displayRequests = await getKeyRequestCountSince(key, new Date(0).toISOString());
    }

    // Live last-minute RPM / TPM (requests + tokens in last 60s). A customer key is
    // limited per ACCOUNT at the paying plan's rates (keyEnforcement), so that is
    // what is counted and shown; an admin key keeps its own per-key figures.
    // The allowance is per (user, plan), so a key pinned to a plan shows that plan's.
    let account = null;
    if (k.userId) {
      const accountDb = await getAdapter();
      const rates = payingRatesSync(accountDb, k.userId, null, { planId: k.planId ?? null });
      const used = rates.rateKey
        ? await getUserRateUsage(k.userId, 60_000, rates.rateKey)
        : { requests: 0, tokens: 0 };
      account = customerAccountSync(accountDb, k.userId, rates, used);
    }
    const limitCount = account
      ? { requests: account.rate.requests, tokens: account.rate.tokens }
      : await getKeyRateUsage(key, 60_000);

    const budgetUsd = resolved.budgetUsd;
    const remainingBudgetUsd =
      budgetUsd == null ? null : Math.max(0, budgetUsd - displayCost);

    return NextResponse.json({
      name: k.name,
      active: k.isActive ?? true,
      groupId: k.groupId ?? null,
      groupName: group?.name ?? null,

      allowedModels: resolved.allowedModels ?? null,
      rpm: account ? account.rate.rpm : resolved.rpm ?? null,
      tpm: account ? account.rate.tpm : resolved.tpm ?? null,
      // Budget is an admin-key mechanism; a customer key is bounded by its plans.
      budgetUsd: account ? null : budgetUsd ?? null,
      resetWindow: resetWindow ?? null,

      windowStartedAt: displayWindowStart,
      windowCostUsd: displayCost,
      windowRequests: displayRequests,
      remainingBudgetUsd,
      resetAt,

      expiresAt: k.expiresAt ?? null,

      // Customer keys only: the account's plans and current rate. null for admin keys.
      account,

      // Live rate counters (last 60s).
      limitCount: {
        requests: limitCount.requests,
        tokens: limitCount.tokens,
      },
    });
  } catch {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
}
