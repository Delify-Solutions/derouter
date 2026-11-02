"use client";

import PropTypes from "prop-types";

function dateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** Per-account outcome of giving a code to accounts: who got it, who did not and why. */
export default function AssignResults({ results }) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const okCount = results.filter((r) => r.ok).length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-main">
        Đã gắn cho {okCount}/{results.length} tài khoản.
      </p>
      <ul className="flex flex-col border border-border">
        {results.map((r, index) => (
          <li
            key={`${r.userId || r.input}-${index}`}
            className={`flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-xs ${index > 0 ? "border-t border-border" : ""}`}
          >
            <span className="min-w-0 break-all font-mono text-text-main">{r.email || r.input}</span>
            <span className={`flex items-center gap-1 ${r.ok ? "text-text-main" : "text-danger"}`}>
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">{r.ok ? "check_circle" : "error"}</span>
              {r.ok
                ? `Đã nhận${r.expiresAt ? ` · hết hạn ${dateTime(r.expiresAt)}` : ""}`
                : r.message || "Không gắn được"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

AssignResults.propTypes = {
  results: PropTypes.array,
};
