"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Select from "@/shared/components/Select";
import Input from "@/shared/components/Input";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import Table from "@/shared/components/Table";
import TableToolbar, { useTableQuery, SortableHeader } from "@/shared/components/TableToolbar";
import { TableStateRow } from "@/shared/components/TableState";
import { nextSortState, hasActiveQuery, clearQueryFilters, tableStateOf } from "@/shared/utils/tableQuery";
import { useModelView } from "./ModelViewSwitch";
import { cn } from "@/shared/utils/cn";
import { maskKeyFull } from "@/shared/utils/apiKey";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import { detailTtft, formatLatency } from "@/shared/utils/latencyFormat";
import { fmtUsdNano } from "@/shared/utils/money";

/**
 * Who made the request: the key owner's e-mail (or "Key admin"), then the key's
 * name and its masked value. Clicking the e-mail filters the table to that user.
 */
function KeyOwner({ apiKey, info, onPickUser = null, compact = true }) {
  if (!apiKey) return <span className="text-vx-text-muted">—</span>;
  const masked = maskKeyFull(apiKey);
  const owner = info?.kind === "user"
    ? (info.email || info.userId)
    : info?.kind === "admin" ? "Key admin" : "Key đã xóa / không rõ";
  return (
    <span className={`flex min-w-0 flex-col ${compact ? "gap-0.5" : "gap-1"}`}>
      {info?.kind === "user" && onPickUser ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onPickUser(info); }}
          title={`Chỉ xem request của ${owner}`}
          className="min-w-0 truncate text-left text-sm text-vx-text hover:underline"
        >
          {owner}
        </button>
      ) : (
        <span className={`min-w-0 truncate text-sm ${info?.kind === "user" ? "text-vx-text" : "text-vx-text-muted"}`} title={owner}>{owner}</span>
      )}
      {/* First on its own line: appended to the name it was cut off by the truncation. */}
      {info?.deleted ? <span className="font-mono text-xs text-vx-text-subtle">key đã xóa</span> : null}
      <span
        className="min-w-0 truncate font-mono text-xs text-vx-text-muted"
        title={`${info?.deleted ? "Key đã xóa — " : ""}${info?.name ? `${info.name} — ` : ""}${masked}`}
      >
        {info?.name ? `${info.name} · ` : ""}{masked}
      </span>
    </span>
  );
}

