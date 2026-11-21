import { getSettings } from "@/lib/localDb";
import BotDetailClient from "./components/BotDetailClient";

export const metadata = {
  title: "Bot doanh nghiệp - derouter",
};

export const dynamic = "force-dynamic";

// The base URL box prefers the configured public base URL (the address customers
// reach the router at) and falls back to the browser's origin.
export default async function AccountBusinessBotPage() {
  let publicBaseUrl = "";
  try {
    const settings = await getSettings();
    publicBaseUrl = typeof settings?.publicBaseUrl === "string" ? settings.publicBaseUrl.trim() : "";
  } catch {
    publicBaseUrl = "";
  }
  return <BotDetailClient publicBaseUrl={publicBaseUrl} />;
}
