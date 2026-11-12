import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { validateAnnouncement, updateAnnouncementSync, deleteAnnouncementSync } from "@/lib/notify/inbox.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** PATCH /api/announcements/[id] — `{ title, body, important }` (web copy only; a sent Telegram message stays as sent). */
export async function PATCH(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const checked = validateAnnouncement(body || {});
  if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
  const db = await getAdapter();
  const announcement = updateAnnouncementSync(db, id, checked.value);
  if (!announcement) return NextResponse.json({ error: "Không tìm thấy thông báo" }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ ok: true, announcement }, { headers: NO_STORE });
}

/** DELETE /api/announcements/[id] */
export async function DELETE(request, { params }) {
  const { id } = await params;
  const db = await getAdapter();
  if (!deleteAnnouncementSync(db, id)) {
    return NextResponse.json({ error: "Không tìm thấy thông báo" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
