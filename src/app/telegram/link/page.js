import TelegramLinkClient from "./TelegramLinkClient";

export const metadata = { title: "Liên kết Telegram - derouter" };

// Opened by Telegram as a Mini App (spec telegram-link). No session: Telegram's
// signed launch data and the one-time token in it identify the account.
export default function TelegramLinkPage() {
  return <TelegramLinkClient />;
}
