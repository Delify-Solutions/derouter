"use client";

import { useState, useEffect, useCallback } from "react";

const WINDOW_LABELS = { "5h": "every 5h", day: "every day", week: "every week" };
const PERIOD_PRESETS = [
  { id: "today", label: "Today" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "60d", label: "60d" },
];

function maskKeyFull(key) {
  if (!key) return "••••";
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…****${key.slice(-4)}`;
}

const fmt = (n) => (typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : "0");
const fmtCost = (n) => (typeof n === "number" && !Number.isNaN(n) ? `$${n.toFixed(4)}` : "$0");

// Status → color class. 2xx green, 4xx amber, 5xx red; unknown stays muted.
function statusColorClass(status) {
  const s = String(status || "");
  if (!s || s === "—") return "text-text-muted";
  if (s.startsWith("2")) return "text-green-600 dark:text-green-400";
  if (s.startsWith("4")) return "text-amber-600 dark:text-amber-400";
  if (s.startsWith("5")) return "text-red-600 dark:text-red-400";
  return "text-text-muted";
}

export default function UsagePage() {
  const [keyInput, setKeyInput] = useState("");
  const [data, setData] = useState(null);     // /api/usage/key (budget/limits/baseline)
  const [rec, setRec] = useState(null);       // /api/usage/key/receipts (summary+rate+history)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("7d");
  const [showRaw, setShowRaw] = useState(false);       // raw payloads loaded for current detail (per-request opt-in)
  const [rawLoading, setRawLoading] = useState(false);  // loading state for the per-request raw fetch
  const [detail, setDetail] = useState(null);           // selected request detail record
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterModel, setFilterModel] = useState("");   // Request History model filter
  const [filterStatus, setFilterStatus] = useState("");// Request History status filter (200/4xx/...)

  const STORAGE_KEY = "derouter.usage.key";

  // Read a key from a `?key=...` in the location hash (a deep link). The key is
  // NOT kept in the URL — on mount we stash it into localStorage and strip it
  // from the hash so the key doesn't linger in the address bar / history.
  const readHashKey = useCallback(() => {
    if (typeof window === "undefined") return "";
    const hash = window.location.hash || "";
    const m = hash.match(/[?&]key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, []);

  // Persist key to localStorage and remove it from the URL hash.
  const consumeHashKey = useCallback((k) => {
    if (typeof window === "undefined") return;
    if (k) {
      try { localStorage.setItem(STORAGE_KEY, k); } catch {}
      // Strip the key from the hash so the address bar shows #/usage only.
      // location.hash starts with '#'; after stripping the key the remainder
      // (e.g. '#/usage') is set back as the hash via replaceState.
      const hash = window.location.hash || "";
      const cleaned = hash.replace(/([?&])key=[^&]+/, "").replace(/[?&]$/, "");
      const finalHash = cleaned || "#/usage";
      if (window.location.hash !== finalHash) {
        window.history.replaceState(null, "", `${window.location.pathname}${finalHash}`);
      }
    }
  }, []);

  const lookup = useCallback(async (key, p = "7d") => {
    if (!key) return;
    setLoading(true);
    setError("");
    setData(null);
    setRec(null);
    try {
      const [baseRes, recRes] = await Promise.all([
        fetch(`/api/usage/key?key=${encodeURIComponent(key)}`),
        fetch(`/api/usage/key/receipts?key=${encodeURIComponent(key)}&period=${p}`),
      ]);
      if (baseRes.status === 404) { setError("Key not found"); return; }
      if (!baseRes.ok) { setError("Failed to load usage"); return; }
      const d = await baseRes.json();
      setData(d);
      if (recRes.ok) {
        const r = await recRes.json();
        setRec(r);
      } else {
        setRec({ summary: { items: [], totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0 }, peakTpm: 0 }, rate: { requests: 0, tokens: 0 }, history: [] });
      }
    } catch { setError("Failed to load usage"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // Priority: a fresh `?key=` deep link in the hash wins (and is then moved
    // into storage so the URL no longer carries the key). Otherwise fall back
    // to a previously-stored key in localStorage (e.g. returning visit).
    const hashKey = readHashKey();
    if (hashKey) {
      consumeHashKey(hashKey);
      setKeyInput(hashKey);
      lookup(hashKey, "7d");
      return;
    }
    let stored = "";
    try { stored = localStorage.getItem(STORAGE_KEY) || ""; } catch {}
    if (stored) {
      setKeyInput(stored);
      lookup(stored, "7d");
    }
  }, [readHashKey, consumeHashKey, lookup]);

  const submitKey = (e) => {
    e?.preventDefault();
    const k = keyInput.trim();
    if (!k) return;
    // Stash key in storage (not the URL); reload usage for this key.
    if (typeof window !== "undefined") {
      try { localStorage.setItem(STORAGE_KEY, k); } catch {}
      const cleanHash = window.location.hash.replace(/([?&])key=[^&]+/, "").replace(/[?&]$/, "") || "#/usage";
      if (window.location.hash !== cleanHash) {
        window.history.replaceState(null, "", `${window.location.pathname}${cleanHash}`);
      }
    }
    lookup(k, period);
  };

  const clearKey = () => {
    setData(null);
    setRec(null);
    setKeyInput("");
    setError("");
    if (typeof window !== "undefined") {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      window.history.replaceState(null, "", `${window.location.pathname}#/usage`);
    }
  };

  const switchPeriod = (p) => {
    setPeriod(p);
    if (keyInput.trim()) lookup(keyInput.trim(), p);
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  };

  const openDetail = async (row) => {
    setDetailLoading(true);
    setDetail(null);
    setShowRaw(false);  // raw payloads are NOT loaded by default; opt in per request
    try {
      const { startDate, endDate } = recRange();
      const params = new URLSearchParams({
        key: keyInput.trim(),
        id: row.connectionId || row.timestamp,
        includeRaw: "0",
      });
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const res = await fetch(`/api/usage/key/receipts/detail?${params.toString()}`);
      if (res.ok) {
        const d = await res.json();
        setDetail(d.detail);
      } else {
        setDetail(null);
      }
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => { setDetail(null); setDetailLoading(false); setShowRaw(false); };

  // Fetch raw request/response payloads for the CURRENT detail, on demand.
  // The detail drawer has a "Raw Responses" button that calls this — it does
  // NOT toggle a global flag; it re-fetches the detail with includeRaw=1.
  const loadRaw = async () => {
    if (!detail || rawLoading) return;
    setRawLoading(true);
    try {
      const { startDate, endDate } = recRange();
      // Find the matching history row to get an id the endpoint can resolve.
      const row = history.find((h) => h.timestamp === detail.timestamp) || detail;
      const params = new URLSearchParams({
        key: keyInput.trim(),
        id: row.connectionId || row.timestamp,
        includeRaw: "1",
      });
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const res = await fetch(`/api/usage/key/receipts/detail?${params.toString()}`);
      if (res.ok) {
        const d = await res.json();
        if (d.detail) { setDetail(d.detail); setShowRaw(true); }
      }
    } catch { /* ignore */ }
    finally { setRawLoading(false); }
  };

  const hideRaw = () => { setShowRaw(false); };

  // Convert the current period to a start/end ISO range for the detail endpoint.
  const recRange = () => {
    const now = new Date();
    const end = now.toISOString();
    let start;
    if (period === "today") {
      const d = new Date(); d.setHours(0, 0, 0, 0); start = d.toISOString();
    } else if (period === "all") {
      start = new Date(0).toISOString();
    } else {
      const ms = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 }[period] || 604800000;
      start = new Date(now.getTime() - ms).toISOString();
    }
    return { startDate: start, endDate: end };
  };

  const totals = rec?.summary?.totals || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0 };
  const items = rec?.summary?.items || [];
  const history = rec?.history || [];
  const peakTpm = rec?.summary?.peakTpm || 0;

  // Request History filters (client-side): model search + status bucket.
  const filteredHistory = history.filter((r) => {
    if (filterModel) {
      const q = filterModel.toLowerCase();
      if (!String(r.model || "").toLowerCase().includes(q)) return false;
    }
    if (filterStatus) {
      const st = String(r.status || "");
      if (!st.startsWith(filterStatus)) return false;
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-bg text-text-main" style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 16px" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold leading-tight">Derouter</h1>
          <p className="text-xs text-text-muted mt-0.5">Key Usage</p>
        </div>
        {data && (
          <button
            onClick={clearKey}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors"
            title="Sign out — clear key"
          >
            <span className="material-symbols-outlined text-[20px]">logout</span>
          </button>
        )}
      </div>

      {/* Key entry form (no key loaded yet) */}
      {!data && !loading && (
        <div className="rounded-xl border border-border bg-surface-1 p-4 mb-4">
          <form onSubmit={submitKey}>
            <label className="block text-sm font-medium mb-1.5">Enter your API key</label>
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-..."
              className="w-full py-2.5 px-3 text-sm bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 font-mono"
            />
            {error && <p className="text-sm text-red-500 mt-2 flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">error</span>{error}</p>}
            <button
              type="submit"
              disabled={!keyInput.trim()}
              className="mt-3 px-4 py-2 rounded-[10px] bg-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              View Usage
            </button>
          </form>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
          Loading…
        </div>
      )}

      {/* Data display */}
      {data && !loading && (
        <div className="flex flex-col gap-4">
          {/* Header */}
          <div>
            <h2 className="text-lg font-semibold">{data.name}</h2>
            <p className="text-xs text-text-muted mt-0.5">
              <span className="font-mono">{maskKeyFull(keyInput)}</span>
              {data.groupName ? <span className="ml-2">Group: {data.groupName}</span> : <span className="ml-2">Custom key</span>}
              {!data.active && <span className="ml-2 text-orange-500">Paused</span>}
              {data.expiresAt && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  Expires {new Date(data.expiresAt).toLocaleString()}
                </span>
              )}
            </p>
          </div>

          {/* Base URL + Key (key masked) */}
          <div className="rounded-xl border border-border bg-surface-1 p-3 text-sm">
            <div className="flex items-center gap-2 py-1">
              <span className="text-text-muted" style={{ width: 80, flexShrink: 0 }}>Base URL</span>
              <code className="font-mono text-xs flex-1 truncate">{typeof window !== "undefined" ? `${window.location.origin}/v1` : "/v1"}</code>
              <button onClick={() => copy(`${typeof window !== "undefined" ? window.location.origin : ""}/v1`)} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted" title="Copy">
                <span className="material-symbols-outlined text-[14px]">content_copy</span>
              </button>
            </div>
            <div className="flex items-center gap-2 py-1">
              <span className="text-text-muted" style={{ width: 80, flexShrink: 0 }}>API Key</span>
              <code className="font-mono text-xs flex-1 truncate">{maskKeyFull(keyInput)}</code>
              <button onClick={() => copy(keyInput || "")} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted" title="Copy full key">
                <span className="material-symbols-outlined text-[14px]">content_copy</span>
              </button>
            </div>
          </div>

          {/* Period presets */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-muted">Period:</span>
            {PERIOD_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => switchPeriod(p.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  period === p.id
                    ? "bg-primary text-white border-primary"
                    : "bg-surface-1 text-text-muted border-border hover:bg-surface-2"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Budget + RPM/TPM + Peak TPM compact grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Budget */}
            <div className="rounded-xl border border-border bg-surface-1 p-4">
              <h3 className="text-sm font-semibold mb-2">Budget</h3>
              {data.budgetUsd == null ? (
                <p className="text-sm text-text-muted">Unlimited</p>
              ) : (
                <>
                  <p className="text-lg font-semibold">
                    ${fmtCost(data.windowCostUsd ?? 0).slice(1)}
                    <span className="text-text-muted text-sm"> / ${data.budgetUsd.toFixed(2)}</span>
                  </p>
                  <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-2">
                    <div className="h-full bg-primary" style={{ width: `${Math.min(100, ((data.windowCostUsd || 0) / data.budgetUsd) * 100)}%` }} />
                  </div>
                  <p className="text-xs text-text-muted mt-1.5">
                    {data.resetWindow ? `Resets ${WINDOW_LABELS[data.resetWindow] || data.resetWindow}` : "No reset"}
                    {data.resetAt ? ` · ${new Date(data.resetAt).toLocaleString()}` : ""}
                  </p>
                </>
              )}
            </div>

            {/* Rate limits (live) */}
            <div className="rounded-xl border border-border bg-surface-1 p-4">
              <h3 className="text-sm font-semibold mb-2">Rate (last 60s)</h3>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted text-xs">RPM</span>
                  <span className="font-medium">{rec?.rate?.requests ?? 0}{data.rpm != null ? ` / ${data.rpm}` : " · ∞"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted text-xs">TPM</span>
                  <span className="font-medium">{fmt(rec?.rate?.tokens ?? 0)}{data.tpm != null ? ` / ${fmt(data.tpm)}` : " · ∞"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted text-xs">Peak TPM</span>
                  <span className="font-medium">{fmt(peakTpm)}</span>
                </div>
              </div>
            </div>

            {/* Totals for period */}
            <div className="rounded-xl border border-border bg-surface-1 p-4">
              <h3 className="text-sm font-semibold mb-2">This Period</h3>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted text-xs">Requests</span>
                  <span className="font-medium">{fmt(totals.requests)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted text-xs">Cost</span>
                  <span className="font-medium">{fmtCost(totals.cost)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted text-xs">Tokens</span>
                  <span className="font-medium">{fmt((totals.input || 0) + (totals.output || 0))}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Per-model summary */}
          <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-surface-2">
              <h3 className="text-sm font-semibold">By Model</h3>
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-text-muted px-4 py-6 text-center">No usage in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-muted border-b border-border">
                      <th className="text-left font-medium px-4 py-2">Model</th>
                      <th className="text-right font-medium px-4 py-2">Requests</th>
                      <th className="text-right font-medium px-4 py-2">Input</th>
                      <th className="text-right font-medium px-4 py-2">Output</th>
                      <th className="text-right font-medium px-4 py-2">Cache R</th>
                      <th className="text-right font-medium px-4 py-2">Cache W</th>
                      <th className="text-right font-medium px-4 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((m) => (
                      <tr key={m.model} className="border-b border-border/50 hover:bg-surface-2/50">
                        <td className="px-4 py-2 font-mono">{m.model}</td>
                        <td className="px-4 py-2 text-right">{fmt(m.requests)}</td>
                        <td className="px-4 py-2 text-right">{fmt(m.input)}</td>
                        <td className="px-4 py-2 text-right">{fmt(m.output)}</td>
                        <td className="px-4 py-2 text-right">{fmt(m.cacheRead)}</td>
                        <td className="px-4 py-2 text-right">{fmt(m.cacheCreation)}</td>
                        <td className="px-4 py-2 text-right">{fmtCost(m.cost)}</td>
                      </tr>
                    ))}
                    <tr className="bg-surface-2 font-semibold">
                      <td className="px-4 py-2">Total</td>
                      <td className="px-4 py-2 text-right">{fmt(totals.requests)}</td>
                      <td className="px-4 py-2 text-right">{fmt(totals.input)}</td>
                      <td className="px-4 py-2 text-right">{fmt(totals.output)}</td>
                      <td className="px-4 py-2 text-right">{fmt(totals.cacheRead)}</td>
                      <td className="px-4 py-2 text-right">{fmt(totals.cacheCreation)}</td>
                      <td className="px-4 py-2 text-right">{fmtCost(totals.cost)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Request history */}
          <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">Request History</h3>
                <span className="text-xs text-text-muted">{filteredHistory.length} request{filteredHistory.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={filterModel}
                  onChange={(e) => setFilterModel(e.target.value)}
                  placeholder="Filter by model…"
                  className="py-1 px-2 text-xs bg-surface-2 border border-border rounded-[6px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 w-40"
                />
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="py-1 px-2 text-xs bg-surface-2 border border-border rounded-[6px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                >
                  <option value="">All statuses</option>
                  <option value="2">2xx (success)</option>
                  <option value="4">4xx</option>
                  <option value="5">5xx</option>
                </select>
                {(filterModel || filterStatus) && (
                  <button
                    onClick={() => { setFilterModel(""); setFilterStatus(""); }}
                    className="px-2 py-1 text-xs rounded-[6px] border border-border text-text-muted hover:bg-surface-2"
                    title="Clear filters"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            {filteredHistory.length === 0 ? (
              <p className="text-sm text-text-muted px-4 py-6 text-center">
                {history.length === 0 ? "No requests in this period." : "No requests match the current filters."}
              </p>
            ) : (
              <div className="overflow-x-auto" style={{ maxHeight: 480 }}>
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-2 z-10">
                    <tr className="text-text-muted border-b border-border">
                      <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Time</th>
                      <th className="text-left font-medium px-3 py-2">Model</th>
                      <th className="text-left font-medium px-3 py-2">Provider</th>
                      <th className="text-center font-medium px-3 py-2">Status</th>
                      <th className="text-right font-medium px-3 py-2">Latency</th>
                      <th className="text-right font-medium px-3 py-2">Input</th>
                      <th className="text-right font-medium px-3 py-2">Output</th>
                      <th className="text-right font-medium px-3 py-2">Cache R</th>
                      <th className="text-right font-medium px-3 py-2">Cache W</th>
                      <th className="text-right font-medium px-3 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistory.map((r, i) => {
                      return (
                        <tr
                          key={i}
                          className="border-b border-border/40 hover:bg-surface-2/40 cursor-pointer"
                          onClick={() => openDetail({ connectionId: null, timestamp: r.timestamp, ...r })}
                          title="Click to view request details"
                        >
                          <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
                            {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-1.5 font-mono max-w-[160px] truncate" title={r.model}>{r.model || "—"}</td>
                          <td className="px-3 py-1.5">{r.provider ? r.provider : "—"}</td>
                          <td className="px-3 py-1.5 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusColorClass(r.status)}`}>
                              {r.status || "—"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-muted">
                            {r.latencyMs != null ? `${r.latencyMs}ms` : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.input)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.output)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.cacheRead)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.cacheCreation)}</td>
                          <td className="px-3 py-1.5 text-right">{fmtCost(r.cost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Available models (combos) with pricing + copy */}
          <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-surface-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Available Models</h3>
              <span className="text-xs text-text-muted">
                {data.allowedModels && data.allowedModels.length > 0
                  ? `${data.allowedModels.length} allowed`
                  : "All models allowed"}
              </span>
            </div>
            {(rec?.availableModels || []).length === 0 ? (
              <p className="text-sm text-text-muted px-4 py-6 text-center">No models configured.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-muted border-b border-border">
                      <th className="text-left font-medium px-3 py-2">Model</th>
                      <th className="text-right font-medium px-3 py-2">Input</th>
                      <th className="text-right font-medium px-3 py-2">Output</th>
                      <th className="text-right font-medium px-3 py-2">Cached</th>
                      <th className="text-right font-medium px-3 py-2" title="Reasoning tokens ($/1M)">Reasoning</th>
                      <th className="text-right font-medium px-3 py-2" title="Cache creation ($/1M)">Cache W</th>
                      <th className="text-center font-medium px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.availableModels.map((m) => {
                      const allowed = !data.allowedModels || data.allowedModels.length === 0 || data.allowedModels.includes(m.name);
                      return (
                        <tr key={m.name} className={`border-b border-border/40 hover:bg-surface-2/40 ${allowed ? "" : "opacity-50"}`}>
                          <td className="px-3 py-2 font-mono">{m.name}</td>
                          <td className="px-3 py-2 text-right">${(m.input || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right">${(m.output || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right">${(m.cached || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right">${(m.reasoning || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right">${(m.cacheCreation || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => copy(m.name)}
                              className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted"
                              title={`Copy ${m.name}`}
                            >
                              <span className="material-symbols-outlined text-[16px]">content_copy</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="px-4 py-2 text-[11px] text-text-muted border-t border-border">
                  Prices in $ per 1M tokens. A model's allowed/usable set for this key is shown at full opacity; dimmed rows are not permitted by this key's allow-list.
                </p>
              </div>
            )}
          </div>

          {/* Request detail drawer */}
          {(detail || detailLoading) && (
            <div
              className="fixed inset-0 z-50 flex justify-end bg-black/40"
              onClick={closeDetail}
            >
              <div
                className="w-full max-w-2xl h-full bg-bg border-l border-border overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sticky top-0 bg-bg border-b border-border px-4 py-3 flex items-center justify-between z-10">
                  <h3 className="text-sm font-semibold">Request Detail</h3>
                  <button
                    onClick={closeDetail}
                    className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted"
                    title="Close"
                  >
                    <span className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                </div>

                {detailLoading && (
                  <div className="flex items-center justify-center py-16 text-text-muted">
                    <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
                    Loading…
                  </div>
                )}

                {detail && !detailLoading && (
                  <div className="p-4 space-y-4">
                    {/* Header summary */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      <div><span className="text-text-muted">Model:</span> <span className="font-mono">{detail.model || "—"}</span></div>
                      {detail.provider && <div><span className="text-text-muted">Provider:</span> <span>{detail.provider}</span></div>}
                      <div>
                        <span className="text-text-muted">Status:</span>{" "}
                        <span className={`font-medium ${statusColorClass(detail.status)}`}>
                          {detail.status || "—"}
                        </span>
                      </div>
                      <div><span className="text-text-muted">Time:</span> <span className="text-text-muted">{detail.timestamp ? new Date(detail.timestamp).toLocaleString() : "—"}</span></div>
                      <div><span className="text-text-muted">Latency:</span> <span className="font-mono">TTFT {detail.latency?.ttft ?? 0}ms / Total {detail.latency?.total ?? 0}ms</span></div>
                      <div><span className="text-text-muted">Key:</span> <span className="font-mono">{detail.apiKey || "—"}</span></div>
                    </div>

                    {/* Token breakdown */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                      <div className="rounded-lg border border-border bg-surface-1 p-2">
                        <p className="text-text-muted text-[11px]">Input Tokens</p>
                        <p className="font-mono font-medium">{fmt(detail.inputTokens)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-surface-1 p-2">
                        <p className="text-text-muted text-[11px]">Output Tokens</p>
                        <p className="font-mono font-medium">{fmt(detail.outputTokens)}</p>
                      </div>
                      {detail.reasoningTokens > 0 && (
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">Reasoning Tokens</p>
                          <p className="font-mono font-medium">{fmt(detail.reasoningTokens)}</p>
                        </div>
                      )}
                      {detail.cachedTokens > 0 && (
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">Cached (read)</p>
                          <p className="font-mono font-medium">{fmt(detail.cachedTokens)}</p>
                        </div>
                      )}
                      {detail.cacheCreationTokens > 0 && (
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">Cache Creation</p>
                          <p className="font-mono font-medium">{fmt(detail.cacheCreationTokens)}</p>
                        </div>
                      )}
                    </div>

                    {/* Request parameters */}
                    <div>
                      <h4 className="text-xs font-semibold mb-2 text-text-muted uppercase tracking-wide">Request Info</h4>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">Messages</p>
                          <p className="font-mono font-medium">{fmt(detail.messageCount)}</p>
                        </div>
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">System messages</p>
                          <p className="font-mono font-medium">{fmt(detail.systemMessageCount)}</p>
                        </div>
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">Tools</p>
                          <p className="font-mono font-medium">{fmt(detail.toolCount)}</p>
                        </div>
                        <div className="rounded-lg border border-border bg-surface-1 p-2">
                          <p className="text-text-muted text-[11px]">Body size</p>
                          <p className="font-mono font-medium">{formatBytes(detail.bodyBytes)}</p>
                        </div>
                      </div>
                    </div>

                    {/* Raw payloads — opt-in via button (not a global toggle) */}
                    {showRaw ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">Raw payloads loaded for this request.</span>
                          <button
                            onClick={hideRaw}
                            className="text-xs px-2 py-1 rounded-[6px] border border-border text-text-muted hover:bg-surface-2"
                          >
                            Hide
                          </button>
                        </div>
                        <RawBlock title="Client Request (Input)" data={detail.request} />
                        {detail.providerRequest && <RawBlock title="Provider Request" data={detail.providerRequest} />}
                        {detail.providerResponse && <RawBlock title="Provider Response" data={detail.providerResponse} />}
                        {detail.response && detail.response !== detail.providerResponse && <RawBlock title="Client Response" data={detail.response} />}
                      </div>
                    ) : (
                      <button
                        onClick={loadRaw}
                        disabled={rawLoading}
                        className="flex items-center gap-2 rounded-lg border border-border bg-surface-1 p-3 text-xs text-text-main hover:bg-surface-2 transition-colors w-full disabled:opacity-50"
                      >
                        {rawLoading ? (
                          <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-[16px] text-text-muted">visibility</span>
                        )}
                        <span className="font-medium">View Raw Responses</span>
                        <span className="text-text-muted">— client request, provider request/response payloads for this request.</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}

function formatBytes(n) {
  if (!n || n < 1) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function RawBlock({ title, data }) {
  const [open, setOpen] = useState(true);
  if (!data || (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0)) return null;
  return (
    <div className="rounded-lg border border-border bg-surface-1 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-surface-2"
      >
        <span>{title}</span>
        <span className="material-symbols-outlined text-[16px]">{open ? "expand_less" : "expand_more"}</span>
      </button>
      {open && (
        <pre className="max-h-[300px] overflow-auto px-3 py-2 font-mono text-[11px] text-text-main bg-black/[0.03] dark:bg-white/[0.03] border-t border-border">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
