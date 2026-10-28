import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { verifyUserToken } from "@/lib/auth/userSession";
import LandingPage from "./landing/components/LandingPage";

export const dynamic = "force-dynamic";

// `/` is public. A live admin session goes to the admin shell, a live customer
// session goes to the account area, and everyone else gets the landing page.
// The middleware (src/dashboardGuard.js) lets `/` through for this to decide.
export default async function RootPage() {
  const cookieStore = await cookies();

  const adminSession = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
  if (adminSession) redirect("/dashboard");

  const userToken = cookieStore.get("user_token")?.value;
  if (userToken && (await verifyUserToken(userToken))) redirect("/account");

  return <LandingPage />;
}
