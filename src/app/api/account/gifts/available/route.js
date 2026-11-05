import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { listAvailableGiftsSync } from "@/lib/db/repos/giftRepo.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";
import { getSettings } from "@/lib/localDb";
import { channelUrlOf } from "@/lib/telegram/channel.js";
import { channelCheckConfigured } from "@/lib/telegram/channelMember.js";

export const dynamic = "force-dynamic";

// GET /api/account/gifts/available — the codes the admin listed that this account
// can still take (change channel-gift), plus the channel link channel-join codes need.
export async function GET(request) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = await getAdapter();
    const settings = (await getSettings().catch(() => null)) || {};
    // Channel-join codes only when the bot can check membership and the
    // customer has a link to join through.
    const includeChannel = channelCheckConfigured(settings) && Boolean(channelUrlOf(settings));
    const codes = listAvailableGiftsSync(db, session.userId, { includeChannel });
    return NextResponse.json(
      { codes, channelUrl: channelUrlOf(settings) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách mã" }, { status: 500 });
  }
}
