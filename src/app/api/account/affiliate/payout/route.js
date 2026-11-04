import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { setAffiliatePayout } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT /api/account/affiliate/payout — save where this affiliate wants to be paid
 * (spec "Payout details"). One currency per call: VND needs the three bank
 * fields, USD needs a network and a USDT address or Binance Pay ID.
 *
 * These details are shown to the affiliate and to admins only.
 */
export async function PUT(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const currency = String(body?.currency || "").toUpperCase();
  try {
    const saved = await setAffiliatePayout(session.userId, currency, body);
    return NextResponse.json({ ok: true, currency, details: saved }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không lưu được thông tin nhận tiền" }, { status: 500, headers: NO_STORE });
  }
}
