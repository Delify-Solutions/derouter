import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { retestStorage } from "@/lib/storage/userStorage.js";
import { requireAnyPagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/users/[id]/storage/test — admin re-runs the customer's storage test.
 * Also called from the Storage page's cross-customer list.
 */
export async function POST(request, { params }) {
  const denied = await requireAnyPagePermission(request, ["users", "storage"], "edit");
  if (denied) return denied;
  const { id } = await params;
  // A user id only: the system storage has its own route.
  if (!(await getUserById(id))) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }
  const result = await retestStorage(await getAdapter(), id);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
