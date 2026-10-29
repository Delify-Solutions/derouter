"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import SectionHeader from "./SectionHeader";
import CopyBlock from "@/app/account/components/CopyBlock";
import { fmtUsd } from "./salesData";

const DOCS_URL = "/docs";
const CHECKOUT_URL = "/register?next=/account/plans";

export default function GetStarted({ models, plans = [], text, baseUrl = "" }) {
  const exampleModel = models[0];
  // The address this page was served from (or the configured public URL), so the
  // sample can be pasted as-is. Only the key stays a placeholder.
  const base = baseUrl || "<base-url>/v1";

  const snippet = `curl ${base}/chat/completions -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"model":"${
    exampleModel?.id || "<model>"
  }","messages":[{"role":"user","content":"xin chào"}]}'`;

  const steps = [
    {
      number: "01",
      title: "Tạo tài khoản và chọn gói",
      body: plans.length
        ? `Đăng ký bằng email, xác nhận liên kết được gửi tới hộp thư, rồi chọn ${plans
            .map((p) => `${p.name} (${fmtUsd(p.priceUsd)}/tháng)`)
            .join(" hoặc ")} trong mục Gói của tôi.`
        : "Đăng ký bằng email và xác nhận liên kết được gửi tới hộp thư.",
    },
    {
      number: "02",
      title: "Tạo API key",
      body: "Vào mục API key trong khu vực tài khoản và tạo một key. Key chỉ hiển thị một lần, hãy lưu vào nơi client đọc được.",
    },
    {
      number: "03",
      title: "Trỏ client vào endpoint",
      body: `Đặt base URL là ${base}, dùng key làm bearer token. Trường model nhận đúng tên model trong danh mục ở trên.`,
    },
    {
      number: "04",
      title: "Theo dõi hạn mức",
      body: "Chạm trần một cửa sổ hạn mức sẽ nhận 429 kèm thời điểm mở lại; hết sạch credit sẽ nhận 402. Sổ cái trong tài khoản ghi từng khoản trừ.",
    },
  ];

  const facts = [
    { label: "Base URL", value: base },
    { label: "Xác thực", value: "Authorization: Bearer <API key>" },
    { label: "Liệt kê model", value: "GET /v1/models" },
    { label: "Wire format", value: "OpenAI · Claude · Responses" },
  ];

  return (
    <section id="get-started" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <SectionHeader eyebrow={text.getStartedEyebrow} title={text.getStartedTitle}>
          {text.getStartedSubtitle ? <p>{text.getStartedSubtitle}</p> : null}
        </SectionHeader>

        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <ol className="flex flex-col border border-border bg-surface">
              {steps.map((step, index) => (
                <li key={step.number} className={`flex gap-4 p-6 ${index > 0 ? "border-t border-border" : ""}`}>
                  <span className="mt-1 font-mono text-xs text-text-subtle">[{step.number}]</span>
                  <div>
                    <h3 className="text-base font-semibold text-text-main">{step.title}</h3>
                    <p className="mt-1.5 text-sm leading-6 text-text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href={CHECKOUT_URL}
                className="inline-flex h-11 flex-1 items-center justify-center border border-text-main bg-text-main px-5 font-mono text-sm font-medium text-bg transition-colors duration-150 hover:bg-text-main/85"
              >
                Chọn gói
              </Link>
              <Link
                href={DOCS_URL}
                className="inline-flex h-11 flex-1 items-center justify-center border border-border bg-surface px-5 font-mono text-sm font-medium text-text-main transition-colors duration-150 hover:bg-surface-2"
              >
                Đọc tài liệu
              </Link>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3 border border-border bg-surface p-6">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Request mẫu</p>
              <CopyBlock value={snippet} label="Sao chép request mẫu" />
              <p className="text-sm text-text-subtle">
                Thay <span className="font-mono">&lt;API_KEY&gt;</span> bằng key tạo ở mục API key trong tài khoản.
              </p>
            </div>

            <dl className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2">
              {facts.map((fact) => (
                <div key={fact.label} className="bg-surface p-5">
                  <dt className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">{fact.label}</dt>
                  <dd className="mt-2 break-all font-mono text-sm text-text-main">{fact.value}</dd>
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
  baseUrl: PropTypes.string,
  plans: PropTypes.array,
  models: PropTypes.array.isRequired,
  text: PropTypes.object.isRequired,
};
