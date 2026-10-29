"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { fmtRate, fmtUsd } from "./salesData";

// Bảng giá chi tiết: desktop là bảng, dưới md là card. Cả hai đọc cùng một
// nguồn (models từ registry + gói đang chọn), nên hai bố cục không thể lệch số.
export default function PricingSection({ plans, models, copy }) {
  // The plan switcher is driven by the plans the admin actually has on sale. A
  // hardcoded pair here would show limits for plans that do not exist, or hide
  // a plan that does.
  const [planId, setPlanId] = useState(plans[0]?.id ?? null);
  const plan = plans.find((item) => item.id === planId) ?? plans[0] ?? null;

  // Every plan spends its credit on any model the buyer's group allows, so the
  // table lists the whole catalogue rather than a per-plan subset.
  const rows = plan ? models : [];

  // The worked example comes from a real catalog row: the spec requires one
  // computed from a listed model's prices (20,000 input + 2,000 output tokens).
  // Falls back to null when the catalogue is empty, so the sentence is omitted
  // rather than printed with a made-up price.
  const exampleModel = models.find((model) => Number(model.input) > 0) ?? models[0] ?? null;
  const example = exampleModel
    ? {
        model: exampleModel.name || exampleModel.id,
        costUsd:
          (Number(exampleModel.input) || 0) * 20_000 / 1_000_000 +
          (Number(exampleModel.output) || 0) * 2_000 / 1_000_000,
      }
    : null;

  if (!plan) {
    return (
      <section id="pricing" className="border-b border-border">
        <div className="shell py-20">
          <p className="meta text-text-muted">{copy.pricingEyebrow}</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
            {copy.pricingTitle}
          </h2>
          <p className="mt-6 border border-border bg-surface p-6 text-sm text-text-muted">
            Chưa có gói nào được mở bán nên chưa có bảng giá.
          </p>
        </div>
      </section>
    );
  }

  const headings = ["Model", "Vào / 1M", "Ra / 1M", "Cached / 1M"];

  return (
    <section id="pricing" className="border-b border-border">
      <div className="shell py-20">
        <p className="meta text-text-muted">{copy.pricingEyebrow}</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          {copy.pricingTitle}
        </h2>
        {copy.pricingSubtitle ? (
          <p className="mt-3 max-w-2xl text-text-muted">{copy.pricingSubtitle}</p>
        ) : null}
        <p className="mt-3 max-w-2xl text-text-muted">
          Giá token tính bằng USD cho 1 triệu token. Credit của gói bị trừ theo đúng các
          mức giá này, nên model càng đắt thì credit hết càng nhanh.
        </p>
        {plan.limitsText?.length > 0 && (
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            {plan.name}: {plan.limitsText.join(" · ")}.
          </p>
        )}

        <div
          role="group"
          aria-label="Chọn gói để xem hạn mức"
          className="mt-8 inline-flex border border-border"
        >
          {plans.map((item) => {
            const active = item.id === planId;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => setPlanId(item.id)}
                className={`h-10 px-5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors duration-150 ${
                  active ? "bg-brand-500 text-white" : "bg-surface text-text-muted hover:text-text-main"
                }`}
              >
                {item.name} · {fmtUsd(item.priceUsd)}
              </button>
            );
          })}
        </div>

        {/* Desktop: bảng cuộn ngang thay vì bóp cột. */}
        <div className="mt-6 hidden overflow-x-auto border border-border md:block">
          <table className="w-full min-w-[880px] border-collapse text-left">
            <caption className="sr-only">
              Giá token của từng model, áp dụng cho credit của gói {plan.name}
            </caption>
            <thead>
              <tr className="bg-surface-2">
                {headings.map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="border-b border-border px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-text-muted"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((model) => (
                <tr key={model.id} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-4 py-3 font-normal">
                    <span className="block text-sm font-semibold text-text-main">{model.name}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-text-subtle">{model.id}</span>
                  </th>
                  <td className="px-4 py-3 font-mono text-sm text-text-main">{fmtRate(model.input)}</td>
                  <td className="px-4 py-3 font-mono text-sm text-text-main">{fmtRate(model.output)}</td>
                  <td className="px-4 py-3 font-mono text-sm text-text-muted">{fmtRate(model.cached)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: một card cho mỗi model, cùng dữ liệu, không cuộn ngang. */}
        <ul className="mt-6 flex flex-col gap-3 md:hidden">
          {rows.map((model) => (
            <li key={model.id} className="border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-text-main">{model.name}</h3>
                <p className="mt-0.5 break-all font-mono text-[11px] text-text-subtle">{model.id}</p>
              </div>

              <dl className="grid grid-cols-3 gap-px bg-border">
                <div className="bg-surface px-3 py-2.5">
                  <dt className="meta text-text-subtle">Vào / 1M</dt>
                  <dd className="mt-1 font-mono text-[13px] text-text-main">{fmtRate(model.input)}</dd>
                </div>
                <div className="bg-surface px-3 py-2.5">
                  <dt className="meta text-text-subtle">Ra / 1M</dt>
                  <dd className="mt-1 font-mono text-[13px] text-text-main">{fmtRate(model.output)}</dd>
                </div>
                <div className="bg-surface px-3 py-2.5">
                  <dt className="meta text-text-subtle">Cached</dt>
                  <dd className="mt-1 font-mono text-[13px] text-text-muted">{fmtRate(model.cached)}</dd>
                </div>
              </dl>

            </li>
          ))}
        </ul>

        {example && (
          <p className="mt-4 max-w-3xl font-mono text-[11px] text-text-subtle">
            Ví dụ với {example.model}: 20.000 token vào và 2.000 token ra tốn{" "}
            {fmtUsd(example.costUsd)} credit, vì giá tính trên từng 1 triệu token.
          </p>
        )}
      </div>
    </section>
  );
}

PricingSection.propTypes = {
  plans: PropTypes.array.isRequired,
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
