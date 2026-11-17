"use client";

import { fmtUsdNano } from "@/shared/utils/money";
import { timeOf } from "./StatusTag";
import { fmtLimitAmount, windowLabel } from "@/lib/billing/limits.js";

/**
 * One spending cap on a group of models inside a purchase's credit pool, as its own bar
 * (spec plan-queue-billing "A full model cap refuses that model only").
 *
 *   "Ảnh: tối đa $15 cho cả thời hạn gói      $3.20 / $15"
 *   "Ảnh: tối đa $15 mỗi 5 giờ                $15.00 / $15 · đã hết · mở lại 15:30"
 *
 * The bar is always drawn (a cap that has not been touched reads 0 / max) because the
 * customer should see the ceiling before reaching it. A full cap says so in words, not
 * only in colour: the rest of the pool still pays for the other models.
 */
export default function ModelCapMeter({ cap, className = "" }) {
  if (!cap) return null;

  const max = Math.max(0, Number(cap.maxNanoUsd) || 0);
  const spent = Math.max(0, Number(cap.spentNanoUsd) || 0);
  const full = cap.full === true;
  const span = cap.hours == null ? "cho cả thời hạn gói" : `mỗi ${windowLabel(cap.hours)}`;
  const pct = max > 0 ? Math.min(100, Math.round((spent / max) * 100)) : 0;
  const reopens = full && cap.resetAt ? `mở lại ${timeOf(cap.resetAt)}` : null;

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        <span className="text-text-muted">
          <span className="text-text-main">{cap.label}</span>: tối đa {fmtLimitAmount(max)} {span}
        </span>
        <span className="flex max-w-full flex-wrap justify-end gap-x-1 font-mono text-xs tabular-nums text-text-main">
          <span className="whitespace-nowrap">{fmtUsdNano(spent)}</span>
          <span className="whitespace-nowrap text-text-subtle">/ {fmtUsdNano(max)}</span>
          {full ? <span className="whitespace-nowrap text-text-subtle">· đã hết</span> : null}
          {reopens ? <span className="whitespace-nowrap text-text-subtle">· {reopens}</span> : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${cap.label}: đã dùng ${fmtUsdNano(spent)} trên ${fmtUsdNano(max)}`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(spent, max)}
        aria-valuetext={`${fmtUsdNano(spent)} trên ${fmtUsdNano(max)}${full ? ", đã hết hạn mức này" : ""}`}
        className="h-1 w-full bg-surface-2"
      >
        <div className={`h-1 ${full ? "bg-amber-500" : "bg-text-main"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
