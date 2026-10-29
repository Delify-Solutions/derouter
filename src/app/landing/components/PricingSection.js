"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import SectionHeader from "./SectionHeader";
import { fmtRate, fmtUsd } from "./salesData";

// Rows revealed per click. The catalogue can be hundreds of models long, so the
// table starts short and the reader searches or asks for more.
const PAGE = 25;

// Bảng giá chi tiết: desktop là bảng, dưới md là card. Cả hai đọc cùng một
// nguồn (models từ registry + gói đang chọn), nên hai bố cục không thể lệch số.
export default function PricingSection({ plans, models, copy }) {
  // The plan switcher is driven by the plans the admin actually has on sale. A
  // hardcoded pair here would show limits for plans that do not exist, or hide
  // a plan that does.
  const [planId, setPlanId] = useState(plans[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const plan = plans.find((item) => item.id === planId) ?? plans[0] ?? null;

  // Every plan spends its credit on any model the buyer's group allows, so the
  // table lists the whole catalogue rather than a per-plan subset.
  const matches = useMemo(() => {
    if (!plan) return [];
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(q));
  }, [plan, models, query]);
  const rows = matches.slice(0, shown);

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
          <SectionHeader eyebrow={copy.pricingEyebrow} title={copy.pricingTitle} />
          <p className="mt-8 border border-dashed border-border p-8 text-sm text-text-muted">
            Chưa có gói nào được mở bán nên chưa có bảng giá.
          </p>
        </div>
      </section>
    );
  }

  const headings = ["Model", "Vào / 1M", "Ra / 1M", "Cached / 1M"];
  const field = "h-10 border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none";

  return (
    <section id="pricing" className="border-b border-border">
      <div className="shell py-20">
        <SectionHeader eyebrow={copy.pricingEyebrow} title={copy.pricingTitle}>
          {copy.pricingSubtitle ? <p>{copy.pricingSubtitle}</p> : null}
          <p>
            Giá token tính bằng USD cho 1 triệu token. Credit của gói bị trừ đúng theo các mức giá này, nên model càng đắt
            thì credit hết càng nhanh.
          </p>
          {plan.limitsText?.length > 0 && (
            <p className="text-sm">
              {plan.name}: {plan.limitsText.join(" · ")}.
            </p>
          )}
        </SectionHeader>

        <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div role="group" aria-label="Chọn gói để xem hạn mức" className="inline-flex flex-wrap border border-border">
            {plans.map((item, index) => {
              const active = item.id === planId;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPlanId(item.id)}
                  className={`h-10 px-5 font-mono text-xs font-medium transition-colors duration-150 ${
                    index > 0 ? "border-l border-border" : ""
                  } ${active ? "bg-text-main text-bg" : "bg-surface text-text-muted hover:text-text-main"}`}
                >
                  {item.name} · {fmtUsd(item.priceUsd)}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="pricing-search" className="sr-only">Tìm model</label>
            <input
              id="pricing-search"
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setShown(PAGE); }}
              placeholder={`Tìm trong ${models.length} model`}
              className={`${field} w-full sm:w-72`}
            />
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="mt-6 border border-dashed border-border p-8 text-center text-sm text-text-muted">
            Không có model nào khớp “{query}”.
          </p>
        ) : (
          <>
            {/* Desktop: bảng cuộn ngang thay vì bóp cột. */}
            <div className="mt-6 hidden overflow-x-auto border border-border bg-surface md:block">
              <table className="w-full min-w-[880px] border-collapse text-left">
                <caption className="sr-only">Giá token của từng model, áp dụng cho credit của gói {plan.name}</caption>
                <thead>
                  <tr className="bg-surface-2">
                    {headings.map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="border-b border-border px-5 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((model) => (
                    <tr key={model.id} className="border-b border-border last:border-b-0">
                      <th scope="row" className="px-5 py-3 font-normal">
                        <span className="block text-sm font-semibold text-text-main">{model.name}</span>
                        <span className="mt-0.5 block font-mono text-xs text-text-subtle">{model.id}</span>
                      </th>
                      <td className="px-5 py-3 font-mono text-sm text-text-main">{fmtRate(model.input)}</td>
                      <td className="px-5 py-3 font-mono text-sm text-text-main">{fmtRate(model.output)}</td>
                      <td className="px-5 py-3 font-mono text-sm text-text-muted">{fmtRate(model.cached)}</td>
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
                    <p className="mt-0.5 break-all font-mono text-xs text-text-subtle">{model.id}</p>
                  </div>
                  <dl className="grid grid-cols-3 gap-px bg-border">
                    {[
                      ["Vào / 1M", model.input, "text-text-main"],
                      ["Ra / 1M", model.output, "text-text-main"],
                      ["Cached", model.cached, "text-text-muted"],
                    ].map(([label, value, tone]) => (
                      <div key={label} className="bg-surface px-3 py-3">
                        <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-subtle">{label}</dt>
                        <dd className={`mt-1 font-mono text-sm ${tone}`}>{fmtRate(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs text-text-subtle">
            Hiển thị {rows.length} / {matches.length} model
          </p>
          {rows.length < matches.length ? (
            <button
              type="button"
              onClick={() => setShown((count) => count + PAGE)}
              className="h-9 border border-border bg-surface px-4 font-mono text-xs font-medium text-text-main transition-colors duration-150 hover:bg-surface-2"
            >
              Hiện thêm {Math.min(PAGE, matches.length - rows.length)}
            </button>
          ) : null}
        </div>

        {example && (
          <p className="mt-6 max-w-3xl text-sm text-text-subtle">
            Ví dụ với {example.model}: 20.000 token vào và 2.000 token ra tốn {fmtUsd(example.costUsd)} credit, vì giá tính
            trên từng 1 triệu token.
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
