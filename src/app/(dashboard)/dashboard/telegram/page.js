import TelegramBroadcastClient from "./TelegramBroadcastClient";
import TelegramChannelCard from "./TelegramChannelCard";
import TelegramLinksClient from "./TelegramLinksClient";

export const metadata = {
  title: "Telegram - derouter",
};

/**
 * `/dashboard/telegram`: broadcasts, the public channel link, and the accounts
 * linked to Telegram (with unlink).
 */
export default function TelegramBroadcastPage() {
  return (
    <div className="flex flex-col gap-12">
      <TelegramBroadcastClient />
      <TelegramChannelCard />
      <div className="border-t border-border pt-10">
        <TelegramLinksClient />
      </div>
    </div>
  );
}
