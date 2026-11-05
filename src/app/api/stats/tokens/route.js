import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseStatsQuery, tokenStatsSync, statsFilterOptionsCachedSync } from "@/lib/stats/tokenStats.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/stats/tokens?from&to&granularity=hour|day|week|month&groupBy=model|upstream|provider|user
//   &userId&provider&model&top (admin; change usage-analytics)
export async function GET(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = parseStatsQuery(params);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  try {
    const db = await getAdapter();
    const stats = tokenStatsSync(db, parsed.value);
    const options = statsFilterOptionsCachedSync(db, parsed.value);
    return NextResponse.json({ ...stats, options }, { headers: NO_STORE });
  } catch (error) {
    console.error(`[stats] token stats failed: ${String(error?.message || "error").slice(0, 200)}`);
    return NextResponse.json({ error: "Không tải được thống kê" }, { status: 500, headers: NO_STORE });
  }
}
