import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { audienceStatsSync, listBroadcastsSync, startBroadcast, MAX_BROADCAST_LENGTH } from "@/lib/notify/broadcast.js";
import { loadTelegramLinkConfig } from "@/lib/telegram/config.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// Admin-only (dashboardGuard: every /api/* outside the public and account
// prefixes needs an admin session).

// GET /api/telegram-broadcasts — audience counts and recent broadcasts.
export async function GET() {
  const db = await getAdapter();
  const config = await loadTelegramLinkConfig();
  return NextResponse.json(
    {
      configured: Boolean(config.botToken),
      maxLength: MAX_BROADCAST_LENGTH,
      audience: audienceStatsSync(db),
      broadcasts: listBroadcastsSync(db),
    },
    { headers: NO_STORE }
  );
}

// POST /api/telegram-broadcasts { text } — send an announcement to every linked
// customer who keeps announcements on. Runs in the background; poll GET.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const config = await loadTelegramLinkConfig();
  if (!config.botToken) {
    return NextResponse.json({ error: "Chưa cấu hình bot token trong Settings" }, { status: 400, headers: NO_STORE });
  }
  const result = await startBroadcast({ text: body?.text, createdBy: await getAdminActor(request) });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ broadcast: result.broadcast }, { status: 201, headers: NO_STORE });
}
