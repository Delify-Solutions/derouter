import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { convertToCredit } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/account/affiliate/convert — turn wallet money into API credit
 * (spec affiliate-program "Convert commission to credit"). `{ currency, amount }`
 * in đồng or nano-USD. Each call is its own grant with its own expiry.
 */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await convertToCredit(session.userId, { currency: body.currency, amount: body.amount });
    return NextResponse.json(
      {
        ok: true,
        creditNanoUsd: result.creditNanoUsd,
        expiresAt: result.userPlan.expiresAt,
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không đổi được credit" }, { status: 500, headers: NO_STORE });
  }
}
