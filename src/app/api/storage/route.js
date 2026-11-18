import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { storageOverviewSync } from "@/lib/storage/userStorage.js";
import { localImagesUsage } from "@/lib/storage/localImages.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/storage — admin-only (dashboardGuard): every customer's image storage
 * with its status, the counts per status, and the system storage. Secrets never
 * leave the server; key ids are masked.
 */
export async function GET() {
  const overview = { ...storageOverviewSync(await getAdapter()), localUsage: await localImagesUsage() };
  return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
}
