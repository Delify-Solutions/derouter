import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { listMyWithdrawals, requestWithdrawal } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";
import { maskTail } from "@/lib/affiliate/mask.js";
import { notifyAdminWithdrawalRequest } from "@/lib/notify/telegram.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function fmtAmount(currency, value) {
  if (currency === "VND") {
    return `${Number(value).toLocaleString("vi-VN")}đ`;
  }
  return `${(Number(value) / 1_000_000_000).toFixed(2)} USD`;
}

/** GET — the affiliate's own withdrawal history. */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const params = request.nextUrl.searchParams;
  const limit = Number(params.get("limit")) || 20;
  const offset = Number(params.get("offset")) || 0;

  try {
    const { rows, total } = await listMyWithdrawals(session.userId, { limit, offset });
    return NextResponse.json(
      {
        total,
        withdrawals: rows.map((row) => ({
          id: row.id,
          currency: row.currency,
          amount: Number(row.amount),
          status: row.status,
          txRef: row.txRef ?? null,
          adminNote: row.adminNote ?? null,
          decidedAt: row.decidedAt ?? null,
          createdAt: row.createdAt,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được lệnh rút" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST — request a withdrawal (spec "Withdrawal request").
 *
 * The reserve happens in the same transaction as the checks, so two requests for
 * the same full balance cannot both succeed. The admin is told afterwards, and
 * only ever sees the tail of the destination.
 */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  try {
    const row = await requestWithdrawal(session.userId, {
      currency: body?.currency,
      amount: body?.amount,
    });

    let destination = {};
    try {
      destination = JSON.parse(row.destination) || {};
    } catch {
      destination = {};
    }
    notifyAdminWithdrawalRequest({
      email: session.email,
      currency: row.currency,
      amountText: fmtAmount(row.currency, row.amount),
      destination: row.currency === "VND"
        ? `${destination.bankName || ""} · ${maskTail(destination.accountNumber)}`
        : `${destination.network || ""} · ${maskTail(destination.address)}`,
    }).catch(() => {});

    return NextResponse.json(
      { ok: true, withdrawal: { id: row.id, currency: row.currency, amount: Number(row.amount), status: row.status } },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không tạo được lệnh rút" }, { status: 500, headers: NO_STORE });
  }
}
