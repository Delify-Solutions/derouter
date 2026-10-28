import Link from "next/link";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { PLANS, USAGE_WINDOWS, fmtUsd, monthlyLimitFor, windowLimitFor } from "./salesData";

const CHECKOUT_URL = "/register?next=/account/plans";

export default function PlansSection({ models, sampleModel }) {
  return (
    <section id="plans" className="border-b border-border">
      <div className="shell py-20">
        <p className="meta text-text-muted">Hai gói</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          Cùng danh mục model, khác hạn mức
        </h2>
        <p className="mt-3 max-w-2xl text-text-muted">
          Cả hai gói đều mở toàn bộ {models.length} model bên dưới. Go Plus không mở thêm model
          nào — nó chỉ nâng hạn mức mỗi model lên gấp {PLANS[1].limitMultiplier} lần.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-px border border-border bg-border md:grid-cols-2">
          {PLANS.map((plan) => (
            <div key={plan.id} className="flex flex-col bg-surface p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold tracking-tight">{plan.name}</h3>
                  <p className="mt-1.5 text-sm text-text-muted">{plan.summary}</p>
                </div>
                <Badge
                  variant={plan.highlighted ? "primary" : "default"}
                  dot={plan.highlighted}
                  className="shrink-0"
                >
                  {plan.badge}
                </Badge>
              </div>

              <p className="mt-6 flex items-baseline gap-2">
                <span className="font-mono text-4xl font-semibold tracking-tight">
                  {fmtUsd(plan.priceUsd)}
                </span>
                <span className="font-mono text-[12px] text-text-muted">/ tháng</span>
              </p>

              <dl className="mt-6 grid grid-cols-3 gap-px border border-border bg-border">
                {USAGE_WINDOWS.map((window) => (
                  <div key={window.id} className="bg-surface px-3 py-3">
                    <dt className="meta text-text-subtle">{window.label}</dt>
                    <dd className="mt-1 font-mono text-sm text-text-main">
                      {fmtUsd(windowLimitFor(plan, sampleModel, window.fraction))}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 font-mono text-[11px] text-text-subtle">
                Ví dụ với {sampleModel.name}: hạn mức tháng {fmtUsd(monthlyLimitFor(plan, sampleModel))}
              </p>

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
            </div>
          ))}
        </div>

        <p className="mt-4 max-w-3xl font-mono text-[11px] text-text-subtle">
          Hạn mức tính bằng USD tiêu thụ theo bảng giá token bên dưới, không phải số request. Một
          request dài tốn nhiều hạn mức hơn một request ngắn.
        </p>
      </div>
    </section>
  );
}

PlansSection.propTypes = {
  models: PropTypes.array.isRequired,
  sampleModel: PropTypes.object.isRequired,
};
