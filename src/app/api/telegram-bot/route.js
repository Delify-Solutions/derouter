import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { botTokenOf } from "@/lib/telegram/channelMember.js";
import { callBotApi } from "@/lib/telegram/botApi.js";
import { CUSTOMER_COMMANDS } from "@/lib/telegram/bot/customer.js";
import { ADMIN_COMMANDS, adminIdsOf } from "@/lib/telegram/bot/admin.js";
import { newWebhookSecret, normalizeBaseUrl, botBaseUrlOf } from "@/lib/telegram/bot/config.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const WEBHOOK_PATH = "/api/public/telegram/webhook";

/** Admin ids that were given a chat-scoped menu (to remove it later). */
function menuIdsOf(settings) {
  return Array.isArray(settings?.telegramBotAdminMenuIds) ? settings.telegramBotAdminMenuIds.map(String) : [];
}

/**
 * Remove command menus: the default one when `token` is given, and each listed
 * admin's chat-scoped one. Best effort: a failure leaves only a stale menu.
 */
async function removeMenus(token, chatIds, tokenForChats = token) {
  if (token) await callBotApi(token, "deleteMyCommands", {});
  for (const id of chatIds) {
    await callBotApi(tokenForChats, "deleteMyCommands", { scope: { type: "chat", chat_id: Number(id) } });
  }
}

function fail(error, status = 400) {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

// GET /api/telegram-bot (admin) — is the command bot receiving updates?
export async function GET() {
  const settings = (await getSettings()) || {};
  const token = botTokenOf(settings);
  const adminIds = adminIdsOf(settings);
  if (!token) return NextResponse.json({ configured: false, enabled: false, adminIds }, { headers: NO_STORE });
  const info = await callBotApi(token, "getWebhookInfo");
  const url = info.ok ? String(info.result?.url || "") : "";
  return NextResponse.json({
    configured: true,
    enabled: Boolean(url) && url.endsWith(WEBHOOK_PATH) && Boolean(settings.telegramWebhookSecret),
    reachable: info.ok,
    webhookUrl: url,
    pendingUpdates: info.ok ? Number(info.result?.pending_update_count || 0) : null,
    lastError: info.ok && info.result?.last_error_message ? String(info.result.last_error_message).slice(0, 200) : null,
    baseUrl: botBaseUrlOf(settings),
    adminIds,
  }, { headers: NO_STORE });
}

// POST /api/telegram-bot (admin) { action: "enable", baseUrl } | { action: "disable" }
// Enable = point the bot's webhook here with a fresh secret and publish the
// command menus (customer menu for everyone, plus admin commands for each admin).
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Dữ liệu không hợp lệ");
  }
  const settings = (await getSettings()) || {};
  const token = botTokenOf(settings);
  if (!token) return fail("Chưa có bot token. Cấu hình bot Telegram trước.");

  if (body?.action === "disable") {
    const res = await callBotApi(token, "deleteWebhook", { drop_pending_updates: false });
    if (!res.ok) return fail("Telegram không tắt được webhook. Thử lại sau.", 502);
    // The old secret must stop working too: a leaked one cannot drive the bot
    // after it was turned off.
    await updateSettings({ telegramWebhookSecret: "" });
    await removeMenus(token, menuIdsOf(settings));
    await updateSettings({ telegramBotAdminMenuIds: [] });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }
  if (body?.action !== "enable") return fail("action phải là enable hoặc disable");

  const baseUrl = normalizeBaseUrl(body?.baseUrl) || normalizeBaseUrl(botBaseUrlOf(settings));
  if (!baseUrl) return fail("Cần địa chỉ https công khai của trang (ví dụ https://ai.delify.vn)");

  // A new secret each time: an old leaked one stops working. Saved only once
  // Telegram accepted the webhook, so a refused update keeps the bot as it was.
  const secret = newWebhookSecret();
  const hook = await callBotApi(token, "setWebhook", {
    url: `${baseUrl}${WEBHOOK_PATH}`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  if (!hook.ok) {
    return fail(`Telegram từ chối webhook: ${hook.description || "lỗi không rõ"}`, 502);
  }
  await updateSettings({ telegramWebhookSecret: secret, telegramBotBaseUrl: baseUrl });

  const menu = await callBotApi(token, "setMyCommands", { commands: CUSTOMER_COMMANDS });
  // Admins see their commands too. A chat-scoped menu needs the admin to have
  // opened the bot once; those that fail are reported.
  const failedAdmins = [];
  const admins = adminIdsOf(settings);
  // Someone taken off the admin list loses the admin menu.
  await removeMenus(null, menuIdsOf(settings).filter((id) => !admins.includes(id)), token);
  for (const id of admins) {
    const res = await callBotApi(token, "setMyCommands", {
      commands: [...CUSTOMER_COMMANDS, ...ADMIN_COMMANDS],
      scope: { type: "chat", chat_id: Number(id) },
    });
    if (!res.ok) failedAdmins.push(id);
  }
  await updateSettings({ telegramBotAdminMenuIds: admins.filter((id) => !failedAdmins.includes(id)) });
  return NextResponse.json({
    ok: true,
    webhookUrl: `${baseUrl}${WEBHOOK_PATH}`,
    menu: menu.ok,
    failedAdmins,
  }, { headers: NO_STORE });
}
