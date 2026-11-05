import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { giftStatusOf } from "@/lib/gift/window.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/affiliates/gift-codes — the codes an admin may pick as a referral
 * welcome gift (design D9: the picker lists only new-user codes).
 *
 * Every new-user code is listed with its status, so a code that cannot currently
 * be advertised (disabled, expired, exhausted) is visible but clearly unusable.
 */
export async function GET() {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT id, code, isActive, startsAt, expiresAt, redeemedCount, maxRedemptions, unlimitedRedemptions, newUserOnly
         FROM giftCodes
        WHERE newUserOnly = 1 AND deletedAt IS NULL
        ORDER BY createdAt DESC, rowid DESC`
    );
    return NextResponse.json(
      {
        codes: rows.map((row) => ({
          id: row.id,
          code: row.code,
          status: giftStatusOf(row),
          startsAt: row.startsAt ?? null,
          expiresAt: row.expiresAt ?? null,
          redeemedCount: Number(row.redeemedCount ?? 0),
          maxRedemptions: Number(row.maxRedemptions ?? 1),
          unlimitedRedemptions: Number(row.unlimitedRedemptions) === 1,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được mã quà tặng" }, { status: 500, headers: NO_STORE });
  }
}
