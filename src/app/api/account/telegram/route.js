import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";
import { getTelegramLinkSync, setTelegramNotifyPrefsSync, unlinkTelegramSync } from "@/lib/db/repos/telegramLinkRepo.js";
import { mergeNotifyPrefs, parseNotifyPrefs } from "@/lib/notify/customerTelegram.js";
import { loadTelegramLinkConfig } from "@/lib/telegram/config.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function publicStatus(status, config) {
  return {
    configured: config.configured,
    linked: status.linked,
    telegramUsername: status.telegramUsername,
    linkedAt: status.linkedAt,
    // Notifications (spec telegram-notify). dmBlocked: Telegram refused the last
    // message, so the customer must open the bot (botUsername) and send a test.
    notifyPrefs: parseNotifyPrefs(status.notifyPrefs),
    dmBlocked: Boolean(status.linked && status.dmBlockedAt),
    botUsername: config.configured ? config.botUsername : null,
  };
}

// GET /api/account/telegram — link status, polled by the page while a link is pending.
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const db = await getAdapter();
  const status = getTelegramLinkSync(db, session.userId);
  const config = await loadTelegramLinkConfig();
  return NextResponse.json(publicStatus(status, config), { headers: NO_STORE });
}

// PATCH /api/account/telegram { notifyPrefs: { billing?, expiry?, announcements? } }
// Security messages cannot be turned off and are not part of the prefs.
export async function PATCH(request) {
  const session = await resolveAccountUser(request);
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (!body?.notifyPrefs || typeof body.notifyPrefs !== "object") {
    return NextResponse.json({ error: "Thiếu notifyPrefs" }, { status: 400, headers: NO_STORE });
  }
  const db = await getAdapter();
  const before = getTelegramLinkSync(db, session.userId);
  const prefs = mergeNotifyPrefs(before.notifyPrefs, body.notifyPrefs);
  setTelegramNotifyPrefsSync(db, session.userId, prefs);
  const config = await loadTelegramLinkConfig();
  return NextResponse.json(publicStatus(getTelegramLinkSync(db, session.userId), config), { headers: NO_STORE });
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
