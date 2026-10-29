"use client";

import { fmtUsdNano } from "@/shared/utils/money";
import { timeOf } from "./StatusTag";

/**
 * One limit of one purchase, as a labelled meter.
 *
 * Copy follows the spec exactly:
 *   open    → "5 giờ: $12.40 / $20 · reset 15:30"
 *   unopened/closed → "5 giờ: chưa dùng"
 *
 * The window length and maximum come from the purchase's snapshot, so what a
 * customer sees is what was sold to them, not the plan's current template.
 */
export default function LimitMeter({ window: limit, className = "" }) {
  if (!limit) return null;

  const label = limit.label || `${limit.hours} giờ`;
  const max = Math.max(0, Number(limit.maxNanoUsd) || 0);
  const spent = Math.max(0, Number(limit.spentNanoUsd) || 0);
  const open = limit.open === true;
  const full = limit.full === true;

  if (!open) {
    return (
      <div className={`flex items-baseline justify-between gap-3 font-mono text-[12px] ${className}`}>
        <span className="text-text-muted">{label}</span>
        <span className="text-text-subtle">chưa dùng</span>
      </div>
    );
  }

  const pct = max > 0 ? Math.min(100, Math.round((spent / max) * 100)) : 0;

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-baseline justify-between gap-3 font-mono text-[12px]">
        <span className="text-text-muted">{label}</span>
        <span className="text-text-main">
          {fmtUsdNano(spent)}
          <span className="text-text-subtle"> / {fmtUsdNano(max)}</span>
          {limit.resetAt ? <span className="text-text-subtle"> · reset {timeOf(limit.resetAt)}</span> : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}: đã dùng ${fmtUsdNano(spent)} trên ${fmtUsdNano(max)}${
          limit.resetAt ? `, reset lúc ${timeOf(limit.resetAt)}` : ""
        }`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={spent}
        aria-valuetext={`${fmtUsdNano(spent)} trên ${fmtUsdNano(max)}${full ? ", đã đầy" : ""}`}
        className="h-1 w-full bg-border"
      >
        <div className={`h-1 ${full ? "bg-amber-500" : "bg-brand-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
