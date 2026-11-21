import Link from "next/link";
import PropTypes from "prop-types";
import SectionHeader from "@/app/landing/components/SectionHeader";
import { fitFigureStyle } from "@/shared/utils/fitFigure";
import { fmtUsd } from "@/app/landing/components/salesData";

/** "20 MB" / "1.5 GB" — the unit a knowledge-base limit is sold in. */
export function docSizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Same deep-link rule as the main landing (spec business-landing "Business plan cards"). */
function checkoutHref(plan, signedIn) {
  const target = `/account/plans?plan=${encodeURIComponent(plan.code)}`;
  return signedIn ? target : `/register?next=${encodeURIComponent(target)}`;
}

const BIZ_PERKS = [
  "Bot trả lời từ tài liệu của doanh nghiệp",
  "Chặn câu hỏi chính trị và giữ đúng quan điểm chủ quyền",
  "Key API riêng cho từng bot, tính phí như request thường",
];

/**
 * One card per active BUSINESS plan, in the admin's sort order. It reuses the main
 * landing's card rules (price, term, credit, duration, featured, "Chưa mở bán") and
 * adds the two lines only a business plan has.
 */
export default function BusinessPlansSection({ plans, signedIn = false }) {
  return (
    <section id="plans" className="border-b border-border">
      <div className="shell py-20">
        <SectionHeader eyebrow="Bảng giá" title="Gói AI doanh nghiệp">
          <p>Mỗi gói cho phép một số bot và một dung lượng tài liệu. Credit dùng cho mọi model doanh nghiệp.</p>
        </SectionHeader>

        {plans.length === 0 ? (
          <p className="mt-12 border border-dashed border-border p-8 text-sm text-text-muted">
            Gói doanh nghiệp sắp mở bán
          </p>
        ) : (
          <div
            className={`mt-12 grid grid-cols-1 gap-4 ${plans.length > 1 ? "md:grid-cols-2" : ""} ${
              plans.length > 2 ? "lg:grid-cols-3" : ""
            }`}
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
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle [overflow-wrap:anywhere]">
                      {plan.code}
                    </span>
                    <h3 className="text-xl font-semibold tracking-tight text-text-main [overflow-wrap:anywhere]">{plan.name}</h3>
                    {plan.summary ? <p className="text-sm leading-6 text-text-muted">{plan.summary}</p> : null}
                  </div>

                  <div className="@container px-6 pt-6">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-text-main">
                      <span
                        className="max-w-full break-words text-4xl font-semibold leading-none tracking-tight tabular-nums"
                        style={fitFigureStyle(headline)}
                      >
                        {headline}
                      </span>
                      {plan.priceVndText || plan.priceUsdText ? (
                        <span className="whitespace-nowrap font-mono text-xs text-text-muted">
                          / {plan.periodLabel || `${plan.durationDays} ngày`}
                        </span>
                      ) : null}
                    </p>
                    {secondary ? (
                      <p className="mt-2 font-mono text-xs text-text-muted">hoặc {secondary} (Binance USDT)</p>
                    ) : null}
                    <p className="mt-4 text-sm font-medium text-text-main">
                      {plan.unlimitedCredit
                        ? "Credit không giới hạn, dùng cho mọi model doanh nghiệp"
                        : `Nhận ${fmtUsd(plan.creditUsd)} credit dùng cho mọi model doanh nghiệp`}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">Dùng {plan.durationDays} ngày</p>
                  </div>

                  <ul className="mt-6 flex flex-1 flex-col gap-2.5 border-t border-border px-6 py-5">
                    {/* The two lines only a business plan has (spec business-landing). */}
                    <li className="flex items-start gap-2.5 text-sm font-medium text-text-main">
                      <span className="material-symbols-outlined mt-0.5 text-[16px] text-text-subtle" aria-hidden="true">smart_toy</span>
                      {`Tối đa ${plan.maxBots ?? 0} bot`}
                    </li>
                    <li className="flex items-start gap-2.5 text-sm font-medium text-text-main">
                      <span className="material-symbols-outlined mt-0.5 text-[16px] text-text-subtle" aria-hidden="true">folder</span>
                      {`Dung lượng tài liệu ${docSizeLabel(plan.maxKbBytes)}`}
                    </li>
                    {[...(plan.limitsText || []), ...BIZ_PERKS].map((line) => (
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
                        className={`inline-flex min-h-11 w-full items-center justify-center border px-3 py-2 text-center font-mono text-sm font-medium transition-colors duration-150 ${
                          plan.highlighted
                            ? "border-text-main bg-text-main text-bg hover:bg-text-main/85"
                            : "border-border bg-surface text-text-main hover:bg-surface-2"
                        }`}
                      >
                        Chọn {plan.name}
                      </Link>
                    ) : (
                      <span className="inline-flex h-11 w-full cursor-not-allowed items-center justify-center border border-border font-mono text-sm font-medium text-text-subtle">
                        Chưa mở bán
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

BusinessPlansSection.propTypes = {
  plans: PropTypes.array.isRequired,
  signedIn: PropTypes.bool,
};
