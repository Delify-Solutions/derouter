import Link from "next/link";
import PropTypes from "prop-types";
import CopyBlock from "@/app/account/components/CopyBlock";
import { PROTOCOLS, fmtUsd, interpolate } from "./salesData";

// Server component. Every string comes from `copy` (operator-editable) and every
// number from the plans rows passed in — so changing the words never means
// editing JSX, and changing a price never means editing words.
export default function HeroSection({ plans, models, copy, baseUrl = "" }) {
  // The cheapest visible plan is the "from" figure. Plans arrive ordered by the
  // admin's sortOrder, not by price, so this must be computed rather than taken
  // from index 0.
  const cheapest = plans.length
    ? plans.reduce((min, p) => (p.priceUsd < min.priceUsd ? p : min), plans[0])
    : null;

  const specs = [
    cheapest ? { label: "Giá từ", value: cheapest.priceVndText || fmtUsd(cheapest.priceUsd), unit: `/ ${cheapest.durationDays} ngày` } : null,
    cheapest ? { label: "Credit nhận", value: cheapest.unlimitedCredit ? "Không giới hạn" : fmtUsd(cheapest.creditUsd), unit: "dùng chung mọi model" } : null,
    { label: "Danh mục", value: String(models.length), unit: "model lập trình" },
    { label: "Endpoint", value: "/v1", unit: "OpenAI · Claude" },
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
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-text-main md:text-6xl">
            {interpolate(copy.heroTitle, { plans: plans.length })}
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-text-muted md:text-lg">
            Một API dùng được với cả giao thức OpenAI và Claude. Credit trừ theo giá token của từng model, gói nào hết thì tự chuyển sang gói kế tiếp.
          </p>

          <ul className="mt-6 flex flex-wrap gap-2" aria-label="Giao thức hỗ trợ">
            {PROTOCOLS.map((protocol) => (
              <li
                key={protocol.id}
                className="inline-flex h-7 items-center gap-2 border border-border bg-surface px-2.5 font-mono text-xs text-text-muted"
              >
                <span className="font-semibold uppercase tracking-[0.08em] text-text-main">{protocol.label}</span>
                <span className="text-text-subtle">{protocol.path}</span>
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/account/plans"
              className="inline-flex h-12 items-center justify-center border border-text-main bg-text-main px-7 font-mono text-sm font-medium text-bg transition-colors duration-150 hover:bg-text-main/85"
            >
              {copy.heroPrimaryCta}
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-12 items-center justify-center gap-2 border border-border bg-surface px-7 font-mono text-sm font-medium text-text-main transition-colors duration-150 hover:bg-surface-2"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">description</span>
              {copy.heroSecondaryCta}
            </Link>
          </div>

          {baseUrl ? (
            <div className="mt-8 max-w-xl">
              <CopyBlock prompt="url" value={baseUrl} label="Sao chép base URL" />
            </div>
          ) : null}
        </div>

        <dl className="mt-16 grid grid-cols-2 gap-px border border-border bg-border lg:grid-cols-4">
          {specs.map((spec) => (
            <div key={spec.label} className="bg-surface p-5">
              <dt className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">{spec.label}</dt>
              <dd className="mt-3 flex flex-col gap-1">
                <span className="text-2xl font-semibold leading-none tracking-tight text-text-main">{spec.value}</span>
                <span className="font-mono text-xs text-text-muted">{spec.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

HeroSection.propTypes = {
  plans: PropTypes.array.isRequired,
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
  baseUrl: PropTypes.string,
};
