import { NextResponse } from "next/server";
import { getProviderUsageSummary, getProviderRateUsage, getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

function periodToRange(period) {
  const now = new Date();
  let start, end;
  if (period === "today") {
    start = new Date(now); start.setHours(0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
  } else if (period === "24h") {
    start = new Date(now.getTime() - 24 * 3600_000);
    end = now;
  } else {
    const days = period === "7d" ? 7 : period === "30d" ? 30 : 60;
    start = new Date(now.getTime() - days * 86400_000);
    end = now;
  }
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

/**
 * GET /api/usage/provider-summary?period=today|24h|7d|30d|60d
 * Admin-only per-provider usage summary for the Providers tab.
 *
 * Returns { items: [{ provider, name, requests, input, output, cost,
 *          liveRpm, liveTpm, peakRpm, peakTpm, peakTokS }] }
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "30d";
    const { startDate, endDate } = periodToRange(period);

    const [{ items }, liveMap, providerNodes] = await Promise.all([
      getProviderUsageSummary({ startDate, endDate }),
      getProviderRateUsage(60_000),
      getProviderNodes(),
    ]);

    const nodeMap = {};
    for (const node of providerNodes) nodeMap[node.id] = node.name;

    const resolved = items.map((it) => {
      let name = it.provider;
      if (nodeMap[it.provider]) name = nodeMap[it.provider];
      else {
        const cfg = getProviderByAlias(it.provider) || AI_PROVIDERS[it.provider];
        if (cfg?.name) name = cfg.name;
      }
      const live = liveMap[it.provider] || {};
      return { ...it, name, liveRpm: live.requests ?? 0, liveTpm: live.tokens ?? 0 };
    });

    return NextResponse.json({ items: resolved });
  } catch (error) {
    console.error("[API] Failed to get provider usage summary:", error);
    return NextResponse.json({ error: "Failed to fetch provider usage summary" }, { status: 500 });
  }
}
