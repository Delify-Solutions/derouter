import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import {
  validateAnnouncement,
  createAnnouncementSync,
  listAnnouncementsSync,
  setAnnouncementBroadcastSync,
} from "@/lib/notify/inbox.js";
import { startBroadcast } from "@/lib/notify/broadcast.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// Admin-only (dashboardGuard: every /api/* outside the public and account
// prefixes needs an admin session).

/** GET /api/announcements?limit&offset — newest first. */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  const db = await getAdapter();
  const { rows, total } = listAnnouncementsSync(db, { limit: params.get("limit"), offset: params.get("offset") });
  return NextResponse.json({ total, announcements: rows }, { headers: NO_STORE });
}

/**
 * POST /api/announcements — `{ title, body, important, sendTelegram }`. Saved for
 * the web first; with `sendTelegram` it also goes out as a Telegram broadcast. A
 * refused broadcast does not undo the announcement: `telegram.error` says why.
 */
export async function POST(request) {
  const actor = await getAdminActor(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const checked = validateAnnouncement(body || {});
  if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });

  const db = await getAdapter();
  const announcement = createAnnouncementSync(db, checked.value, { createdBy: actor });

  let telegram = null;
  if (body?.sendTelegram === true) {
    try {
      const started = await startBroadcast({ text: `${checked.value.title}\n\n${checked.value.body}`, createdBy: actor });
      if (started.ok) {
        setAnnouncementBroadcastSync(db, announcement.id, started.broadcast.id);
        announcement.telegramBroadcastId = started.broadcast.id;
        telegram = { ok: true };
      } else {
        telegram = { ok: false, error: started.error };
      }
    } catch {
      telegram = { ok: false, error: "Không gửi được qua Telegram" };
    }
  }
  return NextResponse.json({ ok: true, announcement, telegram }, { headers: NO_STORE });
}
