"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Pagination, Select } from "@/shared/components";
import { dateOf, timeOf } from "@/shared/components/billing";
import { fmtUsdNano } from "@/shared/utils/money";

const KIND_LABEL = {
  charge: "Trừ tiền",
  grant: "Cấp",
  expire: "Hết hạn",
  adjust: "Điều chỉnh",
  refund: "Hoàn tiền",
  revoke: "Thu hồi",
};

/** `Sổ cái` — the customer's ledger, paginated and filterable by plan and kind. */
export default function LedgerTab({ userId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState({ entries: [], total: 0, page: 1, planOptions: [] });
  const [page, setPage] = useState(1);
  const [planId, setPlanId] = useState("");
  const [kind, setKind] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (planId) params.set("planId", planId);
      if (kind) params.set("kind", kind);
      const res = await fetch(`/api/users/${userId}/ledger?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được sổ cái");
      setData({
        entries: Array.isArray(body.entries) ? body.entries : [],
        total: Number(body.total) || 0,
        page: Number(body.page) || 1,
        planOptions: Array.isArray(body.planOptions) ? body.planOptions : [],
      });
    } catch (e) {
      setError(e.message || "Không tải được sổ cái");
    } finally {
      setLoading(false);
    }
  }, [userId, page, planId, kind]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [planId, kind]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Gói</span>
          <Select
            value={planId}
            onChange={(event) => setPlanId(event.target.value)}
            options={[{ value: "", label: "Mọi gói" }, ...data.planOptions.map((o) => ({ value: o.planId, label: o.planName }))]}
            selectClassName="h-9 py-0 text-[12px] font-mono"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Loại</span>
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            options={[{ value: "", label: "Mọi loại" }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]}
            selectClassName="h-9 py-0 text-[12px] font-mono"
          />
        </div>
        <p className="ml-auto font-mono text-[11px] text-text-muted">{data.total} dòng</p>
      </div>

      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      {loading ? (
        <div className="h-40 border border-border bg-surface" aria-hidden="true" />
      ) : data.entries.length === 0 ? (
        <div className="border border-border bg-surface px-6 py-10">
          <p className="font-medium text-text-main">Không có dòng sổ cái nào</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Thời điểm</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Loại</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Gói</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Model</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Token</th>
                <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Thay đổi</th>
                <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Số dư sau</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">
                    {dateOf(entry.createdAt)} {timeOf(entry.createdAt)}
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-main">
                    {KIND_LABEL[entry.kind] || entry.kind}
                    {entry.backfill && <span className="ml-1 text-[10px] text-text-subtle">truy trừ</span>}
                  </td>
                  <td className="px-4 py-2 text-sm text-text-main">{entry.planName || "—"}</td>
                  <td className="max-w-[200px] truncate px-4 py-2 font-mono text-[12px] text-text-muted" title={entry.model || ""}>
                    {entry.model || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">
                    {entry.promptTokens == null ? "—" : `${entry.promptTokens} / ${entry.completionTokens ?? 0}`}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[12px] text-text-main">
                    {entry.deltaNanoUsd > 0 ? "+" : ""}{fmtUsdNano(entry.deltaNanoUsd)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[12px] text-text-muted">{entry.balanceAfterUsd ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.total > 25 && (
        <Pagination currentPage={page} pageSize={25} totalItems={data.total} onPageChange={setPage} />
      )}

      <div>
        <Button variant="secondary" size="sm" icon="refresh" onClick={load}>Tải lại</Button>
      </div>
    </div>
  );
}
