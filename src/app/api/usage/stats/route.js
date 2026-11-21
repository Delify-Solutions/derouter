import { NextResponse } from "next/server";
import { getUsageStats, getActiveRequests } from "@/lib/usageDb";
import { getRequestedBackfillProgress } from "@/lib/db/repos/usageRepo.js";
import { swr } from "@/lib/cache/swrCache.js";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
// A rebuild step landing during a computation is retried this many times before the
// response is sent marked stale (the client then asks again).
const MAX_GENERATION_RETRIES = 3;

export const dynamic = "force-dynamic";

/** "upstream" only when asked for exactly; anything else is the default requested view. */
function parseModelView(value) {
  return value === "upstream" ? "upstream" : "requested";
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const modelView = parseModelView(searchParams.get("modelView"));

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    // The aggregation scans the period; share one result between tabs and refreshes.
    // The live fields (in-flight, recent, last failing provider) are cheap and in memory,
    // so they are read fresh on every call instead of being served from the cache.
    //
    // Requested-view figures change each time the background rebuild resolves a day, so
    // that cache is keyed by the rebuild generation: a computation started before a day
    // was rebuilt is stored under the old key and can never be served as the new one. A
    // generation that moved while this computation ran means it may predate the change;
    // compute again under the new key.
    let stats;
    let generation = getRequestedBackfillProgress().generation;
    for (let attempt = 0; ; attempt += 1) {
      const key = modelView === "requested"
        ? `usage:stats:${period}:requested:g${generation}`
        : `usage:stats:${period}:upstream`;
      stats = await swr(key, { ttlMs: 15_000 }, () => getUsageStats(period, { modelView }));
      const now = getRequestedBackfillProgress().generation;
      if (modelView !== "requested" || now === generation || attempt >= MAX_GENERATION_RETRIES) break;
      generation = now;
    }
    const live = await getActiveRequests();
    // Read after the stats call, which starts the rebuild when it is needed. `stale`: the
    // figures predate the latest rebuilt day — the client keeps refreshing until it is false.
    const progress = getRequestedBackfillProgress();
    const requestedBackfill = { ...progress, stale: modelView === "requested" && progress.generation !== generation };
    return NextResponse.json({ ...stats, ...live, modelView, requestedBackfill });
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
