"use client";

import React, { useState, useEffect, useMemo } from "react";
import { apiGet } from "@/shared/api/client";
import type { Combo } from "@/shared/types";

/**
 * Multi-select picker for allowed models, backed by /api/combos (LLM combos only).
 *
 * A key/group's allowedModels stores **combo names** (not raw pool model ids), so
 * key-holders consume curated named combos rather than individual pool models —
 * this keeps internal pool ids (e.g. vinGLM-5.2) out of the admin UI and avoids
 * duplicate models across pools.
 */

export interface AllowedModelsPickerProps {
  value?: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}

export default function AllowedModelsPicker({ value = [], onChange, placeholder = "Search combos…" }: AllowedModelsPickerProps) {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [query, setQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // LLM combos only (kind null or "llm") — same filter the combos dashboard uses.
    apiGet<{ combos: Combo[] }>("/api/combos")
      .then((data) => {
        if (cancelled) return;
        const llm = (data.combos || []).filter((c: Combo) => !c.kind || c.kind === "llm");
        setCombos(llm);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setCombos([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(() => value, [value]);

  const filtered = useMemo<Combo[]>(() => {
    if (!query.trim()) return combos;
    const q = query.toLowerCase();
    return combos.filter((c: Combo) => (c.name || "").toLowerCase().includes(q));
  }, [combos, query]);

  const toggle = (name: string): void => {
    if (selected.includes(name)) onChange(selected.filter((x: string) => x !== name));
    else onChange([...selected, name]);
  };

  const remove = (name: string): void => onChange(selected.filter((x: string) => x !== name));

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-main">Allowed combos</label>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((name: string) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary/10 text-primary border border-primary/20"
            >
              {name}
              <button
                type="button"
                onClick={() => remove(name)}
                className="hover:text-red-500"
                title="Remove"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-text-muted hover:text-red-500 underline ml-1"
          >
            clear all
          </button>
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder={loading ? "Loading…" : placeholder}
          className="w-full py-2.5 px-3 pr-9 text-sm bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40"
        />
        <span className="material-symbols-outlined text-[18px] absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">search</span>
      </div>

      {/* Dropdown results: combo names */}
      {filtered.length > 0 && (
        <div className="border border-border rounded-[10px] bg-surface-1 max-h-56 overflow-y-auto shadow-lg z-10">
          {filtered.map((c: Combo) => {
            const isSel = selected.includes(c.name);
            const count = (c.models || []).length;
            return (
              <button
                key={c.id || c.name}
                type="button"
                onClick={() => toggle(c.name)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-black/5 dark:hover:bg-white/5 ${isSel ? "bg-primary/5" : ""}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="material-symbols-outlined text-[16px] text-text-muted shrink-0">
                    {isSel ? "check_box" : "check_box_outline_blank"}
                  </span>
                  <span className="font-mono text-xs truncate">{c.name}</span>
                </span>
                <span className="text-[11px] text-text-muted shrink-0">{count} model{count !== 1 ? "s" : ""}</span>
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 && !loading && (
        <p className="text-xs text-text-muted p-2">
          {combos.length === 0
            ? "No combos yet — create one on the Combos page first."
            : "No combos match your search."}
        </p>
      )}

      {selected.length === 0 && (
        <p className="text-xs text-text-muted">Leave blank to allow all combos.</p>
      )}
    </div>
  );
}
