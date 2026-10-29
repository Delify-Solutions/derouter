"use client";

import PropTypes from "prop-types";
import CreditBar from "./CreditBar";
import LimitMeter from "./LimitMeter";
import StatusTag, { dateOf } from "./StatusTag";

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
export default function QueueEntryCard({ entry, renderActions = null, dragHandle = null, className = "" }) {
  if (!entry) return null;

  const daysLeft = (() => {
    const expires = entry.expiresAt ? new Date(entry.expiresAt).getTime() : NaN;
    if (!Number.isFinite(expires)) return null;
    const days = Math.ceil((expires - Date.now()) / 86_400_000);
    return Number.isFinite(days) ? Math.max(0, days) : null;
  })();

  return (
    <article className={`flex flex-col gap-4 border border-border bg-surface p-5 ${className}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {dragHandle}
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-text-main" title={entry.planName || entry.planCode || ""}>
              {entry.planName || entry.planCode || "Gói"}
            </h3>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted">
              <span>{SOURCE_LABEL[entry.source] || entry.source || "—"}</span>
              <span aria-hidden="true" className="text-text-subtle">·</span>
              <span>hết hạn {dateOf(entry.expiresAt)}</span>
              {daysLeft != null && (
                <>
                  <span aria-hidden="true" className="text-text-subtle">·</span>
                  <span>còn {daysLeft} ngày</span>
                </>
              )}
            </p>
          </div>
        </div>
        <StatusTag status={entry.statusLabel} reopenAt={entry.reopenAt} />
      </header>

      <CreditBar
        totalNanoUsd={entry.creditTotalNanoUsd}
        remainingNanoUsd={entry.creditRemainingNanoUsd}
        label="Credit còn lại"
      />

      {Array.isArray(entry.windows) && entry.windows.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {entry.windows.map((window) => (
            <LimitMeter key={window.hours} window={window} />
          ))}
        </div>
      )}

      {Array.isArray(entry.limits) && entry.limits.length > 0 && (!entry.windows || entry.windows.length === 0) && (
        <ul className="flex flex-col gap-1 border-t border-border pt-3 font-mono text-[12px] text-text-muted">
          {entry.limits.map((limit) => (
            <li key={limit.hours}>
              {limit.hours === 5 ? "5 giờ" : limit.hours === 24 ? "1 ngày" : limit.hours === 168 ? "1 tuần" : `${limit.hours} giờ`}: chưa dùng
            </li>
          ))}
        </ul>
      )}

      {renderActions && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">{renderActions(entry)}</div>}
    </article>
  );
}

QueueEntryCard.propTypes = {
  entry: PropTypes.object.isRequired,
  renderActions: PropTypes.func,
  dragHandle: PropTypes.node,
  className: PropTypes.string,
};
