import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { listTelegramLinksSync } from "@/lib/db/repos/telegramLinkRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// Admin-only (dashboardGuard: every /api/* outside the public and account
// prefixes needs an admin session).

/** GET /api/telegram-links?q&limit&offset — accounts with a linked Telegram user. */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const db = await getAdapter();
    const { rows, total } = listTelegramLinksSync(db, {
      q: (params.get("q") || "").slice(0, 100),
      limit: params.get("limit"),
      offset: params.get("offset"),
    });
    return NextResponse.json({ total, links: rows }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách liên kết Telegram" }, { status: 500, headers: NO_STORE });
  }
}
