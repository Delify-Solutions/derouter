import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { listUserActivitySync, listUserIpsSync, IP_LOOKBACK_DAYS } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET — every IP the account used (web actions + its keys' API requests) with the
 * number of other accounts seen on each, plus the latest activity (spec
 * activity-ip-log "Admin IP lookup"). Admin only: /api/users/** is behind the
 * dashboard guard.
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }
  const db = await getAdapter();
  return NextResponse.json(
    {
      ips: listUserIpsSync(db, id),
      activity: listUserActivitySync(db, id, { limit: 100 }),
      lookbackDays: IP_LOOKBACK_DAYS,
    },
    { headers: NO_STORE }
  );
}
