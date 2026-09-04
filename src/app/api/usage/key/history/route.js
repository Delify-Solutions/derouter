import { NextResponse } from "next/server";
import { getApiKeyForAuth, deleteKeyUsageHistory } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/usage/key/history?key=<apikey>
 *
 * Public — a key holder wipes their OWN request log. No admin login required.
 * Gated by the key itself: 404 if the key is not found (existence not leaked).
 *
 * Removes every usageHistory row and every requestDetails row for this key.
 * The daily rollup (usageDaily) and the lifetime request counter are NOT
 * touched — those are aggregate admin stats, not a per-key log, and scrubbing
 * them would desync the dashboard totals. Cost/budget windows (windowCostUsd
 * on the key row) are also unaffected; clearing the log is a display action.
 *
 * Returns { ok, history, details } = row counts removed.
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    if (!key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const auth = await getApiKeyForAuth(key);
    if (!auth || !auth.key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const result = await deleteKeyUsageHistory(key);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.log("Error clearing key history:", err);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
