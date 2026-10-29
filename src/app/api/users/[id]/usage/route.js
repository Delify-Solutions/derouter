import { NextResponse } from "next/server";
import { getUserById } from "@/lib/localDb";
import { getUserUsage } from "@/lib/db/repos/adminUsersRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/users/[id]/usage?range=7d|30d
 *
 * `{ daily: [{ date, requests, costNanoUsd }], byModel: [...] }` across every key of
 * the user — the data behind the Usage tab's bar chart and per-model table.
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const range = request.nextUrl.searchParams.get("range") === "30d" ? "30d" : "7d";
  return NextResponse.json(await getUserUsage(id, { range }), { headers: NO_STORE });
}
