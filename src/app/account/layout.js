import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import AccountNav from "./components/AccountNav";

export const dynamic = "force-dynamic";

// Customer account shell: a fixed 240px sidebar on desktop, a flat bar with the
// same links on narrow screens. Session gate lives here; the middleware also
// redirects, so an unauthenticated render should not happen in practice.
export default async function AccountLayout({ children }) {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (!session) redirect("/login");

  const { user } = session;

  return (
    <div className="min-h-screen bg-bg flex flex-col lg:flex-row">
      <aside className="hidden lg:flex lg:flex-col w-[240px] shrink-0 border-r border-border bg-sidebar sticky top-0 h-screen">
        <AccountNav email={user.email} />
      </aside>

      <div className="lg:hidden border-b border-border">
        <div className="h-16 flex items-center px-4 border-b border-border">
          <span className="meta text-text-main">derouter</span>
        </div>
        <nav aria-label="Account" className="flex overflow-x-auto">
          {[
            { href: "/account", label: "Overview" },
            { href: "/account/plans", label: "Plans" },
            { href: "/account/gift", label: "Gift code" },
            { href: "/account/keys", label: "API keys" },
            { href: "/account/usage", label: "Usage" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="h-11 px-4 flex items-center font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main whitespace-nowrap border-b-2 border-transparent hover:border-b-brand-500 transition-colors duration-150"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <main className="flex-1 min-w-0">
        <div className="shell py-8 lg:py-10">{children}</div>
      </main>
    </div>
  );
}
