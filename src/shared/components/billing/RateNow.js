"use client";

import PropTypes from "prop-types";

const num = (value) => Number(value || 0).toLocaleString("vi-VN");

/**
 * The request/token rate the customer is held to right now: last-60-second usage
 * against the RPM/TPM of the plan that is paying (spec plan-templates "Plan request
 * and token rates"). Counted over every key of the account, exactly as enforcement
 * counts it, so the page and the 429 agree.
 */
export default function RateNow({ rate, className = "" }) {
  if (!rate) return null;
  const rows = [
    ["RPM", rate.requests, rate.rpm, "request"],
    ["TPM", rate.tokens, rate.tpm, "token"],
  ];
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Tốc độ (60 giây qua)</p>
      {rows.map(([label, used, max, unit]) => {
        const pct = max ? Math.min(100, Math.round((Number(used || 0) / max) * 100)) : 0;
        const full = max != null && Number(used || 0) >= max;
        return (
          <div key={label} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="text-text-muted">{label}</span>
              <span className="font-mono text-sm text-text-main tabular-nums">
                {num(used)}
                <span className="text-text-subtle"> / {max ? `${num(max)} ${unit}` : "không giới hạn"}</span>
                {full ? <span className="text-amber-700 dark:text-amber-400"> · đã chạm</span> : null}
              </span>
            </div>
            {max ? (
              <div
                role="progressbar"
                aria-label={`${label}: ${num(used)} trên ${num(max)} ${unit} mỗi phút`}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={Math.min(Number(used || 0), max)}
                className="h-1 w-full bg-surface-2"
              >
                <div className={`h-1 ${full ? "bg-amber-500" : "bg-text-main"}`} style={{ width: `${pct}%` }} />
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="text-xs text-text-muted">
        {rate.planName
          ? `Theo gói đang trả: ${rate.planName}. Tính chung mọi API key của tài khoản.`
          : "Chưa có gói nào đang trả nên không áp RPM/TPM."}
      </p>
    </div>
  );
}

RateNow.propTypes = {
  rate: PropTypes.shape({
    requests: PropTypes.number,
    tokens: PropTypes.number,
    rpm: PropTypes.number,
    tpm: PropTypes.number,
    planName: PropTypes.string,
  }),
  className: PropTypes.string,
};
