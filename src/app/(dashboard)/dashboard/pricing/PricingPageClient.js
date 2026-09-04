"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, Button, Input, Select, Modal, ConfirmModal, CardSkeleton } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { PRICING_FIELDS, EMPTY_PRICING, parsePricingDraft, pricingToDraft } from "@/shared/utils/pricingMatch";

const PAGE_SIZE = 20;

// A row is considered a user override when its 5-field values differ from the
// built-in default for the same (provider, model), OR the built-in has no entry.
function isOverrideRow(merged, defaults, provider, model) {
  const d = defaults?.[provider]?.[model];
  if (!d) return true; // not in built-in → user-added
  const m = merged?.[provider]?.[model];
  for (const f of ["input", "output", "cached", "reasoning", "cache_creation"]) {
    if (Number(m?.[f] ?? 0) !== Number(d[f] ?? 0)) return true;
  }
  return false;
}

// Flatten {provider:{model:{5 fields}}} into sorted rows.
function flatten(merged, defaults) {
  const rows = [];
  for (const [provider, models] of Object.entries(merged || {})) {
    for (const [model, pricing] of Object.entries(models || {})) {
      rows.push({
        provider,
        model,
        input: pricing?.input ?? 0,
        output: pricing?.output ?? 0,
        cached: pricing?.cached ?? 0,
        reasoning: pricing?.reasoning ?? 0,
        cache_creation: pricing?.cache_creation ?? 0,
        isOverride: isOverrideRow(merged, defaults, provider, model),
      });
    }
  }
  rows.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.model.localeCompare(b.model);
  });
  return rows;
}

