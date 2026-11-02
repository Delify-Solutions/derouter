import { NextResponse } from "next/server";
import { getUsageByOwner } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/user-summary?startDate=<iso>&endDate=<iso>
 * Admin-only (not under the public /api/usage/key prefix). Usage grouped by the
 * customer who owns the key: one entry per customer with totals over all of their
 * keys, per-key and per-model breakdowns, peak minute and last request. Keys are
 * masked; no secret and no request payload is returned.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const items = await getUsageByOwner({ startDate, endDate });
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
    }
    console.error("[API] Failed to get usage by customer:", error?.message || error);
    return NextResponse.json({ error: "Failed to fetch usage by customer" }, { status: 500 });
  }
}
