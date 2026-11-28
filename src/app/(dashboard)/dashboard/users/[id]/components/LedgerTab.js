"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Pagination, Select, Table } from "@/shared/components";
import { dateOf, timeOf } from "@/shared/components/billing";
import { fmtUsdNano } from "@/shared/utils/money";

// The same kinds in the image unit: an image grant is not "Được cấp credit".
const IMAGE_KIND_LABEL = {
  charge: "Trừ ảnh",
  grant: "Được cấp ảnh",
  expire: "Hết hạn ảnh",
  revoke: "Thu hồi ảnh",
  adjust: "Điều chỉnh ảnh",
  refund: "Hoàn ảnh",
};

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
        <Card padding="lg">
          <p className="font-medium text-text-main">Không có dòng sổ cái nào</p>
        </Card>
      ) : (
        <Table className="min-w-[760px] text-left">
          <Table.Head>
            <tr>
              <Table.HeaderCell>Thời điểm</Table.HeaderCell>
              <Table.HeaderCell>Loại</Table.HeaderCell>
              <Table.HeaderCell>Gói</Table.HeaderCell>
              <Table.HeaderCell>Model</Table.HeaderCell>
              <Table.HeaderCell>Token</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Thay đổi</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Số dư sau</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {data.entries.map((entry) => (
              <Table.Row key={entry.id}>
                <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">
                  {dateOf(entry.createdAt)} {timeOf(entry.createdAt)}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-main">
                  {entry.deltaImages
                    ? IMAGE_KIND_LABEL[entry.kind] || KIND_LABEL[entry.kind] || entry.kind
                    : KIND_LABEL[entry.kind] || entry.kind}
                  {entry.backfill && <span className="ml-1 text-[10px] text-text-subtle">truy trừ</span>}
                  {entry.debtNote && <span className="ml-1 text-[10px] text-text-subtle">{entry.debtNote}</span>}
                </Table.Cell>
                <Table.Cell className="text-sm text-text-main">{entry.planName || "—"}</Table.Cell>
                <Table.Cell className="max-w-[200px] truncate font-mono text-[12px] text-text-muted" title={[entry.model, entry.upstreamModel].filter(Boolean).join(" → ")}>
                  {entry.model || entry.upstreamModel || "—"}
                  {entry.upstreamModel && entry.upstreamModel !== entry.model ? (
                    <span className="block truncate text-[11px] text-text-subtle">{entry.upstreamModel}</span>
                  ) : null}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">
                  {entry.promptTokens == null ? "—" : `${entry.promptTokens} / ${entry.completionTokens ?? 0}`}
                </Table.Cell>
                {/* An image-plan row moves images, not money: "$0.00" would read as
                    a free charge. */}
                <Table.Cell className="text-right font-mono text-[12px] text-text-main">
                  {entry.deltaImages
                    ? `${entry.deltaImages > 0 ? "+" : ""}${entry.deltaImages.toLocaleString("vi-VN")} ảnh`
                    : `${entry.deltaNanoUsd > 0 ? "+" : ""}${fmtUsdNano(entry.deltaNanoUsd)}`}
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[12px] text-text-muted">
                  {entry.deltaImages
                    ? entry.balanceAfterImages == null
                      ? "—"
                      : `${entry.balanceAfterImages.toLocaleString("vi-VN")} ảnh`
                    : entry.balanceAfterUsd ?? "—"}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
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
