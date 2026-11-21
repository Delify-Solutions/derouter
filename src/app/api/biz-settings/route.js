import { NextResponse } from "next/server";
import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { pendingDocumentsSync } from "@/lib/db/repos/bizDocumentsRepo.js";
import { kickIngest } from "@/lib/biz/ingestWorker.js";
import { invalidateBotCache } from "@/lib/biz/retrieval.js";
import {
  businessReady,
  getBusinessSettings,
  saveBusinessSettings,
  validateBusinessSettings,
  DEFAULT_BUSINESS_SETTINGS,
} from "@/lib/biz/settings.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** Combo names offered by the pickers: a business model must be an existing combo. */
async function comboOptions() {
  try {
    return (await getCombos()).map((combo) => ({ name: combo.name, kind: combo.kind ?? null }));
  } catch {
    return [];
  }
}

/**
 * GET /api/biz-settings — the "AI doanh nghiệp" settings, plus what the page needs
 * to render its pickers and its 503 warning:
 * `{ business, combos, ready, defaults }`.
 */
export async function GET() {
  try {
    const business = await getBusinessSettings();
    return NextResponse.json(
      {
        business,
        combos: await comboOptions(),
        // Until BOTH the guard model and the embedding model are set, every
        // business request answers 503 (spec business-guard "Business settings").
        ready: businessReady(business),
        defaults: DEFAULT_BUSINESS_SETTINGS,
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được cấu hình AI doanh nghiệp" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PATCH /api/biz-settings — 400 with a Vietnamese message for an unknown combo, a
 * duplicate id or an out-of-range text (spec business-guard "Business settings").
 */
export async function PATCH(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const combos = await comboOptions();
  const invalid = validateBusinessSettings(body ?? {}, { comboNames: combos.map((combo) => combo.name) });
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400, headers: NO_STORE });

  const before = await getBusinessSettings();
  const result = await saveBusinessSettings(body ?? {}, { listCombos: async () => combos.map((c) => ({ name: c.name })) });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE });

  // A different embedding model makes every stored vector unusable: the cached
  // ones must go, and the documents still in `processing` are queued for the new
  // model so a pending upload does not wait for the periodic sweep.
  if (result.business.embeddingModel !== before.embeddingModel) {
    try {
      const db = await getAdapter();
      for (const bot of db.all(`SELECT DISTINCT botId FROM bizChunks`)) invalidateBotCache(bot.botId);
      if (pendingDocumentsSync(db, 1).length > 0) kickIngest();
    } catch {
      /* the periodic sweep still picks the documents up */
    }
  }

  return NextResponse.json(
    { business: result.business, ready: businessReady(result.business) },
    { headers: NO_STORE }
  );
}
