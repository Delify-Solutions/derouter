"use client";

import { fmtUsdNano } from "@/shared/utils/money";
import { dateOf } from "@/shared/components/billing";

const STATUS_LABEL = {
  exhausted: "Hết credit",
  expired: "Hết hạn",
  revoked: "Đã thu hồi",
};

const SOURCE_LABEL = {
  purchase: "Mua",
  gift: "Tặng",
  admin: "Admin",
  refund: "Hoàn tiền",
};

/**
 * Past plans: exhausted, expired and revoked purchases, newest first.
 *
 * Collapsed by default — a customer returning after months does not need 40 dead
 * rows between them and the queue. A native <details> keeps it keyboard-operable
 * with no state to manage.
 */
export default function PlanHistory({ history = [], loading = false }) {
  if (loading) {
    return <div className="h-16 border border-border bg-surface" aria-hidden="true" />;
  }
  if (!history.length) return null;

  return (
    <details className="border border-border bg-surface">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main">
        <span>Lịch sử gói ({history.length})</span>
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">expand_more</span>
      </summary>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[560px] text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Gói</th>
              <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Nguồn</th>
              <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Bắt đầu</th>
              <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Hết hạn</th>
              <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Đã nhận</th>
              <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {history.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2 text-sm text-text-main">{row.planName || row.planCode || "Gói"}</td>
                <td className="px-4 py-2 font-mono text-[12px] text-text-muted">
                  {SOURCE_LABEL[row.source] || row.source || "—"}
                </td>
                <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{dateOf(row.startsAt)}</td>
                <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{dateOf(row.expiresAt)}</td>
                <td className="px-4 py-2 font-mono text-[12px] text-text-main">
                  {fmtUsdNano(row.creditTotalNanoUsd)}
                </td>
                <td className="px-4 py-2 font-mono text-[12px] text-text-muted">
                  {STATUS_LABEL[row.status] || row.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
