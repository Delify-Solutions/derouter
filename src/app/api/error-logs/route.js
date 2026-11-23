import { NextResponse } from "next/server";
import {
  listErrorLogs,
  errorLogSummary,
  clearErrorLogs,
  countErrorLogs,
  deleteErrorLogsByFilter,
  getErrorLogConfig,
} from "../../../lib/db/repos/errorLogsRepo.js";

// Admin only: /api/error-logs is not a public path, so the dashboard guard applies.
export const dynamic = "force-dynamic";

const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

function filterFromQuery(p) {
  const rangeMs = RANGES[p.get("range")] || null;
  return {
    source: p.get("source") || undefined,
    status: p.get("status") || undefined,
    statusMode: p.get("statusMode") || undefined,
    owner: p.get("owner") || undefined,
    model: p.get("model") || undefined,
    q: p.get("q") || undefined,
    since: rangeMs ? new Date(Date.now() - rangeMs).toISOString() : undefined,
  };
}

// GET /api/error-logs?source=&status=&statusMode=&owner=&model=&q=&range=1h|24h|7d&limit=&before=
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const filter = filterFromQuery(p);
  const [page, count, summary, config] = await Promise.all([
    listErrorLogs({ ...filter, limit: p.get("limit") || 50, before: p.get("before") || undefined }),
    countErrorLogs(filter),
    errorLogSummary(filter.since),
    getErrorLogConfig(),
  ]);
  return NextResponse.json({ ...page, count, summary, config });
}

// DELETE /api/error-logs                                         -> everything
// DELETE /api/error-logs?olderThanDays=7                         -> rows older than N days
// DELETE /api/error-logs?source=&status=&statusMode=&owner=&...  -> only rows matching this filter
export async function DELETE(request) {
  const p = new URL(request.url).searchParams;
  const filter = filterFromQuery(p);
  const hasFilter = Object.values(filter).some((v) => v !== undefined);
  if (hasFilter) {
    const removed = await deleteErrorLogsByFilter(filter);
    return NextResponse.json({ removed });
  }

  const days = p.get("olderThanDays");
  if (days != null && !(Number(days) >= 0)) {
    return NextResponse.json({ error: "olderThanDays must be a number of days" }, { status: 400 });
  }
  const removed = await clearErrorLogs({ olderThanDays: days == null ? null : Number(days) });
  return NextResponse.json({ removed });
}
