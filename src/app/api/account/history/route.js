import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { listAccountHistorySync, accountSummarySync } from "@/lib/account/history.js";
import { describeUserAgent } from "@/lib/notify/customerTelegram.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/history?group=all|security|orders|plans&offset&limit — the
 * caller's own timeline (spec customer-portal "Account history"). The first page
 * (offset 0) also carries the summary. The user id comes from the session only.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, { status: 401, headers: NO_STORE });

  const params = request.nextUrl.searchParams;
  try {
    const db = await getAdapter();
    const page = listAccountHistorySync(db, session.userId, {
      group: params.get("group") || "all",
      offset: params.get("offset"),
      limit: params.get("limit"),
    });
    const summary = page.offset === 0 ? accountSummarySync(db, session.userId) : undefined;
    // The raw User-Agent stays on the server; the page shows "Chrome trên macOS".
    const entries = page.entries.map(({ userAgent, ...entry }) =>
      entry.group === "security" ? { ...entry, device: describeUserAgent(userAgent) || null } : entry
    );
    return NextResponse.json({ ...page, entries, ...(summary ? { summary } : {}) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được lịch sử" }, { status: 500, headers: NO_STORE });
  }
}
