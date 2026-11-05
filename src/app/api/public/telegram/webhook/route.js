import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/localDb";
import { checkLimits } from "@/lib/auth/actionLimiter.js";
import { botTokenOf } from "@/lib/telegram/channelMember.js";
import { botClient } from "@/lib/telegram/botApi.js";
import { handleUpdate } from "@/lib/telegram/bot/handler.js";
import { botBaseUrlOf, webhookSecretMatches } from "@/lib/telegram/bot/config.js";
import { loadSiteName } from "@/lib/notify/customerTelegram.js";

export const dynamic = "force-dynamic";

// Telegram may deliver an update twice (a retry after a slow answer): the ids
// seen recently are skipped. In memory, per process; bounded.
const seen = new Set();
function firstTime(updateId) {
  if (!Number.isInteger(updateId)) return true;
  if (seen.has(updateId)) return false;
  seen.add(updateId);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return true;
}

const OK = () => NextResponse.json({ ok: true });

// POST /api/public/telegram/webhook — updates from Telegram for the command bot
// (change telegram-bot-commands). Public path; authenticated by the secret token
// Telegram echoes in X-Telegram-Bot-Api-Secret-Token (set with setWebhook).
// Anything accepted answers 200 so Telegram does not retry it.
export async function POST(request) {
  const settings = (await getSettings().catch(() => null)) || {};
  if (!webhookSecretMatches(settings.telegramWebhookSecret, request.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const token = botTokenOf(settings);
  if (!token) return OK();

  let update;
  try {
    update = await request.json();
  } catch {
    return OK();
  }
  if (!firstTime(update?.update_id)) return OK();

  // A flood from one Telegram user is dropped quietly (30 a minute).
  const fromId = update?.message?.from?.id ?? update?.callback_query?.from?.id;
  if (fromId != null) {
    const gate = checkLimits([{ bucket: `telegram-bot:${fromId}`, limit: 30, windowMs: 60_000 }]);
    if (!gate.allowed) return OK();
  }

  const db = await getAdapter();
  await handleUpdate(update, {
    db,
    settings,
    api: botClient(token),
    siteName: await loadSiteName().catch(() => "derouter"),
    baseUrl: botBaseUrlOf(settings),
  });
  return OK();
}
