import { NextResponse } from "next/server";
import {
  getApiKeys,
  getApiKeyForAuth,
  getKeyRateUsage,
  getKeyCostSince,
  getKeyRequestCountSince,
  getKeyUsageSummary,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Window duration in ms for the "5h" / "day" / "week" reset windows.
const WINDOW_MS = {
  "5h": 5 * 3600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// Mask a full API key for display: sk-…****last4 (never reveal the middle).
function maskKeyFull(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 12) return "****";
  return `${key.slice(0, key.indexOf("-") + 1 || 3)}…****${key.slice(-4)}`;
}

/**
 * GET /api/usage/key-summary
 * Admin-only per-key usage summary (viber-router KeyTokenUsage-style).
 *
 * Query:
 *   key=<apikey>      — return a single key (plus window/limits). If omitted,
 *                       return an array for ALL keys.
 *   startDate=<iso>   — window start (inclusive).
 *   endDate=<iso>      — window end (inclusive).
 *
 * Each item:
 *   { id, name, group, maskedKey, active,
 *     rpm, tpm, budgetUsd, resetWindow,
 *     windowStartedAt, windowCostUsd, windowRequests, remainingBudgetUsd,
 *     resetAt, expiresAt, allowedModels,
 *     liveRpm, liveTpm, peakTpm,
 *     byModel:[{ model, input, output, cacheRead, cacheCreation, requests, cost }],
 *     totals:{ input, output, cacheRead, cacheCreation, requests, cost } }
 *
 * Raw request/response payloads are NOT included here — use
 * /api/usage/request-details?apiKey=&includeRaw=1 for those.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const keyParam = searchParams.get("key");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const keys = keyParam
      ? [await getApiKeyForAuth(keyParam)].filter(Boolean)
      : await getAllKeysWithAuth();

    const items = await Promise.all(
      keys.filter(Boolean).map(async (auth) => {
        const k = auth.key;
        const group = auth.group;
        const resolved = auth.resolved;

        const resetWindow = resolved.resetWindow;
        const windowMs = resetWindow ? WINDOW_MS[resetWindow] ?? null : null;

        let windowStartedAt = k.windowStartedAt || k.createdAt || new Date().toISOString();
        const startMs = new Date(windowStartedAt).getTime();

        let displayWindowStart = windowStartedAt;
        let displayCost = k.windowCostUsd ?? 0;
        let displayRequests = 0;
        let resetAt = null;

        if (windowMs) {
          const nowMs = Date.now();
          const elapsed = nowMs - startMs;
          if (elapsed >= windowMs) {
            displayWindowStart = new Date(nowMs - (nowMs % windowMs)).toISOString();
            displayCost = await getKeyCostSince(k.key, displayWindowStart);
            displayRequests = await getKeyRequestCountSince(k.key, displayWindowStart);
            resetAt = new Date(new Date(displayWindowStart).getTime() + windowMs).toISOString();
          } else {
            displayCost = await getKeyCostSince(k.key, windowStartedAt);
            displayRequests = await getKeyRequestCountSince(k.key, windowStartedAt);
            resetAt = new Date(startMs + windowMs).toISOString();
          }
        } else {
          displayCost = await getKeyCostSince(k.key, new Date(0).toISOString());
          displayRequests = await getKeyRequestCountSince(k.key, new Date(0).toISOString());
        }

        // Live last-minute RPM / TPM (requests + tokens in last 60s).
        const limitCount = await getKeyRateUsage(k.key, 60_000);

        const budgetUsd = resolved.budgetUsd;
        const remainingBudgetUsd =
          budgetUsd == null ? null : Math.max(0, budgetUsd - displayCost);

        const summary = await getKeyUsageSummary(k.key, { startDate, endDate });

        return {
          id: k.id,
          name: k.name,
          group: group?.name ?? null,
          groupId: k.groupId ?? null,
          maskedKey: maskKeyFull(k.key),
          active: k.isActive ?? true,

          rpm: resolved.rpm ?? null,
          tpm: resolved.tpm ?? null,
          budgetUsd: budgetUsd ?? null,
          resetWindow: resetWindow ?? null,

          windowStartedAt: displayWindowStart,
          windowCostUsd: displayCost,
          windowRequests: displayRequests,
          remainingBudgetUsd,
          resetAt,
          expiresAt: k.expiresAt ?? null,

          allowedModels: resolved.allowedModels ?? null,

          liveRpm: limitCount.requests,
          liveTpm: limitCount.tokens,
          peakTpm: summary.peakTpm,

          byModel: summary.items,
          totals: summary.totals,
        };
      })
    );

    return NextResponse.json(keyParam ? { item: items[0] || null } : { items });
  } catch (error) {
    console.error("[API] Failed to get key usage summary:", error);
    return NextResponse.json({ error: "Failed to fetch key usage summary" }, { status: 500 });
  }
}

// Resolve auth (key + group + resolved limits) for every stored key.
async function getAllKeysWithAuth() {
  const all = await getApiKeys();
  const out = [];
  for (const k of all) {
    const auth = await getApiKeyForAuth(k.key);
    if (auth) out.push(auth);
  }
  return out;
}
