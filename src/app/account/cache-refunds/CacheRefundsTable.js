"use client";

import { useCallback, useEffect, useState } from "react";
import { CardSkeleton } from "@/shared/components";
import { ActionButton, Empty } from "@/app/account/components/ui";
import { dateOf, timeOf } from "@/shared/components/billing";
import { fmtUsdNano } from "@/shared/utils/money";

// The ONLY reason shown anywhere on this page, for every row, regardless of the
// internal cause recorded for diagnostics (spec cache-miss-refund "No internal
// cause exposed" / "Customer visibility").
const GENERIC_REASON = "Hệ thống không dùng được cache cho yêu cầu này";

/**
 * The customer's own cache-miss refunds: date, amount, the fixed generic reason.
 * Follows the same loading/error/empty/accessibility conventions as the rest of
 * the account pages (spec customer-portal "Interface states and accessibility").
 */
export default function CacheRefundsTable() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/account/cache-refunds", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được danh sách hoàn tiền");
      setEntries(Array.isArray(body.entries) ? body.entries : []);
    } catch (e) {
      setError(e.message || "Không tải được danh sách hoàn tiền");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div role="alert" className="flex items-start justify-between gap-3 border border-danger/40 bg-danger/5 px-4 py-3">
        <span className="flex items-start gap-2 text-sm text-danger">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
          {error}
        </span>
        <ActionButton size="sm" onClick={load}>Thử lại</ActionButton>
      </div>
    );
  }

  if (loading) return <CardSkeleton />;

  if (entries.length === 0) {
    return (
      <Empty
        icon="cached"
        title="Chưa có khoản hoàn tiền nào"
        body="Khi hệ thống không dùng được cache cho một yêu cầu đáng lẽ dùng được, phần chênh lệch bạn đã trả sẽ được hoàn lại vào đây."
      />
    );
  }

  return (
    <div className="overflow-x-auto border border-border bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-surface-2">
            <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">Thời điểm</th>
            <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap text-right">Số tiền</th>
            <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Lý do</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">
                {dateOf(entry.resolvedAt || entry.detectedAt)} {timeOf(entry.resolvedAt || entry.detectedAt)}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[12px] text-brand-700 dark:text-brand-400 whitespace-nowrap">
                +{fmtUsdNano(entry.refundNanoUsd)}
              </td>
              <td className="px-4 py-2.5 text-sm text-text-main">{GENERIC_REASON}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
