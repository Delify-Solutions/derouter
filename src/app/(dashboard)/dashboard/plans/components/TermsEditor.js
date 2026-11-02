"use client";

import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { fmtUsdNano, usdToNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import {
  MAX_TERM_DISCOUNT_PERCENT,
  MAX_TERM_OPTIONS,
  MAX_TERM_PERIODS,
  termLabel,
  termPrice,
  validateTermOptions,
} from "@/lib/billing/terms.js";

const PRESETS = [3, 6, 12];

/** Stored terms → editable rows (strings while typing). */
export function termsToDraft(terms) {
  return (Array.isArray(terms) ? terms : []).map((term) => ({
    periods: String(term.periods),
    discountPercent: term.discountPercent ? String(term.discountPercent) : "",
  }));
}

/** Editable rows → the API payload. Empty discount = 0. */
export function draftToTerms(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    periods: Number(row.periods),
    discountPercent: String(row.discountPercent ?? "").trim() === "" ? 0 : Number(row.discountPercent),
  }));
}

/** The same message the API would answer, or null. */
export function draftTermsError(rows, { allowCustomAmount = false } = {}) {
  return validateTermOptions(draftToTerms(rows), { allowCustomAmount });
}

/**
 * Longer terms a plan sells besides the single period (spec plan-terms): the number
 * of periods and the discount for each, with the price the customer will see. One
 * period is always sold and needs no row.
 */
export default function TermsEditor({ rows, onChange, priceUsd, priceVnd, durationDays, error = null }) {
  const days = Number(durationDays) || 0;
  const plan = {
    priceNanoUsd: usdToNano(Number(priceUsd) || 0),
    priceVnd: Number(priceVnd) > 0 ? Number(priceVnd) : null,
  };

  const update = (index, field, value) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value.replace(/\D/g, "") } : row)));
  };
  const remove = (index) => onChange(rows.filter((_, i) => i !== index));
  const add = (periods = "") => onChange([...rows, { periods: periods === "" ? "" : String(periods), discountPercent: "" }]);
  const used = new Set(rows.map((row) => Number(row.periods)));
  const presets = PRESETS.filter((periods) => !used.has(periods));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-text-main">Kỳ hạn dài</p>
        <p className="text-xs text-text-muted">
          Gói luôn bán 1 kỳ ({days ? termLabel(days, 1) : "—"}). Thêm kỳ dài để khách mua nhiều kỳ một lần: mỗi kỳ có
          credit và hạn mức riêng, kỳ sau bắt đầu khi kỳ trước hết hạn. Giá = giá 1 kỳ × số kỳ × (100% − % giảm).
        </p>
      </div>

      {rows.length > 0 && (
        <ul className="flex flex-col border border-border">
          {rows.map((row, index) => {
            const periods = Number(row.periods);
            const discount = String(row.discountPercent ?? "").trim() === "" ? 0 : Number(row.discountPercent);
            const valid = Number.isInteger(periods) && periods >= 2 && periods <= MAX_TERM_PERIODS
              && Number.isInteger(discount) && discount >= 0 && discount <= MAX_TERM_DISCOUNT_PERCENT;
            const price = valid ? termPrice(plan, { periods, discountPercent: discount }) : null;
            return (
              <li
                key={index}
                className={`flex flex-wrap items-end gap-3 px-3 py-3 ${index > 0 ? "border-t border-border" : ""}`}
              >
                <label className="flex w-24 flex-col gap-1 text-xs text-text-muted">
                  Số kỳ
                  <input
                    value={row.periods}
                    onChange={(event) => update(index, "periods", event.target.value)}
                    inputMode="numeric"
                    placeholder="3"
                    aria-label={`Số kỳ của kỳ hạn ${index + 1}`}
                    className="h-9 w-full border border-border bg-surface px-2 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                  />
                </label>
                <label className="flex w-24 flex-col gap-1 text-xs text-text-muted">
                  % giảm
                  <input
                    value={row.discountPercent}
                    onChange={(event) => update(index, "discountPercent", event.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                    aria-label={`Phần trăm giảm của kỳ hạn ${index + 1}`}
                    className="h-9 w-full border border-border bg-surface px-2 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                  />
                </label>
                <p className="min-w-0 flex-1 basis-40 pb-2 font-mono text-xs text-text-muted tabular-nums">
                  {price
                    ? `${termLabel(days, periods)} · ${[
                        price.priceVnd ? formatVnd(price.priceVnd) : null,
                        price.priceNanoUsd > 0 ? fmtUsdNano(price.priceNanoUsd) : null,
                      ].filter(Boolean).join(" / ") || "Miễn phí"}`
                    : "—"}
                </p>
                <Button size="sm" variant="ghost" onClick={() => remove(index)} aria-label={`Xóa kỳ hạn ${index + 1}`}>
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length < MAX_TERM_OPTIONS && (
        <div className="flex flex-wrap gap-2">
          {presets.map((periods) => (
            <Button key={periods} size="sm" variant="secondary" onClick={() => add(periods)}>
              + {days ? termLabel(days, periods) : `${periods} kỳ`}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => add()}>
            + Kỳ khác
          </Button>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-danger" role="alert">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}
    </div>
  );
}

TermsEditor.propTypes = {
  rows: PropTypes.arrayOf(PropTypes.shape({ periods: PropTypes.string, discountPercent: PropTypes.string })).isRequired,
  onChange: PropTypes.func.isRequired,
  priceUsd: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  priceVnd: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  durationDays: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  error: PropTypes.string,
};
