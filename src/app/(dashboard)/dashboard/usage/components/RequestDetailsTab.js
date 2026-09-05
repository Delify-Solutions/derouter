"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { maskKeyFull } from "@/shared/utils/apiKey";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

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
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>}
          <span className="font-semibold text-sm text-text-main">{title}</span>
        </div>
        <span className={cn(
          "material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200",
          isOpen ? "rotate-90" : ""
        )}>
          chevron_right
        </span>
      </button>
      
      {isOpen && (
        <div className="p-4 border-t border-black/5 dark:border-white/5">
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

// Status → color class. 2xx green, 4xx amber, 5xx red; "error"/unknown muted.
// Mirrors the public /usage page's helper so both views color statuses the same.
function statusColorClass(status) {
  const s = String(status || "");
  if (!s || s === "—" || s === "null") return "text-text-muted";
  if (s === "success") return "text-green-600 dark:text-green-400";
  if (s === "error") return "text-red-600 dark:text-red-400";
  if (s.startsWith("2")) return "text-green-600 dark:text-green-400";
  if (s.startsWith("4")) return "text-amber-600 dark:text-amber-400";
  if (s.startsWith("5")) return "text-red-600 dark:text-red-400";
  return "text-text-muted";
}

// Render an error-source badge. "platform" = the proxy's OWN limit (RPM/TPM/
// budget/expiry/abort/bad-gateway) rejected the request before (or without)
// the upstream; "upstream" = the provider API returned the error. Success
// rows render nothing.
function ErrorSourceBadge({ source }) {
  if (!source) return null;
  const isPlatform = source === "platform";
  const label = isPlatform ? "Platform" : "Upstream";
  const cls = isPlatform
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`} title={isPlatform ? "Rejected by the proxy's own limit" : "Returned by the upstream API"}>
      {label}
    </span>
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

export default function RequestDetailsTab() {
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
  const [filters, setFilters] = useState({
    provider: "",
    apiKey: "",
    status: "",
    startDate: "",
    endDate: ""
  });
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

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
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString()
      });
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.apiKey) params.append("apiKey", filters.apiKey);
      if (filters.status) params.append("status", filters.status);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);
      if (showRaw) params.append("includeRaw", "1");

      const res = await fetch(`/api/usage/request-details?${params}`);
      const data = await res.json();

      setDetails(data.details || []);
      setPagination(prev => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch request details:", error);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters, showRaw]);

  useEffect(() => {
    fetchProviders();
    fetchKeys();
  }, [fetchProviders, fetchKeys]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

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
    setFilters({ provider: "", apiKey: "", status: "", startDate: "", endDate: "" });
    setShowRaw(false);
  };

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="provider-filter" className="text-sm font-medium text-text-main">Provider</label>
            <select
              id="provider-filter"
              value={filters.provider}
              onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-full min-w-0 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Providers</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="key-filter" className="text-sm font-medium text-text-main">Key</label>
            <select
              id="key-filter"
              value={filters.apiKey}
              onChange={(e) => setFilters({ ...filters, apiKey: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-full min-w-0 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Keys</option>
              {keys.map((k) => (
                <option key={k.id || k.key} value={k.key}>
                  {k.name ? `${k.name} — ${maskKeyFull(k.key)}` : maskKeyFull(k.key)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="status-filter" className="text-sm font-medium text-text-main">Status</label>
            <select
              id="status-filter"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-full min-w-0 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Statuses</option>
              <option value="2">2xx (success)</option>
              <option value="4">4xx (client / rate-limit)</option>
              <option value="5">5xx (server / upstream)</option>
              <option value="error">error</option>
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="start-date-filter" className="text-sm font-medium text-text-main">Start Date</label>
            <input
              id="start-date-filter"
              type="datetime-local"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              )}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="end-date-filter" className="text-sm font-medium text-text-main">End Date</label>
            <input
              id="end-date-filter"
              type="datetime-local"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              )}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label className="text-sm font-medium text-text-main">Raw Responses</label>
            <button
              type="button"
              role="switch"
              aria-checked={showRaw}
              onClick={() => setShowRaw((v) => !v)}
              className={cn(
                "h-9 px-3 rounded-lg border flex items-center justify-between gap-2 text-sm w-full min-w-0 transition-colors",
                showRaw
                  ? "border-brand-500/40 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                  : "border-black/10 dark:border-white/10 bg-surface text-text-muted"
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">{showRaw ? "visibility" : "visibility_off"}</span>
                {showRaw ? "Showing raw" : "Redacted"}
              </span>
              <span className={cn(
                "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
                showRaw ? "bg-brand-500" : "bg-surface-3"
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
              <span className="text-sm text-text-muted">Delete ALL request logs?</span>
              <Button
                variant="primary"
                onClick={handleClearAll}
                disabled={clearing}
                className="!bg-red-600 hover:!bg-red-700"
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
              variant="ghost"
              onClick={() => setConfirmClear(true)}
              disabled={clearing || details.length === 0}
              className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <span className="material-symbols-outlined text-[18px] mr-1">delete_sweep</span>
              Clear all logs
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={handleClearFilters}
            disabled={!filters.provider && !filters.apiKey && !filters.status && !filters.startDate && !filters.endDate && !showRaw}
            className="w-full sm:w-auto"
          >
            Clear Filters
          </Button>
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Timestamp</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Model</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Provider</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Key</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Status</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Input Tokens</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cached</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cache Creation</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Output Tokens</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main" title="Tokens (input + output); Tok/s = output tokens / total time">Tok</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Latency</th>
                <th className="text-center p-4 text-sm font-semibold text-text-main">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="12" className="p-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : details.length === 0 ? (
                <tr>
                  <td colSpan="12" className="p-8 text-center text-text-muted">
                    No request details found
                  </td>
                </tr>
              ) : (
                details.map((detail, index) => (
                  <tr
                    key={`${detail.id}-${index}`}
                    className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="whitespace-nowrap p-4 text-sm text-text-main">
                      {new Date(detail.timestamp).toLocaleString()}
                    </td>
                    <td className="max-w-[260px] truncate p-4 font-mono text-sm text-text-main">
                      {detail.model}
                    </td>
                    <td className="max-w-[180px] truncate p-4 text-sm text-text-main">
                       <span className="font-medium">
                         {getProviderName(detail.provider, providerNameCache)}
                       </span>
                     </td>
                    <td className="max-w-[200px] truncate p-4 text-xs text-text-muted font-mono" title={detail.apiKey || ""}>
                      {detail.apiKey ? maskKeyFull(detail.apiKey) : "—"}
                    </td>
                    <td className="p-4 text-sm">
                      <div className="flex flex-col gap-1">
                        <span className={`font-medium ${statusColorClass(detail.status)}`}>
                          {detail.status || "—"}
                        </span>
                        <ErrorSourceBadge source={detail.errorSource} />
                      </div>
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getInputTokens(detail.tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCachedTokens(detail.tokens) > 0 ? getCachedTokens(detail.tokens).toLocaleString() : "—"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCacheCreationTokens(detail.tokens) > 0 ? getCacheCreationTokens(detail.tokens).toLocaleString() : "—"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {detail.tokens?.completion_tokens?.toLocaleString() || 0}
                    </td>
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
                        <td className="p-4 text-sm text-text-main text-right font-mono">
                          <div className="tabular-nums">{tok.toLocaleString()}</div>
                          {tokS != null && (
                            <div className="text-text-muted text-[11px]">{tokS} t/s</div>
                          )}
                        </td>
                      );
                    })()}
                    <td className="p-4 text-sm text-text-muted">
                      <div className="flex flex-col gap-0.5">
                        <div>TTFT: <span className="font-mono">{detail.latency?.ttft || 0}ms</span></div>
                        <div>Total: <span className="font-mono">{detail.latency?.total || 0}ms</span></div>
                      </div>
                    </td>
                    <td className="p-4 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleViewDetail(detail)}
                      >
                        Detail
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && details.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
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
                <span className="text-text-muted">ID:</span>{" "}
                <span className="break-all font-mono text-text-main">{selectedDetail.id}</span>
              </div>
              <div>
                <span className="text-text-muted">Timestamp:</span>{" "}
                <span className="text-text-main">{new Date(selectedDetail.timestamp).toLocaleString()}</span>
              </div>
              <div>
                 <span className="text-text-muted">Provider:</span>{" "}
                 <span className="text-text-main font-medium">{getProviderName(selectedDetail.provider, providerNameCache)}</span>
               </div>
              <div>
                <span className="text-text-muted">Key:</span>{" "}
                <span className="text-text-main font-mono">{selectedDetail.apiKey ? maskKeyFull(selectedDetail.apiKey) : "—"}</span>
              </div>
              <div>
                <span className="text-text-muted">Model:</span>{" "}
                <span className="text-text-main font-mono">{selectedDetail.model}</span>
              </div>
              <div>
                <span className="text-text-muted">Status:</span>{" "}
                <span className={cn("font-medium", statusColorClass(selectedDetail.status))}>
                  {selectedDetail.status}
                </span>
                <span className="ml-2"><ErrorSourceBadge source={selectedDetail.errorSource} /></span>
              </div>
              <div>
                <span className="text-text-muted">Latency:</span>{" "}
                <span className="text-text-main font-mono">
                  TTFT {selectedDetail.latency?.ttft || 0}ms / Total {selectedDetail.latency?.total || 0}ms
                </span>
              </div>
              <div>
                <span className="text-text-muted">Input Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {getInputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
              {getCachedTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cached Tokens:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCachedTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              {getCacheCreationTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cache Creation:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCacheCreationTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              <div>
                <span className="text-text-muted">Output Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {selectedDetail.tokens?.completion_tokens?.toLocaleString() || 0}
                </span>
              </div>
            </div>

            {selectedDetail.pxpipe && (
              <div className="rounded-lg border border-black/5 dark:border-white/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-[18px] text-text-muted">image</span>
                  <span className="font-semibold text-sm text-text-main">PXPIPE</span>
                  <span className={cn(
                    "text-xs px-2 py-0.5 rounded",
                    selectedDetail.pxpipe.applied
                      ? "bg-green-500/15 text-green-600"
                      : "bg-amber-500/15 text-amber-600"
                  )}>
                    {selectedDetail.pxpipe.applied ? "Activated" : "Skipped"}
                  </span>
                </div>
                {selectedDetail.pxpipe.applied ? (
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <span className="text-text-muted block text-xs">Original (est.)</span>
                      <span className="font-mono">{(selectedDetail.pxpipe.tokensBeforeEst || 0).toLocaleString()} tokens</span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Compressed (est.)</span>
                      <span className="font-mono">{(selectedDetail.pxpipe.tokensAfterEst || 0).toLocaleString()} tokens</span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Saved</span>
                      <span className="font-mono text-green-600">{selectedDetail.pxpipe.savedPct || 0}%</span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Images</span>
                      <span className="font-mono">{selectedDetail.pxpipe.imageCount || 0} ({selectedDetail.pxpipe.durationMs || 0}ms)</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">
                    Reason: <span className="font-mono">{selectedDetail.pxpipe.reason}</span>
                    {selectedDetail.pxpipe.detail ? ` — ${selectedDetail.pxpipe.detail}` : ""}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-4">
              {!showRaw && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  <span className="material-symbols-outlined text-[16px]">visibility_off</span>
                  Request & response payloads are redacted. Enable <span className="font-medium">Raw Responses</span> in the filter bar to view them.
                </div>
              )}
              <CollapsibleSection title="1. Client Request (Input)" defaultOpen={true} icon="input">
                {showRaw ? (
                  <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                    {JSON.stringify(selectedDetail.request, null, 2)}
                  </pre>
                ) : (
                  <RedactedBody value={selectedDetail.request} />
                )}
              </CollapsibleSection>

              {selectedDetail.providerRequest && (
                <CollapsibleSection title="2. Provider Request (Translated)" icon="translate">
                  {showRaw ? (
                    <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
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
                    <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
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
                        <h4 className="font-semibold text-text-main mb-2 flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">
                          <span className="material-symbols-outlined text-[16px]">psychology</span>
                          Thinking Process
                        </h4>
                        <pre className="max-h-[200px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-200 bg-amber-50 p-3 font-mono text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 sm:p-4">
                          {selectedDetail.response.thinking}
                        </pre>
                      </div>
                    )}

                    <h4 className="font-semibold text-text-main mb-2 text-xs uppercase tracking-wide opacity-70">
                      Content
                    </h4>
                    <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
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
    <div className="flex items-center gap-2 rounded-lg border border-black/5 bg-black/[0.02] p-3 text-xs text-text-muted dark:border-white/5 dark:bg-white/[0.02]">
      <span className="material-symbols-outlined text-[16px]">visibility_off</span>
      {isRedacted ? "Redacted — enable Raw Responses to view." : "(redacted)"}
    </div>
  );
}
