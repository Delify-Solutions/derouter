"use client";

import PropTypes from "prop-types";
import { termLabel } from "@/lib/billing/terms.js";

/**
 * Pick how many periods to buy: "1 tháng · 3 tháng −5% · 12 tháng −15%"
 * (spec plan-terms). A native radio group styled as square segments, so keyboard
 * and screen readers get the standard behaviour; the discount is written out, never
 * shown by colour alone (openspec/ui-dna.md).
 */
export default function TermPicker({ name, durationDays, terms, value, onChange, className = "" }) {
  if (!Array.isArray(terms) || terms.length < 2) return null;
  return (
    <fieldset className={`min-w-0 ${className}`}>
      <legend className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Kỳ hạn</legend>
      <div className="flex flex-wrap gap-px border border-border bg-border">
        {terms.map((term) => {
          const id = `${name}-${term.periods}`;
          const checked = term.periods === value;
          return (
            <label
              key={term.periods}
              htmlFor={id}
              className={`flex min-h-11 min-w-[5.5rem] flex-1 cursor-pointer flex-col items-center justify-center px-2 py-1.5 text-center transition-colors duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-text-main ${
                checked ? "bg-text-main text-bg" : "bg-surface text-text-main hover:bg-surface-2"
              }`}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={term.periods}
                checked={checked}
                onChange={() => onChange(term.periods)}
                className="sr-only"
              />
              <span className="text-sm font-medium whitespace-nowrap">{termLabel(durationDays, term.periods)}</span>
              {term.discountPercent > 0 && (
                <span className={`font-mono text-[11px] ${checked ? "text-bg" : "text-text-muted"}`}>
                  −{term.discountPercent}%
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

TermPicker.propTypes = {
  name: PropTypes.string.isRequired,
  durationDays: PropTypes.number,
  terms: PropTypes.arrayOf(PropTypes.shape({ periods: PropTypes.number, discountPercent: PropTypes.number })).isRequired,
  value: PropTypes.number,
  onChange: PropTypes.func.isRequired,
  className: PropTypes.string,
};
