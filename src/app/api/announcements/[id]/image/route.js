import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { announcementImageTypeSync } from "@/lib/notify/inbox.js";
import { imageResponseHeaders, readAnnouncementImage } from "@/lib/notify/announcementImage.js";

export const dynamic = "force-dynamic";

/** GET /api/announcements/[id]/image — the announcement's image, for the admin page. */
export async function GET(request, { params }) {
  const { id } = await params;
  const db = await getAdapter();
  const type = announcementImageTypeSync(db, id);
  const bytes = type ? readAnnouncementImage(id) : null;
  if (!bytes) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new NextResponse(bytes, { headers: imageResponseHeaders(type) });
}
