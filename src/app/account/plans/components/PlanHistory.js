"use client";

import { fmtUsdNano } from "@/shared/utils/money";
import { dateOf } from "@/shared/components/billing";
import { Empty, Tag } from "@/app/account/components/ui";

// Why a plan left the queue. Every label says it in words; the tone and icon are
// only a second signal (ui-dna: no colour-only status).
const STATUS_VIEW = {
  exhausted: { label: "Hết credit", tone: "neutral", icon: "battery_0_bar" },
  expired: { label: "Hết hạn", tone: "warning", icon: "schedule" },
  revoked: { label: "Đã hủy", tone: "danger", icon: "block" },
  refunded: { label: "Đã hoàn tiền", tone: "neutral", icon: "undo" },
};

const SOURCE_LABEL = {
  purchase: "Mua",
  gift: "Tặng",
  admin: "Admin",
  refund: "Hoàn tiền",
};

/**
 * Plans that can no longer pay for a request: out of credit, expired, cancelled by
 * an admin or refunded. Shown on the "Không hoạt động" tab so the queue itself
 * only ever lists plans that can still be spent.
 */
export default function PlanHistory({ history = [], loading = false }) {
  if (loading) {
    return <div className="h-32 border border-border bg-surface" aria-hidden="true" />;
  }
  if (!history.length) {
    return (
      <Empty
        icon="inventory_2"
        title="Chưa có gói nào ngừng hoạt động"
        body="Gói hết credit, hết hạn, bị hủy hoặc đã hoàn tiền sẽ chuyển sang đây."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {history.map((row) => {
        const view = STATUS_VIEW[row.status] || { label: row.status, tone: "neutral" };
        return (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border border-border bg-surface-2 px-5 py-4">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-text-main">{row.planName || row.planCode || "Gói"}</span>
                <Tag tone={view.tone} icon={view.icon}>{view.label}</Tag>
              </div>
              <p className="text-sm text-text-muted">
                {SOURCE_LABEL[row.source] || row.source || "—"} · {dateOf(row.startsAt)} → {dateOf(row.expiresAt)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm text-text-main">{fmtUsdNano(row.creditTotalNanoUsd)}</p>
              <p className="text-xs text-text-subtle">credit đã nhận</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
