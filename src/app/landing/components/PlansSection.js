import Link from "next/link";
import PropTypes from "prop-types";
import SectionHeader from "./SectionHeader";
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
          <SectionHeader eyebrow={copy.plansEyebrow} title={copy.plansTitle} />
          <p className="mt-8 border border-dashed border-border p-8 text-sm text-text-muted">
            Hiện chưa có gói nào được mở bán. Vui lòng quay lại sau.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section id="plans" className="border-b border-border">
      <div className="shell py-20">
        <SectionHeader eyebrow={copy.plansEyebrow} title={copy.plansTitle}>
          <p>{interpolate(copy.plansSubtitle, { count: models.length, plans: plans.length })}</p>
        </SectionHeader>

        <div
          className={`mt-12 grid grid-cols-1 gap-4 ${
            plans.length > 1 ? "md:grid-cols-2" : ""
          } ${plans.length > 2 ? "lg:grid-cols-3" : ""}`}
        >
          {plans.map((plan) => {
            const headline = plan.priceVndText || plan.priceUsdText || "Chưa mở bán";
            const secondary = plan.priceVndText && plan.priceUsdText ? plan.priceUsdText : null;
            return (
              <div
                key={plan.id}
                className={`flex flex-col border bg-surface ${plan.highlighted ? "border-text-main" : "border-border"}`}
              >
                {plan.badge ? (
                  <div className="flex h-8 items-center bg-text-main px-6 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bg">
                    {plan.badge}
                  </div>
                ) : null}

                <div className="flex flex-col gap-1 px-6 pt-6">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle">{plan.code}</span>
                  <h3 className="text-xl font-semibold tracking-tight text-text-main">{plan.name}</h3>
                  {plan.summary ? <p className="text-sm leading-6 text-text-muted">{plan.summary}</p> : null}
                </div>

                {/* Both rails, each labelled: the admin prices them separately and
                    there is no exchange rate between them (spec plan-dual-pricing). */}
                <div className="px-6 pt-6">
                  <p className="flex items-baseline gap-2 text-text-main">
                    <span className="text-4xl font-semibold leading-none tracking-tight">{headline}</span>
                    {plan.priceVndText || plan.priceUsdText ? (
                      <span className="font-mono text-xs text-text-muted">/ {plan.durationDays} ngày</span>
                    ) : null}
                  </p>
                  {secondary ? (
                    <p className="mt-2 font-mono text-xs text-text-muted">hoặc {secondary} (Binance USDT)</p>
                  ) : null}
                  <p className="mt-4 text-sm font-medium text-text-main">
                    Nhận {fmtUsd(plan.creditUsd)} credit
                    <span className="font-normal text-text-muted"> · dùng chung mọi model</span>
                  </p>
                </div>

                <ul className="mt-6 flex flex-1 flex-col gap-2.5 border-t border-border px-6 py-5">
                  {[...(plan.limitsText || []), ...DEFAULT_PERKS].map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-sm text-text-muted">
                      <span className="material-symbols-outlined mt-0.5 text-[16px] text-text-subtle" aria-hidden="true">check</span>
                      {line}
                    </li>
                  ))}
                </ul>

                <div className="border-t border-border p-6">
                  {plan.purchasable && !plan.soldOut ? (
                    <Link
                      href={checkoutHref(plan, signedIn)}
                      className={`inline-flex h-11 w-full items-center justify-center border font-mono text-sm font-medium transition-colors duration-150 ${
                        plan.highlighted
                          ? "border-text-main bg-text-main text-bg hover:bg-text-main/85"
                          : "border-border bg-surface text-text-main hover:bg-surface-2"
                      }`}
                    >
                      Chọn {plan.name}
                    </Link>
                  ) : (
                    // Shown but not buyable: the plan is advertised before its
                    // capacity exists. The button is inert rather than absent so
                    // the card keeps its shape and the state is legible.
                    <span className="inline-flex h-11 w-full cursor-not-allowed items-center justify-center border border-border font-mono text-sm font-medium text-text-subtle">
                      Chưa mở bán
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {copy.plansFootnote ? (
          <p className="mt-6 max-w-3xl text-sm text-text-subtle">{copy.plansFootnote}</p>
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
