import { NextResponse } from "next/server";
import {
  getApiKeyForAuth,
  getKeyRateUsage,
  getKeyUsageSummary,
  getUsageHistory,
  getCombos,
  getComboPricing,
} from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// Period presets (ms back from now). Mirrors the admin key-summary presets.
const PERIOD_MS = {
  today: null, // computed to start-of-day
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "60d": 60 * 86_400_000,
};

function periodToRange(period) {
  const now = new Date();
  const end = now.toISOString();
  let start;
  if (period === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    start = d.toISOString();
  } else if (period === "all") {
    start = new Date(0).toISOString();
  } else {
    const ms = PERIOD_MS[period];
    start = ms ? new Date(now.getTime() - ms).toISOString() : new Date(now.getTime() - 7 * 86_400_000).toISOString();
  }
  return { startDate: start, endDate: end };
}

/**
 * GET /api/usage/key/receipts?key=<apikey>&period=7d&limit=200
 *
 * Public — a key holder views their OWN usage. No admin login required.
 * Gated by the key itself: 404 if the key is not found (existence not leaked).
 *
 * Returns:
 * {
 *   summary:  { items: [{model, input, output, cacheRead, cacheCreation, requests, cost}],
 *               totals: {input, output, cacheRead, cacheCreation, requests, cost},
 *               peakTpm },
 *   rate:     { requests: number, tokens: number },          // live last-60s (RPM/TPM)
 *   history:  [{ timestamp, provider, model, status, cost,
 *                input, output, cacheRead, cacheCreation }] // recent requests, NO raw payloads
 * }
 *
 * Raw request/response payloads are NEVER exposed here (public endpoint). Use the
 * admin /api/usage/request-details?includeRaw=1 for raw payloads (dashboard guard).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    const period = searchParams.get("period") || "7d";
    const limitRaw = parseInt(searchParams.get("limit"), 10);
    const limit = Number.isNaN(limitRaw) ? 200 : Math.min(500, Math.max(1, limitRaw));

    if (!key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const auth = await getApiKeyForAuth(key);
    if (!auth || !auth.key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const { startDate, endDate } = periodToRange(period);

    const [summary, rate, historyRaw, combos, comboPricing] = await Promise.all([
      getKeyUsageSummary(key, { startDate, endDate }),
      getKeyRateUsage(key, 60_000),
      getUsageHistory({ apiKey: key, startDate, endDate }),
      getCombos(),
      getComboPricing(),
    ]);

    // Normalize status to an HTTP-style code for display. The DB stores
    // mixed values ("ok", "200", "429", "200.0", provider error strings).
    // "ok"/"success" → 200; numeric strings → as-is; everything else → "—".
    const normalizeStatus = (s) => {
      if (s == null || s === "") return "—";
      const lower = String(s).toLowerCase();
      if (lower === "ok" || lower === "success" || lower === "completed") return "200";
      const n = Number(s);
      if (!Number.isNaN(n) && n >= 100 && n < 600) return String(Math.trunc(n));
      if (/^\d{3}$/.test(String(s))) return String(s);
      return String(s);
    };

    // Most recent first, capped to limit.
    const history = historyRaw
      .slice()
      .reverse()
      .slice(0, limit)
      .map((r) => {
        const t = r.tokens || {};
        return {
          timestamp: r.timestamp,
          provider: r.provider,
          model: r.model,
          status: normalizeStatus(r.status),
          cost: r.cost,
          input: r.promptTokens ?? t.prompt_tokens ?? t.input_tokens ?? 0,
          output: r.completionTokens ?? t.completion_tokens ?? t.output_tokens ?? 0,
          cacheRead: t.cached_tokens ?? t.cache_read_input_tokens ?? t.prompt_tokens_details?.cached_tokens ?? 0,
          cacheCreation: t.cache_creation_input_tokens ?? 0,
        };
      });

    // Build the available-models table (combos + their per-1M-token pricing).
    // Pricing values are $/1M tokens (mirrors the admin pricing page). A combo
    // may have no explicit price override — show the default/zero entry then.
    const availableModels = combos.map((c) => {
      const p = comboPricing?.[c.name] || {};
      return {
        name: c.name,
        kind: c.kind || "llm",
        modelsCount: Array.isArray(c.models) ? c.models.length : 0,
        input: p.input ?? 0,
        output: p.output ?? 0,
        cached: p.cached ?? 0,
        reasoning: p.reasoning ?? 0,
        cacheCreation: p.cache_creation ?? 0,
      };
    });

    return NextResponse.json({
      period,
      summary,
      rate,
      history,
      availableModels,
    });
  } catch (err) {
    console.log("Error fetching key receipts:", err);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
}
