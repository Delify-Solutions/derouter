import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import {
  validateAnnouncement,
  createAnnouncementSync,
  deleteAnnouncementSync,
  listAnnouncementsSync,
  setAnnouncementBroadcastSync,
  setAnnouncementImageSync,
} from "@/lib/notify/inbox.js";
import { startBroadcast } from "@/lib/notify/broadcast.js";
import { readAnnouncementRequest, saveAnnouncementImage } from "@/lib/notify/announcementImage.js";

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
 * POST /api/announcements — multipart `{ title, body, important, sendTelegram, image? }`
 * (or JSON without an image). Saved for the web first; with `sendTelegram` it also
 * goes out as a Telegram broadcast, with the image as a photo. A refused broadcast
 * does not undo the announcement: `telegram.error` says why.
 */
export async function POST(request) {
  const actor = await getAdminActor(request);
  const input = await readAnnouncementRequest(request);
  if (input.error) return NextResponse.json({ error: input.error }, { status: 400, headers: NO_STORE });
  const checked = validateAnnouncement(input.fields);
  if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });

  const db = await getAdapter();
  let announcement = createAnnouncementSync(db, checked.value, { createdBy: actor });
  if (input.image) {
    try {
      saveAnnouncementImage(announcement.id, input.image.buffer);
    } catch {
      // Nothing half-published: without its image the announcement is not what was asked for.
      deleteAnnouncementSync(db, announcement.id);
      return NextResponse.json({ error: "Không lưu được ảnh" }, { status: 500, headers: NO_STORE });
    }
    setAnnouncementImageSync(db, announcement.id, input.image.type, { now: announcement.updatedAt });
    announcement = { ...announcement, hasImage: true };
  }

  let telegram = null;
  if (input.fields.sendTelegram === true) {
    try {
      const started = await startBroadcast({
        text: `${checked.value.title}\n\n${checked.value.body}`,
        createdBy: actor,
        photo: input.image,
      });
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
