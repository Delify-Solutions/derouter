"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Table from "@/shared/components/Table";
import TableToolbar, { useTableQuery, SortableHeader } from "@/shared/components/TableToolbar";
import { TableStateRow } from "@/shared/components/TableState";
import { fmtUsdNano } from "@/shared/utils/money";
import { applyTableQuery, nextSortState, hasActiveQuery, clearQueryFilters, tableStateOf } from "@/shared/utils/tableQuery";

// Admin review of every cache-miss detection (spec cache-miss-refund "Admin review
// page"). No row, column, tooltip or filter here may ever name a connection,
// account or "rotation"/"pool" — only neutral facts (timestamps, tokens, provider,
// model). The ONLY reason text anywhere on this page is the fixed generic sentence.
const GENERIC_REASON = "Hệ thống không dùng được cache cho yêu cầu này";

const COLS = 8;

const SORTS = [
  { value: "detectedAt", label: "Thời điểm" },
  { value: "refundNanoUsd", label: "Số tiền" },
  { value: "status", label: "Trạng thái" },
];
const DEFAULTS = { sort: "detectedAt", dir: "desc", top: 0 };
const QUERY_OPTIONS = { sortFields: SORTS.map((s) => s.value) };

const STATUS_LABEL = {
  pending: "Chờ duyệt",
  auto_refunded: "Đã hoàn tự động",
  approved: "Đã duyệt",
  rejected: "Đã từ chối",
};
const STATUS_BADGE = {
  pending: "warning",
  auto_refunded: "success",
  approved: "success",
  rejected: "default",
};

function sortValue(row, field) {
  switch (field) {
    case "detectedAt": return row.detectedAt ? Date.parse(row.detectedAt) : 0;
    case "refundNanoUsd": return row.refundNanoUsd || 0;
    case "status": return row.status || "";
    default: return null;
  }
}

