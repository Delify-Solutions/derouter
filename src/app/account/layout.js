import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { isAffiliateAreaAvailable } from "@/lib/db/repos/affiliateRepo.js";
import AccountShell from "./components/AccountShell";
import PromoPopupSlot from "@/app/landing/components/PromoPopupSlot";

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

  return (
    <AccountShell email={user.email} name={user.displayName || ""} affiliateAvailable={affiliateAvailable}>
      {children}
      {/* New accounts only (no purchase, popup code not redeemed); never on the
          gift page, where the code is already prefilled. */}
      <PromoPopupSlot accountUserId={user.id} hideOn={["/account/gift"]} />
    </AccountShell>
  );
}
