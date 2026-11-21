"use client";

// The non-data states every admin usage table shows (spec admin-usage-views "Table
// states"): loading, a failed fetch with "Thử lại", nothing matching the search and
// filters with "Xoá bộ lọc", and the table's own empty message. Which one applies is
// decided by tableStateOf (src/shared/utils/tableQuery.js).

import Button from "./Button";

function StateContent({ state, emptyMessage, onRetry, onClearFilters }) {
  if (state === "loading") {
    return (
      <span className="inline-flex items-center gap-2 text-text-muted" role="status">
        <span className="material-symbols-outlined animate-spin text-[20px]" aria-hidden="true">progress_activity</span>
        Đang tải…
      </span>
    );
  }
  if (state === "error") {
    return (
      <span role="alert" className="inline-flex flex-wrap items-center justify-center gap-3">
        <span className="inline-flex items-center gap-2 text-danger">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">error</span>
          Không tải được dữ liệu
        </span>
        {onRetry && <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>Thử lại</Button>}
      </span>
    );
  }
  if (state === "filtered-empty") {
    return (
      <span className="inline-flex flex-wrap items-center justify-center gap-3 text-text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">filter_alt_off</span>
          Không có dữ liệu khớp bộ lọc
        </span>
        {onClearFilters && <Button variant="secondary" size="sm" icon="close" onClick={onClearFilters}>Xoá bộ lọc</Button>}
      </span>
    );
  }
  return <span className="text-text-muted">{emptyMessage}</span>;
}

/** A full-width table row holding the state; renders nothing for "ready". */
export function TableStateRow({ state, colSpan, emptyMessage, onRetry, onClearFilters }) {
  if (state === "ready") return null;
  return (
    <tr>
      <td colSpan={colSpan} className="p-8 text-center text-sm">
        <StateContent state={state} emptyMessage={emptyMessage} onRetry={onRetry} onClearFilters={onClearFilters} />
      </td>
    </tr>
  );
}

/** The same state as a block, for a table that is not rendered at all in that state. */
export default function TableState({ state, emptyMessage, onRetry, onClearFilters, className = "" }) {
  if (state === "ready") return null;
  return (
    <div className={`flex items-center justify-center p-8 text-center text-sm ${className}`}>
      <StateContent state={state} emptyMessage={emptyMessage} onRetry={onRetry} onClearFilters={onClearFilters} />
    </div>
  );
}
