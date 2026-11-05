import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import SettingsPageClient from "./components/SettingsPageClient";

export const metadata = {
  title: "Tài khoản - derouter",
};

export const dynamic = "force-dynamic";

/**
 * `/account/settings` ("Tài khoản"): security (email, password, Telegram) and the
 * account history (spec customer-portal "Account settings page").
 * `?tab=history` opens the history tab.
 */
export default async function AccountSettingsPage({ searchParams }) {
  const session = await getAccountSession(await cookies());
  if (!session) redirect("/login");
  const params = await searchParams;
  const tab = params?.tab === "history" ? "history" : "security";
  const { user } = session;
  return (
    <SettingsPageClient
      initialTab={tab}
      account={{
        email: user.email,
        status: user.status,
        createdAt: user.createdAt ?? null,
        lastLoginAt: user.lastLoginAt ?? null,
      }}
    />
  );
}
