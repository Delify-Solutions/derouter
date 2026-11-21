import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { documentCountsSync, blockedCountSync } from "@/lib/db/repos/bizDocumentsRepo.js";
import { getBusinessSettings } from "@/lib/biz/settings.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/biz-settings/bots — every bot, for the admin overview (spec
 * business-bots "Admin bot overview"): owner email, bot/company, model, active as
 * text, document counts by status and the blocked count over 7 days.
 */
export async function GET() {
  try {
    const db = await getAdapter();
    const business = await getBusinessSettings();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.all(
      `SELECT b.*, u.email AS ownerEmail
         FROM bizBots b LEFT JOIN users u ON u.id = b.userId
        ORDER BY b.createdAt DESC`
    );
    return NextResponse.json(
      {
        bots: rows.map((row) => ({
          id: row.id,
          ownerEmail: row.ownerEmail ?? null,
          name: row.name,
          companyName: row.companyName,
          modelId: row.modelId,
          isActive: row.isActive === 1 || row.isActive === true,
          documents: documentCountsSync(db, row.id, business.embeddingModel),
          blocked7d: blockedCountSync(db, row.id, since),
          createdAt: row.createdAt,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách bot" }, { status: 500, headers: NO_STORE });
  }
}
