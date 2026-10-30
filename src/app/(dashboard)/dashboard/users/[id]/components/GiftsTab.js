"use client";

import { useEffect, useState } from "react";
import { fmtUsdNano, UNLIMITED_CREDIT_LABEL } from "@/shared/utils/money";
import { dateOf } from "@/shared/components/billing";

const KIND_LABEL = { plan: "Gói", credit: "Credit" };

/** `Mã quà tặng` — the customer's gift-code redemptions. */
export default function GiftsTab({ userId }) {
  const [redemptions, setRedemptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}/gifts`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Không tải được mã quà tặng");
        if (!cancelled) setRedemptions(Array.isArray(body.redemptions) ? body.redemptions : []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Không tải được mã quà tặng");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) return <div className="h-40 border border-border bg-surface" aria-hidden="true" />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      {redemptions.length === 0 ? (
        <div className="border border-border bg-surface px-6 py-10">
          <p className="font-medium text-text-main">Chưa nhập mã quà tặng nào</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[600px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Mã</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Loại</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Giá trị</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Số ngày</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Nhập lúc</th>
              </tr>
            </thead>
            <tbody>
              {redemptions.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono text-[12px] text-text-main">{row.code || "—"}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{KIND_LABEL[row.grantKind] || row.grantKind || "—"}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-main">
                    {row.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : row.creditNanoUsd == null ? "—" : fmtUsdNano(row.creditNanoUsd)}
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{row.durationDays ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{dateOf(row.redeemedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
