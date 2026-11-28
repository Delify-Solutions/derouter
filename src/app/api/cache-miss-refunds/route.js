import { NextResponse } from "next/server";
import { requirePagePermission } from "@/lib/auth/adminAccess";
import { listCacheMissDetections, getCacheMissStats } from "@/lib/db/repos/cacheMissRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/cache-miss-refunds?userId=&sinceDays=
 *
 * Admin review page (spec cache-miss-refund "Admin review page"): every detection
 * (pending/auto_refunded/approved/rejected), optionally filtered to one user, plus
 * aggregate statistics for the chosen period. Neutral facts only — timestamps,
 * tokens, provider, model; never a connection/account identity or rotation wording.
 */
export async function GET(request) {
  const denied = await requirePagePermission(request, "cache-refunds", "view");
  if (denied) return denied;

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId") || null;
    const sinceDays = Number(searchParams.get("sinceDays"));
    const sinceIso = Number.isFinite(sinceDays) && sinceDays > 0
      ? new Date(Date.now() - sinceDays * 86400_000).toISOString()
      : null;

    const [items, stats] = await Promise.all([
      listCacheMissDetections({ userId }),
      getCacheMissStats({ userId, sinceIso }),
    ]);

    return NextResponse.json({ items, stats }, { headers: NO_STORE });
  } catch (error) {
    console.error("[cache-miss-refunds] list failed:", error?.message || error);
    return NextResponse.json({ error: "Failed to load cache-miss detections" }, { status: 500, headers: NO_STORE });
  }
}
