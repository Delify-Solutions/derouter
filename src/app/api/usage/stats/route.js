import { NextResponse } from "next/server";
import { getUsageStats, getActiveRequests } from "@/lib/usageDb";
import { swr } from "@/lib/cache/swrCache.js";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    // The aggregation scans the period; share one result between tabs and refreshes.
    // The live fields (in-flight, recent, last failing provider) are cheap and in memory,
    // so they are read fresh on every call instead of being served from the cache.
    const stats = await swr(`usage:stats:${period}`, { ttlMs: 15_000 }, () => getUsageStats(period));
    const live = await getActiveRequests();
    return NextResponse.json({ ...stats, ...live });
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
