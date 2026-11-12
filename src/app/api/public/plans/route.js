import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function rowToPlan(row) {
  const imagePlan = row.kind === "image";
  const images = imagePlan ? Math.max(0, Math.floor(Number(row.imageCount) || 0)) : 0;
  return {
    id: row.id,
    code: row.code,
    name: row.name ?? row.code,
    description: row.description ?? null,
    priceNanoUsd: row.priceNanoUsd ?? 0,
    // What the plan sells: an image plan's credit fields are 0 and this count is
    // its balance.
    kind: imagePlan ? "image" : "llm",
    imageCount: images,
    creditNanoUsd: row.creditNanoUsd ?? 0,
    unlimitedCredit: Number(row.unlimitedCredit) === 1,
    durationDays: row.durationDays ?? 0,
    sortOrder: row.sortOrder ?? 0,
    priceLabel: fmtUsdNano(row.priceNanoUsd ?? 0),
    creditLabel: fmtCreditNano(row.creditNanoUsd ?? 0, Number(row.unlimitedCredit) === 1),
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
    console.error("[public/plans] failed:", error?.message || error);
    return NextResponse.json({ plans: [] }, { headers: NO_STORE });
  }
}
