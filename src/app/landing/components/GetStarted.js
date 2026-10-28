"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { fmtUsd } from "./salesData";

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";
const CHECKOUT_URL = "/register?next=/account/plans";

export default function GetStarted({ models, plans = [], text }) {
  const { copied, copy } = useCopyToClipboard();
  const exampleModel = models[0];

  const snippet = [
    "curl $DEROUTER_BASE/v1/chat/completions \\",
    '  -H "Authorization: Bearer $DEROUTER_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${exampleModel?.id || "<model>"}","messages":[{"role":"user","content":"xin chào"}]}'`,
  ].join("\n");

  const steps = [
    {
      number: "01",
      title: "Tạo tài khoản và chọn gói",
      body: plans.length
        ? `Đăng ký bằng email, xác nhận liên kết được gửi tới hộp thư, rồi chọn ${plans
            .map((p) => `${p.name} (${fmtUsd(p.priceUsd)}/tháng)`)
            .join(" hoặc ")} trong mục Plans.`
        : "Đăng ký bằng email và xác nhận liên kết được gửi tới hộp thư.",
    },
    {
      number: "02",
      title: "Tạo API Key",
      body: "Vào mục API keys trong khu vực tài khoản và tạo một key. Key chỉ hiển thị một lần, hãy lưu vào nơi client đọc được.",
    },
    {
      number: "03",
      title: "Trỏ client vào endpoint",
      body: "Đặt base URL là origin của bạn cộng /v1, dùng key làm bearer token. Trường model nhận đúng model id trong danh mục ở trên.",
    },
    {
      number: "04",
      title: "Theo dõi hạn mức",
      body: "Mỗi phản hồi kèm header cho biết hạn mức còn lại của model và cửa sổ đang chặn. Chạm trần một cửa sổ sẽ nhận 429 kèm thời điểm nạp lại.",
    },
  ];

  const facts = [
    { label: "Base URL", value: "<origin>/v1" },
    { label: "Header xác thực", value: "Authorization: Bearer <API Key>" },
    { label: "Liệt kê model", value: "GET /v1/models" },
    { label: "Wire format", value: "OpenAI · Claude · Responses" },
  ];

  return (
    <section id="get-started" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <p className="meta text-text-muted">{text.getStartedEyebrow}</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          {text.getStartedTitle}
        </h2>
        {text.getStartedSubtitle ? (
          <p className="mt-3 max-w-2xl text-text-muted">{text.getStartedSubtitle}</p>
        ) : null}

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
          <ol className="flex flex-col border border-border bg-surface">
            {steps.map((step, index) => (
              <li
                key={step.number}
                className={`flex gap-4 p-5 ${index > 0 ? "border-t border-border" : ""}`}
              >
                <span className="mt-0.5 font-mono text-[12px] text-text-subtle">{step.number}</span>
                <div>
                  <h3 className="text-base font-semibold">{step.title}</h3>
                  <p className="mt-1.5 text-sm text-text-muted">{step.body}</p>
                </div>
              </li>
            ))}
            <div className="flex flex-col gap-2 border-t border-border p-5 sm:flex-row">
              <Link
                href={CHECKOUT_URL}
                className="inline-flex h-10 flex-1 items-center justify-center border border-brand-500 bg-brand-500 px-5 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600"
              >
                Chọn gói
              </Link>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 flex-1 items-center justify-center border border-border px-5 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-text-main transition-colors duration-150 hover:bg-surface-2"
              >
                Đọc tài liệu
              </a>
            </div>
          </ol>

          <div className="flex flex-col gap-6">
            <div className="border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="meta text-text-muted">Request mẫu</span>
                <button
                  type="button"
                  onClick={() => copy(snippet, "snippet")}
                  className="inline-flex h-7 items-center gap-1.5 border border-border px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {copied === "snippet" ? "check" : "content_copy"}
                  </span>
                  {copied === "snippet" ? "Đã chép" : "Chép"}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-text-main">
                {snippet}
              </pre>
              <p className="border-t border-border px-4 py-3 font-mono text-[11px] text-text-subtle">
                DEROUTER_BASE là origin triển khai của bạn, ví dụ https://proxy.example.com
              </p>
            </div>

            <dl className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2">
              {facts.map((fact) => (
                <div key={fact.label} className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">{fact.label}</dt>
                  <dd className="mt-1 break-all font-mono text-[12px] text-text-main">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

GetStarted.propTypes = {
  plans: PropTypes.array,
  models: PropTypes.array.isRequired,
  text: PropTypes.object.isRequired,
};
