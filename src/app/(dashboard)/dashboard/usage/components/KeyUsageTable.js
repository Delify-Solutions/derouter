"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { maskKeyFull } from "@/shared/utils/apiKey";

const PAGE_SIZE = 20;

const PERIOD_PRESETS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

function periodToRange(period) {
  const now = new Date();
  let start, end;
  if (period === "today") {
    start = new Date(now); start.setHours(0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
  } else if (period === "24h") {
    start = new Date(now.getTime() - 24 * 3600_000);
    end = now;
  } else {
    const days = period === "7d" ? 7 : period === "30d" ? 30 : 60;
    start = new Date(now.getTime() - days * 86400_000);
    end = now;
  }
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function fmtCompact(v) {
  if (v == null) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}
function fmtCost(v) {
  if (v == null) return "—";
  return `$${Number(v).toFixed(4)}`;
}
function fmtPct(used, total) {
  if (total == null || total === 0) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

export default function KeyUsageTable() {
  const [items, setItems] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [period, setPeriod] = useState("30d");
  const [expandedRow, setExpandedRow] = useState(null);

  const loadGroups = useCallback(async () => {
    try {
      const res = await fetch("/api/groups");
      const data = await res.json();
      setGroups(Array.isArray(data.groups) ? data.groups : []);
    } catch {}
  }, []);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { startDate, endDate } = periodToRange(period);
      const params = new URLSearchParams({ startDate, endDate });
      const res = await fetch(`/api/usage/key-summary?${params}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (e) {
      setError(e.message || "Failed to load key usage");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { loadGroups(); }, [loadGroups]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (q && !(it.name || "").toLowerCase().includes(q) && !(it.maskedKey || "").toLowerCase().includes(q)) return false;
      if (groupFilter === "none" && it.groupId) return false;
      if (groupFilter !== "all" && groupFilter !== "none" && it.groupId !== groupFilter) return false;
      return true;
    });
  }, [items, search, groupFilter]);

  useEffect(() => { setPage(1); }, [search, groupFilter, period, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const groupOptions = useMemo(() => [
    { value: "all", label: "All groups" },
    { value: "none", label: "Custom (no group)" },
    ...groups.map((g) => ({ value: g.id, label: g.name })),
  ], [groups]);

  const periodLabel = PERIOD_PRESETS.find((p) => p.value === period)?.label || period;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">vpn_key</span>
              Key Usage
            </h2>
            <p className="text-sm text-text-muted mt-1">
              Per-key limits, live RPM/TPM, peak TPM, cost and per-model breakdown for {periodLabel}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)} options={PERIOD_PRESETS} className="w-32" />
            <Button variant="ghost" icon="refresh" onClick={loadSummary} disabled={loading}>Refresh</Button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <Input
            placeholder="Search key name or masked key…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon="search"
            className="sm:flex-1"
          />
          <Select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            options={groupOptions}
            className="sm:w-56"
          />
        </div>

        <div className="text-xs text-text-muted mb-3 flex items-center gap-3">
          <span><span className="font-medium text-text-main">{filtered.length}</span> of {items.length} keys</span>
          <span className="inline-flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px] text-amber-500">visibility_off</span>
            Keys masked
          </span>
        </div>
      </Card>

      <Card padding="none">
        {error ? (
          <div className="p-6 text-sm text-red-500 flex items-center gap-2">
            <span className="material-symbols-outlined">error</span>{error}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-text-muted">
                  <th className="text-left font-medium px-3 py-2 w-8">#</th>
                  <th className="text-left font-medium px-3 py-2">Key</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">RPM (limit / live)</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">TPM (limit / live)</th>
                  <th className="text-left font-medium px-3 py-2 min-w-[160px]">Budget</th>
                  <th className="text-right font-medium px-3 py-2">Peak TPM</th>
                  <th className="text-right font-medium px-3 py-2">Requests</th>
                  <th className="text-right font-medium px-3 py-2">Input</th>
                  <th className="text-right font-medium px-3 py-2">Output</th>
                  <th className="text-right font-medium px-3 py-2">Cost</th>
                  <th className="text-right font-medium px-3 py-2">Models</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-text-muted">
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                        Loading…
                      </div>
                    </td>
                  </tr>
                ) : pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-text-muted">No keys match the current filters.</td>
                  </tr>
                ) : (
                  pageRows.map((it, idx) => {
                    const rowIdx = (currentPage - 1) * pageSize + idx + 1;
                    const isOpen = expandedRow === it.id;
                    const budgetPct = fmtPct(it.windowCostUsd, it.budgetUsd);
                    const models = it.byModel || [];
                    return (
                      <RowFragment
                        key={it.id}
                        it={it}
                        rowIdx={rowIdx}
                        isOpen={isOpen}
                        onToggle={() => setExpandedRow(isOpen ? null : it.id)}
                        budgetPct={budgetPct}
                        models={models}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="border-t border-border-subtle">
            <Pagination
              currentPage={currentPage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(s) => setPageSize(Number(s) || PAGE_SIZE)}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function RowFragment({ it, rowIdx, isOpen, onToggle, budgetPct, models }) {
  const status = it.active ? "active" : "paused";
  return (
    <>
      <tr
        className={cn(
          "border-b border-border-subtle/50 hover:bg-surface-2/50 cursor-pointer transition-colors",
          it.active === false && "opacity-60"
        )}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-text-muted">{rowIdx}</td>
        <td className="px-3 py-2">
          <div className="font-medium text-text-main">{it.name || "(unnamed)"}</div>
          <div className="font-mono text-xs text-text-muted">{it.maskedKey}</div>
          {it.group && <div className="text-xs text-text-muted">{it.group}</div>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          <span className="font-medium">{it.rpm ?? "∞"}</span>
          <span className="text-text-muted"> / {fmtCompact(it.liveRpm)}</span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          <span className="font-medium">{it.tpm ?? "∞"}</span>
          <span className="text-text-muted"> / {fmtCompact(it.liveTpm)}</span>
        </td>
        <td className="px-3 py-2">
          {it.budgetUsd == null ? (
            <span className="text-text-muted">∞</span>
          ) : (
            <div className="flex flex-col gap-1 min-w-[140px]">
              <span className="text-xs tabular-nums">
                ${Number(it.windowCostUsd || 0).toFixed(4)} / ${Number(it.budgetUsd).toFixed(2)}
              </span>
              <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                <div
                  className={cn("h-full rounded-full", (budgetPct || 0) > 90 ? "bg-red-500" : "bg-brand-500")}
                  style={{ width: `${budgetPct || 0}%` }}
                />
              </div>
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.peakTpm)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.totals?.requests)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.totals?.input)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.totals?.output)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtCost(it.totals?.cost)}</td>
        <td className="px-3 py-2 text-right">
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs px-2 py-0.5 rounded-full cursor-pointer",
              models.length > 0 ? "bg-brand-500/10 text-brand-600 dark:text-brand-400" : "text-text-muted"
            )}
            title={models.length > 0 ? "Expand to see per-model usage" : ""}
          >
            {models.length}
            <span className="material-symbols-outlined text-[14px]">{isOpen ? "expand_less" : "expand_more"}</span>
          </span>
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <span className={cn(
              "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full w-fit",
              status === "active" ? "bg-green-500/15 text-green-600 dark:text-green-400" : "bg-surface-3 text-text-muted"
            )}>
              <span className="material-symbols-outlined text-[12px]">{status === "active" ? "check_circle" : "pause_circle"}</span>
              {status}
            </span>
            {it.expiresAt && (
              <span className="text-xs text-text-muted">
                exp {new Date(it.expiresAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-surface-2/30">
          <td colSpan={12} className="p-4">
            <div className="flex flex-col gap-4">
              {/* Window info */}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-muted">
                <span>Window: <span className="font-medium text-text-main">{it.resetWindow || "—"}</span></span>
                <span>Started: <span className="font-medium text-text-main">{it.windowStartedAt ? new Date(it.windowStartedAt).toLocaleString() : "—"}</span></span>
                <span>Reset at: <span className="font-medium text-text-main">{it.resetAt ? new Date(it.resetAt).toLocaleString() : "—"}</span></span>
                <span>Remaining: <span className="font-medium text-text-main">{it.remainingBudgetUsd == null ? "∞" : `$${Number(it.remainingBudgetUsd).toFixed(4)}`}</span></span>
                {it.allowedModels && (
                  <span>Allowed models: <span className="font-medium text-text-main">{Array.isArray(it.allowedModels) ? it.allowedModels.join(", ") : "—"}</span></span>
                )}
              </div>

              {/* Per-model usage sub-table */}
              {models.length === 0 ? (
                <div className="text-sm text-text-muted">No usage in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-text-muted border-b border-border-subtle">
                        <th className="text-left font-medium px-2 py-1.5">Model</th>
                        <th className="text-right font-medium px-2 py-1.5">Requests</th>
                        <th className="text-right font-medium px-2 py-1.5">Input</th>
                        <th className="text-right font-medium px-2 py-1.5">Output</th>
                        <th className="text-right font-medium px-2 py-1.5">Cache Read</th>
                        <th className="text-right font-medium px-2 py-1.5">Cache Write</th>
                        <th className="text-right font-medium px-2 py-1.5">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((m) => (
                        <tr key={m.model} className="border-b border-border-subtle/40">
                          <td className="px-2 py-1.5 font-mono text-text-main">{m.model}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(m.requests)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(m.input)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(m.output)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{m.cacheRead > 0 ? fmtCompact(m.cacheRead) : "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{m.cacheCreation > 0 ? fmtCompact(m.cacheCreation) : "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtCost(m.cost)}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-border-subtle font-medium">
                        <td className="px-2 py-1.5">Total</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(it.totals?.requests)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(it.totals?.input)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(it.totals?.output)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(it.totals?.cacheRead)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtCompact(it.totals?.cacheCreation)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtCost(it.totals?.cost)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
