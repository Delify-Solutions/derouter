"use client";

import { fmtUsdNano } from "@/shared/utils/money";
import { dateOf } from "@/shared/components/billing";
import { Section } from "@/app/account/components/ui";

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
    <Section title="Lịch sử gói" description={`${history.length} gói đã hết credit, hết hạn hoặc bị thu hồi.`}>
      <details className="border border-border bg-surface">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-text-muted hover:text-text-main">
          <span>Xem lịch sử ({history.length})</span>
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">expand_more</span>
        </summary>

        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["Gói", "Nguồn", "Bắt đầu", "Hết hạn", "Đã nhận", "Trạng thái"].map((h) => (
                  <th key={h} scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 text-sm text-text-main">{row.planName || row.planCode || "Gói"}</td>
                  <td className="px-4 py-3 text-sm text-text-muted">{SOURCE_LABEL[row.source] || row.source || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">{dateOf(row.startsAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">{dateOf(row.expiresAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-main">{fmtUsdNano(row.creditTotalNanoUsd)}</td>
                  <td className="px-4 py-3 text-sm text-text-muted">{STATUS_LABEL[row.status] || row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Section>
  );
}
