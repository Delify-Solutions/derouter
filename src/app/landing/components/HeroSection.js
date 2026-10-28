import Link from "next/link";
import PropTypes from "prop-types";
import { PLANS, USAGE_WINDOWS, fmtUsd } from "./salesData";

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";
const SIGNUP_URL = "/register?next=/account/plans";

// Server component: không có state, không cần xuống client. Mọi con số đọc từ
// salesData.js và danh mục model nhận qua props, không viết tay trong JSX.
export default function HeroSection({ models }) {
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
          <p className="meta text-text-muted">Thuê bao model lập trình</p>

          <h1 className="mt-4 text-4xl font-semibold leading-[1.15] tracking-tight md:text-6xl">
            Go và Go Plus: một thuê bao, mọi model lập trình
          </h1>

          <p className="mt-6 max-w-2xl text-base text-text-muted md:text-lg">
            Trả một khoản cố định mỗi tháng để dùng các model lập trình phổ biến qua một endpoint
            tương thích OpenAI. Hạn mức được chia riêng cho từng model và kiểm tra theo ba cửa sổ:
            5 giờ, 1 tuần và 1 tháng.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href={SIGNUP_URL}
              className="inline-flex h-12 items-center justify-center border border-brand-500 bg-brand-500 px-7 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600"
            >
              Mua gói
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center gap-2 border border-border px-7 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-text-main transition-colors duration-150 hover:bg-surface-2"
            >
              <span className="material-symbols-outlined text-[18px]">description</span>
              Đọc tài liệu
            </a>
          </div>
        </div>

        {/* gap-px + bg-border: mỗi ô chia sẻ đúng một đường kẻ ở mọi breakpoint. */}
        <dl className="mt-12 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {specs.map((spec) => (
            <div key={spec.label} className="bg-bg px-5 py-4">
              <dt className="meta text-text-muted">{spec.label}</dt>
              <dd className="mt-1 break-words font-mono text-sm text-text-main">{spec.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

HeroSection.propTypes = {
  models: PropTypes.array.isRequired,
};
