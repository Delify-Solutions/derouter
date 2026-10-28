import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { fmtUsdNano } from "@/shared/utils/money";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function rowToPlan(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name ?? row.code,
    description: row.description ?? null,
    priceNanoUsd: row.priceNanoUsd ?? 0,
    creditNanoUsd: row.creditNanoUsd ?? 0,
    durationDays: row.durationDays ?? 0,
    sortOrder: row.sortOrder ?? 0,
    priceLabel: fmtUsdNano(row.priceNanoUsd ?? 0),
    creditLabel: fmtUsdNano(row.creditNanoUsd ?? 0),
  };
}

export async function GET() {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT * FROM plans WHERE isActive = 1 ORDER BY sortOrder ASC, priceNanoUsd ASC, createdAt ASC`
    );
    return NextResponse.json({ plans: rows.map(rowToPlan) }, { headers: NO_STORE });
  } catch (error) {
    console.log("[public/plans] failed:", error?.message || error);
    return NextResponse.json({ plans: [] }, { headers: NO_STORE });
  }
}
