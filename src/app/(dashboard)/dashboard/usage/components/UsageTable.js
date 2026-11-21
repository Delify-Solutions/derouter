"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import { SortableHeader } from "@/shared/components/TableToolbar";
import { TableStateRow } from "@/shared/components/TableState";
import { fmtUsd } from "@/shared/utils/money";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
// Money is a legacy USD float here (stats API); fmtUsd is the single formatter.
const fmtCost = (n) => fmtUsd(n || 0);

function fmtTime(iso) {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Providers that served a requested-model row, most requests first: three names, then
 * "+N" for the rest (their names in the tooltip).
 */
function ProviderList({ providers = [], highlight = false }) {
  if (!providers.length) return <span className="text-text-muted">—</span>;
  const shown = providers.slice(0, 3);
  const rest = providers.slice(3);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((p) => (
        <Badge key={p.id} variant={highlight ? "primary" : "neutral"} size="sm">{p.name}</Badge>
      ))}
      {rest.length > 0 && (
        <span className="font-mono text-xs text-text-muted" title={rest.map((p) => p.name).join(", ")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

ProviderList.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, name: PropTypes.string })),
  highlight: PropTypes.bool,
};

/**
 * Render 3 token or cost cells based on viewMode
 */
function ValueCells({ item, viewMode, isSummary = false }) {
  if (viewMode === "tokens") {
    return (
      <>
        <td className="px-6 py-3 text-right font-mono tabular-nums text-text-muted">
          {isSummary && item.promptTokens === undefined ? "—" : fmt(item.promptTokens)}
        </td>
        <td className="px-6 py-3 text-right font-mono tabular-nums text-text-muted">
          {item.cachedTokens ? fmt(item.cachedTokens) : "—"}
        </td>
        <td className="px-6 py-3 text-right font-mono tabular-nums text-text-muted">
          {isSummary && item.completionTokens === undefined ? "—" : fmt(item.completionTokens)}
        </td>
        <td className="px-6 py-3 text-right font-mono tabular-nums font-medium">
          {fmt(item.totalTokens)}
        </td>
      </>
    );
  }
  return (
    <>
      <td className="px-6 py-3 text-right font-mono tabular-nums text-text-muted">
        {isSummary && item.inputCost === undefined ? "—" : fmtCost(item.inputCost)}
      </td>
      <td className="px-6 py-3 text-right font-mono tabular-nums text-text-muted">
        {item.cachedCost ? fmtCost(item.cachedCost) : "—"}
      </td>
      <td className="px-6 py-3 text-right font-mono tabular-nums text-text-muted">
        {isSummary && item.outputCost === undefined ? "—" : fmtCost(item.outputCost)}
      </td>
      <td className="px-6 py-3 text-right font-mono tabular-nums font-medium text-warning">
        {fmtCost(item.totalCost || item.cost)}
      </td>
    </>
  );
}

ValueCells.propTypes = {
  item: PropTypes.object.isRequired,
  viewMode: PropTypes.string.isRequired,
  isSummary: PropTypes.bool,
};

const HEAD_CELL = "px-6 py-3 font-medium";

/**
 * Usage table with expandable group rows. Sorting, search, filters and Top N are applied
 * by the caller (shared toolbar state); a column with a `sortField` gets a header button
 * that writes the same state, so header and toolbar always agree.
 *
 * @param {object} props
 * @param {string} props.title - Table title
 * @param {Array} props.columns - Column definitions [{field, label, align?, sortField?}]
 * @param {Array} props.groupedData - Groups to show, already filtered, sorted and cut
 * @param {object} props.sortState - Toolbar state ({ sort, dir })
 * @param {function} props.onSort - Header click with the column's sort field
 * @param {string} props.viewMode - "tokens" or "costs"
 * @param {string} props.storageKey - localStorage key for expanded state
 * @param {function} props.renderDetailCells - Render detail row custom cells (before value cells)
 * @param {function} props.renderSummaryCells - Render summary row cells after group label (placeholder cols)
 * @param {string} props.emptyMessage - Message when the period has no data
 * @param {string} props.tableState - "ready" | "loading" | "error" | "filtered-empty" | "empty"
 * @param {function} [props.onRetry] - "Thử lại" after a failed fetch
 * @param {function} [props.onClearFilters] - "Xoá bộ lọc" when nothing matches
 * @param {import("react").ReactNode} [props.toolbar] - Toolbar shown above the table
 */
