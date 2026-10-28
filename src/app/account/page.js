import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { getApiKeys, getKeyGroupById } from "@/lib/localDb";
import { fmtUsdNano } from "@/shared/utils/money";

export const dynamic = "force-dynamic";

async function readWallet(userId) {
  try {
    const mod = await import("@/lib/db/repos/billingRepo.js");
    if (typeof mod?.walletSummary === "function") {
      const summary = await mod.walletSummary(userId);
      if (summary && typeof summary === "object") {
        return {
          availableNanoUsd: Number.isFinite(summary.availableNanoUsd) ? summary.availableNanoUsd : 0,
          plans: Array.isArray(summary.plans) ? summary.plans : [],
        };
      }
    }
  } catch {
    // Billing repo not installed yet: the overview still renders, with zeroes.
  }
  return { availableNanoUsd: 0, plans: [] };
}

function StatusBadge({ status }) {
  const map = {
    active: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400",
    unverified: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
    suspended: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  };
  const cls = map[status] || "border-border bg-surface-2 text-text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${cls}`}>
      <span className="size-1.5 bg-current" aria-hidden="true" />
      {status || "unknown"}
    </span>
  );
}

export default async function AccountOverviewPage() {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (!session) redirect("/login");

  const user = session.user;

  const [wallet, keys, group] = await Promise.all([
    readWallet(user.id),
    getApiKeys(),
    user.groupId ? getKeyGroupById(user.groupId).catch(() => null) : Promise.resolve(null),
  ]);

  const myKeys = keys.filter((key) => key.userId === user.id);
  const activePlans = wallet.plans.filter((plan) => plan?.status === "active");

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="meta text-text-muted">Account</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-main">
            {user.displayName || user.email}
          </h1>
          <StatusBadge status={user.status} />
        </div>
        <p className="font-mono text-[12px] text-text-muted break-all">{user.email}</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {/* A subscriber's ceiling is per model and refills on its own windows, so
            the wallet figure is not their limit — showing it as the headline made
            people believe $500 was spendable when the model allowance ran out
            first. Subscribers see the plan count and the quota page; credit is
            shown only to accounts that actually pay from credit. */}
        {activePlans.length > 0 ? (
          <div className="border border-border bg-surface p-6">
            <p className="meta text-text-muted">Gói đang dùng</p>
            <p className="font-mono text-[32px] leading-none text-text-main mt-3">
              {activePlans.length}
            </p>
            <p className="text-xs text-text-muted mt-2">
              <Link href="/account/quota" className="underline">
                Xem hạn mức còn lại theo từng model
              </Link>
            </p>
          </div>
        ) : (
          <div className="border border-border bg-surface p-6">
            <p className="meta text-text-muted">Số dư credit</p>
            <p className="font-mono text-[32px] leading-none text-text-main mt-3">
              {fmtUsdNano(wallet.availableNanoUsd)}
            </p>
            <p className="text-xs text-text-muted mt-2">
              Dùng cho lưu lượng không thuộc gói nào
            </p>
          </div>
        )}

        <div className="border border-border bg-surface p-6">
          <p className="meta text-text-muted">API keys</p>
          <p className="font-mono text-[32px] leading-none text-text-main mt-3">{myKeys.length}</p>
          <p className="text-xs text-text-muted mt-2">
            {myKeys.length === 0 ? "No keys yet" : `${myKeys.filter((k) => k.isActive).length} active`}
          </p>
        </div>
      </section>

      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between gap-4 px-6 h-14 border-b border-border">
          <h2 className="meta text-text-main">Active plans</h2>
          <Link
            href="/account/plans"
            className="font-mono text-[12px] uppercase tracking-[0.08em] text-brand-600 dark:text-brand-400 hover:underline"
          >
            Browse plans
          </Link>
        </div>

        {activePlans.length === 0 ? (
          <div className="px-6 py-10 flex flex-col items-start gap-3">
            <p className="text-sm text-text-main">No active plan.</p>
            <p className="text-sm text-text-muted max-w-md">
              A plan adds credit and a validity window. Pick one to start sending requests, or
              redeem a gift code if you were given one.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/account/plans"
                className="inline-flex items-center h-9 px-4 border border-border font-mono text-[12px] uppercase tracking-[0.08em] text-text-main hover:bg-surface-2 transition-colors duration-150"
              >
                View plans
              </Link>
              <Link
                href="/account/gift"
                className="inline-flex items-center h-9 px-4 border border-border font-mono text-[12px] uppercase tracking-[0.08em] text-text-main hover:bg-surface-2 transition-colors duration-150"
              >
                Redeem code
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* No credit columns: on a subscription the ceiling is per model and
                refills on its own windows, so "remaining credit" is not what
                limits the customer and showing it implied a balance they could
                never spend down. The quota page carries the real numbers. */}
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border">
                  <th className="meta text-text-muted font-medium px-6 py-3">Gói</th>
                  <th className="meta text-text-muted font-medium px-6 py-3">Bắt đầu</th>
                  <th className="meta text-text-muted font-medium px-6 py-3">Hết hạn</th>
                  <th className="meta text-text-muted font-medium px-6 py-3">Hạn mức</th>
                </tr>
              </thead>
              <tbody>
                {activePlans.map((plan) => (
                  <tr key={plan.id} className="border-b border-border last:border-b-0">
                    <td className="px-6 py-3 text-sm text-text-main">{plan.planName || plan.planCode || "Gói"}</td>
                    <td className="px-6 py-3 font-mono text-[12px] text-text-muted">
                      {plan.startsAt ? new Date(plan.startsAt).toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className="px-6 py-3 font-mono text-[12px] text-text-muted">
                      {plan.expiresAt ? new Date(plan.expiresAt).toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className="px-6 py-3 font-mono text-[12px] text-text-main">
                      <Link href="/account/quota" className="underline">
                        Xem theo model
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="border border-border bg-surface">
        <div className="px-6 h-14 flex items-center border-b border-border">
          <h2 className="meta text-text-main">Account details</h2>
        </div>
        <dl className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            <dt className="text-sm text-text-muted">Group</dt>
            <dd className="font-mono text-[12px] text-text-main">{group?.name || "None"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            <dt className="text-sm text-text-muted">Member since</dt>
            <dd className="font-mono text-[12px] text-text-main">
              {user.createdAt ? new Date(user.createdAt).toISOString().slice(0, 10) : "—"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            <dt className="text-sm text-text-muted">Last sign-in</dt>
            <dd className="font-mono text-[12px] text-text-main">
              {user.lastLoginAt ? new Date(user.lastLoginAt).toISOString().replace("T", " ").slice(0, 19) : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { href: "/account/keys", label: "API keys", body: "Create and revoke keys", icon: "key" },
          { href: "/account/usage", label: "Usage", body: "Requests and spend", icon: "monitoring" },
          { href: "/account/gift", label: "Gift code", body: "Redeem a code", icon: "redeem" },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="border border-border bg-surface p-5 flex flex-col gap-2 hover:bg-surface-2 transition-colors duration-150"
          >
            <span className="material-symbols-outlined text-[20px] text-text-muted">{item.icon}</span>
            <span className="meta text-text-main">{item.label}</span>
            <span className="text-sm text-text-muted">{item.body}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
