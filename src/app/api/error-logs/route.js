import { NextResponse } from "next/server";
import {
  listErrorLogs,
  errorLogSummary,
  clearErrorLogs,
  getErrorLogConfig,
} from "../../../lib/db/repos/errorLogsRepo.js";

// Admin only: /api/error-logs is not a public path, so the dashboard guard applies.
export const dynamic = "force-dynamic";

const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

// GET /api/error-logs?source=&status=&model=&q=&range=1h|24h|7d&limit=&before=
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const rangeMs = RANGES[p.get("range")] || null;
  const since = rangeMs ? new Date(Date.now() - rangeMs).toISOString() : null;
  const [page, summary, config] = await Promise.all([
    listErrorLogs({
      source: p.get("source") || undefined,
      status: p.get("status") || undefined,
      model: p.get("model") || undefined,
      q: p.get("q") || undefined,
      since,
      limit: p.get("limit") || 50,
      before: p.get("before") || undefined,
    }),
    errorLogSummary(since),
    getErrorLogConfig(),
  ]);
  return NextResponse.json({ ...page, summary, config });
}

// DELETE /api/error-logs            -> everything
// DELETE /api/error-logs?olderThanDays=7
export async function DELETE(request) {
  const days = new URL(request.url).searchParams.get("olderThanDays");
  if (days != null && !(Number(days) >= 0)) {
    return NextResponse.json({ error: "olderThanDays must be a number of days" }, { status: 400 });
  }
  const removed = await clearErrorLogs({ olderThanDays: days == null ? null : Number(days) });
  return NextResponse.json({ removed });
}
