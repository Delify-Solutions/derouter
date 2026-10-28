import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { verifyUserToken } from "@/lib/auth/userSession";
import LandingPage from "./landing/components/LandingPage";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { mergeLandingCopy } from "@/lib/db/repos/contentRepo.js";

export const dynamic = "force-dynamic";

/**
 * `/` is public. A signed-in admin normally goes straight to the shell and a
 * customer goes to their account, which is what makes the site feel like an app
 * rather than a brochure.
 *
 * `?preview=1` suppresses that redirect for the signed-in visitor. Without it an
 * admin could never look at the landing page they are editing — every visit
 * bounced to /dashboard — and checking a copy change meant opening a private
 * window or logging out. The flag only ever affects the caller's own view.
 */
export default async function RootPage({ searchParams }) {
  const params = await searchParams;
  const preview = params?.preview === "1";

  const cookieStore = await cookies();

  if (!preview) {
    const adminSession = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (adminSession) redirect("/dashboard");

    const userToken = cookieStore.get("user_token")?.value;
    if (userToken && (await verifyUserToken(userToken))) redirect("/account");
  }

  // Copy is operator-editable, so it is read per request rather than baked into
  // the build. `dynamic` is already forced above, which is what keeps a saved
  // edit visible on the next load instead of after a redeploy.
  const settings = await getSettings();
  return <LandingPage copy={mergeLandingCopy(settings.landingCopy)} preview={preview} />;
}
