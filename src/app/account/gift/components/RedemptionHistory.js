"use client";

import { useCallback, useEffect, useState } from "react";
import { CardSkeleton } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";
import { formatGiftCode } from "./formatCode";

function fmtWhen(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
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
        setError(data.error || "Could not load your redemptions.");
        return;
      }
      setRows(Array.isArray(data.redemptions) ? data.redemptions : []);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (loading) return <CardSkeleton />;

  if (error) {
    return (
      <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="border border-border px-4 py-6 text-sm text-text-muted">
        Codes you redeem appear here with what they granted and when.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto border border-border">
      <table className="w-full min-w-[540px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
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
                  {row.planName || fmtUsdNano(row.creditNanoUsd ?? 0)}
                </span>
                {row.planName && (
                  <p className="text-xs text-text-subtle">{fmtUsdNano(row.creditNanoUsd ?? 0)} credit</p>
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
