import Link from "next/link";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { USAGE_WINDOWS, fmtUsd, windowLimitFor, monthlyLimitFor, interpolate } from "./salesData";

const CHECKOUT_URL = "/account/plans";

// One card per plan that is active in the admin list — the count, the names and
// the prices all come from the database, so adding a third plan in
// /dashboard/plans makes a third card appear here with no code change.
export default function PlansSection({ plans, models, copy }) {
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
            const sampleId = plan.sampleModel?.model ?? null;
            const sampleMonthly = sampleId ? monthlyLimitFor(plan, sampleId) : null;
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

                <p className="mt-6 flex items-baseline gap-2">
                  <span className="font-mono text-4xl font-semibold tracking-tight">
                    {fmtUsd(plan.priceUsd)}
                  </span>
                  <span className="font-mono text-[12px] text-text-muted">/ tháng</span>
                </p>

                {sampleId && sampleMonthly !== null ? (
                  <>
                    <dl className="mt-6 grid grid-cols-3 gap-px border border-border bg-border">
                      {USAGE_WINDOWS.map((window) => (
                        <div key={window.id} className="bg-surface px-3 py-3">
                          <dt className="meta text-text-subtle">{window.label}</dt>
                          <dd className="mt-1 font-mono text-sm text-text-main">
                            {fmtUsd(windowLimitFor(plan, sampleId, window.fraction))}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 font-mono text-[11px] text-text-subtle">
                      Ví dụ với {sampleId}: hạn mức tháng {fmtUsd(sampleMonthly)}
                    </p>
                  </>
                ) : (
                  <p className="mt-6 font-mono text-[11px] text-text-subtle">
                    Tín dụng {fmtUsd(plan.creditUsd)} dùng cho mọi model
                  </p>
                )}

                <ul className="mt-6 flex flex-col gap-2.5">
                  {plan.perks.map((perk) => (
                    <li key={perk} className="flex items-start gap-2.5 text-sm text-text-muted">
                      <span className="material-symbols-outlined mt-0.5 text-[16px] text-brand-600 dark:text-brand-400">
                        check
                      </span>
                      {perk}
                    </li>
                  ))}
                </ul>

                {plan.purchasable ? (
                  <Link
                    href={CHECKOUT_URL}
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
};
