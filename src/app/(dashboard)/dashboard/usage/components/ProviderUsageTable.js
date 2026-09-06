"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";

const PERIOD_PRESETS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

function fmtCompact(v) {
  if (v == null) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}
function fmtCost(v) {
  if (v == null) return "—";
  return `$${Number(v).toFixed(4)}`;
}

export default function ProviderUsageTable() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState("30d");
  const [sortKey, setSortKey] = useState("requests");
  const [sortDir, setSortDir] = useState("desc");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ period });
      const res = await fetch(`/api/usage/provider-summary?${params}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (e) {
      setError(e.message || "Failed to load provider usage");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      const cmp = (typeof av === "number" && typeof bv === "number")
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [items, sortKey, sortDir]);

  const onSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortIcon = (key) =>
    sortKey === key ? (sortDir === "asc" ? "arrow_upward" : "arrow_downward") : "unfold_more";

  // Totals row
  const totals = useMemo(() => {
    return items.reduce(
      (acc, it) => {
        acc.requests += it.requests || 0;
        acc.input += it.input || 0;
        acc.output += it.output || 0;
        acc.cost += it.cost || 0;
        acc.liveRpm += it.liveRpm || 0;
        acc.liveTpm += it.liveTpm || 0;
        acc.peakRpm = Math.max(acc.peakRpm, it.peakRpm || 0);
        acc.peakTpm = Math.max(acc.peakTpm, it.peakTpm || 0);
        acc.peakTokS = Math.max(acc.peakTokS, it.peakTokS || 0);
        return acc;
      },
      { requests: 0, input: 0, output: 0, cost: 0, liveRpm: 0, liveTpm: 0, peakRpm: 0, peakTpm: 0, peakTokS: 0 }
    );
  }, [items]);

  const periodLabel = PERIOD_PRESETS.find((p) => p.value === period)?.label || period;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">dns</span>
              Provider Usage
            </h2>
            <p className="text-sm text-text-muted mt-1">
              Per-provider live RPM/TPM (last 60s), peak RPM/TPM/Tok-s, token volume, cost and requests for {periodLabel}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)} options={PERIOD_PRESETS} className="w-32" />
            <Button variant="ghost" icon="refresh" onClick={load} disabled={loading}>Refresh</Button>
          </div>
        </div>

        <div className="text-xs text-text-muted mb-3 flex items-center gap-3">
          <span><span className="font-medium text-text-main">{items.length}</span> providers</span>
        </div>
      </Card>

      <Card padding="none">
        {error ? (
          <div className="p-6 text-sm text-red-500 flex items-center gap-2">
            <span className="material-symbols-outlined">error</span>{error}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-text-muted">
                  <th className="text-left font-medium px-3 py-2 w-8">#</th>
                  <th className="text-left font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("name")}>
                      Provider
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("name")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("requests")}>
                      Requests
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("requests")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("input")}>
                      Input
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("input")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("output")}>
                      Output
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("output")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("cost")}>
                      Cost
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("cost")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("liveRpm")}>
                      RPM
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("liveRpm")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    <button className="inline-flex items-center gap-1 hover:text-text-main" onClick={() => onSort("liveTpm")}>
                      TPM
                      <span className="material-symbols-outlined text-[14px]">{sortIcon("liveTpm")}</span>
                    </button>
                  </th>
                  <th className="text-right font-medium px-3 py-2">Peak RPM</th>
                  <th className="text-right font-medium px-3 py-2">Peak TPM</th>
                  <th className="text-right font-medium px-3 py-2">Peak Tok/s</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-text-muted">
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                        Loading…
                      </div>
                    </td>
                  </tr>
                ) : sorted.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-text-muted">No provider usage in this period.</td>
                  </tr>
                ) : (
                  <>
                    {sorted.map((it, idx) => (
                      <tr key={it.provider} className="border-b border-border-subtle/50 hover:bg-surface-2/50">
                        <td className="px-3 py-2 text-text-muted">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-text-main">{it.name || it.provider}</div>
                          <div className="font-mono text-xs text-text-muted">{it.provider}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.requests)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.input)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.output)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCost(it.cost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.liveRpm)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.liveTpm)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.peakRpm)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.peakTpm)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(it.peakTokS)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border-subtle font-medium bg-surface-2/30">
                      <td className="px-3 py-2"></td>
                      <td className="px-3 py-2">Total ({items.length})</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(totals.requests)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(totals.input)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(totals.output)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCost(totals.cost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title="Sum of live RPM across providers">{fmtCompact(totals.liveRpm)}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title="Sum of live TPM across providers">{fmtCompact(totals.liveTpm)}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title="Max peak across providers">{fmtCompact(totals.peakRpm)}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title="Max peak across providers">{fmtCompact(totals.peakTpm)}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title="Max peak across providers">{fmtCompact(totals.peakTokS)}</td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
