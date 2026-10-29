"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eyebrow, Stat } from "@/app/account/components/ui";

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

  const field = "h-9 border border-border bg-surface px-3 font-mono text-xs text-text-main focus:border-text-main focus:outline-none";

  return (
    <div className="flex flex-col gap-8">
      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <label htmlFor="account-usage-key"><Eyebrow>API key</Eyebrow></label>
          <select
            id="account-usage-key"
            value={selectedKeyId || ""}
            onChange={(event) => router.push(hrefFor({ key: event.target.value, period }))}
            className={`${field} min-w-[240px]`}
          >
            {keys.map((key) => (
              <option key={key.id} value={key.id}>
                {key.name} · {key.keyPrefix}…{key.isActive ? "" : " (đã tắt)"}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <Eyebrow>Khoảng thời gian</Eyebrow>
          <div className="flex border border-border" role="group" aria-label="Khoảng thời gian">
            {periods.map((p, index) => (
              <Link
                key={p.id}
                href={hrefFor({ key: selectedKeyId, period: p.id })}
                aria-current={p.id === period ? "true" : undefined}
                className={`flex h-9 items-center px-4 font-mono text-xs font-medium transition-colors duration-150 ${
                  index > 0 ? "border-l border-border" : ""
                } ${
                  p.id === period
                    ? "bg-text-main text-bg"
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
      <dl className="grid grid-cols-2 gap-px border border-border bg-border lg:grid-cols-4">
        {[
          { label: "Số request", value: fmt(totals.requests) },
          { label: "Tổng token", value: fmt(totals.tokens) },
          { label: "Token vào", value: fmt(totals.input) },
          { label: "Chi phí", value: totals.costLabel },
        ].map((item) => (
          <div key={item.label} className="bg-surface p-5">
            <Stat label={item.label} value={item.value} />
          </div>
        ))}
      </dl>

      {/* Receipts */}
      <div className="border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-base font-semibold text-text-main">
              <span className="mr-2 text-text-subtle" aria-hidden="true">{"//"}</span>Bản ghi
            </h2>
            <span className="font-mono text-xs text-text-muted">
              {filtered.length}
              {rows.length >= historyLimit ? ` trong ${historyLimit} gần nhất` : ""}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={filterModel}
              onChange={(event) => setFilterModel(event.target.value)}
              placeholder="Lọc theo model"
              aria-label="Lọc theo model"
              className={`${field} w-44`}
            />
            <select
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
              aria-label="Lọc theo trạng thái"
              className={field}
            >
              <option value="">Mọi trạng thái</option>
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
                className="h-9 border border-border px-3 font-mono text-xs text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-main"
              >
                Xoá lọc
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-text-muted">
            {rows.length === 0
              ? "Chưa có request nào trong khoảng thời gian này."
              : "Không có request nào khớp bộ lọc."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-surface-2">
                <tr className="border-b border-border text-text-muted">
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Thời điểm</th>
                  <th className="px-4 py-3 text-left font-medium">Model</th>
                  <th className="px-4 py-3 text-center font-medium">Trạng thái</th>
                  <th className="px-4 py-3 text-right font-medium">Độ trễ</th>
                  <th className="px-4 py-3 text-right font-medium">Vào</th>
                  <th className="px-4 py-3 text-right font-medium">Ra</th>
                  <th className="px-4 py-3 text-right font-medium">Tổng</th>
                  <th className="px-4 py-3 text-right font-medium">Cache đọc</th>
                  <th className="px-4 py-3 text-right font-medium">Cache ghi</th>
                  <th className="px-4 py-3 text-right font-medium">Chi phí</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, index) => (
                  <tr key={`${row.timestamp}-${index}`} className="border-b border-border last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                      {row.timestamp ? new Date(row.timestamp).toLocaleString("vi-VN") : "—"}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 font-mono" title={row.model}>
                      {row.model}
                    </td>
                    <td className={`px-4 py-3 text-center font-mono ${statusClass(row.status)}`}>{row.status}</td>
                    <td className="px-4 py-3 text-right font-mono text-text-muted">
                      {row.latencyMs != null ? `${row.latencyMs} ms` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{fmt(row.input)}</td>
                    <td className="px-4 py-3 text-right font-mono">{fmt(row.output)}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmt(row.tok)}
                      {row.tokS != null && <span className="ml-1 text-[10px] text-text-subtle">{row.tokS} t/s</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{fmt(row.cacheRead)}</td>
                    <td className="px-4 py-3 text-right font-mono">{fmt(row.cacheCreation)}</td>
                    <td className="px-4 py-3 text-right font-mono">{row.costLabel}</td>
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
