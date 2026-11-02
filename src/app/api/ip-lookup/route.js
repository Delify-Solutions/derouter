import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { listAccountsByIpSync, looksLikeIp, IP_LOOKBACK_DAYS } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET ?ip=… — every account seen on one IP, from web actions and API requests
 * (spec activity-ip-log "Admin IP lookup"). Admin only: /api/* outside the public
 * allow-list requires the dashboard session.
 */
export async function GET(request) {
  const ip = (request.nextUrl.searchParams.get("ip") || "").trim();
  if (!looksLikeIp(ip)) {
    return NextResponse.json({ error: "IP không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const db = await getAdapter();
  return NextResponse.json(
    { ip, accounts: listAccountsByIpSync(db, ip), lookbackDays: IP_LOOKBACK_DAYS },
    { headers: NO_STORE }
  );
}
