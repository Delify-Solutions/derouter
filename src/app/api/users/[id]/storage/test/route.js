import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { retestStorage } from "@/lib/storage/userStorage.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** POST /api/users/[id]/storage/test — admin re-runs the customer's storage test. */
export async function POST(request, { params }) {
  const { id } = await params;
  const result = await retestStorage(await getAdapter(), id);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
