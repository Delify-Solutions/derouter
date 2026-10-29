import { getSettings } from "@/lib/localDb";
import KeysPageClient from "./components/KeysPageClient";

export const metadata = {
  title: "API key - derouter",
};

export const dynamic = "force-dynamic";

// The base URL box prefers the configured public base URL (the address customers
// reach the proxy at, behind a reverse proxy) and falls back to the origin the
// browser is on. Read on the server so the box is correct on the first paint.
export default async function AccountKeysPage() {
  let publicBaseUrl = "";
  try {
    const settings = await getSettings();
    publicBaseUrl = typeof settings?.publicBaseUrl === "string" ? settings.publicBaseUrl.trim() : "";
  } catch {
    publicBaseUrl = "";
  }

  return <KeysPageClient publicBaseUrl={publicBaseUrl} />;
}
