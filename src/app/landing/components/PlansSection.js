import Link from "next/link";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { fmtUsd, interpolate, DEFAULT_PERKS } from "./salesData";

/**
 * Where "Chọn <plan>" goes (spec public-landing "Plan selection entry flow"):
 *   signed out → /register?next=/account/plans?plan=<code>  (verify → login → back)
 *   signed in  → /account/plans?plan=<code>                 (the card is highlighted)
 */
function checkoutHref(plan, signedIn) {
  const target = `/account/plans?plan=${encodeURIComponent(plan.code)}`;
  return signedIn ? target : `/register?next=${encodeURIComponent(target)}`;
}

// One card per plan that is active in the admin list — the count, the names and
// the prices all come from the database, so adding a third plan in
// /dashboard/plans makes a third card appear here with no code change.
export default function PlansSection({ plans, models, copy, signedIn = false }) {
  if (!plans.length) {
    return (
      <section id="plans" className="border-b border-border">
        <div className="shell py-20">
          <p className="meta text-text-muted">{copy.plansEyebrow}</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
            {copy.plansTitle}
          </h2>
          <p className="mt-6 border border-border bg-surface p-6 text-sm text-text-muted">
            Hiện chưa có gói nào được mở bán. Vui lòng quay lại sau.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section id="plans" className="border-b border-border">
      <div className="shell py-20">
        <p className="meta text-text-muted">{copy.plansEyebrow}</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          {copy.plansTitle}
        </h2>
        <p className="mt-3 max-w-2xl text-text-muted">
          {interpolate(copy.plansSubtitle, { count: models.length, plans: plans.length })}
        </p>

        <div
          className={`mt-10 grid grid-cols-1 gap-px border border-border bg-border ${
            plans.length > 1 ? "md:grid-cols-2 lg:grid-cols-3" : ""
          }`}
        >
          {plans.map((plan) => {
            return (
              <div key={plan.id} className="flex flex-col bg-surface p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold tracking-tight">{plan.name}</h3>
                    {plan.summary ? (
                      <p className="mt-1.5 text-sm text-text-muted">{plan.summary}</p>
                    ) : null}
                  </div>
                  {plan.badge ? (
                    <Badge variant={plan.highlighted ? "primary" : "default"} className="shrink-0">
                      {plan.badge}
                    </Badge>
                  ) : null}
                </div>

                {/* Both rails, each labelled: the admin prices them separately and
                    there is no exchange rate between them (spec plan-dual-pricing). */}
                <div className="mt-6 flex flex-col gap-1">
                  {plan.priceVndText ? (
                    <p className="flex items-baseline gap-2">
                      <span className="font-mono text-3xl font-semibold tracking-tight">
                        {plan.priceVndText}
                      </span>
                      <span className="font-mono text-[12px] text-text-muted">chuyển khoản</span>
                    </p>
                  ) : null}
                  {plan.priceUsdText ? (
                    <p className="flex items-baseline gap-2">
                      <span
                        className={
                          plan.priceVndText
                            ? "font-mono text-base font-semibold tracking-tight text-text-main"
                            : "font-mono text-3xl font-semibold tracking-tight"
                        }
                      >
                        {plan.priceUsdText}
                      </span>
                      <span className="font-mono text-[12px] text-text-muted">Binance USDT</span>
                    </p>
                  ) : null}
                  {!plan.priceVndText && !plan.priceUsdText ? (
                    <p className="font-mono text-base text-text-muted">Chưa mở bán</p>
                  ) : null}
                </div>

                <p className="mt-6 text-sm text-text-main">
                  Nhận {fmtUsd(plan.creditUsd)} dùng chung mọi model
                </p>
                <p className="mt-1 font-mono text-[12px] text-text-muted">
                  Dùng {plan.durationDays} ngày
                </p>

                {plan.limitsText?.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-1">
                    {plan.limitsText.map((line) => (
                      <li key={line} className="font-mono text-[12px] text-text-muted">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}

                <ul className="mt-6 flex flex-col gap-2.5">
                  {DEFAULT_PERKS.map((perk) => (
                    <li key={perk} className="flex items-start gap-2.5 text-sm text-text-muted">
                      <span className="material-symbols-outlined mt-0.5 text-[16px] text-brand-600 dark:text-brand-400">
                        check
                      </span>
                      {perk}
                    </li>
                  ))}
                </ul>

                {plan.purchasable && !plan.soldOut ? (
                  <Link
                    href={checkoutHref(plan, signedIn)}
                    className={`mt-8 inline-flex h-11 items-center justify-center px-6 font-mono text-xs font-semibold uppercase tracking-[0.08em] transition-colors duration-150 ${
                      plan.highlighted
                        ? "border border-brand-500 bg-brand-500 text-white hover:border-brand-600 hover:bg-brand-600"
                        : "border border-border text-text-main hover:bg-surface-2"
                    }`}
                  >
                    Chọn {plan.name}
                  </Link>
                ) : (
                  // Shown but not buyable: the plan is advertised before its
                  // capacity exists. The button is inert rather than absent so
                  // the card keeps its shape and the state is legible.
                  <span className="mt-8 inline-flex h-11 cursor-not-allowed items-center justify-center border border-border px-6 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-text-subtle">
                    Chưa mở bán
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {copy.plansFootnote ? (
          <p className="mt-4 max-w-3xl font-mono text-[11px] text-text-subtle">
            {copy.plansFootnote}
          </p>
        ) : null}
      </div>
    </section>
  );
}

PlansSection.propTypes = {
  plans: PropTypes.array.isRequired,
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
  signedIn: PropTypes.bool,
};
