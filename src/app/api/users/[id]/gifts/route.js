import { NextResponse } from "next/server";
import { getUserById, listUserRedemptions } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/users/[id]/gifts — the customer's gift-code redemptions. */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json({ redemptions: await listUserRedemptions(id) }, { headers: NO_STORE });
}
