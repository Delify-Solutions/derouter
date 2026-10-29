import Link from "next/link";
import PropTypes from "prop-types";
import { fmtUsd, interpolate } from "./salesData";

// Server component. Every string comes from `copy` (operator-editable) and every
// number from the plans rows passed in — so changing the words never means
// editing JSX, and changing a price never means editing words.
export default function HeroSection({ plans, models, copy }) {
  // The cheapest visible plan is the "from" figure. Plans arrive ordered by the
  // admin's sortOrder, not by price, so this must be computed rather than taken
  // from index 0.
  const cheapest = plans.length
    ? plans.reduce((min, p) => (p.priceUsd < min.priceUsd ? p : min), plans[0])
    : null;

  const specs = [
    cheapest
      ? { label: "Giá từ", value: `${fmtUsd(cheapest.priceUsd)}/tháng` }
      : null,
    { label: "Danh mục", value: `${models.length} model lập trình` },
    cheapest
      ? {
          label: "Credit",
          value: `Nhận ${fmtUsd(cheapest.creditUsd)} dùng chung mọi model`,
        }
      : null,
    { label: "Endpoint", value: "POST /v1/chat/completions" },
  ].filter(Boolean);

  return (
    <section id="hero" className="relative overflow-hidden border-b border-border">
      {/* Lưới blueprint, mask để không bao giờ nằm dưới chữ. */}
      <div
        className="hero-blueprint-grid blueprint-fade pointer-events-none absolute inset-0"
        aria-hidden="true"
      />

      <div className="shell relative py-20 md:py-28">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold leading-[1.15] tracking-tight md:text-6xl">
            {interpolate(copy.heroTitle, { plans: plans.length })}
          </h1>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/account/plans"
              className="inline-flex h-12 items-center justify-center border border-brand-500 bg-brand-500 px-7 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600"
            >
              {copy.heroPrimaryCta}
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-12 items-center justify-center gap-2 border border-border px-7 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-text-main transition-colors duration-150 hover:bg-surface-2"
            >
              <span className="material-symbols-outlined text-[18px]">description</span>
              {copy.heroSecondaryCta}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

HeroSection.propTypes = {
  plans: PropTypes.array.isRequired,
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
