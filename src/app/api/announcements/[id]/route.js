import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import {
  validateAnnouncement,
  updateAnnouncementSync,
  deleteAnnouncementSync,
  setAnnouncementImageSync,
} from "@/lib/notify/inbox.js";
import {
  readAnnouncementRequest,
  removeAnnouncementImage,
  saveAnnouncementImage,
} from "@/lib/notify/announcementImage.js";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PATCH /api/announcements/[id] — `{ title, body, important, image?, removeImage? }`
 * (web copy only; a sent Telegram message stays as sent). A new `image` replaces
 * the old one; `removeImage` drops it; neither keeps it.
 */
export async function PATCH(request, { params }) {
  const denied = await requirePagePermission(request, "announcements", "edit");
  if (denied) return denied;
  const { id } = await params;
  const input = await readAnnouncementRequest(request);
  if (input.error) return NextResponse.json({ error: input.error }, { status: 400, headers: NO_STORE });
  const checked = validateAnnouncement(input.fields);
  if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
  const db = await getAdapter();
  let announcement = updateAnnouncementSync(db, id, checked.value);
  if (!announcement) return NextResponse.json({ error: "Không tìm thấy thông báo" }, { status: 404, headers: NO_STORE });
  if (input.image) {
    try {
      saveAnnouncementImage(id, input.image.buffer);
    } catch {
      return NextResponse.json({ error: "Đã lưu nội dung nhưng không lưu được ảnh" }, { status: 500, headers: NO_STORE });
    }
    setAnnouncementImageSync(db, id, input.image.type, { now: announcement.updatedAt });
    announcement = { ...announcement, hasImage: true };
  } else if (input.fields.removeImage === true) {
    setAnnouncementImageSync(db, id, null, { now: announcement.updatedAt });
    removeAnnouncementImage(id);
    announcement = { ...announcement, hasImage: false };
  }
  return NextResponse.json({ ok: true, announcement }, { headers: NO_STORE });
}

/** DELETE /api/announcements/[id] */
export async function DELETE(request, { params }) {
  const denied = await requirePagePermission(request, "announcements", "delete");
  if (denied) return denied;
  const { id } = await params;
  const db = await getAdapter();
  if (!deleteAnnouncementSync(db, id)) {
    return NextResponse.json({ error: "Không tìm thấy thông báo" }, { status: 404, headers: NO_STORE });
  }
  removeAnnouncementImage(id);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
