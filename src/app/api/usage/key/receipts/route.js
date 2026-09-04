import { NextResponse } from "next/server";
import {
  getApiKeyForAuth,
  getKeyRateUsage,
  getKeyUsageSummary,
  getUsageHistory,
  getCombos,
  getComboPricing,
  getPricingForModel,
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
 *   history:  [{ timestamp, model, status, cost,
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

    // allowedModels (from the key's own setting or its group) is a list of combo
    // names (see AllowedModelsPicker). null/empty → unlimited → show all combos.
    // Non-null → restrict the Available Models table + By-Model usage summary to
    // only those combos so a key holder never sees models they can't use.
    const allowedModels = auth.resolved?.allowedModels ?? null;

    const { startDate, endDate } = periodToRange(period);

    const [summary, rate, historyRaw, combos, comboPricing] = await Promise.all([
      getKeyUsageSummary(key, { startDate, endDate }),
      getKeyRateUsage(key, 60_000),
      getUsageHistory({ apiKey: key, startDate, endDate }),
      getCombos(),
      getComboPricing(),
    ]);

    // Filter combos to the key's allow-list. `allowedModels` entries are combo
    // names; combos have no kind restriction here beyond the llm default. When
    // allowed is null/empty we pass everything through (unlimited key).
    const isAllowedCombo = (comboName) => {
      if (!Array.isArray(allowedModels) || allowedModels.length === 0) return true;
      return allowedModels.includes(comboName);
    };
    const visibleCombos = combos.filter((c) => isAllowedCombo(c.name));

    // Provider is intentionally not exposed on the public usage page (neither
    // resolved names nor raw UUIDs). The history rows below omit it entirely.

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
    // Pricing values are $/1M tokens (mirrors the admin pricing page). Resolution:
    //   1. Explicit combo-level override (comboPricing[comboName]) — set on the
    //      dashboard /combos page when the admin commits a custom price.
    //   2. Otherwise fall back to the first model's pool/default pricing
    //      (getPricingForModel: user per-pool override → built-in MODEL_PRICING →
    //      pattern pricing). Combo model entries are `provider/model` shaped, so we
    //      split on "/" and resolve by (provider, model). A combo with no resolvable
    //      model price shows 0 (same as before) rather than misleading the key owner.
    const resolveComboPricing = async (combo) => {
      const p = comboPricing?.[combo.name];
      if (p) return p;
      const models = Array.isArray(combo.models) ? combo.models : [];
      for (const m of models) {
        const slash = m.indexOf("/");
        const provider = slash >= 0 ? m.slice(0, slash) : null;
        const model = slash >= 0 ? m.slice(slash + 1) : m;
        const resolved = await getPricingForModel(provider, model);
        if (resolved) return resolved;
      }
      return null;
    };

    const availableModels = [];
    for (const c of visibleCombos) {
      const p = (await resolveComboPricing(c)) || {};
      availableModels.push({
        name: c.name,
        kind: c.kind || "llm",
        modelsCount: Array.isArray(c.models) ? c.models.length : 0,
        input: p.input ?? 0,
        output: p.output ?? 0,
        cached: p.cached ?? 0,
        reasoning: p.reasoning ?? 0,
        cacheCreation: p.cache_creation ?? 0,
      });
    }

    // Scope the per-model usage summary to the same allow-list, so the By-Model
    // table on /usage only lists combos the key can consume. `summary.items` is
    // keyed by model name (= combo name in this proxy). Recompute totals from
    // the filtered set so the totals row matches what's shown.
    const filteredSummary = (() => {
      if (!Array.isArray(allowedModels) || allowedModels.length === 0) return summary;
      const items = (summary?.items || []).filter((it) => isAllowedCombo(it.model));
      const totals = items.reduce(
        (acc, it) => {
          acc.input += it.input || 0;
          acc.output += it.output || 0;
          acc.cacheRead += it.cacheRead || 0;
          acc.cacheCreation += it.cacheCreation || 0;
          acc.requests += it.requests || 0;
          acc.cost += it.cost || 0;
          return acc;
        },
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0 }
      );
      return { ...summary, items, totals };
    })();

    return NextResponse.json({
      period,
      summary: filteredSummary,
      rate,
      history,
      availableModels,
    });
  } catch (err) {
    console.log("Error fetching key receipts:", err);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
}
