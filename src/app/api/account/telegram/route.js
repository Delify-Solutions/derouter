import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";
import { getTelegramLinkSync, unlinkTelegramSync } from "@/lib/db/repos/telegramLinkRepo.js";
import { loadTelegramLinkConfig } from "@/lib/telegram/config.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/account/telegram — link status, polled by the page while a link is pending.
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const db = await getAdapter();
  const status = getTelegramLinkSync(db, session.userId);
  const config = await loadTelegramLinkConfig();
  return NextResponse.json(
    {
      configured: config.configured,
      linked: status.linked,
      telegramUsername: status.telegramUsername,
      linkedAt: status.linkedAt,
    },
    { headers: NO_STORE }
  );
}

// DELETE /api/account/telegram — unlink. Past gift redemptions keep their record.
export async function DELETE(request) {
  const session = await resolveAccountUser(request);
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const db = await getAdapter();
  const before = getTelegramLinkSync(db, session.userId);
  db.transaction(() => unlinkTelegramSync(db, session.userId));
  if (before.linked) {
    await recordActivity(request, {
      userId: session.userId,
      action: "telegram_unlink",
      details: { telegramUserId: before.telegramUserId },
    });
  }
  return NextResponse.json({ ok: true, linked: false }, { headers: NO_STORE });
}