/** Search customers by e-mail; picking one filters the table to all of their keys. */
function UserFilter({ value, onChange }) {
  const [query, setQuery] = useState(value?.email || "");
  const [options, setOptions] = useState([]);
  useEffect(() => { setQuery(value?.email || ""); }, [value?.email]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === value?.email) { setOptions([]); return undefined; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&pageSize=10`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        setOptions(Array.isArray(data.users) ? data.users : []);
      } catch {
        setOptions([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, value?.email]);

  const pick = (text) => {
    setQuery(text);
    const match = options.find((u) => u.email === text);
    if (match) onChange({ id: match.id, email: match.email });
    if (!text) onChange(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor="user-filter" className="text-sm font-medium text-vx-text">Người dùng</label>
      <div className="flex min-w-0 items-start gap-2">
        <Input
          id="user-filter"
          type="search"
          list="user-filter-options"
          value={query}
          onChange={(event) => pick(event.target.value)}
          placeholder="Gõ email để lọc mọi key của user"
          autoComplete="off"
          className="min-w-0 flex-1"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { setQuery(""); onChange(null); }}
            aria-label="Bỏ lọc người dùng"
            className="w-8 shrink-0 border border-vx-border px-0"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
          </Button>
        )}
      </div>
      <datalist id="user-filter-options">
        {options.map((u) => <option key={u.id} value={u.email}>{u.displayName || u.groupName || ""}</option>)}
      </datalist>
    </div>
  );
}

let providerNameCache = null;
let providerNodesCache = null;

async function fetchProviderNames() {
  if (providerNameCache && providerNodesCache) {
    return { providerNameCache, providerNodesCache };
  }

  const nodesRes = await fetch("/api/provider-nodes");
  const nodesData = await nodesRes.json();
  const nodes = nodesData.nodes || [];
  providerNodesCache = {};

  for (const node of nodes) {
    providerNodesCache[node.id] = node.name;
  }

  providerNameCache = {
    ...AI_PROVIDERS,
    ...providerNodesCache
  };

  return { providerNameCache, providerNodesCache };
}

function getProviderName(providerId, cache) {
  if (!providerId) return providerId;
  if (!cache) return providerId;

  const cached = cache[providerId];

  if (typeof cached === 'string') {
    return cached;
  }

  if (cached?.name) {
    return cached.name;
  }

  const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return providerConfig?.name || providerId;
}

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-vx-border rounded-vx-md overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-vx-surface-2 hover:bg-vx-surface-3 transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="material-symbols-outlined text-[18px] text-vx-text-muted">{icon}</span>}
          <span className="font-semibold text-sm text-vx-text">{title}</span>
        </div>
        <span className={cn(
          "material-symbols-outlined text-[20px] text-vx-text-muted transition-transform duration-200",
          isOpen ? "rotate-90" : ""
        )}>
          chevron_right
        </span>
      </button>

      {isOpen && (
        <div className="p-4 border-t border-vx-border">
          {children}
        </div>
      )}
    </div>
  );
}

function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}

function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}

// Status → badge variant. 2xx success, 4xx warning, 5xx error; "error"/unknown muted.
// Mirrors the public /usage page's helper so both views color statuses the same.
function statusBadgeVariant(status) {
  const s = String(status || "");
  if (!s || s === "—" || s === "null") return "default";
  if (s === "success" || s.startsWith("2")) return "success";
  if (s.startsWith("4")) return "warning";
  if (s === "error" || s.startsWith("5")) return "error";
  return "default";
}

// Render an error-source badge. "platform" = the proxy's OWN limit (RPM/TPM/
// budget/expiry/abort/bad-gateway) rejected the request before (or without)
// the upstream; "upstream" = the provider API returned the error. Success
// rows render nothing.
function ErrorSourceBadge({ source }) {
  if (!source) return null;
  const isPlatform = source === "platform";
  return (
    <Badge
      variant={isPlatform ? "warning" : "error"}
      size="xs"
      title={isPlatform ? "Rejected by the proxy's own limit" : "Returned by the upstream API"}
    >
      {isPlatform ? "Platform" : "Upstream"}
    </Badge>
  );
}

function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  // Canonical storage keeps prompt cache-inclusive. Legacy Claude rows may have
  // stored prompt cache-exclusive; fall back to cache when it's larger so old
  // rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

// Shared toolbar (spec admin-usage-views): sorted and filtered on the server, before
// pagination; newest first by default.
const DETAIL_SORTS = [
  { value: "time", label: "Thời gian" },
  { value: "tokens", label: "Tokens" },
  { value: "latency", label: "Độ trễ" },
];
const DETAIL_DEFAULTS = { sort: "time", dir: "desc", top: 0 };
const DETAIL_QUERY_OPTIONS = { sortFields: DETAIL_SORTS.map((s) => s.value) };

/** The model a row is listed under in a view; requested falls back to the upstream model. */
function shownModel(detail, modelView) {
  return modelView === "requested" ? (detail.requestedModel || detail.model) : detail.model;
}

const EMPTY_FILTERS = { provider: "", apiKey: "", user: null, status: "", startDate: "", endDate: "" };

export default function RequestDetailsTab({ modelView: modelViewProp } = {}) {
  const [urlModelView] = useModelView();
  const modelView = modelViewProp ?? urlModelView;
  const [query, setQuery] = useTableQuery("details", DETAIL_DEFAULTS, DETAIL_QUERY_OPTIONS);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0
  });
  const [loading, setLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [keys, setKeys] = useState([]);
  const [providerNameCache, setProviderNameCache] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  // `user` is the { id, email } of the customer whose keys to show, or null.
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // A new model view, search, filter or sort starts again from page 1.
  const queryKey = [modelView, query.q, query.sort, query.dir, query.filters.model || "", JSON.stringify(filters)].join("\u0000");
  const [lastQueryKey, setLastQueryKey] = useState(queryKey);
  if (queryKey !== lastQueryKey) {
    setLastQueryKey(queryKey);
    setPagination((p) => (p.page === 1 ? p : { ...p, page: 1 }));
  }

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/providers");
      const data = await res.json();
      setProviders(data.providers || []);

      const cache = await fetchProviderNames();
      setProviderNameCache(cache.providerNameCache);
    } catch (error) {
      console.error("Failed to fetch providers:", error);
    }
  }, []);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      const data = await res.json();
      // API may return { keys: [...] } or an array directly.
      const list = Array.isArray(data) ? data : (data.keys || data.items || []);
      setKeys(list);
    } catch (error) {
      console.error("Failed to fetch keys:", error);
    }
  }, []);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        modelView,
        sort: query.sort || "time",
        order: query.dir || "desc",
      });
      if (query.q?.trim()) params.append("q", query.q.trim());
      if (query.filters.model) params.append("model", query.filters.model);
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.apiKey) params.append("apiKey", filters.apiKey);
      if (filters.user?.id) params.append("userId", filters.user.id);
      if (filters.status) params.append("status", filters.status);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);
      if (showRaw) params.append("includeRaw", "1");

      const res = await fetch(`/api/usage/request-details?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to fetch request details");

      setDetails(data.details || []);
      setModels(Array.isArray(data.models) ? data.models : []);
      setPagination(prev => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch request details:", error.message);
      setDetails([]);
      setError(error.message || "Failed to fetch request details");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters, showRaw, modelView, query]);

  useEffect(() => {
    fetchProviders();
    fetchKeys();
  }, [fetchProviders, fetchKeys]);

  // reloadTick: "Thử lại" runs the same fetch again.
  useEffect(() => {
    fetchDetails();
  }, [fetchDetails, reloadTick]);

  const handleViewDetail = (detail) => {
    setSelectedDetail(detail);
    setIsDrawerOpen(true);
  };

  const handlePageChange = (newPage) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newPageSize) => {
    setPagination(prev => ({ ...prev, pageSize: newPageSize, page: 1 }));
  };

  const handleClearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setShowRaw(false);
    setQuery(clearQueryFilters);
  };

  const existingFiltersActive = Boolean(
    filters.provider || filters.apiKey || filters.user || filters.status || filters.startDate || filters.endDate
  );
  const filtersActive = existingFiltersActive || hasActiveQuery(query);
  // "Xoá bộ lọc": search and every filter, never the sort or the model view.
  const clearAllFilters = () => {
    setFilters(EMPTY_FILTERS);
    setQuery(clearQueryFilters);
    setPagination((p) => ({ ...p, page: 1 }));
  };
  const tableState = tableStateOf({ loading, error, total: null, matched: details.length, filtersActive });
  const onHeaderSort = (field) => setQuery((s) => nextSortState(s, field));
  const modelOptions = models.map((m) => ({ value: m, label: m }));
  // A chosen model that is not in the list (old link, another view) stays selectable.
  if (query.filters.model && !models.includes(query.filters.model)) {
    modelOptions.unshift({ value: query.filters.model, label: query.filters.model });
  }

  // "Clear all request logs" — wipes every row in the requestDetails (log)
  // table. Destructive across all keys/providers; usageHistory accounting is NOT
  // affected. After confirm, refetch the current page so the table empties.
  const handleClearAll = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/usage/request-details", { method: "DELETE" });
      if (!res.ok) throw new Error("clear failed");
      setConfirmClear(false);
      setSelectedDetail(null);
      setIsDrawerOpen(false);
      setPagination(prev => ({ ...prev, page: 1 }));
      await fetchDetails();
    } catch (e) {
      console.error("Failed to clear all logs:", e);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <TableToolbar
          className="mb-4"
          state={query}
          onChange={setQuery}
          searchPlaceholder="Model, provider, email, key name…"
          filters={[{ name: "model", label: "Model", options: modelOptions }]}
          sortOptions={DETAIL_SORTS}
          showTop={false}
          shown={details.length}
          total={pagination.totalItems || 0}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
          <Select
            label="Provider"
            value={filters.provider}
            onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
            options={[
              { value: "", label: "All Providers" },
              ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
            ]}
          />

          <UserFilter
            value={filters.user}
            onChange={(user) => { setFilters((f) => ({ ...f, user })); setPagination((p) => ({ ...p, page: 1 })); }}
          />

          <Select
            label="Key admin"
            value={filters.apiKey}
            onChange={(e) => setFilters({ ...filters, apiKey: e.target.value })}
            options={[
              { value: "", label: "All Keys" },
              ...keys.map((k) => ({
                value: k.key,
                label: k.name ? `${k.name} — ${maskKeyFull(k.key)}` : maskKeyFull(k.key),
              })),
            ]}
          />

          <Select
            label="Status"
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            options={[
              { value: "", label: "All Statuses" },
              { value: "2", label: "2xx (success)" },
              { value: "4", label: "4xx (client / rate-limit)" },
              { value: "5", label: "5xx (server / upstream)" },
              { value: "error", label: "error" },
            ]}
          />

          <Input
            label="Start Date"
            id="start-date-filter"
            type="datetime-local"
            value={filters.startDate}
            onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
          />

          <Input
            label="End Date"
            id="end-date-filter"
            type="datetime-local"
            value={filters.endDate}
            onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
          />

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-vx-text-muted">Raw Responses</span>
            <button
              type="button"
              role="switch"
              aria-checked={showRaw}
              onClick={() => setShowRaw((v) => !v)}
              className={cn(
                "h-[42px] px-3 rounded-vx-md border flex items-center justify-between gap-2 text-sm w-full min-w-0 transition-colors",
                showRaw
                  ? "border-vx-primary/40 bg-vx-primary/10 text-vx-primary"
                  : "border-vx-border bg-vx-surface text-vx-text-muted"
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">{showRaw ? "visibility" : "visibility_off"}</span>
                {showRaw ? "Showing raw" : "Redacted"}
              </span>
              <span className={cn(
                "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
                showRaw ? "bg-vx-primary" : "bg-vx-surface-3"
              )}>
                <span className={cn(
                  "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  showRaw ? "translate-x-3.5" : "translate-x-0.5"
                )} />
              </span>
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
          {/* Clear all request logs — destructive, wipes the whole requestDetails
              (log) table across all keys/providers. usageHistory is not touched. */}
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-vx-text-muted">Delete ALL request logs?</span>
              <Button
                variant="danger"
                onClick={handleClearAll}
                disabled={clearing}
              >
                {clearing ? "Clearing…" : "Delete all"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmClear(false)}
                disabled={clearing}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="danger-outline"
              onClick={() => setConfirmClear(true)}
              disabled={clearing || details.length === 0}
            >
              <span className="material-symbols-outlined text-[18px] mr-1">delete_sweep</span>
              Clear all logs
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={handleClearFilters}
            disabled={!filtersActive && !showRaw}
            className="w-full sm:w-auto"
          >
            Clear Filters
          </Button>
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto" aria-busy={loading}>
          <table className="w-full min-w-[1000px]">
            <Table.Head>
              <tr>
                <SortableHeader label="Timestamp" field="time" state={query} onSort={onHeaderSort} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" />
                <Table.HeaderCell>{modelView === "requested" ? "Model (khách gọi)" : "Model (gốc)"}</Table.HeaderCell>
                <Table.HeaderCell>Provider</Table.HeaderCell>
                <Table.HeaderCell>Người dùng / Key</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Input Tokens</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Cached</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Cache Creation</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Output Tokens</Table.HeaderCell>
                <SortableHeader
                  label="Tok"
                  field="tokens"
                  state={query}
                  onSort={onHeaderSort}
                  align="right"
                  className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted"
                />
                <Table.HeaderCell
                  className="text-right"
                  title="Giá niêm yết của request này, theo bảng giá — không phân biệt gói unlimited hay credit thật"
                >
                  Giá trị
                </Table.HeaderCell>
                <Table.HeaderCell
                  className="text-right"
                  title="Số tiền thực sự bị trừ khỏi credit thật — bằng 0 khi request được trả hoàn toàn bằng gói unlimited"
                >
                  Đã trừ
                </Table.HeaderCell>
                <SortableHeader label="Latency" field="latency" state={query} onSort={onHeaderSort} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted" />
                <Table.HeaderCell className="text-center">Action</Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {tableState !== "ready" ? (
                <TableStateRow
                  state={tableState}
                  colSpan={14}
                  emptyMessage="No request details found"
                  onRetry={() => setReloadTick((t) => t + 1)}
                  onClearFilters={clearAllFilters}
                />
              ) : (
                details.map((detail, index) => (
                  <Table.Row key={`${detail.id}-${index}`}>
                    <Table.Cell className="whitespace-nowrap">
                      {new Date(detail.timestamp).toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="max-w-[260px] truncate font-mono" title={shownModel(detail, modelView) || ""}>
                      {shownModel(detail, modelView)}
                    </Table.Cell>
                    <Table.Cell className="max-w-[180px] truncate">
                       <span className="font-medium">
                         {getProviderName(detail.provider, providerNameCache)}
                       </span>
                     </Table.Cell>
                    <Table.Cell className="max-w-[240px]">
                      <KeyOwner
                        apiKey={detail.apiKey}
                        info={detail.keyInfo}
                        onPickUser={(info) => { setFilters((f) => ({ ...f, user: { id: info.userId, email: info.email } })); setPagination((p) => ({ ...p, page: 1 })); }}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant={statusBadgeVariant(detail.status)} size="sm">
                          {detail.status || "—"}
                        </Badge>
                        <ErrorSourceBadge source={detail.errorSource} />
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono">
                      {getInputTokens(detail.tokens).toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono">
                      {getCachedTokens(detail.tokens) > 0 ? getCachedTokens(detail.tokens).toLocaleString() : "—"}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono">
                      {getCacheCreationTokens(detail.tokens) > 0 ? getCacheCreationTokens(detail.tokens).toLocaleString() : "—"}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono">
                      {detail.tokens?.completion_tokens?.toLocaleString() || 0}
                    </Table.Cell>
                    {(() => {
                      const tok = getInputTokens(detail.tokens) + (detail.tokens?.completion_tokens || 0);
                      const latTotal = detail.latency?.total || 0;
                      // Tok/s = output tokens / generation time — measures LLM
                      // generation speed (only tokens the model PRODUCED, not the
                      // prompt it consumed). input+output over total time would
                      // inflate the rate for prompt-heavy requests.
                      const output = detail.tokens?.completion_tokens || 0;
                      const tokS = latTotal > 0 ? Math.round((output / (latTotal / 1000)) * 10) / 10 : null;
                      return (
                        <Table.Cell className="text-right font-mono">
                          <div className="tabular-nums">{tok.toLocaleString()}</div>
                          {tokS != null && (
                            <div className="text-vx-text-muted text-[11px]">{tokS} t/s</div>
                          )}
                        </Table.Cell>
                      );
                    })()}
                    <Table.Cell className="text-right font-mono">
                      {Number.isFinite(detail.costNanoUsd) ? fmtUsdNano(detail.costNanoUsd) : "—"}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono">
                      {Number.isFinite(detail.chargedNanoUsd) ? fmtUsdNano(detail.chargedNanoUsd) : "—"}
                    </Table.Cell>
                    <Table.Cell className="text-vx-text-muted">
                      <div className="flex flex-col gap-0.5">
                        <div>TTFT: <span className="font-mono">{detailTtft(detail.latency) != null ? `${detailTtft(detail.latency)}ms` : "—"}</span></div>
                        <div>Total: <span className="font-mono">{detail.latency?.total || 0}ms</span></div>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleViewDetail(detail)}
                      >
                        Detail
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </table>
        </div>

        {!loading && details.length > 0 && (
          <div className="border-t border-vx-border">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </Card>

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title="Request Details"
        width="lg"
      >
        {selectedDetail && (
          <div className="space-y-6">
            <div className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-vx-text-muted">ID:</span>{" "}
                <span className="break-all font-mono text-vx-text">{selectedDetail.id}</span>
              </div>
              <div>
                <span className="text-vx-text-muted">Timestamp:</span>{" "}
                <span className="text-vx-text">{new Date(selectedDetail.timestamp).toLocaleString()}</span>
              </div>
              <div>
                 <span className="text-vx-text-muted">Provider:</span>{" "}
                 <span className="text-vx-text font-medium">{getProviderName(selectedDetail.provider, providerNameCache)}</span>
               </div>
              <div>
                <span className="text-vx-text-muted">Người dùng / Key:</span>{" "}
                <span className="inline-flex max-w-full align-top"><KeyOwner apiKey={selectedDetail.apiKey} info={selectedDetail.keyInfo} compact={false} /></span>
              </div>
              <div>
                <span className="text-vx-text-muted">Model khách gọi:</span>{" "}
                <span className="text-vx-text font-mono">{selectedDetail.requestedModel || selectedDetail.model}</span>
                {!selectedDetail.requestedModel && (
                  <span className="ml-1 text-xs text-vx-text-muted">(không ghi nhận, tính theo model gốc)</span>
                )}
              </div>
              <div>
                <span className="text-vx-text-muted">Model gốc:</span>{" "}
                <span className="text-vx-text font-mono">{selectedDetail.upstreamModel ?? selectedDetail.model}</span>
              </div>
              <div>
                <span className="text-vx-text-muted">Status:</span>{" "}
                <Badge variant={statusBadgeVariant(selectedDetail.status)} size="sm">
                  {selectedDetail.status}
                </Badge>
                <span className="ml-2"><ErrorSourceBadge source={selectedDetail.errorSource} /></span>
              </div>
              <div>
                <span className="text-vx-text-muted">Latency:</span>{" "}
                <span className="text-vx-text font-mono">
                  {formatLatency(selectedDetail.latency?.total, detailTtft(selectedDetail.latency))}
                </span>
              </div>
              <div>
                <span className="text-vx-text-muted">Input Tokens:</span>{" "}
                <span className="text-vx-text font-mono">
                  {getInputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
              {getCachedTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-vx-text-muted">Cached Tokens:</span>{" "}
                  <span className="text-vx-text font-mono">
                    {getCachedTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              {getCacheCreationTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-vx-text-muted">Cache Creation:</span>{" "}
                  <span className="text-vx-text font-mono">
                    {getCacheCreationTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              <div>
                <span className="text-vx-text-muted">Output Tokens:</span>{" "}
                <span className="text-vx-text font-mono">
                  {selectedDetail.tokens?.completion_tokens?.toLocaleString() || 0}
                </span>
              </div>
            </div>

            {selectedDetail.pxpipe && (
              <div className="rounded-vx-md border border-vx-border p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-[18px] text-vx-text-muted">image</span>
                  <span className="font-semibold text-sm text-vx-text">PXPIPE</span>
                  <Badge variant={selectedDetail.pxpipe.applied ? "success" : "warning"} size="sm">
                    {selectedDetail.pxpipe.applied ? "Activated" : "Skipped"}
                  </Badge>
                </div>
                {selectedDetail.pxpipe.applied ? (
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <span className="text-vx-text-muted block text-xs">Original (est.)</span>
                      <span className="font-mono">{(selectedDetail.pxpipe.tokensBeforeEst || 0).toLocaleString()} tokens</span>
                    </div>
                    <div>
                      <span className="text-vx-text-muted block text-xs">Compressed (est.)</span>
                      <span className="font-mono">{(selectedDetail.pxpipe.tokensAfterEst || 0).toLocaleString()} tokens</span>
                    </div>
                    <div>
                      <span className="text-vx-text-muted block text-xs">Saved</span>
                      <span className="font-mono text-vx-success">{selectedDetail.pxpipe.savedPct || 0}%</span>
                    </div>
                    <div>
                      <span className="text-vx-text-muted block text-xs">Images</span>
                      <span className="font-mono">{selectedDetail.pxpipe.imageCount || 0} ({selectedDetail.pxpipe.durationMs || 0}ms)</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-vx-text-muted">
                    Reason: <span className="font-mono">{selectedDetail.pxpipe.reason}</span>
                    {selectedDetail.pxpipe.detail ? ` — ${selectedDetail.pxpipe.detail}` : ""}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-4">
              {!showRaw && (
                <div className="flex items-center gap-2 rounded-vx-md border border-vx-warning/30 bg-vx-warning/10 p-3 text-xs text-vx-warning">
                  <span className="material-symbols-outlined text-[16px]">visibility_off</span>
                  Request & response payloads are redacted. Enable <span className="font-medium">Raw Responses</span> in the filter bar to view them.
                </div>
              )}
              <CollapsibleSection title="1. Client Request (Input)" defaultOpen={true} icon="input">
                {showRaw ? (
                  <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-vx-md border border-vx-border bg-vx-surface-2 p-3 font-mono text-xs text-vx-text sm:p-4">
                    {JSON.stringify(selectedDetail.request, null, 2)}
                  </pre>
                ) : (
                  <RedactedBody value={selectedDetail.request} />
                )}
              </CollapsibleSection>

              {selectedDetail.providerRequest && (
                <CollapsibleSection title="2. Provider Request (Translated)" icon="translate">
                  {showRaw ? (
                    <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-vx-md border border-vx-border bg-vx-surface-2 p-3 font-mono text-xs text-vx-text sm:p-4">
                      {JSON.stringify(selectedDetail.providerRequest, null, 2)}
                    </pre>
                  ) : (
                    <RedactedBody value={selectedDetail.providerRequest} />
                  )}
                </CollapsibleSection>
              )}

              {selectedDetail.providerResponse && (
                <CollapsibleSection title="3. Provider Response (Raw)" icon="data_object">
                  {showRaw ? (
                    <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-vx-md border border-vx-border bg-vx-surface-2 p-3 font-mono text-xs text-vx-text sm:p-4">
                      {typeof selectedDetail.providerResponse === 'object'
                        ? JSON.stringify(selectedDetail.providerResponse, null, 2)
                        : selectedDetail.providerResponse
                      }
                    </pre>
                  ) : (
                    <RedactedBody value={selectedDetail.providerResponse} />
                  )}
                </CollapsibleSection>
              )}

              <CollapsibleSection title="4. Client Response (Final)" defaultOpen={true} icon="output">
                {showRaw ? (
                  <>
                    {selectedDetail.response?.thinking && (
                      <div className="mb-4">
                        <h4 className="font-semibold text-vx-text mb-2 flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">
                          <span className="material-symbols-outlined text-[16px]">psychology</span>
                          Thinking Process
                        </h4>
                        <pre className="max-h-[200px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-vx-md border border-vx-warning/30 bg-vx-warning/10 p-3 font-mono text-xs text-vx-warning sm:p-4">
                          {selectedDetail.response.thinking}
                        </pre>
                      </div>
                    )}

                    <h4 className="font-semibold text-vx-text mb-2 text-xs uppercase tracking-wide opacity-70">
                      Content
                    </h4>
                    <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-vx-md border border-vx-border bg-vx-surface-2 p-3 font-mono text-xs text-vx-text sm:p-4">
                      {selectedDetail.response?.content || "[No content]"}
                    </pre>
                  </>
                ) : (
                  <RedactedBody value={selectedDetail.response} />
                )}
              </CollapsibleSection>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function RedactedBody({ value }) {
  // The route already returns { redacted: true } for concealed payloads, but a
  // payload may also be a plain object (when includeRaw was on, then toggled off
  // mid-session) — normalize both to a clear "(redacted)" notice.
  const isRedacted =
    value === null ||
    value === undefined ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) ||
    (typeof value === "object" && value.redacted === true);
  return (
    <div className="flex items-center gap-2 rounded-vx-md border border-vx-border bg-vx-surface-2 p-3 text-xs text-vx-text-muted">
      <span className="material-symbols-outlined text-[16px]">visibility_off</span>
      {isRedacted ? "Redacted — enable Raw Responses to view." : "(redacted)"}
    </div>
  );
}
