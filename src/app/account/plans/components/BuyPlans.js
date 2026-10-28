"use client";

import { fmtUsdNano } from "@/shared/utils/money";

/**
 * The shop: every active plan as a square card. One action, "Buy", which creates
 * a pending manual order — there is no gateway, so the card also states what
 * happens next before the customer commits.
 */
export default function BuyPlans({ plans, loading, buyingId, onBuy }) {
  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Available plans</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[240px] border border-border bg-surface-2/50" aria-hidden="true" />
          ))}
        </div>
      </section>
    );
  }

  if (!plans.length) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Available plans</span>
        <div className="border border-border px-6 py-10 flex flex-col items-center text-center gap-2">
          <span className="material-symbols-outlined text-[28px] text-text-subtle">sell</span>
          <p className="text-sm text-text-main font-medium">Nothing on sale right now</p>
          <p className="text-sm text-text-muted max-w-sm">
            No active plans. A gift code still adds credit to your balance.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <span className="meta text-text-muted">Available plans</span>
      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const busy = buyingId === plan.id;
          return (
            <li key={plan.id} className="flex flex-col border border-border bg-surface">
              <div className="flex flex-col gap-1 px-6 pt-6">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                  {plan.code}
                </span>
                <h3 className="text-base font-semibold text-text-main">{plan.name}</h3>
                {plan.description && (
                  <p className="text-sm text-text-muted mt-1">{plan.description}</p>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-px bg-border m-6 mb-5 border border-border">
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Price</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtUsdNano(plan.priceNanoUsd)}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Credit</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtUsdNano(plan.creditNanoUsd)}</dd>
                </div>
                <div className="bg-surface px-4 py-3 col-span-2">
                  <dt className="meta text-text-subtle">Valid for</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {plan.durationDays} {plan.durationDays === 1 ? "day" : "days"} from approval
                  </dd>
                </div>
              </dl>

              <div className="mt-auto flex flex-col gap-2 px-6 pb-6">
                <button
                  type="button"
                  onClick={() => onBuy(plan)}
                  disabled={busy}
                  className="h-10 w-full border border-brand-500 bg-brand-500 font-mono text-[11px] uppercase tracking-[0.12em] text-white transition-colors hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? "Creating order…" : `Buy for ${fmtUsdNano(plan.priceNanoUsd)}`}
                </button>
                <p className="text-[11px] text-text-muted">
                  Manual transfer. An admin approves it, then the credit lands.
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
