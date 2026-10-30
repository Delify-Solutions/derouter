"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty } from "@/app/account/components/ui";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money";
import { formatGiftCode } from "./formatCode";

function fmtWhen(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RedemptionHistory({ refreshKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/account/redeem");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không tải được lịch sử nhập mã.");
        return;
      }
      setRows(Array.isArray(data.redemptions) ? data.redemptions : []);
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (loading) return <div className="h-[120px] border border-border bg-surface-2" aria-hidden="true" />;

  if (error) {
    return (
      <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty icon="redeem" title="Chưa nhập mã nào" body="Mã bạn nhập sẽ hiện ở đây cùng thứ nhận được và thời điểm nhập." />
    );
  }

  return (
    <div className="overflow-x-auto border border-border bg-surface">
      <table className="w-full min-w-[540px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-surface-2">
            <th className="meta px-4 py-3 text-text-muted">Mã</th>
            <th className="meta px-4 py-3 text-text-muted">Đã cấp</th>
            <th className="meta px-4 py-3 text-text-muted">Nhập lúc</th>
            <th className="meta px-4 py-3 text-text-muted">Hết hạn</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-b-0">
              <td className="px-4 py-3 font-mono text-xs tracking-wider text-text-main">
                {formatGiftCode(row.giftCode)}
              </td>
              <td className="px-4 py-3">
                <span className="font-mono text-sm text-text-main">
                  {row.planName || fmtCreditNano(row.creditNanoUsd ?? 0, row.unlimitedCredit)}
                </span>
                {row.planName && (
                  <p className="text-xs text-text-subtle">
                    {row.unlimitedCredit ? "Credit không giới hạn" : `${fmtUsdNano(row.creditNanoUsd ?? 0)} credit`}
                  </p>
                )}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-muted whitespace-nowrap">
                {fmtWhen(row.redeemedAt)}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-muted whitespace-nowrap">
                {fmtWhen(row.expiresAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
