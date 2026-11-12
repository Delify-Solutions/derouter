"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { fmtUsdNano } from "@/shared/utils/money";
import { cn } from "@/shared/utils/cn";

const TZ_MS = 7 * 3600 * 1000;
const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];
const OTHER = "__other";

const GRANULARITIES = [
  { value: "hour", label: "Giờ" },
  { value: "day", label: "Ngày" },
  { value: "week", label: "Tuần" },
  { value: "month", label: "Tháng" },
];
const GROUP_BYS = [
  { value: "model", label: "Model khách gọi" },
  { value: "upstream", label: "Model nhà cung cấp" },
  { value: "provider", label: "Nhà cung cấp" },
  { value: "user", label: "Khách hàng" },
];

/** Start of a Vietnam local day, `daysBack` days ago, as epoch ms. */
function vnDayStart(now, daysBack = 0) {
  return Math.floor((now + TZ_MS) / 86400000) * 86400000 - TZ_MS - daysBack * 86400000;
}
function vnMonthStart(now, monthsBack = 0) {
  const d = new Date(now + TZ_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1) - TZ_MS;
}

/** Presets: [label, () => { from, to, granularity }]. */
const PRESETS = [
  { value: "today", label: "Hôm nay", range: (n) => ({ from: vnDayStart(n), to: n, granularity: "hour" }) },
  { value: "yesterday", label: "Hôm qua", range: (n) => ({ from: vnDayStart(n, 1), to: vnDayStart(n) - 1, granularity: "hour" }) },
  { value: "24h", label: "24 giờ", range: (n) => ({ from: n - 86400000, to: n, granularity: "hour" }) },
  { value: "7d", label: "7 ngày", range: (n) => ({ from: vnDayStart(n, 6), to: n, granularity: "day" }) },
  { value: "30d", label: "30 ngày", range: (n) => ({ from: vnDayStart(n, 29), to: n, granularity: "day" }) },
  { value: "month", label: "Tháng này", range: (n) => ({ from: vnMonthStart(n), to: n, granularity: "day" }) },
  { value: "lastmonth", label: "Tháng trước", range: (n) => ({ from: vnMonthStart(n, 1), to: vnMonthStart(n) - 1, granularity: "day" }) },
  { value: "90d", label: "90 ngày", range: (n) => ({ from: vnDayStart(n, 89), to: n, granularity: "week" }) },
];

