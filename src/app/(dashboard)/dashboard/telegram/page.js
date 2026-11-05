import TelegramBroadcastClient from "./TelegramBroadcastClient";
import TelegramChannelCard from "./TelegramChannelCard";

export const metadata = {
  title: "Telegram - derouter",
};

/** `/dashboard/telegram`: broadcasts and the public channel link. */
export default function TelegramBroadcastPage() {
  return (
    <div className="flex flex-col gap-10">
      <TelegramBroadcastClient />
      <TelegramChannelCard />
    </div>
  );
}
