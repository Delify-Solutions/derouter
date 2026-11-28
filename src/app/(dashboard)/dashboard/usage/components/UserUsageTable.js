"use client";

import { Fragment, useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import Badge from "@/shared/components/Badge";
import Pagination from "@/shared/components/Pagination";
import Table from "@/shared/components/Table";
import TableToolbar, { useTableQuery, SortableHeader } from "@/shared/components/TableToolbar";
import { TableStateRow } from "@/shared/components/TableState";
import { cn } from "@/shared/utils/cn";
import { fmtUsd } from "@/shared/utils/money";
import { applyTableQuery, nextSortState, hasActiveQuery, clearQueryFilters, tableStateOf } from "@/shared/utils/tableQuery";

// Usage grouped by the customer who owns the key: one customer may hold many
// keys, so their traffic is summed into one row, with the keys and models
// underneath. Data: GET /api/usage/user-summary (admin only).

const PAGE_SIZE = 20;
const COLS = 12;

const PERIOD_PRESETS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

// Shared toolbar (spec admin-usage-views): default order is cost, highest first.
const USER_SORTS = [
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Chi phí" },
  { value: "lastUsed", label: "Lần dùng cuối" },
];
const USER_DEFAULTS = { sort: "cost", dir: "desc", top: 0 };
const USER_QUERY_OPTIONS = { sortFields: USER_SORTS.map((s) => s.value) };
const ACTIVITY_OPTIONS = [{ value: "active", label: "With requests" }];

function userSortValue(o, field) {
  const t = o.totals || {};
  switch (field) {
    case "requests": return t.requests || 0;
    case "tokens": return (t.input || 0) + (t.output || 0);
    case "cost": return t.costNanoUsd != null ? t.costNanoUsd : Math.round(Number(t.cost || 0) * 1e9);
    case "lastUsed": {
      // No last request in the period: sorts after every customer who has one.
      const ms = o.lastUsedAt ? Date.parse(o.lastUsedAt) : NaN;
      return Number.isFinite(ms) ? ms : null;
    }
    default: return null;
  }
}

const userSearchText = (o) => [o.email, o.displayName, o.group, ownerTitle(o), ...(o.keys || []).flatMap((k) => [k.name, k.maskedKey])];

function periodToRange(period) {
  const now = new Date();
  let start;
  let end = now;
  if (period === "today") {
    start = new Date(now); start.setHours(0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
  } else if (period === "24h") {
    start = new Date(now.getTime() - 24 * 3600_000);
  } else {
    const days = period === "7d" ? 7 : period === "30d" ? 30 : 60;
    start = new Date(now.getTime() - days * 86400_000);
  }
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function fmtCompact(v) {
  if (v == null) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

function fmtCost(acc) {
  if (!acc) return "—";
  return fmtUsd(acc.costNanoUsd != null ? acc.costNanoUsd / 1e9 : Number(acc.cost || 0));
}

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
}

function ownerTitle(o) {
  if (o.kind === "admin") return "Admin keys";
  if (o.kind === "unknown") return "Deleted or unknown keys";
  return o.email || o.userId || "—";
}

export default function UserUsageTable() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [period, setPeriod] = useState("30d");
  const [expanded, setExpanded] = useState(null);
  const [query, setQueryRaw] = useTableQuery("users", USER_DEFAULTS, USER_QUERY_OPTIONS);
  // Any change of search, filter, sort or Top N starts again from the first page.
  const setQuery = useCallback((patch) => { setQueryRaw(patch); setPage(1); }, [setQueryRaw]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ ...periodToRange(period), period });
      const res = await fetch(`/api/usage/user-summary?${params}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load usage by user");
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      setError(e.message || "Failed to load usage by user");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const userOptions = useMemo(
    () => [...new Set(items.map(ownerTitle))].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v })),
    [items]
  );

  const result = useMemo(() => applyTableQuery(items, {
    search: query.q,
    searchFields: [userSearchText],
    filters: query.filters,
    filterFields: {
      user: ownerTitle,
      // "With requests" hides customers with no request in the period.
      activity: (o) => (o.totals?.requests > 0 ? "active" : ""),
    },
    sortField: query.sort,
    sortDir: query.dir,
    top: query.top,
    valueOf: userSortValue,
    nameOf: ownerTitle,
  }), [items, query]);
  const filtered = result.rows;

  const tableState = tableStateOf({ loading, error, total: items.length, matched: result.matched, filtersActive: hasActiveQuery(query) });
  const onHeaderSort = (field) => setQuery((s) => nextSortState(s, field));

  // "Tổng kỳ" is every customer of the period whatever the search, filters or Top N;
  // "Tổng đang hiển thị" is the rows shown, when those hide some.
  const sumOwners = (list) => list.reduce(
    (acc, o) => {
      acc.requests += o.totals?.requests || 0;
      acc.costNanoUsd += o.totals?.costNanoUsd || 0;
      return acc;
    },
    { requests: 0, costNanoUsd: 0 }
  );
  const periodTotals = useMemo(() => sumOwners(items), [items]);
  const shownTotals = useMemo(() => sumOwners(filtered), [filtered]);
  const partial = filtered.length !== items.length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const periodLabel = PERIOD_PRESETS.find((p) => p.value === period)?.label || period;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <span className="material-symbols-outlined text-vx-primary" aria-hidden="true">group</span>
              Usage by user
            </h2>
            <p className="mt-1 text-sm text-vx-text-muted">
              Requests, tokens and cost per customer over all of their keys, for {periodLabel}. Open a row for its keys and models.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onChange={(e) => { setPeriod(e.target.value); setPage(1); }} options={PERIOD_PRESETS} className="w-32" aria-label="Period" />
            <Button variant="ghost" icon="refresh" onClick={load} disabled={loading}>Refresh</Button>
          </div>
        </div>

        <TableToolbar
          className="mb-4"
          state={query}
          onChange={setQuery}
          searchPlaceholder="Email, name, group, key name or masked key…"
          filters={[
            { name: "user", label: "Người dùng", options: userOptions },
            { name: "activity", label: "Hoạt động", options: ACTIVITY_OPTIONS },
          ]}
          sortOptions={USER_SORTS}
          shown={filtered.length}
          total={items.length}
        />

        <div className="flex flex-col gap-1 text-xs text-vx-text-muted">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-medium text-vx-text">Tổng kỳ</span>
            <span><span className="font-mono font-medium text-vx-text">{fmtCompact(periodTotals.requests)}</span> requests</span>
            <span><span className="font-mono font-medium text-vx-text">{fmtCost(periodTotals)}</span> cost</span>
          </p>
          {partial && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-vx-text">Tổng đang hiển thị</span>
              <span><span className="font-mono font-medium text-vx-text">{fmtCompact(shownTotals.requests)}</span> requests</span>
              <span><span className="font-mono font-medium text-vx-text">{fmtCost(shownTotals)}</span> cost</span>
            </p>
          )}
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto" aria-busy={loading}>
          <table className="w-full min-w-[1100px] text-sm">
            <Table.Head>
              <tr>
                <Table.HeaderCell className="w-8">#</Table.HeaderCell>
                <Table.HeaderCell>User</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Keys</Table.HeaderCell>
                <SortableHeader label="Requests" field="requests" state={query} onSort={onHeaderSort} align="right" className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" />
                <Table.HeaderCell className="text-right">Input</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Output</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Input cache</Table.HeaderCell>
                <SortableHeader label="Cost" field="cost" state={query} onSort={onHeaderSort} align="right" className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" />
                <Table.HeaderCell className="text-right">Peak RPM</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Peak TPM</Table.HeaderCell>
                <SortableHeader label="Last used" field="lastUsed" state={query} onSort={onHeaderSort} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted whitespace-nowrap" />
                <Table.HeaderCell className="w-10"><span className="sr-only">Details</span></Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {tableState !== "ready" ? (
                <TableStateRow
                  state={tableState}
                  colSpan={COLS}
                  emptyMessage="No keys yet."
                  onRetry={load}
                  onClearFilters={() => setQuery(clearQueryFilters)}
                />
              ) : (
                pageRows.map((o, idx) => (
                  <OwnerRow
                    key={o.ownerId}
                    o={o}
                    rowIdx={(currentPage - 1) * pageSize + idx + 1}
                    isOpen={expanded === o.ownerId}
                    onToggle={() => setExpanded(expanded === o.ownerId ? null : o.ownerId)}
                  />
                ))
              )}
            </Table.Body>
          </table>
        </div>

        {tableState === "ready" && filtered.length > 0 && (
          <div className="border-t border-vx-border">
            <Pagination
              currentPage={currentPage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(Number(s) || PAGE_SIZE); setPage(1); }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function OwnerRow({ o, rowIdx, isOpen, onToggle }) {
  const t = o.totals || {};
  const idle = !(t.requests > 0);
  const detailsId = `owner-details-${rowIdx}`;
  return (
    <Fragment>
      <Table.Row className={cn(idle && "text-vx-text-muted")}>
        <Table.Cell className="px-3 py-2 text-vx-text-muted">{rowIdx}</Table.Cell>
        <Table.Cell className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {o.kind === "user" && o.userId ? (
              <Link href={`/dashboard/users/${encodeURIComponent(o.userId)}`} className="font-medium text-vx-text underline-offset-2 hover:underline">
                {ownerTitle(o)}
              </Link>
            ) : (
              <span className="font-medium text-vx-text">{ownerTitle(o)}</span>
            )}
            {o.status && o.status !== "active" && (
              <Badge variant="default" size="sm">{o.status}</Badge>
            )}
          </div>
          {(o.displayName || o.group) && (
            <div className="text-xs text-vx-text-muted">{[o.displayName, o.group].filter(Boolean).join(" · ")}</div>
          )}
        </Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums" title={`${o.activeKeyCount} active of ${o.keyCount}`}>
          {o.activeKeyCount}/{o.keyCount}
        </Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums" title={String(t.requests ?? 0)}>{fmtCompact(t.requests)}</Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums" title={String(t.input ?? 0)}>{fmtCompact(t.input)}</Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums" title={String(t.output ?? 0)}>{fmtCompact(t.output)}</Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">
          {t.cacheRead > 0 ? `${t.cacheEstimated ? "≈" : ""}${fmtCompact(t.cacheRead)}` : "—"}
        </Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCost(t)}</Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(o.peakRpm)}</Table.Cell>
        <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(o.peakTpm)}</Table.Cell>
        <Table.Cell className="px-3 py-2 font-mono text-xs whitespace-nowrap">{fmtWhen(o.lastUsedAt)}</Table.Cell>
        <Table.Cell className="px-3 py-2 text-right">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-controls={detailsId}
            aria-label={`${isOpen ? "Hide" : "Show"} keys and models of ${ownerTitle(o)}`}
            className="w-8 border border-vx-border px-0"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{isOpen ? "expand_less" : "expand_more"}</span>
          </Button>
        </Table.Cell>
      </Table.Row>
      {isOpen && (
        <tr id={detailsId} className="bg-vx-surface-2/30">
          <td colSpan={COLS} className="p-4">
            <div className="grid gap-6 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-vx-text-muted">Keys ({o.keys.length})</h3>
                <table className="w-full text-sm">
                  <Table.Head>
                    <tr>
                      <Table.HeaderCell className="px-2 py-1.5">Key</Table.HeaderCell>
                      <Table.HeaderCell className="px-2 py-1.5">Status</Table.HeaderCell>
                      <Table.HeaderCell className="px-2 py-1.5 text-right">Requests</Table.HeaderCell>
                      <Table.HeaderCell className="px-2 py-1.5 text-right">Tokens</Table.HeaderCell>
                      <Table.HeaderCell className="px-2 py-1.5 text-right">Cost</Table.HeaderCell>
                      <Table.HeaderCell className="px-2 py-1.5">Last used</Table.HeaderCell>
                    </tr>
                  </Table.Head>
                  <Table.Body>
                    {o.keys.map((k) => (
                      <Table.Row key={k.id}>
                        <Table.Cell className="px-2 py-1.5">
                          <div className="text-vx-text">{k.noKey ? "No key (local)" : k.deleted ? "Deleted key" : k.name || "(unnamed)"}</div>
                          {k.maskedKey && <div className="whitespace-nowrap font-mono text-xs text-vx-text-muted">{k.maskedKey}</div>}
                        </Table.Cell>
                        <Table.Cell className="px-2 py-1.5 text-xs">{k.noKey ? "—" : k.deleted ? "deleted" : k.active ? "active" : "paused"}</Table.Cell>
                        <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(k.requests)}</Table.Cell>
                        <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(k.tokens)}</Table.Cell>
                        <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(k)}</Table.Cell>
                        <Table.Cell className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{fmtWhen(k.lastUsedAt)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </table>
              </section>
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-vx-text-muted">Models ({o.byModel.length})</h3>
                {o.byModel.length === 0 ? (
                  <p className="text-sm text-vx-text-muted">No usage in this period.</p>
                ) : (
                  <table className="w-full text-sm">
                    <Table.Head>
                      <tr>
                        <Table.HeaderCell className="px-2 py-1.5">Model</Table.HeaderCell>
                        <Table.HeaderCell className="px-2 py-1.5 text-right">Requests</Table.HeaderCell>
                        <Table.HeaderCell className="px-2 py-1.5 text-right">Input</Table.HeaderCell>
                        <Table.HeaderCell className="px-2 py-1.5 text-right">Output</Table.HeaderCell>
                        <Table.HeaderCell className="px-2 py-1.5 text-right">Input cache</Table.HeaderCell>
                        <Table.HeaderCell className="px-2 py-1.5 text-right">Cost</Table.HeaderCell>
                      </tr>
                    </Table.Head>
                    <Table.Body>
                      {o.byModel.map((m) => (
                        <Table.Row key={m.model}>
                          <Table.Cell className="px-2 py-1.5 font-mono text-vx-text">{m.model}</Table.Cell>
                          <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(m.requests)}</Table.Cell>
                          <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(m.input)}</Table.Cell>
                          <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(m.output)}</Table.Cell>
                          <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {m.cacheRead > 0 ? `${m.cacheEstimated ? "≈" : ""}${fmtCompact(m.cacheRead)}` : "—"}
                          </Table.Cell>
                          <Table.Cell className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(m)}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </table>
                )}
              </section>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