/** epoch ms → "YYYY-MM-DDTHH:mm" in Vietnam time, for a datetime-local input. */
function toLocalInput(ms) {
  return new Date(ms + TZ_MS).toISOString().slice(0, 16);
}
function fromLocalInput(value) {
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? ms - TZ_MS : null;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
const fmtInt = (n) => (Number(n) || 0).toLocaleString("vi-VN");

function bucketLabel(bucket, granularity) {
  if (granularity === "hour") return `${bucket.slice(8, 10)}/${bucket.slice(5, 7)} ${bucket.slice(11, 13)}h`;
  if (granularity === "month") return `${bucket.slice(5, 7)}/${bucket.slice(0, 4)}`;
  const label = `${bucket.slice(8, 10)}/${bucket.slice(5, 7)}`;
  return granularity === "week" ? `Tuần ${label}` : label;
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap border border-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-8 border-r border-border px-3 text-xs font-medium last:border-r-0 transition-colors duration-150",
            value === option.value ? "bg-text-main text-bg" : "bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, hint }) {
  return (
    <div className="flex flex-col gap-1 bg-surface px-4 py-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">{label}</span>
      <span className="font-mono text-xl font-semibold tabular-nums text-text-main">{value}</span>
      {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
    </div>
  );
}

function UserFilter({ value, onChange }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) return undefined;
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&pageSize=8`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        setResults(Array.isArray(data.users) ? data.users : []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  if (value) {
    return (
      <div className="flex h-8 items-center gap-2 border border-border bg-surface-2 px-2 text-xs">
        <span className="font-mono text-text-main">{value.email}</span>
        <button type="button" onClick={() => onChange(null)} aria-label="Bỏ lọc khách hàng" className="text-text-muted hover:text-text-main">
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim().length < 2) setResults([]); }}
        placeholder="Lọc khách (email)…"
        aria-label="Lọc theo khách hàng"
        className="h-8 w-52 border border-border bg-surface px-2 text-xs text-text-main placeholder:text-text-subtle focus:border-text-main focus:outline-none"
      />
      {results.length > 0 ? (
        <ul className="absolute left-0 top-9 z-20 w-72 border border-border bg-surface">
          {results.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => { onChange({ id: user.id, email: user.email }); setQuery(""); setResults([]); }}
                className="block w-full truncate px-2 py-1.5 text-left font-mono text-xs text-text-main hover:bg-surface-2"
              >
                {user.email}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChartTooltip({ active, payload, label, names }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
  return (
    <div className="border border-border bg-surface px-3 py-2 text-xs">
      <p className="mb-1 text-text-muted">{label}</p>
      <p className="mb-1 font-mono font-semibold text-text-main">{fmtTokens(total)} token</p>
      {[...payload].reverse().map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3" style={{ background: p.color }} aria-hidden="true" />
          <span className="font-mono text-text-main">{fmtTokens(p.value)}</span>
          <span className="text-text-muted">{names[p.dataKey] || p.dataKey}</span>
        </p>
      ))}
    </div>
  );
}

function toCsv(groups, groupLabel) {
  const head = [groupLabel, "Request", "Lỗi", "Input", "Output", "Cache", "Tổng token", "Tỉ lệ %", "Giá trị (USD)", "Đã trừ credit (USD)"];
  // A cell starting with = + - @ (or a tab/CR) is a formula to a spreadsheet: a
  // model name a client sent, or an e-mail, must stay text.
  const esc = (v) => {
    const text = String(v ?? "");
    const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [head.map(esc).join(",")];
  for (const g of groups) {
    lines.push([
      g.label, g.requests, g.errors, g.input, g.output, g.cached, g.total, (g.share * 100).toFixed(2),
      (g.costNanoUsd / 1e9).toFixed(6), (g.chargedNanoUsd / 1e9).toFixed(6),
    ].map(esc).join(","));
  }
  return `﻿${lines.join("\n")}`;
}

/**
 * Token statistics (change usage-analytics): a range (presets or custom, Vietnam
 * time), a bucket size, a breakdown (requested model, upstream model, provider,
 * customer) and filters, all scoping the totals, the stacked chart and the table.
 * Clicking a row filters by it.
 */
export default function StatsClient() {
  const [preset, setPreset] = useState("7d");
  const [range, setRange] = useState(() => PRESETS.find((p) => p.value === "7d").range(Date.now()));
  const [granularity, setGranularity] = useState("day");
  const [groupBy, setGroupBy] = useState("model");
  const [user, setUser] = useState(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const pickPreset = (value) => {
    const p = PRESETS.find((item) => item.value === value);
    if (!p) return;
    const next = p.range(Date.now());
    setPreset(value);
    setRange({ from: next.from, to: next.to });
    setGranularity(next.granularity);
  };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      granularity,
      groupBy,
    });
    if (user) params.set("userId", user.id);
    if (provider) params.set("provider", provider);
    if (model) params.set("model", model);
    try {
      const res = await fetch(`/api/stats/tokens?${params}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) {
        // Old numbers under new filters would mislead: they go.
        setError(body.error || "Không tải được thống kê");
        setData(null);
      } else setData(body);
    } catch {
      if (mine === seq.current) { setError("Không kết nối được máy chủ"); setData(null); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [range, granularity, groupBy, user, provider, model]);

  // A burst of clicks (preset, unit, breakdown) makes one request.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const names = useMemo(() => {
    const map = { [OTHER]: "Khác" };
    for (const g of data?.groups || []) map[g.key || "∅"] = g.label;
    return map;
  }, [data]);

  const chartData = useMemo(() => (data?.series || []).map((s) => {
    const row = { label: bucketLabel(s.bucket, data.query.granularity) };
    for (const key of data.topKeys) row[key || "∅"] = s.byGroup[key] || 0;
    row[OTHER] = s.byGroup[OTHER] || 0;
    return row;
  }), [data]);
  const seriesKeys = useMemo(() => {
    if (!data) return [];
    const keys = data.topKeys.map((key) => key || "∅");
    if ((data.series || []).some((s) => (s.byGroup[OTHER] || 0) > 0)) keys.push(OTHER);
    return keys;
  }, [data]);
  const colorOf = (key, i) => (key === OTHER ? "var(--viz-other)" : SERIES[i % SERIES.length]);

  const drill = (g) => {
    if (!g.key) return;
    if (groupBy === "user") setUser({ id: g.key, email: g.label });
    else if (groupBy === "provider") setProvider(g.key);
    else setModel(g.key);
  };

  const exportCsv = () => {
    if (!data) return;
    const blob = new Blob([toCsv(data.groups, GROUP_BYS.find((g) => g.value === groupBy)?.label)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thong-ke-${groupBy}-${toLocalInput(range.from).slice(0, 10)}-${toLocalInput(range.to).slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const t = data?.totals;
  const hasData = (t?.requests || 0) > 0;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text-main">Thống kê</h1>
        <p className="text-sm text-text-muted">Token, request và chi phí theo thời gian, model, nhà cung cấp và khách hàng. Giờ Việt Nam.</p>
      </div>

      {/* Filters: one block above everything they scope. */}
      <section className="flex flex-col gap-3 border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Khoảng thời gian" options={PRESETS} value={preset} onChange={pickPreset} />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Từ</span>
            <input
              type="datetime-local"
              value={toLocalInput(range.from)}
              onChange={(e) => { const ms = fromLocalInput(e.target.value); if (ms != null) { setPreset(""); setRange((r) => ({ ...r, from: ms })); } }}
              className="h-8 border border-border bg-surface px-2 font-mono text-xs text-text-main focus:border-text-main focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Đến</span>
            <input
              type="datetime-local"
              value={toLocalInput(range.to)}
              onChange={(e) => { const ms = fromLocalInput(e.target.value); if (ms != null) { setPreset(""); setRange((r) => ({ ...r, to: ms })); } }}
              className="h-8 border border-border bg-surface px-2 font-mono text-xs text-text-main focus:border-text-main focus:outline-none"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Theo</span>
            <Segmented label="Đơn vị thời gian" options={GRANULARITIES} value={granularity} onChange={setGranularity} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Chia theo</span>
            <Segmented label="Chia theo" options={GROUP_BYS} value={groupBy} onChange={setGroupBy} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <UserFilter value={user} onChange={setUser} />
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="Lọc theo nhà cung cấp"
            className="h-8 border border-border bg-surface px-2 text-xs text-text-main focus:border-text-main focus:outline-none"
          >
            <option value="">Mọi nhà cung cấp</option>
            {(data?.options?.providers || []).concat(provider && !(data?.options?.providers || []).includes(provider) ? [provider] : [])
              .map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Lọc theo model"
            className="h-8 max-w-[260px] border border-border bg-surface px-2 text-xs text-text-main focus:border-text-main focus:outline-none"
          >
            <option value="">Mọi model</option>
            {(data?.options?.models || []).concat(model && !(data?.options?.models || []).includes(model) ? [model] : [])
              .map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {(user || provider || model) ? (
            <button type="button" onClick={() => { setUser(null); setProvider(""); setModel(""); }} className="h-8 px-2 text-xs text-text-muted underline underline-offset-4 hover:text-text-main">
              Bỏ lọc
            </button>
          ) : null}
          <span className="ml-auto" />
          <button
            type="button"
            onClick={exportCsv}
            disabled={!hasData}
            className="inline-flex h-8 items-center gap-1 border border-border px-3 text-xs text-text-main hover:bg-surface-2 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">download</span>
            Xuất CSV
          </button>
        </div>
        {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        {data?.retention?.truncated ? (
          <p role="status" className="flex items-start gap-2 text-xs text-text-muted">
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">info</span>
            Chi tiết request chỉ được giữ {data.retention.days} ngày: trước {new Date(data.retention.retainedFrom).toLocaleDateString("vi-VN")} chỉ còn số credit đã trừ, không còn token.
          </p>
        ) : null}
      </section>

      <div className={cn("flex flex-col gap-6 transition-opacity duration-150", loading && data ? "opacity-60" : "")} aria-busy={loading}>
        <section className="grid grid-cols-2 gap-px border border-border bg-border md:grid-cols-4">
          <Kpi label="Request" value={fmtInt(t?.requests)} hint={t?.errors ? `${fmtInt(t.errors)} lỗi` : null} />
          <Kpi label="Tổng token" value={fmtTokens(t?.total)} hint={`${fmtTokens(t?.input)} vào · ${fmtTokens(t?.output)} ra`} />
          <Kpi label="Token cache" value={fmtTokens(t?.cached)} hint={t?.input ? `${((t.cached / t.input) * 100).toFixed(1)}% token vào` : null} />
          <Kpi label="Đã trừ credit" value={fmtUsdNano(t?.chargedNanoUsd)} hint={`Giá trị theo bảng giá ${fmtUsdNano(t?.costNanoUsd)}`} />
        </section>

        <section className="flex flex-col gap-3 border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-text-main">Token theo {GRANULARITIES.find((g) => g.value === (data?.query?.granularity || granularity))?.label.toLowerCase()}</h2>
          {!data ? (
            <div className="h-64" aria-hidden="true" />
          ) : !hasData ? (
            <p className="flex h-64 items-center justify-center text-sm text-text-muted">Không có request nào trong khoảng này.</p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Chú thích">
                {seriesKeys.map((key, i) => (
                  <li key={key} className="flex items-center gap-1.5">
                    <span className="inline-block size-2.5" style={{ background: colorOf(key, i) }} aria-hidden="true" />
                    <span className="max-w-[220px] truncate text-text-main" title={names[key]}>{names[key] || key}</span>
                  </li>
                ))}
              </ul>
              <table className="sr-only">
                <caption>Token theo thời gian</caption>
                <thead><tr><th scope="col">Mốc</th><th scope="col">Request</th><th scope="col">Token vào</th><th scope="col">Token ra</th></tr></thead>
                <tbody>
                  {(data.series || []).map((s) => (
                    <tr key={s.bucket}><td>{bucketLabel(s.bucket, data.query.granularity)}</td><td>{s.requests}</td><td>{s.input}</td><td>{s.output}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="h-72 text-text-muted" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} axisLine={{ stroke: "var(--color-border)" }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} axisLine={false} tickFormatter={fmtTokens} width={52} />
                    <Tooltip cursor={{ fill: "var(--color-surface-2)" }} content={<ChartTooltip names={names} />} />
                    {seriesKeys.map((key, i) => (
                      <Bar key={key} dataKey={key} stackId="t" fill={colorOf(key, i)} stroke="var(--color-surface)" strokeWidth={1} isAnimationActive={false} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-text-main">Theo {GROUP_BYS.find((g) => g.value === groupBy)?.label.toLowerCase()}</h2>
            <span className="text-xs text-text-muted">Bấm một dòng để lọc theo nó.</span>
          </div>
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  {["Tên", "Request", "Lỗi", "Input", "Output", "Cache", "Tổng token", "Tỉ lệ", "Giá trị", "Đã trừ credit"].map((h, i) => (
                    <th key={h} scope="col" className={cn("px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted", i > 0 && "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.groups || []).length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-text-muted">Không có dữ liệu.</td></tr>
                ) : data.groups.map((g) => {
                  const topIndex = data.topKeys.indexOf(g.key);
                  return (
                    <tr key={g.key || "∅"} className="border-b border-border last:border-b-0 hover:bg-surface-2">
                      <td className="max-w-[280px] px-3 py-2">
                        <button
                          type="button"
                          onClick={() => drill(g)}
                          disabled={!g.key}
                          className="flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
                          title={g.key ? `Lọc theo ${g.label}` : undefined}
                        >
                          <span
                            className="inline-block size-2.5 shrink-0"
                            style={{ background: topIndex >= 0 ? colorOf(g.key, topIndex) : "var(--viz-other)" }}
                            aria-hidden="true"
                          />
                          <span className="truncate font-mono text-xs text-text-main">{g.label}</span>
                        </button>
                      </td>
                      {[fmtInt(g.requests), fmtInt(g.errors), fmtInt(g.input), fmtInt(g.output), fmtInt(g.cached), fmtInt(g.total),
                        `${(g.share * 100).toFixed(1)}%`, fmtUsdNano(g.costNanoUsd), fmtUsdNano(g.chargedNanoUsd)].map((v, i) => (
                        <td key={i} className="px-3 py-2 text-right font-mono text-xs tabular-nums text-text-main whitespace-nowrap">{v}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-text-muted">
            Giá trị: theo bảng giá của request. Đã trừ credit: số khách thật sự bị trừ (sau giảm giá, gồm cả phần thành nợ; không tính request trả bằng gói không giới hạn).
          </p>
        </section>
      </div>
    </div>
  );
}
