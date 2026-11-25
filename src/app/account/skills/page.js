import { redirect } from "next/navigation";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import SkillsPageClient from "./SkillsPageClient";

export async function generateMetadata() {
  const settings = await getSettings();
  const label = settings.skillsNavLabel || "Skill";
  return { title: `${label} - derouter` };
}

export const dynamic = "force-dynamic";

export default async function AccountSkillsPage() {
  const settings = await getSettings();
  // Disabled by admin: block the page itself, not just the nav link (owner
  // decision — a direct URL visit must not reach it either).
  if (settings.skillsNavEnabled === false) redirect("/account");
  return <SkillsPageClient label={settings.skillsNavLabel || "Skill"} />;
}
