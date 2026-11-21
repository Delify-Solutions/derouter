"use client";

// Shared search / filter / sort / Top N toolbar of the admin usage tables
// (spec admin-usage-views "Shared table toolbar"). The state lives in the URL, namespaced
// per table (see src/shared/utils/tableQuery.js), so a reload or a shared link restores it
// and two tables on one page never override each other. Column headers write the same
// state through SortableHeader, so header and toolbar always agree.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { readTableQuery, writeTableQuery, TOP_VALUES } from "@/shared/utils/tableQuery";

const LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
const FIELD = cn(
  "h-9 w-full min-w-0 rounded-none border border-border bg-surface px-3 text-sm text-text-main",
  "focus:border-brand-500 focus:outline-none transition-colors duration-150"
);

export const DIR_OPTIONS = [
  { value: "desc", label: "Nhiều → ít" },
  { value: "asc", label: "Ít → nhiều" },
];

const TOP_OPTIONS = [
  ...TOP_VALUES.map((n) => ({ value: String(n), label: `Top ${n}` })),
  { value: "0", label: "Tất cả" },
];

/**
 * One table's toolbar state, read from and written to the URL.
 * `defaults` and `options` must be stable (module constants): they key the memo.
 * Returns [state, update] where update takes a patch object or a function of the state.
 */
export function useTableQuery(ns, defaults, options) {
  const searchParams = useSearchParams();
  const state = useMemo(() => readTableQuery(searchParams, ns, defaults, options), [searchParams, ns, defaults, options]);
  const update = useCallback((patch) => {
    // Built from the live URL, not the render's snapshot, so two updates in a row (or two
    // tables) never drop each other's keys. replaceState is folded into the Next.js router
    // (useSearchParams re-renders) without a server round trip.
    const params = new URLSearchParams(window.location.search);
    const current = readTableQuery(params, ns, defaults, options);
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
    writeTableQuery(params, ns, next, defaults, options);
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [ns, defaults, options]);
  return [state, update];
}

function SelectField({ id, label, value, onChange, options }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto sm:min-w-[150px]">
      <label htmlFor={id} className={LABEL}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={FIELD} style={{ colorScheme: "auto" }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

// The search box keeps its own text while typing and writes the URL after a pause, so a
// keystroke never waits for a navigation. A change made elsewhere ("Xoá bộ lọc", back
// button) replaces the text, unless it is the value this box wrote itself.
function SearchField({ id, value, onChange, placeholder }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [emitted, setEmitted] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== emitted) {
      setText(value);
      setEmitted(value);
    }
  }
  useEffect(() => {
    if (text === emitted) return undefined;
    const timer = setTimeout(() => {
      setEmitted(text);
      onChange(text);
    }, 250);
    return () => clearTimeout(timer);
  }, [text, emitted, onChange]);
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5 sm:min-w-[240px] sm:flex-1">
      <label htmlFor={id} className={LABEL}>Tìm kiếm</label>
      <div className="relative">
        <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[18px] text-text-muted" aria-hidden="true">search</span>
        <input
          id={id}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className={cn(FIELD, "pl-9")}
        />
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.state             toolbar state from useTableQuery
 * @param {function} props.onChange        update from useTableQuery (patch or updater)
 * @param {string} [props.searchPlaceholder]
 * @param {boolean} [props.showSearch=true]
 * @param {Array<{name:string,label:string,options:Array<{value:string,label:string}>}>} [props.filters]
 *        "Tất cả" is added in front of each filter's options
 * @param {Array<{value:string,label:string}>} props.sortOptions  "Sắp xếp theo" fields
 * @param {boolean} [props.showTop=true]   the "Hiển thị" Top N select
 * @param {number} [props.shown]           rows shown (counter "N / M")
 * @param {number} [props.total]           rows in the table's data
 * @param {import("react").ReactNode} [props.children]  extra controls at the end
 */
export default function TableToolbar({
  state,
  onChange,
  searchPlaceholder = "",
  showSearch = true,
  filters = [],
  sortOptions = [],
  showTop = true,
  shown,
  total,
  children,
  className,
}) {
  const uid = useId();
  const setSearch = useCallback((q) => onChange((s) => ({ ...s, q })), [onChange]);
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-3">
        {showSearch && (
          <SearchField id={`${uid}-q`} value={state.q || ""} onChange={setSearch} placeholder={searchPlaceholder} />
        )}
        {filters.map((f) => (
          <SelectField
            key={f.name}
            id={`${uid}-f-${f.name}`}
            label={f.label}
            value={state.filters?.[f.name] ?? ""}
            onChange={(value) => onChange((s) => ({ ...s, filters: { ...s.filters, [f.name]: value } }))}
            options={[{ value: "", label: "Tất cả" }, ...f.options]}
          />
        ))}
        {sortOptions.length > 0 && (
          <>
            <SelectField
              id={`${uid}-sort`}
              label="Sắp xếp theo"
              value={state.sort ?? ""}
              onChange={(sort) => onChange({ sort })}
              options={sortOptions}
            />
            <SelectField
              id={`${uid}-dir`}
              label="Thứ tự"
              value={state.dir}
              onChange={(dir) => onChange({ dir })}
              options={DIR_OPTIONS}
            />
          </>
        )}
        {showTop && (
          <SelectField
            id={`${uid}-top`}
            label="Hiển thị"
            value={String(state.top || 0)}
            onChange={(top) => onChange({ top: Number(top) })}
            options={TOP_OPTIONS}
          />
        )}
        {children}
      </div>
      {shown != null && total != null && (
        <p className="text-xs text-text-muted" aria-live="polite">
          <span className="font-mono tabular-nums text-text-main">{shown}</span>
          {" / "}
          <span className="font-mono tabular-nums">{total}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Sortable column header bound to the toolbar state: announces the active sort with
 * `aria-sort` and is operated with the keyboard through its button.
 */
export function SortableHeader({ label, field, state, onSort, align = "left", className, buttonClassName }) {
  const active = state?.sort === field;
  const ariaSort = active ? (state.dir === "asc" ? "ascending" : "descending") : "none";
  const icon = active ? (state.dir === "asc" ? "arrow_upward" : "arrow_downward") : "unfold_more";
  return (
    <th scope="col" aria-sort={ariaSort} className={cn(align === "right" ? "text-right" : "text-left", className)}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-text-main focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
          active && "text-text-main",
          buttonClassName
        )}
      >
        {label}
        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">{icon}</span>
      </button>
    </th>
  );
}
