import { NextResponse } from "next/server";
import { exportErrorLogs } from "../../../../lib/db/repos/errorLogsRepo.js";

// Admin only: /api/error-logs is not a public path, so the dashboard guard applies.
export const dynamic = "force-dynamic";

const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

/**
 * GET /api/error-logs/export?source=&status=&model=&q=&range=&limit=
 * Downloads the entries the page is filtered to — full entries with the stored
 * request, the body sent upstream, the error response and every attempt — as one
 * JSON file (newest first, at most 500).
 */
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const rangeMs = RANGES[p.get("range")] || null;
  const entries = await exportErrorLogs({
    source: p.get("source") || undefined,
    status: p.get("status") || undefined,
    model: p.get("model") || undefined,
    q: p.get("q") || undefined,
    since: rangeMs ? new Date(Date.now() - rangeMs).toISOString() : null,
    limit: p.get("limit") || 100,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), count: entries.length, entries }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="derouter-errors-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
