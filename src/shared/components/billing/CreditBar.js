"use client";

import { fmtUsdNano } from "@/shared/utils/money";

/**
 * Remaining credit of one purchase, as a labelled progress bar.
 *
 * `role="progressbar"` with real values so a screen reader reads "75% used" rather
 * than a bare colour; the numeric line beside it carries the same information in
 * text, and the fill colour is only an accent (ui-dna: status never colour-only).
 */
export default function CreditBar({ totalNanoUsd = 0, remainingNanoUsd = 0, label = "Credit", className = "" }) {
  const total = Math.max(0, Number(totalNanoUsd) || 0);
  const remaining = Math.max(0, Math.min(Number(remainingNanoUsd) || 0, total));
  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const low = total > 0 && pct <= 10;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[12px]">
        <span className="text-text-muted">{label}</span>
        <span className="text-text-main">
          {fmtUsdNano(remaining)}
          <span className="text-text-subtle"> / {fmtUsdNano(total)}</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}: còn ${fmtUsdNano(remaining)} trên ${fmtUsdNano(total)}`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={remaining}
        aria-valuetext={`${fmtUsdNano(remaining)} trên ${fmtUsdNano(total)}`}
        className="h-1 w-full bg-border"
      >
        <div
          className={`h-1 ${low ? "bg-amber-500" : "bg-brand-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
