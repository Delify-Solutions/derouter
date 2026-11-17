import { NextResponse } from "next/server";
import { getUsageByOwner } from "@/lib/db/index.js";
import { swr } from "@/lib/cache/swrCache.js";

const PRESETS = new Set(["today", "24h", "7d", "30d", "60d"]);
// Without a preset, dates snap to 5 minutes: wider than the cache window, so repeated
// loads of the same range share a key instead of rotating it every minute.
const BUCKET_MS = 5 * 60_000;

// The page sends "now" as the end of the range, so the raw dates differ on every call.
function bucket(value) {
  if (!value) return "";
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date: ${value}`);
  return String(Math.floor(ms / BUCKET_MS));
}

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
    // The page names its preset ("30d"…) next to the dates, and the preset is what the
    // answer depends on; its dates only differ by when it was asked. The dates are still
    // validated, so an invalid one is a 400 whatever the preset.
    const period = searchParams.get("period");
    const dateKey = `${bucket(startDate)}:${bucket(endDate)}`;
    const key = `usage:owner:${PRESETS.has(period) ? period : dateKey}`;
    const items = await swr(key, { ttlMs: 45_000 }, () => getUsageByOwner({ startDate, endDate }));
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
    }
    console.error("[API] Failed to get usage by customer:", error?.message || error);
    return NextResponse.json({ error: "Failed to fetch usage by customer" }, { status: 500 });
  }
}
