import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { isAffiliateAreaAvailable } from "@/lib/db/repos/affiliateRepo.js";
import AccountShell from "./components/AccountShell";
import PromoPopupSlot from "@/app/landing/components/PromoPopupSlot";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { unreadCountSync } from "@/lib/notify/inbox.js";
import { channelUrlOf } from "@/lib/telegram/channel.js";

export const dynamic = "force-dynamic";

// Session gate lives here; the middleware also redirects, so an unauthenticated
// render should not happen in practice. The frame itself is AccountShell.
export default async function AccountLayout({ children }) {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (!session) redirect("/login");

  const { user } = session;

  // The "Giới thiệu" item appears when the program is enabled and the account may
  // refer under the access mode, or when the account has something to keep
  // (wallet history, users it already referred). The check must not take the
  // whole account area down if it fails.
  let affiliateAvailable = false;
  try {
    affiliateAvailable = await isAffiliateAreaAvailable(user.id);
  } catch {
    affiliateAvailable = false;
  }

  // Unread announcements + own notifications for the "Thông báo" badge, and the
  // Telegram channel link (change models-notifications). Never fatal.
  let unreadCount = 0;
  let channelUrl = "";
  // Nav visibility + display label for Skill / Plugin DSH (settingsRepo defaults
  // keep both on with their usual names if settings cannot be read at all).
  let skillsNavEnabled = true;
  let skillsNavLabel = "Skill";
  let dshPluginsNavEnabled = true;
  let dshPluginsNavLabel = "Plugin DSH";
  try {
    unreadCount = unreadCountSync(await getAdapter(), user.id);
  } catch {
    unreadCount = 0;
  }
  try {
    const settings = await getSettings();
    channelUrl = channelUrlOf(settings);
    skillsNavEnabled = settings.skillsNavEnabled !== false;
    skillsNavLabel = settings.skillsNavLabel || "Skill";
    dshPluginsNavEnabled = settings.dshPluginsNavEnabled !== false;
    dshPluginsNavLabel = settings.dshPluginsNavLabel || "Plugin DSH";
  } catch {
    channelUrl = "";
  }

  return (
    <AccountShell
      email={user.email}
      name={user.displayName || ""}
      affiliateAvailable={affiliateAvailable}
      unreadCount={unreadCount}
      channelUrl={channelUrl}
      skillsNavEnabled={skillsNavEnabled}
      skillsNavLabel={skillsNavLabel}
      dshPluginsNavEnabled={dshPluginsNavEnabled}
      dshPluginsNavLabel={dshPluginsNavLabel}
    >
      {children}
      {/* New accounts only (no purchase, popup code not redeemed); never on the
          gift page, where the code is already prefilled. */}
      <PromoPopupSlot accountUserId={user.id} hideOn={["/account/gift"]} />
    </AccountShell>
  );
}
