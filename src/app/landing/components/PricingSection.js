"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import SectionHeader from "./SectionHeader";
import { fmtUsd as fmtCost } from "@/shared/utils/money";
import { fmtRate, fmtUsd } from "./salesData";
import { percentLabel, dateTimeLabel } from "@/shared/utils/discountFormat";

// Rows revealed per click. The catalogue can be hundreds of models long, so the
// table starts short and the reader searches or asks for more.
const PAGE = 25;

// Giá hiệu lực của một model cho gói đang chọn: giá giảm (nếu có đợt giảm giá
// đang chạy) kèm giá niêm yết để gạch ngang.
function effectiveRates(model, planId) {
  const discount = (planId && model.planDiscounts?.[planId]) || model.discount || null;
  return discount
    ? { input: discount.input, output: discount.output, cached: discount.cached, discount }
    : { input: model.input, output: model.output, cached: model.cached, discount: null };
}

// Một ô giá: giá giảm đậm, giá niêm yết gạch ngang ngay dưới.
function RateCell({ list, shown, discounted, className }) {
  if (!discounted || !(Number(list) > 0)) return <span className={className}>{fmtRate(shown)}</span>;
  return (
    <span className={className}>
      {fmtRate(shown)}
      <span className="block text-xs text-text-subtle line-through" title="Giá niêm yết">{fmtRate(list)}</span>
    </span>
  );
}

function DiscountTag({ discount }) {
  if (!discount) return null;
  return (
    <span className="mt-1 inline-block border border-brand-500/30 bg-brand-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-main">
      Giảm {percentLabel(discount.percentBp)}
      {discount.endsAt ? ` · đến ${dateTimeLabel(discount.endsAt)}` : ""}
    </span>
  );
}

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
  // A time-limited discount lowers the rates the credit is actually charged at,
  // so the example uses the effective (discounted) rates of the selected plan.
  const exampleRates = exampleModel ? effectiveRates(exampleModel, plan?.id) : null;
  const example = exampleModel
    ? {
        model: exampleModel.name || exampleModel.id,
        discountBp: exampleRates.discount?.percentBp ?? 0,
        costUsd:
          (Number(exampleRates.input) || 0) * 20_000 / 1_000_000 +
          (Number(exampleRates.output) || 0) * 2_000 / 1_000_000,
      }
    : null;

  if (!plan) {
    return (
      <section id="pricing" className="border-b border-border">
        <div className="shell py-20">
          <SectionHeader eyebrow={copy.pricingEyebrow} title={copy.pricingTitle} />
          <p className="mt-8 border border-dashed border-border p-8 text-sm text-text-muted">
            Bảng giá sẽ hiện khi có gói mở bán.
          </p>
        </div>
      </section>
    );
  }

  const headings = ["Model", "Input / 1M", "Output / 1M", "Cached / 1M"];
  const field = "h-10 border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none";

  return (
    <section id="pricing" className="border-b border-border">
      <div className="shell py-20">
        <SectionHeader eyebrow={copy.pricingEyebrow} title={copy.pricingTitle}>
          {copy.pricingSubtitle ? <p>{copy.pricingSubtitle}</p> : null}
          <p>
            Giá tính bằng USD cho mỗi 1 triệu token. Credit bị trừ đúng theo các mức giá này, nên model càng đắt thì credit hết càng nhanh.
          </p>
          {plan.limitsText?.length > 0 && (
            <p className="text-sm">
              Gói {plan.name}: {plan.limitsText.join(" · ")}.
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
            {query.trim() ? `Không có model nào khớp “${query}”.` : "Chưa có model nào trong danh mục."}
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
                  {rows.map((model) => {
                    const eff = effectiveRates(model, plan.id);
                    return (
                      <tr key={model.id} className="border-b border-border last:border-b-0">
                        <th scope="row" className="px-5 py-3 font-normal">
                          <span className="block text-sm font-semibold text-text-main">{model.name}</span>
                          <span className="mt-0.5 block font-mono text-xs text-text-subtle">{model.id}</span>
                          <DiscountTag discount={eff.discount} />
                        </th>
                        <td className="px-5 py-3 font-mono text-sm text-text-main">
                          <RateCell list={model.input} shown={eff.input} discounted={!!eff.discount} />
                        </td>
                        <td className="px-5 py-3 font-mono text-sm text-text-main">
                          <RateCell list={model.output} shown={eff.output} discounted={!!eff.discount} />
                        </td>
                        <td className="px-5 py-3 font-mono text-sm text-text-muted">
                          <RateCell list={model.cached} shown={eff.cached} discounted={!!eff.discount} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: một card cho mỗi model, cùng dữ liệu, không cuộn ngang. */}
            <ul className="mt-6 flex flex-col gap-3 md:hidden">
              {rows.map((model) => {
                const eff = effectiveRates(model, plan.id);
                return (
                  <li key={model.id} className="border border-border bg-surface">
                    <div className="border-b border-border px-4 py-3">
                      <h3 className="text-sm font-semibold text-text-main">{model.name}</h3>
                      <p className="mt-0.5 break-all font-mono text-xs text-text-subtle">{model.id}</p>
                      <DiscountTag discount={eff.discount} />
                    </div>
                    <dl className="grid grid-cols-3 gap-px bg-border">
                      {[
                        ["Input / 1M", model.input, eff.input, "text-text-main"],
                        ["Output / 1M", model.output, eff.output, "text-text-main"],
                        ["Cached / 1M", model.cached, eff.cached, "text-text-muted"],
                      ].map(([label, list, shown, tone]) => (
                        <div key={label} className="bg-surface px-3 py-3">
                          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-subtle">{label}</dt>
                          <dd className={`mt-1 font-mono text-sm ${tone}`}>
                            <RateCell list={list} shown={shown} discounted={!!eff.discount} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                );
              })}
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
              Xem thêm {Math.min(PAGE, matches.length - rows.length)}
            </button>
          ) : null}
        </div>

        {example && (
          <p className="mt-6 max-w-3xl text-sm text-text-subtle">
            Ví dụ với {example.model}: một request 20.000 token input và 2.000 token output trừ {fmtCost(example.costUsd)} credit{example.discountBp > 0 ? ` (đã tính mức giảm ${percentLabel(example.discountBp)} đang áp dụng)` : ""}.
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
