import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { customerInboxSync } from "@/lib/notify/inbox.js";
import { channelUrlOf } from "@/lib/telegram/channel.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/account/notifications — announcements, own notifications, unread count, channel link. */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, { status: 401, headers: NO_STORE });
  }
  try {
    const db = await getAdapter();
    let settings = {};
    try {
      settings = await getSettings();
    } catch {
      settings = {};
    }
    return NextResponse.json(
      { ...customerInboxSync(db, session.userId), channelUrl: channelUrlOf(settings) },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được thông báo" }, { status: 500, headers: NO_STORE });
  }
}