export default function PricingPageClient() {
  const [loading, setLoading] = useState(true);
  const [merged, setMerged] = useState({}); // GET /api/pricing
  const [defaults, setDefaults] = useState({}); // GET /api/pricing?defaults=1
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  // Inline edit state
  const [editing, setEditing] = useState(null); // {provider, model}
  const [editDraft, setEditDraft] = useState({ ...EMPTY_PRICING });
  const [savingRow, setSavingRow] = useState(false);

  // Add price modal
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState({ provider: "", model: "", ...EMPTY_PRICING });
  const [savingAdd, setSavingAdd] = useState(false);

  const [status, setStatus] = useState(null); // {type, message}
  const [confirmReset, setConfirmReset] = useState(null); // {provider, model}

  const loadData = useCallback(async () => {
    try {
      const [mergedRes, defaultsRes] = await Promise.all([
        fetch("/api/pricing"),
        fetch("/api/pricing?defaults=1"),
      ]);
      if (mergedRes.ok) setMerged((await mergedRes.json()) || {});
      if (defaultsRes.ok) setDefaults((await defaultsRes.json()) || {});
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const rows = useMemo(() => flatten(merged, defaults), [merged, defaults]);

  const providerOptions = useMemo(() => {
    const counts = {};
    for (const r of rows) counts[r.provider] = (counts[r.provider] || 0) + 1;
    return [
      { value: "", label: `All providers (${rows.length})` },
      ...Object.keys(counts).sort().map((p) => ({ value: p, label: `${p} (${counts[p]})` })),
    ];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (providerFilter && r.provider !== providerFilter) return false;
      if (!q) return true;
      return r.provider.toLowerCase().includes(q) || r.model.toLowerCase().includes(q);
    });
  }, [rows, search, providerFilter]);

  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Reset page when filters change.
  useEffect(() => { setPage(1); }, [search, providerFilter, pageSize]);

  const startEdit = (row) => {
    setEditing({ provider: row.provider, model: row.model });
    setEditDraft({
      input: String(row.input ?? ""),
      output: String(row.output ?? ""),
      cached: String(row.cached ?? ""),
      reasoning: String(row.reasoning ?? ""),
      cache_creation: String(row.cache_creation ?? ""),
    });
    setStatus(null);
  };

  const cancelEdit = () => { setEditing(null); setEditDraft({ ...EMPTY_PRICING }); };

  const saveEdit = async () => {
    if (!editing) return;
    let parsed;
    try { parsed = parsePricingDraft(editDraft); }
    catch (e) { setStatus({ type: "error", message: e.message }); return; }
    setSavingRow(true);
    try {
      const body = { [editing.provider]: { [editing.model]: parsed } };
      const res = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({ type: "error", message: data.error || "Failed to save price" });
        return;
      }
      const updated = await res.json();
      setMerged(updated || merged);
      setStatus({ type: "success", message: `Saved price for ${editing.provider}/${editing.model}` });
      cancelEdit();
    } catch (e) {
      setStatus({ type: "error", message: e.message || "Failed to save price" });
    } finally {
      setSavingRow(false);
    }
  };

  const resetOverride = async (provider, model) => {
    setSavingRow(true);
    try {
      const res = await fetch(`/api/pricing?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, { method: "DELETE" });
      if (!res.ok) { setStatus({ type: "error", message: "Failed to reset" }); return; }
      const updated = await res.json();
      setMerged(updated || {});
      setStatus({ type: "success", message: `Reset ${provider}/${model} to built-in default` });
    } catch (e) {
      setStatus({ type: "error", message: e.message || "Failed to reset" });
    } finally {
      setSavingRow(false);
      setConfirmReset(null);
    }
  };

  const saveAdd = async () => {
    const provider = addDraft.provider.trim();
    const model = addDraft.model.trim();
    if (!provider) { setStatus({ type: "error", message: "Provider is required" }); return; }
    if (!model) { setStatus({ type: "error", message: "Model is required" }); return; }
    let parsed;
    try { parsed = parsePricingDraft(addDraft); }
    catch (e) { setStatus({ type: "error", message: e.message }); return; }
    setSavingAdd(true);
    try {
      const body = { [provider]: { [model]: parsed } };
      const res = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({ type: "error", message: data.error || "Failed to add price" });
        return;
      }
      const updated = await res.json();
      setMerged(updated || merged);
      setStatus({ type: "success", message: `Added price for ${provider}/${model}` });
      setShowAdd(false);
      setAddDraft({ provider: "", model: "", ...EMPTY_PRICING });
    } catch (e) {
      setStatus({ type: "error", message: e.message || "Failed to add price" });
    } finally {
      setSavingAdd(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
      </div>
    );
  }

  const overrideCount = rows.filter((r) => r.isOverride).length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">sell</span>
              Pool Model Pricing
            </h2>
            <p className="text-sm text-text-muted mt-1">
              Per-pool model prices (USD / 1M tokens). Built-in defaults are read-only;
              overrides apply on top. Combo-level pricing is set on the Combos page.
            </p>
          </div>
          <Button onClick={() => setShowAdd(true)} icon="add">
            Add Price
          </Button>
        </div>

        {status && (
          <div className={`text-sm flex items-center gap-1 mb-4 ${status.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
            <span className="material-symbols-outlined text-[16px]">{status.type === "error" ? "error" : "check_circle"}</span>
            {status.message}
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <Input
            placeholder="Search provider or model…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon="search"
            className="sm:flex-1"
          />
          <Select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            options={providerOptions}
            className="sm:w-64"
          />
        </div>

        <div className="text-xs text-text-muted mb-3 flex items-center gap-3">
          <span><span className="font-medium text-text-main">{totalItems}</span> rows</span>
          <span className="inline-flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px] text-amber-500">edit</span>
            <span className="font-medium text-text-main">{overrideCount}</span> override{overrideCount !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Table */}
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-muted border-b border-border-subtle">
                <th className="text-left font-medium px-2 py-2">Provider</th>
                <th className="text-left font-medium px-2 py-2">Model</th>
                {PRICING_FIELDS.map((f) => (
                  <th key={f.key} className="text-right font-medium px-2 py-2 whitespace-nowrap">{f.label.replace(" ($/1M)", "")}</th>
                ))}
                <th className="text-right font-medium px-2 py-2 w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-text-muted py-10">
                    No prices match the current filter.
                  </td>
                </tr>
              )}
              {pageRows.map((row) => {
                const isEditing = editing?.provider === row.provider && editing?.model === row.model;
                return (
                  <tr key={`${row.provider}/${row.model}`} className="border-b border-border-subtle/50 hover:bg-surface-2/50">
                    <td className="px-2 py-2 text-text-muted whitespace-nowrap">{row.provider}</td>
                    <td className="px-2 py-2 font-medium text-text-main whitespace-nowrap">
                      {row.model}
                      {row.isOverride && (
                        <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400 align-middle">
                          <span className="material-symbols-outlined text-[12px]">edit</span>override
                        </span>
                      )}
                    </td>
                    {isEditing ? (
                      <>
                        {PRICING_FIELDS.map((f) => (
                          <td key={f.key} className="px-1 py-1 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editDraft[f.key]}
                              onChange={(e) => setEditDraft({ ...editDraft, [f.key]: e.target.value })}
                              placeholder="0"
                              className="w-20 px-2 py-1 text-right text-sm bg-surface-2 border border-border rounded-[8px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                            />
                          </td>
                        ))}
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <Button size="sm" onClick={saveEdit} disabled={savingRow} loading={savingRow}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={savingRow} className="ml-1">Cancel</Button>
                        </td>
                      </>
                    ) : (
                      <>
                        {PRICING_FIELDS.map((f) => (
                          <td key={f.key} className={`px-2 py-2 text-right tabular-nums ${row.isOverride ? "text-text-main font-medium" : "text-text-muted"}`}>
                            {Number(row[f.key]) > 0 ? Number(row[f.key]).toFixed(row[f.key] < 1 ? 4 : 2) : "—"}
                          </td>
                        ))}
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => startEdit(row)}
                            title="Edit"
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-main"
                          >
                            <span className="material-symbols-outlined text-[18px]">edit</span>
                          </button>
                          {row.isOverride && (
                            <button
                              onClick={() => setConfirmReset({ provider: row.provider, model: row.model })}
                              title="Reset to built-in"
                              className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-red-500 ml-1"
                            >
                              <span className="material-symbols-outlined text-[18px]">restart_alt</span>
                            </button>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalItems > pageSize && (
          <Pagination
            currentPage={currentPage}
            pageSize={pageSize}
            totalItems={totalItems}
            onPageChange={setPage}
            onPageSizeChange={(s) => setPageSize(Number(s) || PAGE_SIZE)}
          />
        )}
      </Card>

      {/* Add Price modal */}
      <Modal
        isOpen={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Pool Price"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowAdd(false)} disabled={savingAdd}>Cancel</Button>
            <Button onClick={saveAdd} disabled={savingAdd} loading={savingAdd}>Add Price</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Provider"
              placeholder="e.g. openai, anthropic"
              value={addDraft.provider}
              onChange={(e) => setAddDraft({ ...addDraft, provider: e.target.value })}
              required
            />
            <Input
              label="Model"
              placeholder="e.g. gpt-5.2"
              value={addDraft.model}
              onChange={(e) => setAddDraft({ ...addDraft, model: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {PRICING_FIELDS.map((f) => (
              <Input
                key={f.key}
                label={f.label}
                type="number"
                step="0.01"
                min="0"
                value={addDraft[f.key]}
                onChange={(e) => setAddDraft({ ...addDraft, [f.key]: e.target.value })}
                placeholder="0.00"
              />
            ))}
          </div>
          <p className="text-xs text-text-muted">
            Leave prices at 0 if a field doesn't apply. This creates or overrides the pool
            price for this provider/model pair.
          </p>
        </div>
      </Modal>

      {/* Reset override confirm */}
      <ConfirmModal
        isOpen={!!confirmReset}
        onClose={() => setConfirmReset(null)}
        title="Reset to built-in?"
        message={confirmReset ? `Reset the price for ${confirmReset.provider}/${confirmReset.model} back to its built-in default?` : ""}
        confirmText="Reset"
        loading={savingRow}
        onConfirm={() => confirmReset && resetOverride(confirmReset.provider, confirmReset.model)}
      />
    </div>
  );
}
