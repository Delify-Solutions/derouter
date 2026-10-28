import { cookies } from "next/headers";
import { USER_COOKIE, verifyUserToken } from "@/lib/auth/userSession";
import UsageClient from "./UsageClient";

export const dynamic = "force-dynamic";

// Public key lookup. Anyone holding an API key can paste it and see their own
// usage; no session required. A signed-in customer additionally gets a link to
// the account view, where every key they own is listed.
export default async function UsagePage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(USER_COOKIE)?.value;
  const session = token ? await verifyUserToken(token) : null;

  return <UsageClient hasUserSession={!!session} />;
}
