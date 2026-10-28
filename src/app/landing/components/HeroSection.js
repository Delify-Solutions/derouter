import Link from "next/link";
import PropTypes from "prop-types";
import { PLANS, USAGE_WINDOWS, fmtUsd } from "./salesData";

const SIGNUP_URL = "/register?next=/account/plans";

// Server component. Every string comes from `copy` (operator-editable, stored in
// settings.landingCopy) and every number is derived from salesData / the model
// catalogue — so changing the words never means editing JSX, and changing a
// price never means editing words.
export default function HeroSection({ models, copy }) {
  const entryPlan = PLANS[0];

  const specs = [
    { label: "Giá từ", value: `${fmtUsd(entryPlan.priceUsd)}/tháng` },
    { label: "Danh mục", value: `${models.length} model lập trình` },
    {
      label: "Cửa sổ hạn mức",
      value: USAGE_WINDOWS.map((w) => `${Math.round(w.fraction * 100)}% · ${w.label}`).join("  "),
    },
    { label: "Endpoint", value: "POST /v1/chat/completions" },
  ];

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
            {copy.heroTitle}
          </h1>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href={SIGNUP_URL}
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
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
