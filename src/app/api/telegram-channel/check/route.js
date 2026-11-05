import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { botTokenOf, channelChatIdOf, checkBotCanReadChannel } from "@/lib/telegram/channelMember.js";

export const dynamic = "force-dynamic";

const REASON_TEXT = {
  not_configured: "Chưa có bot token hoặc chưa có kênh để kiểm tra (link công khai hoặc ID kênh).",
  bad_token: "Bot token không hợp lệ. Kiểm tra lại token của bot ở phần cấu hình Telegram.",
  bot_not_admin: "Bot đang ở trong kênh nhưng chưa là quản trị viên. Hãy thêm bot làm quản trị viên của kênh.",
  chat_unavailable: "Bot không thấy kênh này. Kiểm tra lại ID kênh và thêm bot làm quản trị viên của kênh.",
  rate_limited: "Telegram đang giới hạn tốc độ, thử lại sau ít giây.",
  network_error: "Không kết nối được Telegram.",
};

// POST /api/telegram-channel/check (admin) — can the bot verify channel members
// for channel-join gift codes (change channel-gift)?
export async function POST() {
  try {
    const settings = (await getSettings()) || {};
    const chatId = channelChatIdOf(settings);
    const result = await checkBotCanReadChannel(botTokenOf(settings), chatId);
    if (result.ok) return NextResponse.json({ ok: true, chatId });
    return NextResponse.json({ ok: false, chatId, error: REASON_TEXT[result.reason] || "Không kiểm tra được kênh." });
  } catch {
    return NextResponse.json({ ok: false, error: "Không kiểm tra được kênh." }, { status: 500 });
  }
}
