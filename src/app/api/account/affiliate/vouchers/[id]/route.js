import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { cancelVoucher } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** DELETE — cancel one of the caller's own unused vouchers; its value returns to the wallet. */
export async function DELETE(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  try {
    await cancelVoucher(session.userId, id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không hủy được voucher" }, { status: 500, headers: NO_STORE });
  }
}
