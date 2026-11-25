import { redirect } from "next/navigation";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import PluginsPageClient from "./PluginsPageClient";

export async function generateMetadata() {
  const settings = await getSettings();
  const label = settings.dshPluginsNavLabel || "Plugin DSH";
  return { title: `${label} - derouter` };
}

export const dynamic = "force-dynamic";

export default async function AccountPluginsPage() {
  const settings = await getSettings();
  // Disabled by admin: block the page itself, not just the nav link (owner
  // decision — a direct URL visit must not reach it either).
  if (settings.dshPluginsNavEnabled === false) redirect("/account");
  return <PluginsPageClient label={settings.dshPluginsNavLabel || "Plugin DSH"} />;
}
