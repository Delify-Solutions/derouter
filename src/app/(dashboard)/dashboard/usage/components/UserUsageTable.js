"use client";

import { Fragment, useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { fmtUsd } from "@/shared/utils/money";

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

const SHOW_OPTIONS = [
  { value: "all", label: "All users" },
  { value: "active", label: "With requests" },
];

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
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("30d");
  const [show, setShow] = useState("all");
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(periodToRange(period));
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((o) => {
      if (show === "active" && !(o.totals?.requests > 0)) return false;
      if (!q) return true;
      const hay = [o.email, o.displayName, o.group, ownerTitle(o), ...(o.keys || []).flatMap((k) => [k.name, k.maskedKey])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, search, show]);

  const totals = useMemo(() => filtered.reduce(
    (acc, o) => {
      acc.requests += o.totals?.requests || 0;
      acc.costNanoUsd += o.totals?.costNanoUsd || 0;
      return acc;
    },
    { requests: 0, costNanoUsd: 0 }
  ), [filtered]);

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
              <span className="material-symbols-outlined text-primary" aria-hidden="true">group</span>
              Usage by user
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Requests, tokens and cost per customer over all of their keys, for {periodLabel}. Open a row for its keys and models.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onChange={(e) => { setPeriod(e.target.value); setPage(1); }} options={PERIOD_PRESETS} className="w-32" aria-label="Period" />
            <Button variant="ghost" icon="refresh" onClick={load} disabled={loading}>Refresh</Button>
          </div>
        </div>

        <div className="mb-4 flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="Search email, name, group, key name or masked key…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            icon="search"
            className="sm:flex-1"
            aria-label="Search users"
          />
          <Select value={show} onChange={(e) => { setShow(e.target.value); setPage(1); }} options={SHOW_OPTIONS} className="sm:w-44" aria-label="Show" />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <span><span className="font-medium text-text-main">{filtered.length}</span> of {items.length} users</span>
          <span><span className="font-mono font-medium text-text-main">{fmtCompact(totals.requests)}</span> requests</span>
          <span><span className="font-mono font-medium text-text-main">{fmtCost(totals)}</span> cost</span>
        </div>
      </Card>

      <Card padding="none">
        {error ? (
          <div role="alert" className="flex items-center gap-2 p-6 text-sm text-danger">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>{error}
          </div>
        ) : (
          <div className="overflow-x-auto" aria-busy={loading}>
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-text-muted">
                  <th className="w-8 px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">User</th>
                  <th className="px-3 py-2 text-right font-medium">Keys</th>
                  <th className="px-3 py-2 text-right font-medium">Requests</th>
                  <th className="px-3 py-2 text-right font-medium">Input</th>
                  <th className="px-3 py-2 text-right font-medium">Output</th>
                  <th className="px-3 py-2 text-right font-medium">Input cache</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Peak RPM</th>
                  <th className="px-3 py-2 text-right font-medium">Peak TPM</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Last used</th>
                  <th className="w-10 px-3 py-2"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={COLS} className="p-8 text-center text-text-muted">
                      <span className="inline-flex items-center gap-2">
                        <span className="material-symbols-outlined animate-spin text-[20px]" aria-hidden="true">progress_activity</span>
                        Loading…
                      </span>
                    </td>
                  </tr>
                ) : pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={COLS} className="p-8 text-center text-text-muted">
                      {items.length === 0 ? "No keys yet." : "No users match the current filters."}
                    </td>
                  </tr>
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
      <tr className={cn("border-b border-border-subtle/50 transition-colors hover:bg-surface-2/50", idle && "text-text-muted")}>
        <td className="px-3 py-2 text-text-muted">{rowIdx}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {o.kind === "user" && o.userId ? (
              <Link href={`/dashboard/users/${encodeURIComponent(o.userId)}`} className="font-medium text-text-main underline-offset-2 hover:underline">
                {ownerTitle(o)}
              </Link>
            ) : (
              <span className="font-medium text-text-main">{ownerTitle(o)}</span>
            )}
            {o.status && o.status !== "active" && (
              <span className="border border-border px-1.5 py-0.5 font-mono text-[11px] uppercase text-text-muted">{o.status}</span>
            )}
          </div>
          {(o.displayName || o.group) && (
            <div className="text-xs text-text-muted">{[o.displayName, o.group].filter(Boolean).join(" · ")}</div>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums" title={`${o.activeKeyCount} active of ${o.keyCount}`}>
          {o.activeKeyCount}/{o.keyCount}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums" title={String(t.requests ?? 0)}>{fmtCompact(t.requests)}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums" title={String(t.input ?? 0)}>{fmtCompact(t.input)}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums" title={String(t.output ?? 0)}>{fmtCompact(t.output)}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums">
          {t.cacheRead > 0 ? `${t.cacheEstimated ? "≈" : ""}${fmtCompact(t.cacheRead)}` : "—"}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCost(t)}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(o.peakRpm)}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtCompact(o.peakTpm)}</td>
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{fmtWhen(o.lastUsedAt)}</td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-controls={detailsId}
            aria-label={`${isOpen ? "Hide" : "Show"} keys and models of ${ownerTitle(o)}`}
            className="flex size-8 items-center justify-center border border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{isOpen ? "expand_less" : "expand_more"}</span>
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr id={detailsId} className="bg-surface-2/30">
          <td colSpan={COLS} className="p-4">
            <div className="grid gap-6 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Keys ({o.keys.length})</h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle text-text-muted">
                      <th className="px-2 py-1.5 text-left font-medium">Key</th>
                      <th className="px-2 py-1.5 text-left font-medium">Status</th>
                      <th className="px-2 py-1.5 text-right font-medium">Requests</th>
                      <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
                      <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                      <th className="px-2 py-1.5 text-left font-medium">Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.keys.map((k) => (
                      <tr key={k.id} className="border-b border-border-subtle/40">
                        <td className="px-2 py-1.5">
                          <div className="text-text-main">{k.noKey ? "No key (local)" : k.deleted ? "Deleted key" : k.name || "(unnamed)"}</div>
                          {k.maskedKey && <div className="whitespace-nowrap font-mono text-xs text-text-muted">{k.maskedKey}</div>}
                        </td>
                        <td className="px-2 py-1.5 text-xs">{k.noKey ? "—" : k.deleted ? "deleted" : k.active ? "active" : "paused"}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(k.requests)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(k.tokens)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(k)}</td>
                        <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{fmtWhen(k.lastUsedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Models ({o.byModel.length})</h3>
                {o.byModel.length === 0 ? (
                  <p className="text-sm text-text-muted">No usage in this period.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle text-text-muted">
                        <th className="px-2 py-1.5 text-left font-medium">Model</th>
                        <th className="px-2 py-1.5 text-right font-medium">Requests</th>
                        <th className="px-2 py-1.5 text-right font-medium">Input</th>
                        <th className="px-2 py-1.5 text-right font-medium">Output</th>
                        <th className="px-2 py-1.5 text-right font-medium">Input cache</th>
                        <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.byModel.map((m) => (
                        <tr key={m.model} className="border-b border-border-subtle/40">
                          <td className="px-2 py-1.5 font-mono text-text-main">{m.model}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(m.requests)}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(m.input)}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCompact(m.output)}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {m.cacheRead > 0 ? `${m.cacheEstimated ? "≈" : ""}${fmtCompact(m.cacheRead)}` : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(m)}</td>
                        </tr>
                      ))}
                    </tbody>
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
