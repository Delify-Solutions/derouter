import TelegramBroadcastClient from "./TelegramBroadcastClient";
import TelegramLinksClient from "./TelegramLinksClient";

export const metadata = {
  title: "Telegram - derouter",
};

/** `/dashboard/telegram`: broadcasts, and the accounts linked to Telegram (with unlink). */
export default function TelegramBroadcastPage() {
  return (
    <div className="flex flex-col gap-12">
      <TelegramBroadcastClient />
      <div className="border-t border-border pt-10">
        <TelegramLinksClient />
      </div>
    </div>
  );
}
