"use client";

import { useState, useEffect, useCallback } from "react";

const WINDOW_LABELS = { "5h": "every 5h", day: "every day", week: "every week" };

export default function UsagePage() {
  const [keyInput, setKeyInput] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Read key from hash (#/usage or #/usage?key=...) on mount.
  const readHashKey = useCallback(() => {
    if (typeof window === "undefined") return "";
    const hash = window.location.hash || "";
    const m = hash.match(/[?&]key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, []);

  const lookup = useCallback(async (key) => {
    if (!key) return;
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await fetch(`/api/usage/key?key=${encodeURIComponent(key)}`);
      if (res.status === 404) { setError("Key not found"); return; }
      if (!res.ok) { setError("Failed to load usage"); return; }
      const d = await res.json();
      setData(d);
    } catch { setError("Failed to load usage"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const k = readHashKey();
    if (k) { setKeyInput(k); lookup(k); }
  }, [readHashKey, lookup]);

  const submitKey = (e) => {
    e?.preventDefault();
    const k = keyInput.trim();
    if (!k) return;
    // Stash key in hash so the link is shareable + survives refresh.
    if (typeof window !== "undefined") {
      window.location.hash = `/usage?key=${encodeURIComponent(k)}`;
    }
    lookup(k);
  };

  const clearKey = () => {
    setData(null);
    setKeyInput("");
    setError("");
    if (typeof window !== "undefined") window.location.hash = "/usage";
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  };

  return (
    <div className="min-h-screen bg-bg text-text-main" style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px" }}>
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
              {data.groupName ? `Group: ${data.groupName}` : "Custom key"}
              {!data.active && <span className="ml-2 text-orange-500">Paused</span>}
              {data.expiresAt && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  Expires {new Date(data.expiresAt).toLocaleString()}
                </span>
              )}
            </p>
          </div>

          {/* Base URL + Key */}
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
              <code className="font-mono text-xs flex-1 truncate">{keyInput || "••••••••"}</code>
              <button onClick={() => copy(keyInput || "")} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted" title="Copy">
                <span className="material-symbols-outlined text-[14px]">content_copy</span>
              </button>
            </div>
          </div>

          {/* Budget */}
          <div className="rounded-xl border border-border bg-surface-1 p-4">
            <h3 className="text-sm font-semibold mb-3">Budget</h3>
            {data.budgetUsd == null ? (
              <p className="text-sm text-text-muted">Unlimited budget</p>
            ) : (
              <>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-sm">
                    <span className="text-lg font-semibold">${(data.windowCostUsd ?? 0).toFixed(4)}</span>
                    <span className="text-text-muted"> / ${data.budgetUsd.toFixed(2)}</span>
                  </span>
                  <span className="text-xs text-text-muted">
                    Remaining: {data.remainingBudgetUsd == null ? "∞" : `$${data.remainingBudgetUsd.toFixed(4)}`}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.min(100, (data.windowCostUsd / data.budgetUsd) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-text-muted mt-2">
                  {data.resetWindow
                    ? `Resets ${WINDOW_LABELS[data.resetWindow] || data.resetWindow}${data.resetAt ? ` · ${new Date(data.resetAt).toLocaleString()}` : ""}`
                    : "No reset window"}
                </p>
              </>
            )}
          </div>

          {/* Rate limits */}
          <div className="rounded-xl border border-border bg-surface-1 p-4">
            <h3 className="text-sm font-semibold mb-3">Rate Limits (last 60s)</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-text-muted text-xs">Requests</p>
                <p className="font-medium">{data.limitCount?.requests ?? 0}{data.rpm != null ? ` / ${data.rpm} RPM` : " · ∞ RPM"}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Tokens</p>
                <p className="font-medium">{(data.limitCount?.tokens ?? 0).toLocaleString()}{data.tpm != null ? ` / ${data.tpm} TPM` : " · ∞ TPM"}</p>
              </div>
            </div>
          </div>

          {/* Window requests */}
          {data.resetWindow && (
            <div className="rounded-xl border border-border bg-surface-1 p-4 text-sm">
              <span className="text-text-muted">Requests this window: </span>
              <span className="font-medium">{data.windowRequests ?? 0}</span>
            </div>
          )}

          {/* Allowed models */}
          <div className="rounded-xl border border-border bg-surface-1 p-4">
            <h3 className="text-sm font-semibold mb-3">Allowed Models</h3>
            {data.allowedModels && data.allowedModels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {data.allowedModels.map((m) => (
                  <span
                    key={m}
                    className="text-xs px-2 py-1 rounded bg-primary/10 text-primary border border-primary/20 cursor-pointer"
                    title={`Copy ${m}`}
                    onClick={() => copy(m)}
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">All models allowed</p>
            )}
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}
