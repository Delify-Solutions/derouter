"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";

// Keep providers without serviceKinds (default LLM) or with "llm" in serviceKinds
function isLLMProvider(id) {
  const p = AI_PROVIDERS[id];
  if (!p?.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}
import Badge from "./Badge";
import Card from "./Card";
import TableToolbar, { useTableQuery } from "./TableToolbar";
import TableState from "./TableState";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageTable, { fmt, fmtTime, ProviderList } from "@/app/(dashboard)/dashboard/usage/components/UsageTable";
import { useModelView } from "@/app/(dashboard)/dashboard/usage/components/ModelViewSwitch";
import {
  filterRows, sortRows, normalizeTop, nextSortState, hasActiveQuery, clearQueryFilters, tableStateOf,
} from "@/shared/utils/tableQuery";
import dynamic from "next/dynamic";
// Lazy-load: keeps @xyflow/react out of the shared bundle until topology renders
const ProviderTopology = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/ProviderTopology"), { ssr: false });
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";

function timeAgo(timestamp) {
  const diff = Math.floor((Date.now() - new Date(timestamp)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Auto-update time display every second without re-rendering parent
function TimeAgo({ timestamp }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return <>{timeAgo(timestamp)}</>;
}

function RecentRequests({ requests = [] }) {
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden" padding="sm" style={{ height: 480 }}>
      {/* Header */}
      <div className="px-1 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Recent Requests</span>
      </div>

      {!requests.length ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No requests yet.</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full min-w-[300px] border-collapse text-xs">
            <thead className="sticky top-0 bg-bg z-10">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-semibold text-text-muted w-2"></th>
                <th className="py-1.5 text-left font-semibold text-text-muted">Model</th>
                <th className="py-1.5 text-right font-semibold text-text-muted whitespace-nowrap">In / Out</th>
                <th className="py-1.5 text-right font-semibold text-text-muted">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {requests.map((r, i) => {
                const ok = !r.status || r.status === "ok" || r.status === "success";
                return (
                  <tr key={i} className="hover:bg-bg-subtle transition-colors">
                    <td className="py-1.5">
                      <span className={`block w-1.5 h-1.5 rounded-full ${ok ? "bg-success" : "bg-error"}`} />
                    </td>
                    <td className="py-1.5 font-mono truncate max-w-[120px]" title={r.model}>{r.model}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <span className="text-primary">{fmt(r.promptTokens)}↑</span>
                      {" "}
                      <span className="text-success">{fmt(r.completionTokens)}↓</span>
                    </td>
                    <td className="py-1.5 text-right text-text-muted whitespace-nowrap"><TimeAgo timestamp={r.timestamp} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Model names come from clients ("__proto__", "constructor"…): never index a plain
// object with them. Own properties only, and Maps for grouping.
const ownValue = (obj, key) => (obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined);

// Rows of one stats map, with the derived token and cost-share fields the table shows.
// `pendingOf(key, data)` is the in-flight count of a row.
function toRows(dataMap, pendingOf = () => 0) {
  return Object.entries(dataMap || {}).map(([key, data]) => {
    const totalTokens = (data.promptTokens || 0) + (data.completionTokens || 0);
    const totalCost = data.cost || 0;
    // ponytail: cost split is a token-share allocation of the (rate-accurate)
    // server total, not a per-rate recompute. cached is a subset of prompt, so
    // peel it out of the input share. Upgrade to a stored per-component cost
    // breakdown if exact cached-rate cost display is needed.
    const cachedTokens = data.cachedTokens || 0;
    const nonCachedInput = Math.max(0, (data.promptTokens || 0) - cachedTokens);
    const inputCost = totalTokens > 0 ? nonCachedInput * (totalCost / totalTokens) : 0;
    const cachedCost = totalTokens > 0 ? cachedTokens * (totalCost / totalTokens) : 0;
    const outputCost = totalTokens > 0 ? (data.completionTokens || 0) * (totalCost / totalTokens) : 0;
    return { ...data, key, totalTokens, totalCost, inputCost, cachedCost, outputCost, pending: Number(pendingOf(key, data)) || 0 };
  });
}

function getGroupKey(item, keyField) {
  switch (keyField) {
    case "rawModel": return item.rawModel || "Unknown Model";
    case "accountName": return item.accountName || `Account ${item.connectionId?.slice(0, 8)}...` || "Unknown Account";
    case "keyName": return item.keyName || "Unknown Key";
    case "endpoint": return item.endpoint || "Unknown Endpoint";
    default: return item[keyField] || "Unknown";
  }
}

function groupDataByKey(data, keyField) {
  if (!Array.isArray(data)) return [];
  const groups = new Map();
  data.forEach((item) => {
    const gk = getGroupKey(item, keyField);
    if (!groups.has(gk)) {
      groups.set(gk, {
        groupKey: gk,
        summary: { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, costNanoUsd: 0, inputCost: 0, cachedCost: 0, outputCost: 0, lastUsed: null, pending: 0 },
        items: [],
      });
    }
    const group = groups.get(gk);
    const s = group.summary;
    s.requests += item.requests || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.cachedTokens += item.cachedTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.costNanoUsd += item.costNanoUsd != null ? item.costNanoUsd : Math.round((item.cost || 0) * 1e9);
    s.inputCost += item.inputCost || 0;
    s.cachedCost += item.cachedCost || 0;
    s.outputCost += item.outputCost || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }
    group.items.push(item);
  });
  return [...groups.values()];
}

// ─── Toolbar state (spec admin-usage-views "Shared table toolbar") ───
const OVERVIEW_SORTS = [
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Chi phí" },
  { value: "lastUsed", label: "Lần dùng cuối" },
  { value: "name", label: "Tên" },
];
const OVERVIEW_DEFAULTS = { sort: "requests", dir: "desc", top: 0 };
// The column fields the Overview sorted by before the toolbar existed (`sortBy`), so an
// old link still opens in its order.
const OVERVIEW_QUERY_OPTIONS = {
  sortFields: OVERVIEW_SORTS.map((s) => s.value),
  legacy: {
    map: {
      rawModel: "name", accountName: "name", keyName: "name", endpoint: "name",
      requests: "requests", lastUsed: "lastUsed",
      totalTokens: "tokens", promptTokens: "tokens", completionTokens: "tokens", cachedTokens: "tokens",
      cost: "cost", cachedCost: "cost",
    },
  },
};
const TABLE_NAMESPACES = { model: "ov-model", account: "ov-account", apiKey: "ov-key", endpoint: "ov-endpoint" };

// A sort value of a row or a group summary; null sorts last.
function metricOf(obj, field, name) {
  switch (field) {
    case "requests": return obj.requests || 0;
    case "tokens": return obj.totalTokens ?? ((obj.promptTokens || 0) + (obj.completionTokens || 0));
    case "cost": return obj.costNanoUsd != null ? obj.costNanoUsd : Math.round((obj.cost || 0) * 1e9);
    case "lastUsed": {
      const t = obj.lastUsed ? Date.parse(obj.lastUsed) : NaN;
      return Number.isFinite(t) ? t : null;
    }
    case "name": return name || null;
    default: return null;
  }
}

const providerNamesOf = (row) => (Array.isArray(row.providers) && row.providers.length ? row.providers.map((p) => p.name) : (row.provider ? [row.provider] : []));
const itemNameOf = (row) => `${row.rawModel || ""} ${row.provider || ""}`.trim();

const MODEL_COLUMNS = [
  { field: "rawModel", label: "Model", sortField: "name" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right", sortField: "requests" },
  { field: "lastUsed", label: "Last Used", align: "right", sortField: "lastUsed" },
];

const ACCOUNT_COLUMNS = [
  { field: "rawModel", label: "Model", sortField: "name" },
  { field: "provider", label: "Provider" },
  { field: "accountName", label: "Account" },
  { field: "requests", label: "Requests", align: "right", sortField: "requests" },
  { field: "lastUsed", label: "Last Used", align: "right", sortField: "lastUsed" },
];

const API_KEY_COLUMNS = [
  { field: "keyName", label: "API Key Name", sortField: "name" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right", sortField: "requests" },
  { field: "lastUsed", label: "Last Used", align: "right", sortField: "lastUsed" },
];

const ENDPOINT_COLUMNS = [
  { field: "endpoint", label: "Endpoint", sortField: "name" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right", sortField: "requests" },
  { field: "lastUsed", label: "Last Used", align: "right", sortField: "lastUsed" },
];

const TABLE_OPTIONS = [
  { value: "model", label: "Usage by Model" },
  { value: "account", label: "Usage by Account" },
  { value: "apiKey", label: "Usage by API Key" },
  { value: "endpoint", label: "Usage by Endpoint" },
];

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

// While the requested-model rebuild runs, the figures are refreshed at this pace.
const REBUILD_POLL_MS = 10_000;

function fmtDay(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(dateKey || "");
}

function ModelViewNotes({ stats, modelView }) {
  if (modelView !== "requested" || !stats) return null;
  const notes = [];
  if (stats.requestedBackfill?.running) {
    notes.push({ icon: "sync", text: "Đang tính lại số liệu theo model khách gọi…" });
  }
  if (stats.requestedPartial) {
    const days = Array.isArray(stats.upstreamOnlyDays) ? stats.upstreamOnlyDays : [];
    let text;
    if (stats.requestedSince && stats.upstreamOnlyIsPrefix) {
      text = `Trước ngày ${fmtDay(stats.requestedSince)} chỉ có model gốc`;
    } else if (days.length > 0) {
      // Days without requested figures that are not simply "everything before a date"
      // (a day being rebuilt, or one whose raw requests were partly deleted).
      const shown = days.slice(-5).map(fmtDay).join(", ");
      const more = days.length > 5 ? ` và ${days.length - 5} ngày trước đó` : "";
      text = `Ngày ${shown}${more} chỉ có model gốc`;
    } else {
      text = "Khoảng thời gian này chỉ có model gốc";
    }
    notes.push({ icon: "info", text });
  }
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" role="status">
      {notes.map((n) => (
        <p key={n.text} className="flex items-center gap-2 border border-border bg-surface px-3 py-2 text-xs text-text-muted">
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{n.icon}</span>
          {n.text}
        </p>
      ))}
    </div>
  );
}

export default function UsageStats({ period: periodProp, setPeriod: setPeriodProp, modelView: modelViewProp, hidePeriodSelector = false } = {}) {
  const [urlModelView] = useModelView();
  const modelView = modelViewProp ?? urlModelView;
  const reqView = modelView === "requested";

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  // When the last stats response (or failure) arrived: the rebuild poll counts from here.
  const [settledAt, setSettledAt] = useState(0);
  const [tableView, setTableView] = useState("model");
  const [viewMode, setViewMode] = useState("costs");
  const [providers, setProviders] = useState([]);
  const [periodLocal, setPeriodLocal] = useState("today");
  const hasLoadedStats = useRef(false);
  const period = periodProp ?? periodLocal;
  const setPeriod = setPeriodProp ?? setPeriodLocal;

  const [query, setQuery] = useTableQuery(TABLE_NAMESPACES[tableView], OVERVIEW_DEFAULTS, OVERVIEW_QUERY_OPTIONS);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  // Fetch connected providers once, deduplicate by provider type
  // Always include noAuth free providers (e.g. opencode) regardless of connections
  useEffect(() => {
    Promise.all([
      fetch("/api/providers").then((r) => r.ok ? r.json() : null),
      fetch("/api/provider-nodes").then((r) => r.ok ? r.json() : null),
    ])
      .then(([d, nodesData]) => {
        // Build node name lookup for custom providers
        const nodeNameMap = {};
        for (const node of (nodesData?.nodes || [])) {
          nodeNameMap[node.id] = node.name;
        }
        const seen = new Set();
        const unique = (d?.connections || []).filter((c) => {
          if (c.isActive === false) return false;
          if (!isLLMProvider(c.provider)) return false;
          if (seen.has(c.provider)) return false;
          seen.add(c.provider);
          return true;
        }).map((c) => ({
          ...c,
          nodeName: nodeNameMap[c.provider] || null,
        }));
        const noAuthProviders = Object.values(FREE_PROVIDERS)
          .filter((p) => p.noAuth && !seen.has(p.id) && isLLMProvider(p.id))
          .map((p) => ({ provider: p.id, name: p.name }));
        setProviders([...unique, ...noAuthProviders]);
      })
      .catch(() => {});
  }, []);

  // Fetch the stats via REST when the period or the model view changes (or on retry)
  useEffect(() => {
    let cancelled = false;
    // Until stats have loaded once (first load, retry after a failed first load): full
    // spinner; afterwards: subtle fetching indicator
    if (!hasLoadedStats.current) {
      setLoading(true);
    } else {
      setFetching(true);
    }
    setError(null);

    const params = new URLSearchParams({ period, modelView });
    fetch(`/api/usage/stats?${params}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok || !data) throw new Error(data?.error || "Failed to load usage statistics");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        hasLoadedStats.current = true;
        // Replace the period/view-dependent maps instead of merging them into the previous
        // response: a map key of the other view must not linger.
        setStats((prev) => ({
          ...data,
          activeRequests: data.activeRequests ?? prev?.activeRequests,
        }));
      })
      .catch((e) => { if (!cancelled) setError(e.message || "Failed to load usage statistics"); })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setFetching(false);
        setSettledAt(Date.now());
      });
    return () => { cancelled = true; };
  }, [period, modelView, reloadTick]);

  // While the requested-model rebuild runs, refresh until it is done.
  // `stale`: the figures predate the latest rebuilt day; refresh until they do not.
  // The next refresh is scheduled REBUILD_POLL_MS after a response arrives, never while a
  // fetch is still running, so a slow response is never cancelled by the next poll.
  const rebuilding = Boolean(reqView && (stats?.requestedBackfill?.running || stats?.requestedBackfill?.stale));
  const inFlight = loading || fetching;
  useEffect(() => {
    if (!rebuilding || inFlight) return undefined;
    const timer = setTimeout(() => setReloadTick((t) => t + 1), REBUILD_POLL_MS);
    return () => clearTimeout(timer);
  }, [rebuilding, inFlight, settledAt]);

  // SSE connection - real-time updates for activeRequests + recentRequests only
  useEffect(() => {
    const es = new EventSource("/api/usage/stream");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Always merge only real-time fields, never overwrite full stats from REST
        setStats((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeRequests: data.activeRequests,
            recentRequests: data.recentRequests,
            errorProvider: data.errorProvider,
            pending: data.pending,
          };
        });
        if (hasLoadedStats.current) setLoading(false);
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };

    es.onerror = () => setLoading(false);

    return () => es.close();
  }, []);

  const onHeaderSort = useCallback((field) => {
    setQuery((s) => nextSortState(s, field, { ascFirst: ["name"] }));
  }, [setQuery]);
  const clearFilters = useCallback(() => setQuery(clearQueryFilters), [setQuery]);

  // Compute active table data
  const activeTableConfig = useMemo(() => {
    if (!stats) return null;
    const providerCell = (item) => (reqView && Array.isArray(item.providers)
      ? <ProviderList providers={item.providers} highlight={item.pending > 0} />
      : <Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge>);
    // The live in-flight counters are kept per UPSTREAM model ("model (provider)"), so the
    // in-flight highlight is shown in the upstream view only; requested rows never match
    // them by accident.
    const noPending = () => 0;
    switch (tableView) {
      case "model": {
        const pendingByModel = stats.pending?.byModel;
        return {
          columns: MODEL_COLUMNS,
          rows: toRows(stats.byModel, reqView ? noPending : (key) => ownValue(pendingByModel, key)),
          groupBy: "rawModel",
          searchFields: ["rawModel", "provider"],
          storageKey: "usage-stats:expanded-models",
          emptyMessage: "No usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">
                {/* One row per requested model: its providers are the group's providers. */}
                {reqView && group.items.length === 1 ? <ProviderList providers={group.items[0].providers || []} /> : "—"}
              </td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3">{providerCell(item)}</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "account": {
        const pendingByAccount = stats?.pending?.byAccount;
        const accountPending = (_key, data) => {
          const connPending = ownValue(pendingByAccount, data.connectionId);
          const modelKey = data.provider ? `${data.rawModel} (${data.provider})` : data.rawModel;
          return ownValue(connPending, modelKey) || 0;
        };
        return {
          columns: ACCOUNT_COLUMNS,
          rows: toRows(stats.byAccount, reqView ? noPending : accountPending),
          groupBy: "accountName",
          searchFields: ["accountName", "rawModel", "provider"],
          storageKey: "usage-stats:expanded-accounts",
          emptyMessage: "No account-specific usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.accountName || `Account ${item.connectionId?.slice(0, 8)}...`}</td>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "apiKey": {
        return {
          columns: API_KEY_COLUMNS,
          rows: toRows(stats.byApiKey),
          groupBy: "keyName",
          searchFields: ["keyName", "apiKeyMasked", "rawModel", "provider"],
          storageKey: "usage-stats:expanded-apikeys",
          emptyMessage: "No API key usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium">{item.keyName}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3">{providerCell(item)}</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "endpoint":
      default: {
        return {
          columns: ENDPOINT_COLUMNS,
          rows: toRows(stats.byEndpoint),
          groupBy: "endpoint",
          searchFields: ["endpoint", "rawModel", "provider"],
          storageKey: "usage-stats:expanded-endpoints",
          emptyMessage: "No endpoint usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium font-mono text-sm">{item.endpoint}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3">{providerCell(item)}</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
    }
  }, [stats, tableView, reqView]);

  // Search and filters apply to rows; groups are then sorted by their summed value, the rows
  // inside a group by the same field, and Top N cuts the groups.
  const tableData = useMemo(() => {
    if (!activeTableConfig) return null;
    const { rows, groupBy, searchFields } = activeTableConfig;
    const modelOptions = [...new Set(rows.map((r) => r.rawModel).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const providerOptions = [...new Set(rows.flatMap(providerNamesOf))].sort((a, b) => a.localeCompare(b));
    const matched = filterRows(rows, {
      search: query.q,
      searchFields,
      filters: query.filters,
      filterFields: { model: "rawModel", provider: providerNamesOf },
    });
    const sortOpts = { sortField: query.sort, sortDir: query.dir };
    const groups = sortRows(groupDataByKey(matched, groupBy), {
      ...sortOpts,
      valueOf: (g, f) => metricOf(g.summary, f, g.groupKey),
      nameOf: (g) => g.groupKey,
    }).map((g) => ({
      ...g,
      items: sortRows(g.items, { ...sortOpts, valueOf: (r, f) => metricOf(r, f, itemNameOf(r)), nameOf: itemNameOf }),
    }));
    const top = normalizeTop(query.top);
    const totalGroups = new Set(rows.map((r) => getGroupKey(r, groupBy))).size;
    return {
      groups: top ? groups.slice(0, top) : groups,
      matchedGroups: groups.length,
      totalGroups,
      filters: [
        { name: "model", label: "Model", options: modelOptions.map((m) => ({ value: m, label: m })) },
        { name: "provider", label: "Provider", options: providerOptions.map((p) => ({ value: p, label: p })) },
      ],
    };
  }, [activeTableConfig, query]);

  const spinner = (
    <div className="flex items-center justify-center py-12 text-text-muted">
      <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
    </div>
  );

  if (!stats && !loading) {
    return (
      <Card>
        <TableState state="error" onRetry={retry} />
      </Card>
    );
  }

  const tableState = tableStateOf({
    loading,
    error,
    total: tableData?.totalGroups ?? 0,
    matched: tableData?.matchedGroups ?? 0,
    filtersActive: hasActiveQuery(query),
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Period selector (hidden when controlled by parent) */}
      {!hidePeriodSelector && (
        <div className="flex w-full items-center gap-2 sm:w-auto sm:self-end">
          <div className="grid flex-1 grid-cols-5 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex sm:flex-none">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                disabled={fetching}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${period === p.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {fetching && (
            <span className="material-symbols-outlined text-[16px] text-text-muted animate-spin">progress_activity</span>
          )}
        </div>
      )}

      <ModelViewNotes stats={stats} modelView={modelView} />

      {/* Overview cards */}
      {loading ? spinner : <OverviewCards stats={stats} />}

      {/* Provider topology + Recent Requests */}
      {loading ? spinner : (
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <ProviderTopology
            providers={providers}
            activeRequests={stats.activeRequests || []}
            lastProvider={stats.recentRequests?.[0]?.provider || ""}
            errorProvider={stats.errorProvider || ""}
          />
          <RecentRequests requests={stats.recentRequests || []} />
        </div>
      )}

      {/* Token / Cost chart - sync period */}
      {loading ? spinner : <UsageChart period={period} />}

      {/* Table with dropdown selector */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <select
            value={tableView}
            onChange={(e) => setTableView(e.target.value)}
            aria-label="Bảng"
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-auto"
            style={{ colorScheme: 'auto' }}
          >
            {TABLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex">
            <button
              onClick={() => setViewMode("costs")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "costs" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Costs
            </button>
            <button
              onClick={() => setViewMode("tokens")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Tokens
            </button>
          </div>
        </div>
        {activeTableConfig || loading || error ? (
          <UsageTable
            title=""
            columns={activeTableConfig?.columns || MODEL_COLUMNS}
            groupedData={tableData?.groups || []}
            sortState={query}
            onSort={onHeaderSort}
            viewMode={viewMode}
            storageKey={activeTableConfig?.storageKey || "usage-stats:expanded-models"}
            renderSummaryCells={activeTableConfig?.renderSummaryCells || (() => null)}
            renderDetailCells={activeTableConfig?.renderDetailCells || (() => null)}
            emptyMessage={activeTableConfig?.emptyMessage || "No usage recorded yet."}
            tableState={tableState}
            onRetry={retry}
            onClearFilters={clearFilters}
            toolbar={(
              <TableToolbar
                state={query}
                onChange={setQuery}
                searchPlaceholder="Model, provider, account, key, endpoint…"
                filters={tableData?.filters || []}
                sortOptions={OVERVIEW_SORTS}
                shown={tableData?.groups.length ?? 0}
                total={tableData?.totalGroups ?? 0}
              />
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
