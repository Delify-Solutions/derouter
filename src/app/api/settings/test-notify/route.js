import { NextResponse } from "next/server";
import { notifyAdmin } from "@/lib/notify/telegram";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const REASON_MESSAGES = {
  not_configured: "Telegram is not configured — set the bot token and chat id, then save",
  telegram_error: "Telegram rejected the message — check the bot token and chat id",
  network_error: "Could not reach Telegram — check this server's network access",
};

export async function POST() {
  const result = await notifyAdmin("Test from derouter");
  if (result.ok) {
    return NextResponse.json({ ok: true, message: "Test message sent" }, { headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: false, reason: result.reason, error: REASON_MESSAGES[result.reason] || "Test message failed" },
    { status: 400, headers: NO_STORE }
  );
}
