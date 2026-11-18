import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { retestStorage, SYSTEM_STORAGE_ID } from "@/lib/storage/userStorage.js";

export const dynamic = "force-dynamic";

/** POST /api/storage/system/test — admin re-runs the system storage's write test. */
export async function POST() {
  const result = await retestStorage(await getAdapter(), SYSTEM_STORAGE_ID);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