export default function UsageTable({
  title,
  columns,
  groupedData,
  sortState,
  onSort,
  viewMode,
  storageKey,
  renderDetailCells,
  renderSummaryCells,
  emptyMessage,
  tableState = "ready",
  onRetry,
  onClearFilters,
  toolbar = null,
}) {
  const [expanded, setExpanded] = useState(new Set());

  // Load expanded state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setExpanded(new Set(JSON.parse(saved)));
    } catch (e) {
      console.error(`Failed to load ${storageKey}:`, e);
    }
  }, [storageKey]);

  // Save expanded state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch (e) {
      console.error(`Failed to save ${storageKey}:`, e);
    }
  }, [expanded, storageKey]);

  const toggleGroup = useCallback((groupKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey);
      return next;
    });
  }, []);

  const valueColumns = useMemo(() => {
    if (viewMode === "tokens") {
      return [
        { field: "promptTokens", label: "Input Tokens" },
        { field: "cachedTokens", label: "Cached" },
        { field: "completionTokens", label: "Output Tokens" },
        { field: "totalTokens", label: "Total Tokens", sortField: "tokens" },
      ];
    }
    return [
      { field: "promptTokens", label: "Input Cost" },
      { field: "cachedCost", label: "Cached Cost" },
      { field: "completionTokens", label: "Output Cost" },
      { field: "cost", label: "Total Cost", sortField: "cost" },
    ];
  }, [viewMode]);

  const totalColSpan = columns.length + valueColumns.length;

  const headerCell = (col, align) => (col.sortField ? (
    <SortableHeader
      key={col.field}
      label={col.label}
      field={col.sortField}
      state={sortState}
      onSort={onSort}
      align={align}
      className={HEAD_CELL}
    />
  ) : (
    <th key={col.field} scope="col" className={`${HEAD_CELL} ${align === "right" ? "text-right" : "text-left"}`}>{col.label}</th>
  ));

  return (
    <Card className="overflow-hidden">
      {(title || toolbar) && (
        <div className="flex flex-col gap-3 p-4 border-b border-border bg-bg-subtle/50">
          {title && <h3 className="font-semibold">{title}</h3>}
          {toolbar}
        </div>
      )}
      <div className="overflow-x-auto" aria-busy={tableState === "loading"}>
        <table className="w-full text-sm text-left">
          <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
            <tr>
              {columns.map((col) => headerCell(col, col.align === "right" ? "right" : "left"))}
              {valueColumns.map((col) => headerCell(col, "right"))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tableState === "ready" && groupedData.map((group) => {
              const isOpen = expanded.has(group.groupKey);
              return (
                <Fragment key={group.groupKey}>
                  {/* Group summary row */}
                  <tr
                    className="group-summary cursor-pointer hover:bg-bg-subtle/50 transition-colors"
                    onClick={() => toggleGroup(group.groupKey)}
                  >
                    <td className="px-6 py-3">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={(e) => { e.stopPropagation(); toggleGroup(group.groupKey); }}
                        className="flex items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                      >
                        <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true">
                          chevron_right
                        </span>
                        <span className={`font-medium transition-colors ${group.summary.pending > 0 ? "text-primary" : ""}`}>
                          {group.groupKey}
                        </span>
                      </button>
                    </td>
                    {renderSummaryCells(group)}
                    <ValueCells item={group.summary} viewMode={viewMode} isSummary />
                  </tr>
                  {/* Detail rows */}
                  {isOpen && group.items.map((item) => (
                    <tr
                      key={`detail-${item.key}`}
                      className="group-detail hover:bg-bg-subtle/20 transition-colors"
                    >
                      {renderDetailCells(item)}
                      <ValueCells item={item} viewMode={viewMode} />
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            <TableStateRow
              state={tableState === "ready" && groupedData.length === 0 ? "empty" : tableState}
              colSpan={totalColSpan}
              emptyMessage={emptyMessage}
              onRetry={onRetry}
              onClearFilters={onClearFilters}
            />
          </tbody>
        </table>
      </div>
    </Card>
  );
}

UsageTable.propTypes = {
  title: PropTypes.string.isRequired,
  columns: PropTypes.arrayOf(PropTypes.shape({
    field: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    align: PropTypes.string,
    sortField: PropTypes.string,
  })).isRequired,
  groupedData: PropTypes.array.isRequired,
  sortState: PropTypes.shape({ sort: PropTypes.string, dir: PropTypes.string }).isRequired,
  onSort: PropTypes.func.isRequired,
  viewMode: PropTypes.string.isRequired,
  storageKey: PropTypes.string.isRequired,
  renderDetailCells: PropTypes.func.isRequired,
  renderSummaryCells: PropTypes.func.isRequired,
  emptyMessage: PropTypes.string.isRequired,
  tableState: PropTypes.string,
  onRetry: PropTypes.func,
  onClearFilters: PropTypes.func,
  toolbar: PropTypes.node,
};

// Re-export utilities for use in UsageStats orchestrator
export { fmt, fmtCost, fmtTime, ProviderList };
