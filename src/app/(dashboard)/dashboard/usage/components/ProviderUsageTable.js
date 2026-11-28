"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import Table from "@/shared/components/Table";
import TableToolbar, { useTableQuery, SortableHeader } from "@/shared/components/TableToolbar";
import { TableStateRow } from "@/shared/components/TableState";
import { applyTableQuery, nextSortState, hasActiveQuery, clearQueryFilters, tableStateOf } from "@/shared/utils/tableQuery";

const PERIOD_PRESETS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

// Shared toolbar (spec admin-usage-views): default order is requests, most first. The
// columns that were sortable before the toolbar keep their header sort through it.
const PROVIDER_SORTS = [
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Chi phí" },
  { value: "lastUsed", label: "Lần dùng cuối" },
  { value: "name", label: "Tên" },
  { value: "input", label: "Input" },
  { value: "output", label: "Output" },
  { value: "liveRpm", label: "RPM" },
  { value: "liveTpm", label: "TPM" },
];
const PROVIDER_DEFAULTS = { sort: "requests", dir: "desc", top: 0 };
const PROVIDER_QUERY_OPTIONS = { sortFields: PROVIDER_SORTS.map((s) => s.value) };
const COLS = 12;

const providerName = (it) => it.name || it.provider || "";
// Integer nanoUSD (money rule): the authoritative figure, the legacy float only as fallback.
const costNanoOf = (it) => (it.costNanoUsd != null ? Math.round(it.costNanoUsd) : Math.round(Number(it.cost || 0) * 1e9));

function providerSortValue(it, field) {
  switch (field) {
    case "name": return providerName(it) || null;
    case "tokens": return (it.input || 0) + (it.output || 0);
    case "cost": return costNanoOf(it);
    case "lastUsed": {
      // No request in the period: sorts after every provider that has one.
      const ms = it.lastUsed ? Date.parse(it.lastUsed) : NaN;
      return Number.isFinite(ms) ? ms : null;
    }
    default: return Object.hasOwn(it, field) ? (it[field] ?? 0) : 0;
  }
}

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
}

// Sums over a list of provider rows: requests, tokens, cost and live rates add up; peaks
// are the maximum.
function sumProviders(list) {
  return list.reduce(
    (acc, it) => {
      acc.requests += it.requests || 0;
      acc.input += it.input || 0;
      acc.output += it.output || 0;
      acc.costNanoUsd += costNanoOf(it);
      acc.liveRpm += it.liveRpm || 0;
      acc.liveTpm += it.liveTpm || 0;
      acc.peakRpm = Math.max(acc.peakRpm, it.peakRpm || 0);
      acc.peakTpm = Math.max(acc.peakTpm, it.peakTpm || 0);
      acc.peakTokS = Math.max(acc.peakTokS, it.peakTokS || 0);
      if (it.lastUsed && (!acc.lastUsed || it.lastUsed > acc.lastUsed)) acc.lastUsed = it.lastUsed;
      return acc;
    },
    { requests: 0, input: 0, output: 0, costNanoUsd: 0, liveRpm: 0, liveTpm: 0, peakRpm: 0, peakTpm: 0, peakTokS: 0, lastUsed: null }
  );
}

