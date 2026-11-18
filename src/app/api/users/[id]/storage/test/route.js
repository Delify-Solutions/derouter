import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { retestStorage } from "@/lib/storage/userStorage.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** POST /api/users/[id]/storage/test — admin re-runs the customer's storage test. */
export async function POST(request, { params }) {
  const { id } = await params;
  // A user id only: the system storage has its own route.
  if (!(await getUserById(id))) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }
  const result = await retestStorage(await getAdapter(), id);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
