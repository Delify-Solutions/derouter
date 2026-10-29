import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import AccountShell from "./components/AccountShell";

export const dynamic = "force-dynamic";

// Session gate lives here; the middleware also redirects, so an unauthenticated
// render should not happen in practice. The frame itself is AccountShell.
export default async function AccountLayout({ children }) {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (!session) redirect("/login");

  const { user } = session;
  return (
    <AccountShell email={user.email} name={user.displayName || ""}>
      {children}
    </AccountShell>
  );
}
