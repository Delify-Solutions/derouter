import Link from "next/link";
import PropTypes from "prop-types";
import PipelineDiagram from "./PipelineDiagram";

/**
 * Hero for /doanh-nghiep (spec business-landing "Page structure"): heading, the
 * three promises in one paragraph, two CTAs and the animated pipeline.
 *
 * "Tạo chatbot" is session-aware: a visitor with no customer session registers
 * first, and comes back to /account/business afterwards.
 */
export default function BusinessHero({ signedIn = false }) {
  const ctaHref = signedIn ? "/account/business" : "/register?next=/account/business";

  return (
    <section className="border-b border-border">
      <div className="shell grid grid-cols-1 items-start gap-12 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:py-24">
        <div>
          <p className="flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            <span className="text-text-subtle" aria-hidden="true">{"//"}</span>
            AI doanh nghiệp
            <span className="h-px w-16 bg-border" aria-hidden="true" />
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight text-text-main md:text-5xl">
            AI chatbot cho doanh nghiệp
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-text-muted md:text-lg">
            Chatbot trả lời khách hàng của bạn bằng chính tài liệu công ty, chỉ trong phạm vi doanh nghiệp bạn
            mô tả, và không bao giờ nói sai về chủ quyền Việt Nam hay đưa nội dung chính trị.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href={ctaHref}
              className="inline-flex h-12 items-center justify-center border border-text-main bg-text-main px-7 font-mono text-sm font-medium text-bg transition-colors duration-150 hover:bg-text-main/85"
            >
              Tạo chatbot
            </Link>
            <a
              href="#plans"
              className="inline-flex h-12 items-center justify-center border border-border bg-surface px-7 font-mono text-sm font-medium text-text-main transition-colors duration-150 hover:bg-surface-2"
            >
              Xem bảng giá
            </a>
          </div>
        </div>

        <div className="w-full border border-border bg-surface p-6">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Đường đi của một câu trả lời
          </p>
          <PipelineDiagram className="mt-4" />
        </div>
      </div>
    </section>
  );
}

BusinessHero.propTypes = {
  signedIn: PropTypes.bool,
};
