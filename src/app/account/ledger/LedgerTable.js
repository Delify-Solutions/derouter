"use client";

import { useCallback, useEffect, useState } from "react";
import { CardSkeleton, Pagination, Select } from "@/shared/components";
import { ActionButton, Empty, Eyebrow, Tag } from "@/app/account/components/ui";
import { dateOf, timeOf } from "@/shared/components/billing";
import { fmtUsdNano } from "@/shared/utils/money";

// Vietnamese kind labels (spec customer-portal "Ledger page"). A customer should
// never see the raw ledger vocabulary.
const KIND_LABEL = {
  charge: "Trừ tiền",
  grant: "Cấp",
  expire: "Hết hạn",
  adjust: "Điều chỉnh",
  refund: "Hoàn tiền",
  revoke: "Thu hồi",
};

const KIND_OPTIONS = [
  { value: "", label: "Mọi loại" },
  ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
];

// Money in is quiet success, money out is neutral, loss of credit is a warning.
const KIND_TONE = {
  charge: "neutral",
  grant: "success",
  expire: "warning",
  adjust: "neutral",
  refund: "neutral",
  revoke: "warning",
};

const PAGE_SIZE = 25;

/**
 * The customer's ledger: 25 rows per page, newest first, filterable by plan and by
 * kind. Charge rows show the model and token counts the money paid for, joined from
 * the usage row through `usageId`.
 *
 * The table scrolls horizontally on narrow screens rather than collapsing columns —
 * a token count is useless if it is hidden behind a disclosure.
 */
export default function LedgerTable() {
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

      const res = await fetch(`/api/account/ledger?${params.toString()}`, { cache: "no-store" });
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
      setData({ entries: [], total: 0, page: 1, planOptions: [] });
    } finally {
      setLoading(false);
    }
  }, [page, planId, kind]);

  useEffect(() => { load(); }, [load]);

  // A filter change restarts at page 1: staying on page 7 of a different result set
  // shows an empty table for no reason the customer can see.
  useEffect(() => { setPage(1); }, [planId, kind]);

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="ledger-plan"><Eyebrow>Gói</Eyebrow></label>
          <Select
            id="ledger-plan"
            value={planId}
            onChange={(event) => setPlanId(event.target.value)}
            options={[
              { value: "", label: "Mọi gói" },
              ...data.planOptions.map((option) => ({ value: option.planId, label: option.planName })),
            ]}
            selectClassName="h-9 py-0 text-[12px] font-mono"
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="ledger-kind"><Eyebrow>Loại</Eyebrow></label>
          <Select
            id="ledger-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            options={KIND_OPTIONS}
            selectClassName="h-9 py-0 text-[12px] font-mono"
          />
        </div>
        <div className="ml-auto self-end">
          <ActionButton onClick={load} disabled={loading}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">refresh</span>
            Tải lại
          </ActionButton>
        </div>
      </div>

      {error ? (
        <div role="alert" className="flex items-start justify-between gap-3 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="flex items-start gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
            {error}
          </span>
          <ActionButton size="sm" onClick={load}>Thử lại</ActionButton>
        </div>
      ) : loading ? (
        <CardSkeleton />
      ) : data.entries.length === 0 ? (
        <Empty
          icon="receipt_long"
          title="Chưa có giao dịch nào"
          body="Mỗi lần credit được cấp, bị trừ hay hết hạn đều xuất hiện ở đây."
          action={
            planId || kind ? (
              <ActionButton size="sm" onClick={() => { setPlanId(""); setKind(""); }}>Bỏ bộ lọc</ActionButton>
            ) : null
          }
        />
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">Thời điểm</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">Loại</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">Gói</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">Model</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">Token vào / ra</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right whitespace-nowrap">Thay đổi</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right whitespace-nowrap">Số dư sau</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">
                    {dateOf(entry.createdAt)} {timeOf(entry.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <Tag tone={KIND_TONE[entry.kind] || "neutral"}>{KIND_LABEL[entry.kind] || entry.kind}</Tag>
                    {entry.backfill && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-text-subtle">
                        truy trừ
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-text-main whitespace-nowrap">
                    {entry.planName || entry.planCode || "—"}
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-[12px] text-text-muted" title={entry.model || ""}>
                    {entry.model || "—"}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">
                    {entry.promptTokens == null && entry.completionTokens == null
                      ? "—"
                      : `${entry.promptTokens ?? 0} / ${entry.completionTokens ?? 0}`}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-[12px] whitespace-nowrap ${
                    entry.deltaNanoUsd < 0 ? "text-text-main" : "text-brand-700 dark:text-brand-400"
                  }`}>
                    {entry.deltaNanoUsd > 0 ? "+" : ""}{fmtUsdNano(entry.deltaNanoUsd)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted whitespace-nowrap">
                    {entry.balanceAfterUsd ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-text-muted">
            {data.total} dòng · trang {data.page}/{totalPages}
          </p>
          <Pagination
            currentPage={data.page}
            pageSize={PAGE_SIZE}
            totalItems={data.total}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
