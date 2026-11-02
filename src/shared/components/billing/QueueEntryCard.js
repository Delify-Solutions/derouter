"use client";

import PropTypes from "prop-types";
import CreditBar from "./CreditBar";
import { UNLIMITED_CREDIT_LABEL } from "@/shared/utils/money";
import LimitMeter from "./LimitMeter";
import StatusTag, { dateTimeOf, spanText } from "./StatusTag";

// Source labels (spec customer-portal "Plan queue page"). A customer asks "where
// did this plan come from?" — the answer changes what they expect: a purchase can
// be refunded, a gift cannot.
const SOURCE_LABEL = {
  purchase: "Mua",
  gift: "Tặng",
  admin: "Admin",
  refund: "Hoàn tiền",
};

/**
 * One card in the plan queue.
 *
 * Presentational: it renders what the API sent (credit, expiry, every limit with
 * its window state, the server-chosen status) and offers the actions it is given.
 * Both `/account/plans` and the admin user `Gói` tab render this component, so the
 * two screens stay identical.
 */
export default function QueueEntryCard({ entry, renderActions = null, dragHandle = null, position = null, className = "" }) {
  if (!entry) return null;

  // The server decides whether a period has started (queueViewSync), like every
  // other status on this card.
  const notStarted = entry.statusLabel === "scheduled";

  // Remaining time to the end (or, for a scheduled period, to its start), in
  // words next to the exact date and time.
  const nowMs = Date.now();
  const expiresMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : NaN;
  const startsMs = entry.startsAt ? new Date(entry.startsAt).getTime() : NaN;
  const untilEnd = Number.isFinite(expiresMs) ? `còn ${spanText(expiresMs - nowMs)}` : null;
  const untilStart = notStarted && Number.isFinite(startsMs) ? `sau ${spanText(startsMs - nowMs)}` : null;
  const rateText = (value, unit) => (value ? `${Number(value).toLocaleString("vi-VN")} ${unit}/phút` : "Không giới hạn");

  return (
    <article className={`flex flex-col gap-5 border border-border bg-surface p-5 ${className}`}>
      {/* The status tag drops under the name on a narrow card instead of
          squeezing the plan name down to a few letters. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
          {dragHandle}
          <div className="min-w-0 flex-1">
            <h3 className="flex items-baseline gap-2 truncate text-base font-semibold text-text-main" title={entry.planName || entry.planCode || ""}>
              {position != null && (
                <span className="font-mono text-xs font-normal text-text-subtle" aria-label={`Vị trí ${position}`}>
                  [{String(position).padStart(2, "0")}]
                </span>
              )}
              <span className="truncate">{entry.planName || entry.planCode || "Gói"}</span>
            </h3>
            <p className="mt-1 text-sm text-text-muted">{SOURCE_LABEL[entry.source] || entry.source || "—"}</p>
          </div>
        </div>
        <StatusTag status={entry.statusLabel} reopenAt={entry.reopenAt} className="shrink-0" />
      </header>

      {/* Validity and rate, always spelled out: when the plan starts and ends (date
          and time), and the RPM/TPM that apply while it is the one paying. */}
      <dl className="grid grid-cols-2 gap-px border border-border bg-border">
        <div className="min-w-0 bg-surface px-3 py-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-subtle">Bắt đầu</dt>
          <dd className="mt-0.5 break-words font-mono text-[13px] text-text-main tabular-nums">{dateTimeOf(entry.startsAt)}</dd>
          {untilStart && <dd className="text-xs text-text-muted">{untilStart}</dd>}
        </div>
        <div className="min-w-0 bg-surface px-3 py-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-subtle">Hết hạn</dt>
          <dd className="mt-0.5 break-words font-mono text-[13px] text-text-main tabular-nums">{dateTimeOf(entry.expiresAt)}</dd>
          {untilEnd && !notStarted && <dd className="text-xs text-text-muted">{untilEnd}</dd>}
        </div>
        <div className="min-w-0 bg-surface px-3 py-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-subtle">RPM</dt>
          <dd className="mt-0.5 break-words font-mono text-[13px] text-text-main tabular-nums">{rateText(entry.rpm, "request")}</dd>
        </div>
        <div className="min-w-0 bg-surface px-3 py-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-subtle">TPM</dt>
          <dd className="mt-0.5 break-words font-mono text-[13px] text-text-main tabular-nums">{rateText(entry.tpm, "token")}</dd>
        </div>
      </dl>

      {entry.unlimitedCredit ? (
        // No ceiling to draw a bar against: the limits below are what bound it.
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
          <span className="text-sm text-text-muted">Credit</span>
          <span className="text-2xl font-semibold leading-none tracking-tight text-text-main">{UNLIMITED_CREDIT_LABEL}</span>
        </div>
      ) : (
        <CreditBar
          totalNanoUsd={entry.creditTotalNanoUsd}
          remainingNanoUsd={entry.creditRemainingNanoUsd}
          label="Credit còn lại"
        />
      )}

      {Array.isArray(entry.windows) && entry.windows.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {entry.windows.map((window) => (
            <LimitMeter key={window.hours} window={window} />
          ))}
        </div>
      )}

      {Array.isArray(entry.limits) && entry.limits.length > 0 && (!entry.windows || entry.windows.length === 0) && (
        <ul className="flex flex-col gap-1 border-t border-border pt-4 text-sm text-text-muted">
          {entry.limits.map((limit) => (
            <li key={limit.hours}>
              {limit.hours === 5 ? "5 giờ" : limit.hours === 24 ? "1 ngày" : limit.hours === 168 ? "1 tuần" : `${limit.hours} giờ`}: chưa dùng
            </li>
          ))}
        </ul>
      )}

      {renderActions && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">{renderActions(entry)}</div>}
    </article>
  );
}

QueueEntryCard.propTypes = {
  entry: PropTypes.object.isRequired,
  renderActions: PropTypes.func,
  dragHandle: PropTypes.node,
  position: PropTypes.number,
  className: PropTypes.string,
};
