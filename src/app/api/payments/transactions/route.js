import { NextResponse } from "next/server";
import { listTransactions, countNeedsReview, listProviderOptions } from "@/lib/db/repos/paymentTransactionsRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const STATUSES = ["matched", "needs_review", "resolved"];

/**
 * GET /api/payments/transactions?status&providerId&from&to&page
 *
 * 50 per page (spec payment-provider-admin "Transactions list"), newest first, with
 * `needsReviewCount` for the navigation badge. An unknown status is a 400 rather
 * than a silent unfiltered list — an admin who mistypes a filter and sees
 * everything would believe there is nothing to review.
 */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  if (status && !STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status phải là một trong ${STATUSES.join(", ")}` },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const page = Number(params.get("page") || 1);
    const [result, needsReviewCount, providers] = await Promise.all([
      listTransactions({
        status: status || null,
        providerId: params.get("providerId") || null,
        from: params.get("from") || null,
        to: params.get("to") || null,
        page,
      }),
      countNeedsReview(),
      listProviderOptions(),
    ]);
    return NextResponse.json({ ...result, needsReviewCount, providers }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được giao dịch" }, { status: 500, headers: NO_STORE });
  }
}
