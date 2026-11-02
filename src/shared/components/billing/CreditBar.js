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
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* Wraps instead of overflowing: label, figure and total each stay on one
          line, and the total drops under the figure when the card is narrow. */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <span className="whitespace-nowrap text-sm text-text-muted">{label}</span>
        <span className="flex max-w-full flex-wrap items-baseline justify-end gap-x-1.5 text-text-main">
          <span className="max-w-full text-2xl font-semibold leading-none tracking-tight tabular-nums break-words">
            {fmtUsdNano(remaining)}
          </span>
          <span className="whitespace-nowrap font-mono text-xs text-text-subtle">/ {fmtUsdNano(total)}</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}: còn ${fmtUsdNano(remaining)} trên ${fmtUsdNano(total)}`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={remaining}
        aria-valuetext={`${fmtUsdNano(remaining)} trên ${fmtUsdNano(total)}`}
        className="h-1.5 w-full bg-surface-2"
      >
        <div
          className={`h-1.5 ${low ? "bg-amber-500" : "bg-text-main"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