const searchText = (row) => [row.userEmail, row.provider, row.model, row.requestedModel];

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function CacheRefundsTable() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ detected: 0, refundedNanoUsd: 0, pendingNanoUsd: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [actionPending, setActionPending] = useState(null);
  const [query, setQueryRaw] = useTableQuery("cacheRefunds", DEFAULTS, QUERY_OPTIONS);
  const setQuery = useCallback((patch) => { setQueryRaw(patch); setPage(1); }, [setQueryRaw]);
  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cache-miss-refunds?sinceDays=30", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load cache-miss detections");
      setItems(Array.isArray(data.items) ? data.items : []);
      setStats(data.stats || { detected: 0, refundedNanoUsd: 0, pendingNanoUsd: 0 });
    } catch (e) {
      setError(e.message || "Failed to load cache-miss detections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const userOptions = useMemo(
    () => [...new Set(items.map((r) => r.userEmail).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v })),
    [items]
  );
  const statusOptions = useMemo(
    () => Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
    []
  );

  const result = useMemo(() => applyTableQuery(items, {
    search: query.q,
    searchFields: [searchText],
    filters: query.filters,
    filterFields: {
      user: (row) => row.userEmail || "",
      status: (row) => row.status || "",
    },
    sortField: query.sort,
    sortDir: query.dir,
    top: query.top,
    valueOf: sortValue,
    nameOf: (row) => row.userEmail || row.userId,
  }), [items, query]);
  const filtered = result.rows;

  const tableState = tableStateOf({ loading, error, total: items.length, matched: result.matched, filtersActive: hasActiveQuery(query) });
  const onHeaderSort = (field) => setQuery((s) => nextSortState(s, field));

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const act = async (id, action) => {
    setActionPending(id);
    try {
      const res = await fetch(`/api/cache-miss-refunds/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Action failed");
      await load();
    } catch (e) {
      setError(e.message || "Action failed");
    } finally {
      setActionPending(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span className="material-symbols-outlined text-vx-primary" aria-hidden="true">cached</span>
            Hoàn tiền cache
          </h2>
          <p className="mt-1 text-sm text-vx-text-muted">
            Mỗi request mà hệ thống không dùng được cache cho dù lẽ ra phải dùng được (30 ngày gần nhất). Lý do hiển thị luôn là một câu cố định: &ldquo;{GENERIC_REASON}&rdquo;.
          </p>
        </div>

        <TableToolbar
          className="mb-4"
          state={query}
          onChange={setQuery}
          searchPlaceholder="Email người dùng, provider, model…"
          filters={[
            { name: "user", label: "Người dùng", options: userOptions },
            { name: "status", label: "Trạng thái", options: statusOptions },
          ]}
          sortOptions={SORTS}
          shown={filtered.length}
          total={items.length}
        />

        <div className="flex flex-col gap-1 text-xs text-vx-text-muted">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span><span className="font-mono font-medium text-vx-text">{stats.detected}</span> request bị gắn cờ</span>
            <span><span className="font-mono font-medium text-vx-text">{fmtUsdNano(stats.refundedNanoUsd)}</span> đã hoàn</span>
            <span><span className="font-mono font-medium text-vx-text">{fmtUsdNano(stats.pendingNanoUsd)}</span> đang chờ duyệt</span>
          </p>
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto" aria-busy={loading}>
          <table className="w-full min-w-[1000px] text-sm">
            <Table.Head>
              <tr>
                <SortableHeader label="Thời điểm" field="detectedAt" state={query} onSort={onHeaderSort} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted whitespace-nowrap" />
                <Table.HeaderCell>Người dùng</Table.HeaderCell>
                <Table.HeaderCell>Provider / model</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Token trùng</Table.HeaderCell>
                <SortableHeader label="Số tiền" field="refundNanoUsd" state={query} onSort={onHeaderSort} align="right" className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" />
                <SortableHeader label="Trạng thái" field="status" state={query} onSort={onHeaderSort} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" />
                <Table.HeaderCell>Lý do</Table.HeaderCell>
                <Table.HeaderCell className="w-32"><span className="sr-only">Thao tác</span></Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {tableState !== "ready" ? (
                <TableStateRow
                  state={tableState}
                  colSpan={COLS}
                  emptyMessage="Chưa phát hiện cache miss nào."
                  onRetry={load}
                  onClearFilters={() => setQuery(clearQueryFilters)}
                />
              ) : (
                pageRows.map((row) => (
                  <Table.Row key={row.id}>
                    <Table.Cell className="px-4 py-2 font-mono text-xs whitespace-nowrap text-vx-text-muted">{fmtWhen(row.detectedAt)}</Table.Cell>
                    <Table.Cell className="px-4 py-2">{row.userEmail || row.userId}</Table.Cell>
                    <Table.Cell className="px-4 py-2 font-mono text-xs">{row.provider} / {row.requestedModel || row.model}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono tabular-nums">{row.overlapTokens.toLocaleString()}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono tabular-nums">{fmtUsdNano(row.refundNanoUsd)}</Table.Cell>
                    <Table.Cell className="px-4 py-2">
                      <Badge variant={STATUS_BADGE[row.status] || "default"} size="sm">{STATUS_LABEL[row.status] || row.status}</Badge>
                    </Table.Cell>
                    <Table.Cell className="max-w-[260px] px-4 py-2 text-xs text-vx-text-muted">{GENERIC_REASON}</Table.Cell>
                    <Table.Cell className="px-4 py-2">
                      {row.status === "pending" ? (
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="ghost" disabled={actionPending === row.id} onClick={() => act(row.id, "approve")}>
                            Duyệt
                          </Button>
                          <Button size="sm" variant="ghost" disabled={actionPending === row.id} onClick={() => act(row.id, "reject")}>
                            Từ chối
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-vx-text-muted">—</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </table>
        </div>
      </Card>
    </div>
  );
}
