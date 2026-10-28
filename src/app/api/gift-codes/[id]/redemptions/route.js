import { NextResponse } from "next/server";
import { listRedemptions } from "@/lib/db/repos/giftRepo.js";

export const dynamic = "force-dynamic";

// GET /api/gift-codes/:id/redemptions — who used this code, and when.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const redemptions = await listRedemptions(id);
    return NextResponse.json({ redemptions });
  } catch (error) {
    console.log("Error listing gift redemptions:", error);
    return NextResponse.json({ error: "Failed to fetch redemptions" }, { status: 500 });
  }
}
