import { NextResponse } from "next/server";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { adjustWallet } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/affiliates/[userId]/adjust — a manual wallet adjustment.
 * `{ currency, delta, reason }`; the reason is required and `delta` ≠ 0 (design D8).
 */
export async function POST(request, { params }) {
  const { userId } = await params;
  const actor = await getAdminActor(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  try {
    const wallet = await adjustWallet(
      userId,
      { currency: body?.currency, delta: body?.delta, reason: body?.reason },
      { actor }
    );
    return NextResponse.json({ ok: true, wallet }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không điều chỉnh được số dư" }, { status: 500, headers: NO_STORE });
  }
}
