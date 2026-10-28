"use client";

import { fmtUsdNano } from "@/shared/utils/money";

const STATUS_TAG = {
  active: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400",
  exhausted: "border-border bg-surface-2 text-text-muted",
  expired: "border-border bg-surface-2 text-text-subtle",
};

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
  });
}

function daysLeft(expiresAt) {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86400000);
  return days;
}

/**
 * Purchased / gifted plans for the customer, newest first. Each row carries a
 * square progress bar: a filled hairline block, no radius, no gradient, so the
 * proportion is readable without colour.
 */
export default function MyPlans({ plans, loading }) {
  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Your plans</span>
        <div className="border border-border divide-y divide-border">
          {[0, 1].map((i) => (
            <div key={i} className="h-[92px] bg-surface-2/50" aria-hidden="true" />
          ))}
        </div>
      </section>
    );
  }

  if (!plans.length) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Your plans</span>
        <div className="border border-border px-6 py-10 flex flex-col items-center text-center gap-2">
          <span className="material-symbols-outlined text-[28px] text-text-subtle">inventory_2</span>
          <p className="text-sm text-text-main font-medium">No plan yet</p>
          <p className="text-sm text-text-muted max-w-sm">
            Credit and expiry appear here after an order is approved or a gift code is redeemed.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <span className="meta text-text-muted">Your plans</span>
      <ul className="border border-border divide-y divide-border">
        {plans.map((plan) => {
          const total = plan.creditTotalNanoUsd || 0;
          const remaining = plan.creditRemainingNanoUsd || 0;
          const pct = total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 0;
          const left = daysLeft(plan.expiresAt);
          const live = plan.status === "active" && (left == null || left > 0);
          const tagClass = STATUS_TAG[plan.status] || STATUS_TAG.exhausted;

          return (
            <li key={plan.id} className="flex flex-col gap-3 px-6 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-main truncate">
                      {plan.planName || (plan.planId ? "Plan" : "Credit grant")}
                    </span>
                    {plan.planCode && (
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                        {plan.planCode}
                      </span>
                    )}
                    <span className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tagClass}`}>
                      {plan.status}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-text-muted">
                    {fmtDate(plan.startsAt)} → {fmtDate(plan.expiresAt)}
                    {live && left != null && (
                      <span className="ml-2 text-text-subtle">
                        {left <= 0 ? "expires today" : `${left} day${left === 1 ? "" : "s"} left`}
                      </span>
                    )}
                  </span>
                </div>

                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="font-mono text-sm text-text-main">{fmtUsdNano(remaining)}</span>
                  <span className="font-mono text-[11px] text-text-subtle">
                    of {fmtUsdNano(total)}
                  </span>
                </div>
              </div>

              {/* Square progress: track + filled block, both 1px-bordered. */}
              <div
                className="h-2 w-full border border-border bg-surface-2"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                aria-label={`${Math.round(pct)} percent of credit remaining`}
              >
                <div
                  className={live ? "h-full bg-brand-500" : "h-full bg-text-subtle"}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