function TotalsRow({ label, count, t }) {
  return (
    <tr className="border-t-2 border-vx-border font-medium bg-vx-surface-2/30">
      <td className="px-3 py-2"></td>
      <td className="px-3 py-2">{label} (<span className="font-mono tabular-nums">{count}</span>)</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(t.requests)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(t.input)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(t.output)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCostNano(t.costNanoUsd)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums" title="Sum of live RPM across providers">{fmtCompact(t.liveRpm)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums" title="Sum of live TPM across providers">{fmtCompact(t.liveTpm)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums" title="Max peak across providers">{fmtCompact(t.peakRpm)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums" title="Max peak across providers">{fmtCompact(t.peakTpm)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums" title="Max peak across providers">{fmtCompact(t.peakTokS)}</td>
      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{fmtWhen(t.lastUsed)}</td>
    </tr>
  );
}

function fmtCompact(v) {
  if (v == null) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}
// Summed as integer nanoUSD; converted to dollars once, for display only.
function fmtCostNano(nano) {
  if (nano == null) return "—";
  return `$${(nano / 1e9).toFixed(4)}`;
}

export default function ProviderUsageTable() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState("30d");
  const [query, setQuery] = useTableQuery("providers", PROVIDER_DEFAULTS, PROVIDER_QUERY_OPTIONS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ period });
      const res = await fetch(`/api/usage/provider-summary?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load provider usage");
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      setError(e.message || "Failed to load provider usage");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const providerOptions = useMemo(
    () => [...new Set(items.map(providerName))].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v })),
    [items]
  );

  const result = useMemo(() => applyTableQuery(items, {
    search: query.q,
    searchFields: ["name", "provider"],
    filters: query.filters,
    filterFields: { provider: providerName },
    sortField: query.sort,
    sortDir: query.dir,
    top: query.top,
    valueOf: providerSortValue,
    nameOf: providerName,
  }), [items, query]);
  const sorted = result.rows;

  const tableState = tableStateOf({ loading, error, total: items.length, matched: result.matched, filtersActive: hasActiveQuery(query) });
  const onSort = (field) => setQuery((s) => nextSortState(s, field, { ascFirst: ["name"] }));
  const headerProps = { state: query, onSort, className: "px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" };

  // "Tổng kỳ" is the whole period whatever the search, filters or Top N; when those hide
  // providers, "Tổng đang hiển thị" adds the shown rows alone.
  const periodTotals = useMemo(() => sumProviders(items), [items]);
  const shownTotals = useMemo(() => sumProviders(sorted), [sorted]);
  const partial = sorted.length !== items.length;

  const periodLabel = PERIOD_PRESETS.find((p) => p.value === period)?.label || period;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-vx-primary" aria-hidden="true">dns</span>
              Provider Usage
            </h2>
            <p className="text-sm text-vx-text-muted mt-1">
              Per-provider live RPM/TPM (last 60s), peak RPM/TPM/Tok-s, token volume, cost and requests for {periodLabel}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)} options={PERIOD_PRESETS} className="w-32" aria-label="Period" />
            <Button variant="ghost" icon="refresh" onClick={load} disabled={loading}>Refresh</Button>
          </div>
        </div>

        <TableToolbar
          state={query}
          onChange={setQuery}
          searchPlaceholder="Provider…"
          filters={[{ name: "provider", label: "Provider", options: providerOptions }]}
          sortOptions={PROVIDER_SORTS}
          shown={sorted.length}
          total={items.length}
        />
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto" aria-busy={loading}>
          <table className="w-full min-w-[1100px] text-sm">
            <Table.Head>
              <tr>
                <Table.HeaderCell className="w-8">#</Table.HeaderCell>
                <SortableHeader label="Provider" field="name" {...headerProps} />
                <SortableHeader label="Requests" field="requests" align="right" {...headerProps} />
                <SortableHeader label="Input" field="input" align="right" {...headerProps} />
                <SortableHeader label="Output" field="output" align="right" {...headerProps} />
                <SortableHeader label="Cost" field="cost" align="right" {...headerProps} />
                <SortableHeader label="RPM" field="liveRpm" align="right" {...headerProps} />
                <SortableHeader label="TPM" field="liveTpm" align="right" {...headerProps} />
                <Table.HeaderCell className="text-right">Peak RPM</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Peak TPM</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Peak Tok/s</Table.HeaderCell>
                <SortableHeader label="Last used" field="lastUsed" {...headerProps} />
              </tr>
            </Table.Head>
            <Table.Body>
              {tableState !== "ready" ? (
                <TableStateRow
                  state={tableState}
                  colSpan={COLS}
                  emptyMessage="No provider usage in this period."
                  onRetry={load}
                  onClearFilters={() => setQuery(clearQueryFilters)}
                />
              ) : (
                <>
                  {sorted.map((it, idx) => (
                    <Table.Row key={it.provider}>
                      <Table.Cell className="px-3 py-2 text-vx-text-muted">{idx + 1}</Table.Cell>
                      <Table.Cell className="px-3 py-2">
                        <div className="font-medium text-vx-text">{providerName(it)}</div>
                        <div className="font-mono text-xs text-vx-text-muted">{it.provider}</div>
                      </Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.requests)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.input)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.output)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCostNano(costNanoOf(it))}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.liveRpm)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.liveTpm)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.peakRpm)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.peakTpm)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(it.peakTokS)}</Table.Cell>
                      <Table.Cell className="px-3 py-2 font-mono text-xs whitespace-nowrap">{fmtWhen(it.lastUsed)}</Table.Cell>
                    </Table.Row>
                  ))}
                  {partial && <TotalsRow label="Tổng đang hiển thị" count={sorted.length} t={shownTotals} />}
                  <TotalsRow label="Tổng kỳ" count={items.length} t={periodTotals} />
                </>
              )}
            </Table.Body>
          </table>
        </div>
      </Card>
    </div>
  );
}
