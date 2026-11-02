"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Drawer from "@/shared/components/Drawer";
import { QueueEntryCard, dateTimeOf } from "@/shared/components/billing";
import PlanHistory from "@/app/account/plans/components/PlanHistory";
import { fmtUsdNano, UNLIMITED_CREDIT_LABEL } from "@/shared/utils/money";

const STATUS_TEXT = {
  paying: "Đang trả",
  waiting: "Chờ",
  blocked: "Tạm khóa",
  scheduled: "Chờ kích hoạt",
};

const VISIBLE = 3;

/**
 * Credit and plans of the account behind a customer key, in one card on /usage:
 * the available credit, then one line per active plan (status, name, when it ends
 * or starts). "Xem chi tiết" opens every plan in full — limits, RPM/TPM, start and
 * expiry — plus recent inactive plans, in a side panel, so the page itself stays
 * short however many plans the account holds.
 */
export default function AccountPlansCard({ account }) {
  const [open, setOpen] = useState(false);
  if (!account) return null;
  const queue = Array.isArray(account.queue) ? account.queue : [];
  const history = Array.isArray(account.history) ? account.history : [];
  const shown = queue.slice(0, VISIBLE);
  const more = queue.length - shown.length;

  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-1 p-4">
      <h3 className="text-sm font-semibold mb-2">Credit khả dụng</h3>
      <p className="text-lg font-semibold tabular-nums break-words">
        {account.hasUnlimitedCredit ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(account.availableNanoUsd)}
      </p>
      {account.debtNanoUsd > 0 && (
        <p className="text-xs text-text-muted mt-1">Đang nợ {fmtUsdNano(account.debtNanoUsd)}</p>
      )}

      {queue.length === 0 ? (
        <p className="mt-3 text-xs text-text-muted">
          Chưa có gói nào đang hoạt động — request sẽ bị từ chối cho tới khi mua hoặc nhận gói.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border border-t border-border" aria-label="Gói đang hoạt động">
          {shown.map((entry) => {
            const scheduled = entry.statusLabel === "scheduled";
            return (
              <li key={entry.id} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-xs">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={`shrink-0 font-mono uppercase tracking-[0.06em] ${entry.statusLabel === "paying" ? "text-text-main" : "text-text-subtle"}`}>
                    {STATUS_TEXT[entry.statusLabel] || "Chờ"}
                  </span>
                  <span className="truncate font-medium text-text-main" title={entry.planName || entry.planCode || ""}>
                    {entry.planName || entry.planCode || "Gói"}
                  </span>
                </span>
                <span className="shrink-0 font-mono tabular-nums text-text-muted">
                  {scheduled ? `từ ${dateTimeOf(entry.startsAt)}` : `hết ${dateTimeOf(entry.expiresAt)}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {(queue.length > 0 || history.length > 0) && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="mt-3 inline-flex h-8 items-center justify-center gap-1.5 self-start border border-border px-3 text-xs font-medium text-text-main transition-colors hover:bg-surface-2"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_full</span>
          {more > 0 ? `Xem đủ ${queue.length} gói` : "Xem chi tiết gói"}
        </button>
      )}

      <Drawer isOpen={open} onClose={() => setOpen(false)} title={`Gói của tài khoản (${queue.length})`} width="lg">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Gói trên cùng trả trước. Mỗi gói ghi rõ thời hạn, hạn mức theo khung giờ và RPM/TPM áp dụng khi gói đó đang trả.
          </p>
          {queue.map((entry, index) => (
            <QueueEntryCard key={entry.id} entry={entry} position={index + 1} />
          ))}
          {history.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Gói đã ngừng hoạt động ({history.length} gần nhất)</h3>
              <PlanHistory history={history} />
            </section>
          )}
        </div>
      </Drawer>
    </div>
  );
}

AccountPlansCard.propTypes = {
  account: PropTypes.shape({
    queue: PropTypes.array,
    history: PropTypes.array,
    availableNanoUsd: PropTypes.number,
    hasUnlimitedCredit: PropTypes.bool,
    debtNanoUsd: PropTypes.number,
  }),
};
