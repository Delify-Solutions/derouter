import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { createVoucher, listMyVouchers } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET — the caller's own vouchers (whoever used one is shown masked). */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total } = await listMyVouchers(session.userId, {
      limit: Number(params.get("limit")) || 20,
      offset: Number(params.get("offset")) || 0,
    });
    return NextResponse.json({ total, vouchers: rows }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được voucher" }, { status: 500, headers: NO_STORE });
  }
}

/** POST — `{ currency, amount }`: make a single-use voucher from the wallet (spec "Vouchers"). */
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
    const voucher = await createVoucher(session.userId, { currency: body.currency, amount: body.amount });
    return NextResponse.json(
      { ok: true, voucher: { id: voucher.id, code: voucher.code, currency: voucher.currency, amount: Number(voucher.amount) } },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không tạo được voucher" }, { status: 500, headers: NO_STORE });
  }
}
