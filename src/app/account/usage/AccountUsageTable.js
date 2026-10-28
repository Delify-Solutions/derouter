"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const fmt = (n) => (typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : "0");

function statusClass(status) {
  const s = String(status || "");
  if (!s || s === "—") return "text-text-muted";
  if (s.startsWith("2")) return "text-brand-700 dark:text-brand-400";
  if (s.startsWith("4")) return "text-amber-600 dark:text-amber-400";
  if (s.startsWith("5")) return "text-red-600 dark:text-red-400";
  return "text-text-muted";
}

// Read-only receipt table. Data is assembled on the server (the plaintext key
// never leaves it), so this component only filters and renders — no fetches, no
// mutations. Period and key selection are links, which keeps the view shareable
// and the page a server render.
export default function AccountUsageTable({
  keys,
  selectedKeyId,
  period,
  periods,
  totals,
  rows,
  historyLimit,
}) {
  const router = useRouter();
  const [filterModel, setFilterModel] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const filtered = useMemo(() => {
    const q = filterModel.trim().toLowerCase();
    return rows.filter((row) => {
      if (q && !String(row.model || "").toLowerCase().includes(q)) return false;
      if (filterStatus && !String(row.status || "").startsWith(filterStatus)) return false;
      return true;
    });
  }, [rows, filterModel, filterStatus]);

  const hrefFor = (next) => {
    const params = new URLSearchParams();
    if (next.key) params.set("key", next.key);
    if (next.period) params.set("period", next.period);
    const qs = params.toString();
    return `/account/usage${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Filters */}
      <div className="flex flex-col gap-3 border border-border p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="account-usage-key"
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted"
          >
            Key
          </label>
          <select
            id="account-usage-key"
            value={selectedKeyId || ""}
            onChange={(event) => router.push(hrefFor({ key: event.target.value, period }))}
            className="h-10 min-w-[220px] border border-border bg-surface px-3 font-mono text-xs text-text-main focus:border-brand-500 focus:outline-none"
          >
            {keys.map((key) => (
              <option key={key.id} value={key.id}>
                {key.name} · {key.keyPrefix}…{key.isActive ? "" : " (paused)"}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Period</span>
          <div className="flex border border-border">
            {periods.map((p, index) => (
              <Link
                key={p.id}
                href={hrefFor({ key: selectedKeyId, period: p.id })}
                className={`h-10 flex items-center px-4 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors duration-150 ${
                  index > 0 ? "border-l border-border" : ""
                } ${
                  p.id === period
                    ? "bg-brand-500 text-white"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Totals */}
      <dl className="grid grid-cols-2 border border-border sm:grid-cols-4">
        {[
          { label: "Requests", value: fmt(totals.requests) },
          { label: "Tokens", value: fmt(totals.tokens) },
          { label: "Input", value: fmt(totals.input) },
          { label: "Cost", value: totals.costLabel },
        ].map((item, index) => (
          <div
            key={item.label}
            className={`px-4 py-3 ${index > 0 ? "border-l border-border" : ""} ${
              index >= 2 ? "border-t border-border sm:border-t-0" : ""
            }`}
          >
            <dt className="meta text-text-muted">{item.label}</dt>
            <dd className="mt-1 font-mono text-sm text-text-main">{item.value}</dd>
          </div>
        ))}
      </dl>

      {/* Receipts */}
      <div className="border border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Receipts</h2>
            <span className="font-mono text-[11px] text-text-muted">
              {filtered.length}
              {rows.length >= historyLimit ? ` of the latest ${historyLimit}` : ""}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={filterModel}
              onChange={(event) => setFilterModel(event.target.value)}
              placeholder="Filter by model"
              className="h-8 w-44 border border-border bg-surface px-2 font-mono text-[11px] text-text-main focus:border-brand-500 focus:outline-none"
            />
            <select
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
              className="h-8 border border-border bg-surface px-2 font-mono text-[11px] text-text-main focus:border-brand-500 focus:outline-none"
            >
              <option value="">All statuses</option>
              <option value="2">2xx</option>
              <option value="4">4xx</option>
              <option value="5">5xx</option>
            </select>
            {(filterModel || filterStatus) && (
              <button
                type="button"
                onClick={() => {
                  setFilterModel("");
                  setFilterStatus("");
                }}
                className="h-8 border border-border px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted hover:bg-surface-2"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-text-muted">
            {rows.length === 0
              ? "No requests in this period."
              : "No requests match the current filters."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-surface-2">
                <tr className="border-b border-border text-text-muted">
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Time</th>
                  <th className="px-3 py-2 text-left font-medium">Model</th>
                  <th className="px-3 py-2 text-center font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Latency</th>
                  <th className="px-3 py-2 text-right font-medium">Input</th>
                  <th className="px-3 py-2 text-right font-medium">Output</th>
                  <th className="px-3 py-2 text-right font-medium">Tok</th>
                  <th className="px-3 py-2 text-right font-medium">Cache R</th>
                  <th className="px-3 py-2 text-right font-medium">Cache W</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, index) => (
                  <tr key={`${row.timestamp}-${index}`} className="border-b border-border/60 last:border-b-0">
                    <td className="px-3 py-2 whitespace-nowrap text-text-muted">
                      {row.timestamp ? new Date(row.timestamp).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono max-w-[200px] truncate" title={row.model}>
                      {row.model}
                    </td>
                    <td className={`px-3 py-2 text-center font-mono ${statusClass(row.status)}`}>
                      {row.status}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text-muted">
                      {row.latencyMs != null ? `${row.latencyMs} ms` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(row.input)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(row.output)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {fmt(row.tok)}
                      {row.tokS != null && (
                        <span className="ml-1 text-[10px] text-text-subtle">{row.tokS} t/s</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(row.cacheRead)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(row.cacheCreation)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.costLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
