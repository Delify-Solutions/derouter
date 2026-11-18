import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { announcementImageTypeSync } from "@/lib/notify/inbox.js";
import { imageResponseHeaders, readAnnouncementImage } from "@/lib/notify/announcementImage.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/account/notifications/[id]/image — an announcement's image, for a signed-in customer. */
export async function GET(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) return new NextResponse(null, { status: 401, headers: NO_STORE });
  const { id } = await params;
  const db = await getAdapter();
  const type = announcementImageTypeSync(db, id);
  const bytes = type ? readAnnouncementImage(id) : null;
  if (!bytes) return new NextResponse(null, { status: 404, headers: NO_STORE });
  return new NextResponse(bytes, { headers: imageResponseHeaders(type) });
}
