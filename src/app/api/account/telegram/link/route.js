import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";
import { checkLimits } from "@/lib/auth/actionLimiter.js";
import { issueLinkTokenSync } from "@/lib/db/repos/telegramLinkRepo.js";
import { loadTelegramLinkConfig, NOT_CONFIGURED_TEXT } from "@/lib/telegram/config.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const ISSUE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

// POST /api/account/telegram/link — a one-time Mini App link for this account.
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const config = await loadTelegramLinkConfig();
  if (!config.configured) {
    return NextResponse.json({ error: NOT_CONFIGURED_TEXT }, { status: 503, headers: NO_STORE });
  }

  const gate = checkLimits([{ bucket: `telegram-link:user:${session.userId}`, ...ISSUE_LIMIT }]);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Bạn đã tạo quá nhiều link. Vui lòng thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  const db = await getAdapter();
  const { token, expiresAt } = db.transaction(() => issueLinkTokenSync(db, session.userId));
  const url = `https://t.me/${config.botUsername}/${config.appName}?startapp=${token}`;
  return NextResponse.json({ url, expiresAt }, { headers: NO_STORE });
}
